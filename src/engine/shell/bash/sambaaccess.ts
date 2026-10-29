/**
 * Accès aux partages d'un serveur Samba simulé (v2.9, #239) : connexion à un partage (smb.conf en
 * vigueur : path, valid users, read only, write list, guest ok, force user, hosts allow…), puis droits
 * Unix du compte effectif sur les fichiers du partage (mêmes règles que la console bash : propriétaire,
 * groupe, autres, traversée des dossiers). Utilisé par smbclient et par les postes Windows
 * (`net use`, Explorateur, `dir`) : une seule règle d'accès pour tous les clients.
 */
import type { HostDevice } from '../../model/schema'
import { inNetwork, isIpv4 } from '../../net/ipv4'
import { findUnit } from '../../services/linuxcatalog'
import { runningConfigText } from '../../services/linuxconfig'
import { isInstalled } from '../../services/linuxpackages'
import {
  authenticateSmb,
  boolValue,
  findShare,
  hostSambaVersion,
  listValue,
  loadSmbConf,
  paramValue,
  readPassdb,
  PASSDB,
  type ConfContext,
  type SamUser,
  type SmbAuth,
  type SmbConf,
  type SmbSection
} from '../../services/linuxsamba'
import { unitStatus } from '../../services/linuxsystem'
import {
  baseOf,
  canTraverse,
  childrenOf,
  hasPerm,
  homeOf,
  hostFiles,
  identityOf,
  joinPath,
  parentOf,
  readPasswd,
  type LinuxFiles,
  type LinuxNode
} from './linuxfs'

/** Serveur Samba en fonctionnement, avec la configuration en vigueur (relue au redémarrage). */
export interface SambaServer {
  host: HostDevice
  files: LinuxFiles
  conf: SmbConf
  cctx: ConfContext
  users: SamUser[]
  unixUsers: string[]
}

/** null : samba absent, ordinateur éteint ou smbd arrêté (le port 445 ne répond pas). */
export function sambaServer(host: HostDevice): SambaServer | null {
  const unit = findUnit('smbd')
  if (!unit || !host.powered || !isInstalled(host, 'samba') || !unitStatus(host, unit).active) return null
  return sambaServerOf(host)
}

/** Configuration d'un serveur sans tenir compte de l'état du service (testparm, smbpasswd). */
export function sambaServerOf(host: HostDevice): SambaServer {
  const files = hostFiles(host)
  const conf = loadSmbConf(runningConfigText(host.host.linux, 'smbd')).conf
  const passdb = files[PASSDB]?.content
  return {
    host,
    files,
    conf,
    cctx: { hostname: host.name, version: hostSambaVersion(host) },
    users: readPassdb(passdb),
    unixUsers: readPasswd(files).map((p) => p.name)
  }
}

export const authenticate = (srv: SambaServer, name: string | null, password: string | null): SmbAuth =>
  authenticateSmb(srv.conf, srv.cctx, srv.users, srv.unixUsers, name, password)

/** Substitutions de smb.conf : %S nom du partage, %U utilisateur de la session, %u utilisateur Unix. */
const sub = (text: string, vars: { S: string; U: string; u: string }) =>
  text.replace(/%([SUu])/g, (_m, k: 'S' | 'U' | 'u') => vars[k])

/** Partages visibles par `smbclient -L` (browseable), avec leur type et leur commentaire. */
export function listedShares(srv: SambaServer): { name: string; type: 'Disk' | 'IPC'; comment: string }[] {
  const shares = srv.conf.shares
    .filter((s) => !['homes', 'printers'].includes(s.name.toLowerCase()))
    .filter((s) => boolValue(srv.conf, srv.cctx, s, 'browseable'))
    .map((s) => ({
      name: s.name,
      type: 'Disk' as const,
      comment: paramValue(srv.conf, srv.cctx, s, 'comment')
    }))
  return [
    ...shares,
    {
      name: 'IPC$',
      type: 'IPC',
      comment: `IPC Service (${paramValue(srv.conf, srv.cctx, null, 'server string')})`
    }
  ]
}

export interface Connection {
  /** Nom du partage tel que demandé. */
  name: string
  /** Dossier Unix du partage. */
  path: string
  /** Compte Unix effectif (force user, sinon compte authentifié, sinon invité). */
  user: string
  /** Groupe Unix supplémentaire imposé (force group). */
  forceGroup: string | null
  writable: boolean
  guest: boolean
  createMask: number
  directoryMask: number
  forceCreate: number
  forceDirectory: number
}

export type ConnectResult =
  | { ok: true; conn: Connection }
  | { ok: false; status: 'NT_STATUS_BAD_NETWORK_NAME' | 'NT_STATUS_ACCESS_DENIED' }

