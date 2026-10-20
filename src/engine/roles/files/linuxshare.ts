/**
 * Partages Samba d'un serveur Linux vus par les postes Windows (v2.9, #239) : `net use`, Explorateur,
 * `dir`, `type`, `mkdir`, `del`… Le même chemin UNC (\\SRVLNX\partage) est ouvert par `openUnc` ; ici le
 * partage Samba est « projeté » en dossiers et fichiers du moteur de fichiers Windows pour que les
 * commandes existantes les lisent, avec les droits calculés par les règles de Samba (smb.conf en
 * vigueur) puis par les droits Unix du compte effectif (shell/bash/sambaaccess.ts).
 *
 * Aucune donnée n'est copiée dans l'état : la projection est recalculée à chaque ouverture depuis
 * `host.linux.files`. Les écritures (création, contenu, suppression) modifient ces mêmes fichiers.
 */
import type { Draft } from 'immer'
import { raise, transact, type EngineResult } from '../../core/result'
import type { FsNode, HostDevice, LabState, ServerDevice, SmbShare } from '../../model/schema'
import { WELL_KNOWN_SIDS } from '../../model/schema'
import { snapshotOnWrite } from '../../services/linuxconfig'
import type { SmbAuth } from '../../services/linuxsamba'
import {
  authenticate,
  connect,
  createInShare,
  listShareDir,
  listedShares,
  mayOn,
  removeInShare,
  sambaServer,
  sharePath,
  type Connection,
  type SambaServer
} from '../../shell/bash/sambaaccess'
import { baseOf, hostFiles, parentOf, type LinuxFiles } from '../../shell/bash/linuxfs'
import { sourceAddressFor } from '../../sim/forward'
import type { AccessToken, Perm } from './acl'

export const isLinuxServer = (d: { kind: string; host?: { os?: string } } | undefined): boolean =>
  !!d && d.kind === 'server' && d.host?.os === 'linux'

const BAD_CREDENTIALS = 'Le nom d’utilisateur ou le mot de passe est incorrect.'

/** Mot de passe du compte de la session d'un poste (comptes locaux et du domaine du lab). */
function sessionCredentials(state: LabState, client: HostDevice): { name: string; password: string } | null {
  const session = client.host.session
  if (!session) return null
  if (session.domain) {
    const domain = Object.values(state.domains).find(
      (d) => d.netbios.toUpperCase() === session.domain?.toUpperCase()
    )
    const user = domain?.users.find((u) => u.sam.toLowerCase() === session.user.toLowerCase())
    return user ? { name: session.user, password: user.password } : null
  }
  if (session.user.toLowerCase() === 'administrateur')
    return { name: session.user, password: client.host.localAdminPassword }
  const local = client.host.localUsers.find((u) => u.name.toLowerCase() === session.user.toLowerCase())
  return local ? { name: session.user, password: local.password } : null
}

/**
 * Compte SMB utilisé par un poste pour un serveur : identifiants donnés à la commande, connexion déjà
 * ouverte vers ce serveur (`net use` réussi : le mot de passe a été vérifié), puis compte de la session.
 */
export function smbAuthFor(
  state: LabState,
  client: HostDevice,
  server: SambaServer,
  token: AccessToken | null
): SmbAuth {
  if (token?.smb) return authenticate(server, token.smb.user, token.smb.password)
  const login = client.host.linux?.smbLogins?.find((l) => l.server === server.host.name.toLowerCase())
  if (login) {
    const user = server.users.find((u) => u.name === login.user)
    return user ? { kind: 'user', user } : { kind: 'failed', status: 'NT_STATUS_LOGON_FAILURE' }
  }
  const creds = sessionCredentials(state, client)
  return authenticate(server, creds?.name ?? null, creds?.password ?? null)
}

/** Compte SMB d'un jeton (écritures sans le poste en main) : identifiants donnés, sinon connexion ouverte par un poste portant ce compte. */
function authFromToken(state: LabState, server: SambaServer, token: AccessToken): SmbAuth {
  if (token.smb) return authenticate(server, token.smb.user, token.smb.password)
  for (const d of Object.values(state.devices)) {
    if (d.kind !== 'server' && d.kind !== 'client') continue
    const session = sessionCredentials(state, d)
    const label = d.host.session
      ? `${d.host.session.domain ?? d.name}\\${d.host.session.user}`.toLowerCase()
      : ''
    if (label !== token.account.toLowerCase() && session?.name.toLowerCase() !== token.account.toLowerCase())
      continue
    const login = d.host.linux?.smbLogins?.find((l) => l.server === server.host.name.toLowerCase())
    if (login) {
      const user = server.users.find((u) => u.name === login.user)
      if (user) return { kind: 'user', user }
    }
  }
  return { kind: 'guest' }
}