const BAD_NAME = { ok: false, status: 'NT_STATUS_BAD_NETWORK_NAME' } as const
const DENIED = { ok: false, status: 'NT_STATUS_ACCESS_DENIED' } as const

/** La liste (noms, @groupe, +groupe) désigne-t-elle ce compte ? */
function inList(srv: SambaServer, list: string[], user: string): boolean {
  const groups = identityOf(srv.files, user)?.groups.map((g) => g.name) ?? []
  return list.some((entry) => {
    if (entry.startsWith('@') || entry.startsWith('+')) return groups.includes(entry.slice(1))
    return entry.toLowerCase() === user.toLowerCase()
  })
}

/** Règle `hosts allow` / `hosts deny` (adresse exacte, préfixe « 192.168.2. », réseau CIDR, ALL). */
function hostMatches(entry: string, ip: string): boolean {
  if (entry.toUpperCase() === 'ALL') return true
  if (entry.endsWith('.')) return ip.startsWith(entry)
  const [net = '', bits] = entry.split('/')
  if (isIpv4(net) && bits !== undefined) return inNetwork(ip, net, Number(bits))
  return entry === ip
}

function hostAllowed(srv: SambaServer, section: SmbSection, ip: string | null): boolean {
  if (ip === null) return true
  const allow = listValue(srv.conf, section, 'hosts allow')
  const deny = listValue(srv.conf, section, 'hosts deny')
  if (allow.some((e) => hostMatches(e, ip))) return true
  if (deny.some((e) => hostMatches(e, ip))) return false
  return allow.length === 0
}

const octal = (srv: SambaServer, section: SmbSection, label: string) =>
  parseInt(paramValue(srv.conf, srv.cctx, section, label), 8) || 0