// ---------------------------------------------------------------------------------------------
// Projection d'un partage en dossiers et fichiers Windows
// ---------------------------------------------------------------------------------------------

const idOf = (path: string) => `lx:${path}`

/** Chemin Windows d'un chemin Unix : /srv/samba/public → C:\srv\samba\public. */
export const winPathOf = (path: string) => `C:${path === '/' ? '\\' : path.replace(/\//g, '\\')}`

/** Chemin Unix d'un chemin local projeté (C:\srv\samba\public → /srv/samba/public). */
export const unixPathOf = (local: string) => local.replace(/^[a-z]:/i, '').replace(/\\/g, '/') || '/'

function permsOf(srv: SambaServer, conn: Connection, path: string): Set<Perm> {
  const node = srv.files[path]
  const perms = new Set<Perm>()
  if (!node) return perms
  const r = mayOn(srv, conn, node, 4)
  const x = mayOn(srv, conn, node, 1)
  const w = conn.writable && mayOn(srv, conn, node, 2)
  if (node.type === 'dir' ? r && x : r) {
    perms.add('list')
    perms.add('read')
  }
  if (x) perms.add('execute')
  if (w) {
    perms.add('write')
    perms.add('delete')
  }
  return perms
}

function projectNode(srv: SambaServer, conn: Connection, path: string): FsNode {
  const node = srv.files[path] as NonNullable<LinuxFiles[string]>
  const perms = permsOf(srv, conn, path)
  const rights = perms.has('write')
    ? 'Modify'
    : perms.has('execute') && perms.has('read')
      ? 'ReadAndExecute'
      : perms.has('read')
        ? 'Read'
        : null
  const content = node.type === 'file' ? (node.content ?? '') : undefined
  return {
    id: idOf(path),
    name: baseOf(path),
    parentId: path === '/' ? null : parentOf(path) === '/' ? null : idOf(parentOf(path)),
    kind: node.type === 'dir' ? 'folder' : 'file',
    size: content === undefined ? 0 : content.length,
    ...(content !== undefined ? { content } : {}),
    acl: rights ? [{ principal: WELL_KNOWN_SIDS.everyone, type: 'Allow', rights }] : [],
    inherits: false,
    owner: WELL_KNOWN_SIDS.administrators,
    modifiedAt: node.mtime,
    system: false
  }
}

/** Dossiers traversés jusqu'au partage et contenu du partage, sous forme de nœuds Windows. */
function projectShare(srv: SambaServer, conn: Connection): FsNode[] {
  const nodes: FsNode[] = []
  const chain: string[] = []
  for (let p = conn.path; p !== '/'; p = parentOf(p)) chain.unshift(p)
  for (const p of chain) if (srv.files[p]) nodes.push(projectNode(srv, conn, p))
  const prefix = `${conn.path}/`
  for (const p of Object.keys(srv.files).sort())
    if (p.startsWith(prefix) && srv.files[p]) nodes.push(projectNode(srv, conn, p))
  return nodes
}

export type LinuxOpen =
  | {
      ok: true
      server: ServerDevice
      share: SmbShare
      nodeId: string | null
      localPath: string
      perms: Set<Perm>
      sharePerms: Set<Perm>
    }
  | { ok: false; code: number; error: string }

const NAME_NOT_FOUND = 'Le nom de réseau est introuvable.'

/**
 * Ouvre \\serveur\partage\dossier d'un serveur Samba depuis un poste. Codes d'erreur système : 67 (nom
 * de réseau introuvable), 5 (accès refusé), 1326 (identifiants incorrects), 3 (chemin introuvable).
 */
export function openLinuxShare(
  state: LabState,
  client: HostDevice,
  server: ServerDevice,
  serverIp: string | null,
  shareName: string,
  rest: string[],
  token: AccessToken | null
): LinuxOpen {
  const srv = sambaServer(server)
  if (!srv) return { ok: false, code: 53, error: 'Le chemin réseau n’a pas été trouvé.' }
  const auth = smbAuthFor(state, client, srv, token)
  if (auth.kind === 'failed') return { ok: false, code: 1326, error: BAD_CREDENTIALS }
  const clientIp = serverIp ? sourceAddressFor(state, client, serverIp) : null
  const ipc = shareName.toLowerCase() === 'ipc$'
  if (ipc) {
    const share: SmbShare = { name: 'IPC$', folderId: '', description: 'IPC distant', acl: [] }
    return {
      ok: true,
      server: { ...server, storage: { rootAcl: [], nodes: [], shares: [share] } } as ServerDevice,
      share,
      nodeId: null,
      localPath: 'C:\\',
      perms: new Set<Perm>(['list']),
      sharePerms: new Set<Perm>(['list'])
    }
  }
  const result = connect(srv, shareName, auth, clientIp)
  if (!result.ok)
    return result.status === 'NT_STATUS_BAD_NETWORK_NAME'
      ? { ok: false, code: 67, error: NAME_NOT_FOUND }
      : { ok: false, code: 5, error: 'Accès refusé.' }
  const conn = result.conn
  const target = sharePath(conn, rest)
  if (target === null || !srv.files[target])
    return { ok: false, code: 3, error: 'Le chemin d’accès spécifié est introuvable.' }
  const nodes = projectShare(srv, conn)
  const share: SmbShare = {
    name: shareName,
    folderId: idOf(conn.path),
    description: '',
    acl: [{ principal: WELL_KNOWN_SIDS.everyone, type: 'Allow', rights: conn.writable ? 'Change' : 'Read' }]
  }
  const projected = { ...server, storage: { rootAcl: [], nodes, shares: [share] } } as ServerDevice
  return {
    ok: true,
    server: projected,
    share,
    nodeId: idOf(target),
    localPath: winPathOf(target),
    perms: permsOf(srv, conn, target),
    sharePerms: new Set<Perm>(
      conn.writable ? ['list', 'read', 'execute', 'write', 'delete'] : ['list', 'read', 'execute']
    )
  }
}

/** Partages visibles par `net view \\serveur` (hors IPC$ et partages masqués). */
export function linuxShareNames(server: ServerDevice): { name: string; comment: string }[] {
  const srv = sambaServer(server)
  if (!srv) return []
  return listedShares(srv)
    .filter((s) => s.type === 'Disk')
    .map((s) => ({ name: s.name, comment: s.comment }))
}

// ---------------------------------------------------------------------------------------------
// Écritures depuis Windows (création, contenu, suppression) sur les fichiers Linux
// ---------------------------------------------------------------------------------------------

function commitFiles(draft: Draft<LabState>, serverId: string, files: LinuxFiles): void {
  const d = draft.devices[serverId]
  if (!d || d.kind !== 'server') return
  const loaded = snapshotOnWrite(d.host.linux?.loaded, hostFiles(d as HostDevice), files)
  d.host.linux = {
    ...d.host.linux,
    distro: d.host.linux?.distro ?? 'debian12',
    files,
    ...(loaded ? { loaded } : {})
  }
}

const MESSAGES: Record<string, [string, string]> = {
  denied: ['AccessDenied', 'Accès refusé.'],
  exists: ['ItemExists', 'Un élément portant ce nom existe déjà.'],
  missing: ['PathNotFound', 'Le chemin d’accès spécifié est introuvable.'],
  notempty: ['NotEmpty', 'Le répertoire n’est pas vide.']
}

/** Connexion du compte du jeton au partage nommé ; lève l'erreur système sinon. */
function writeConnection(state: LabState, serverId: string, token: AccessToken, shareName: string) {
  const server = state.devices[serverId] as ServerDevice
  const srv = sambaServer(server)
  if (!srv) raise('PathNotFound', 'Le chemin réseau n’a pas été trouvé.')
  const live = srv as SambaServer
  const auth = authFromToken(state, live, token)
  const r = connect(live, shareName, auth, null)
  if (!r.ok) raise('AccessDenied', 'Accès refusé.')
  return { srv: live, conn: (r as { ok: true; conn: Connection }).conn }
}