/** Connexion à un partage (tree connect) : existence, hôtes autorisés, comptes admis, chemin Unix. */
export function connect(
  srv: SambaServer,
  shareName: string,
  auth: SmbAuth,
  clientIp: string | null
): ConnectResult {
  if (auth.kind === 'failed') return DENIED
  const authUser = auth.kind === 'user' ? auth.user.name : null
  let section = findShare(srv.conf, shareName)
  let path = ''
  const guestAccount = paramValue(srv.conf, srv.cctx, null, 'guest account')
  // [homes] : le partage portant le nom du compte donne son dossier personnel
  if (!section || ['homes', 'printers'].includes(section.name.toLowerCase())) {
    const homes = findShare(srv.conf, 'homes')
    if (
      !homes ||
      !authUser ||
      authUser.toLowerCase() !== shareName.toLowerCase() ||
      section?.name.toLowerCase() === 'printers'
    )
      return BAD_NAME
    section = homes
    path = homeOf(srv.files, authUser)
  }
  const vars = {
    S: section.name.toLowerCase() === 'homes' ? shareName : section.name,
    U: authUser ?? guestAccount,
    u: authUser ?? guestAccount
  }
  const rawPath = paramValue(srv.conf, srv.cctx, section, 'path')
  if (rawPath !== '') path = sub(rawPath, vars)
  if (path === '' || !boolValue(srv.conf, srv.cctx, section, 'available')) return BAD_NAME
  if (!hostAllowed(srv, section, clientIp)) return DENIED
  const guest = auth.kind === 'guest'
  if (guest && !boolValue(srv.conf, srv.cctx, section, 'guest ok')) return DENIED
  const account = authUser ?? guestAccount
  const expand = (l: string[]) => l.map((e) => sub(e, vars))
  const valid = expand(listValue(srv.conf, section, 'valid users'))
  if (valid.length > 0 && (guest || !inList(srv, valid, account))) return DENIED
  if (inList(srv, expand(listValue(srv.conf, section, 'invalid users')), account)) return DENIED
  const admin = !guest && inList(srv, expand(listValue(srv.conf, section, 'admin users')), account)
  const forceUser = paramValue(srv.conf, srv.cctx, section, 'force user')
  const unix = admin ? 'root' : forceUser !== '' ? forceUser : account
  const dir = srv.files[path]
  if (!dir || dir.type !== 'dir') return BAD_NAME
  if (!canTraverse(srv.files, unix, joinPath(path, 'x')) || !hasPerm(srv.files, unix, dir, 1)) return DENIED
  let writable = !boolValue(srv.conf, srv.cctx, section, 'read only')
  if (!guest && inList(srv, expand(listValue(srv.conf, section, 'write list')), account)) writable = true
  if (inList(srv, expand(listValue(srv.conf, section, 'read list')), account)) writable = false
  const forceGroup = paramValue(srv.conf, srv.cctx, section, 'force group')
  return {
    ok: true,
    conn: {
      name: shareName,
      path,
      user: unix,
      forceGroup: forceGroup !== '' ? forceGroup : null,
      writable,
      guest,
      createMask: octal(srv, section, 'create mask'),
      directoryMask: octal(srv, section, 'directory mask'),
      forceCreate: octal(srv, section, 'force create mode'),
      forceDirectory: octal(srv, section, 'force directory mode')
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Fichiers du partage
// ---------------------------------------------------------------------------------------------

/** Chemin Unix d'un élément du partage (composantes relatives) ; null si « .. » sort du partage. */
export function sharePath(conn: Connection, parts: string[]): string | null {
  let current = conn.path
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') return null
    current = joinPath(current, part)
  }
  return current
}

/** Droit r/w/x du compte effectif sur un nœud, groupe imposé compris. */
export function mayOn(srv: SambaServer, conn: Connection, node: LinuxNode, want: 4 | 2 | 1): boolean {
  if (hasPerm(srv.files, conn.user, node, want)) return true
  if (!conn.forceGroup || conn.user === 'root') return false
  // force group : le compte agit avec ce groupe en plus des siens
  const shift = node.group === conn.forceGroup ? 3 : -1
  return shift >= 0 && ((node.mode >> shift) & want) !== 0
}

export interface ShareEntry {
  name: string
  node: LinuxNode
  path: string
}

/** Contenu d'un dossier du partage : null si le compte ne peut pas le lire. */
export function listShareDir(srv: SambaServer, conn: Connection, path: string): ShareEntry[] | null {
  const dir = srv.files[path]
  if (!dir || dir.type !== 'dir' || !mayOn(srv, conn, dir, 4) || !mayOn(srv, conn, dir, 1)) return null
  return childrenOf(srv.files, path).flatMap((p) => {
    const node = srv.files[p]
    return node ? [{ name: baseOf(p), node, path: p }] : []
  })
}

export type WriteFailure = 'denied' | 'exists' | 'missing' | 'notempty'

/** Groupe propriétaire d'un nouvel élément : force group, sinon groupe principal du compte. */
function groupFor(srv: SambaServer, conn: Connection): string {
  if (conn.forceGroup) return conn.forceGroup
  return identityOf(srv.files, conn.user)?.groups[0]?.name ?? 'nogroup'
}

/**
 * Crée un fichier (contenu éventuel) ou un dossier du partage : droit d'écriture du partage et du
 * dossier parent, droits d'origine bornés par `create mask` / `directory mask`.
 */
export function createInShare(
  srv: SambaServer,
  conn: Connection,
  path: string,
  kind: 'file' | 'dir',
  clock: number,
  content?: string
): { files: LinuxFiles } | { error: WriteFailure } {
  const parent = srv.files[parentOf(path)]
  if (!parent || parent.type !== 'dir') return { error: 'missing' }
  const existing = srv.files[path]
  if (existing) {
    if (kind === 'dir' || existing.type === 'dir') return { error: 'exists' }
    if (!conn.writable || !mayOn(srv, conn, existing, 2)) return { error: 'denied' }
    return {
      files: {
        ...srv.files,
        [path]: { ...existing, content: content ?? existing.content ?? '', mtime: clock }
      }
    }
  }
  if (!conn.writable || !mayOn(srv, conn, parent, 2) || !mayOn(srv, conn, parent, 1))
    return { error: 'denied' }
  const mode =
    kind === 'file'
      ? (0o666 & conn.createMask) | conn.forceCreate
      : (0o777 & conn.directoryMask) | conn.forceDirectory
  const node: LinuxNode = {
    type: kind,
    mode,
    owner: conn.user,
    group: groupFor(srv, conn),
    mtime: clock,
    ...(kind === 'file' ? { content: content ?? '' } : {})
  }
  return { files: { ...srv.files, [path]: node } }
}

/** Supprime un fichier ou un dossier vide du partage (droit d'écriture sur le dossier parent). */
export function removeInShare(
  srv: SambaServer,
  conn: Connection,
  path: string
): { files: LinuxFiles } | { error: WriteFailure } {
  const node = srv.files[path]
  const parent = srv.files[parentOf(path)]
  if (!node || !parent || path === conn.path) return { error: 'missing' }
  if (!conn.writable || !mayOn(srv, conn, parent, 2) || !mayOn(srv, conn, parent, 1))
    return { error: 'denied' }
  if (node.type === 'dir' && childrenOf(srv.files, path).length > 0) return { error: 'notempty' }
  const files = { ...srv.files }
  delete files[path]
  return { files }
}