/** Crée un dossier ou un fichier (contenu éventuel) dans un partage Samba depuis un poste Windows. */
export function linuxCreate(
  state: LabState,
  serverId: string,
  localPath: string,
  kind: 'folder' | 'file',
  token: AccessToken,
  share: string | undefined,
  content?: string
): EngineResult<string> {
  return transact(state, (draft) => {
    if (!share) raise('AccessDenied', 'Accès refusé.')
    const { srv, conn } = writeConnection(state, serverId, token, share as string)
    const path = unixPathOf(localPath)
    const r = createInShare(srv, conn, path, kind === 'folder' ? 'dir' : 'file', state.clock, content)
    if ('error' in r) {
      const [code, message] = MESSAGES[r.error] as [string, string]
      raise(code, message)
    }
    commitFiles(draft, serverId, (r as { files: LinuxFiles }).files)
    return idOf(path)
  })
}

/** Supprime un fichier ou un dossier vide d'un partage Samba. */
export function linuxRemove(
  state: LabState,
  serverId: string,
  localPath: string,
  token: AccessToken,
  share: string | undefined
): EngineResult {
  return transact(state, (draft) => {
    if (!share) raise('AccessDenied', 'Accès refusé.')
    const { srv, conn } = writeConnection(state, serverId, token, share as string)
    const r = removeInShare(srv, conn, unixPathOf(localPath))
    if ('error' in r) {
      const [code, message] = MESSAGES[r.error] as [string, string]
      raise(code, message)
    }
    commitFiles(draft, serverId, (r as { files: LinuxFiles }).files)
    return undefined
  })
}

export { listShareDir }

// ---------------------------------------------------------------------------------------------
// Connexions mémorisées par le poste (smbstatus les relit, les commandes suivantes les réutilisent)
// ---------------------------------------------------------------------------------------------

/** Compte Samba authentifié (pas d'invité) d'un poste vers un serveur, pour mémoriser sa connexion. */
export function authenticatedUser(
  state: LabState,
  client: HostDevice,
  server: ServerDevice,
  token: AccessToken | null
): string | null {
  const srv = sambaServer(server)
  if (!srv) return null
  const auth = smbAuthFor(state, client, srv, token)
  return auth.kind === 'user' ? auth.user.name : null
}

/** Mémorise (ou complète) la connexion d'un poste à un partage d'un serveur Samba. */
export function rememberLogin(
  draft: Draft<LabState>,
  clientId: string,
  serverName: string,
  user: string,
  share: string
): void {
  const client = draft.devices[clientId]
  if (!client || (client.kind !== 'server' && client.kind !== 'client')) return
  const key = serverName.toLowerCase()
  const logins = [...(client.host.linux?.smbLogins ?? [])]
  const existing = logins.find((l) => l.server === key && l.user === user)
  if (existing) {
    if (!existing.shares.includes(share)) existing.shares = [...existing.shares, share]
  } else logins.push({ server: key, user, time: draft.clock, shares: [share] })
  client.host.linux = {
    ...client.host.linux,
    distro: client.host.linux?.distro ?? 'debian12',
    smbLogins: logins
  }
}

/** Retire un partage des connexions du poste (la connexion disparaît avec son dernier partage). */
export function forgetShare(
  draft: Draft<LabState>,
  clientId: string,
  serverName: string,
  share: string
): void {
  const client = draft.devices[clientId]
  if (!client || (client.kind !== 'server' && client.kind !== 'client')) return
  const key = serverName.toLowerCase()
  const logins = client.host.linux?.smbLogins
  if (!logins || !client.host.linux) return
  const next = logins
    .map((l) =>
      l.server === key ? { ...l, shares: l.shares.filter((s) => s.toLowerCase() !== share.toLowerCase()) } : l
    )
    .filter((l) => l.server !== key || l.shares.length > 0)
  if (next.length === 0) delete client.host.linux.smbLogins
  else client.host.linux.smbLogins = next
}

/** Contenu d'un fichier d'un serveur Linux désigné par son chemin local projeté (null s'il n'existe pas). */
export function linuxFileText(state: LabState, serverId: string, localPath: string): string | null {
  const server = state.devices[serverId]
  if (!server || server.kind !== 'server') return null
  const node = hostFiles(server as HostDevice)[unixPathOf(localPath)]
  return node && node.type === 'file' ? (node.content ?? '') : null
}
