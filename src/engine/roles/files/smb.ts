/**
 * Accès réseau aux partages (SMB) : résolution du nom du serveur (DNS, puis diffusion NetBIOS sur
 * le segment local), connexion SMB tracée, contrôle des autorisations (partage ∩ NTFS) et
 * lecteurs réseau (net use, préférences de stratégie de groupe).
 */
import type { Draft } from 'immer'
import { transact } from '../../core/result'
import { kerberosSkewExceeded, TIME_SKEW_MESSAGE } from '../../services/hostclock'
import { serviceRunning } from '../../services/servicestate'
import type { HostDevice, LabState, MappedDrive, ServerDevice, SmbShare } from '../../model/schema'
import { effectiveIpv4 } from '../../net/addressing'
import { l2Segment } from '../../net/segment'
import { concatTraces, type PacketTrace } from '../../sim/trace'
import { serverExchange } from '../adds/locator'
import { roleModules } from '../registry'
import { firstAddress, resolveName } from '../dns/resolver'
import { accessPerms, sharePerms, type AccessToken, type Perm } from './acl'
import { findShare, shareFolderId } from './actions'
import { findNode, formatUnc, nodePath, parseUnc } from './paths'
import { authenticatedUser, forgetShare, isLinuxServer, openLinuxShare, rememberLogin } from './linuxshare'

export const NETWORK_PATH_NOT_FOUND = 'Le chemin réseau n’a pas été trouvé.'
export const NETWORK_NAME_NOT_FOUND = 'Le nom de réseau est introuvable.'

/** Cible d'un chemin réseau ouvert avec succès. */
export interface UncTarget {
  server: ServerDevice
  share: SmbShare
  /** Élément visé (null = racine du volume, partage C$). */
  nodeId: string | null
  /** Chemin local correspondant sur le serveur. */
  localPath: string
  /** Droits effectifs (partage ∩ NTFS). */
  perms: Set<Perm>
  /** Droits accordés par le seul partage (connexion au partage). */
  sharePerms: Set<Perm>
}

export type UncResult =
  | { ok: true; target: UncTarget; trace: PacketTrace }
  | { ok: false; code: number; error: string; trace: PacketTrace }

function hostOf(state: LabState, id: string): HostDevice | null {
  const d = state.devices[id]
  return d && (d.kind === 'server' || d.kind === 'client') ? d : null
}

/** Ordinateur désigné par un nom ou une adresse, vu depuis le client. */
function locateServer(
  state: LabState,
  client: HostDevice,
  name: string,
  traces: PacketTrace[]
): { device: HostDevice; ip: string | null } | null {
  const lower = name.toLowerCase()
  if (lower === client.name.toLowerCase() || lower === 'localhost' || lower === '127.0.0.1')
    return { device: client, ip: null }
  const byIp = (ip: string) =>
    Object.values(state.devices).find(
      (d): d is HostDevice =>
        (d.kind === 'server' || d.kind === 'client') &&
        d.powered &&
        d.interfaces.some((i) => effectiveIpv4(i)?.address === ip)
    )
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) {
    const device = byIp(name)
    return device ? { device, ip: name } : null
  }
  const dns = resolveName(state, client.id, name)
  traces.push(dns.trace)
  const ip = firstAddress(dns)
  if (ip) {
    const device = byIp(ip)
    return device ? { device, ip } : null
  }
  // Nom court sans réponse DNS : diffusion NetBIOS sur le segment local
  if (name.includes('.')) return null
  for (const iface of client.interfaces) {
    for (const member of l2Segment(state, { deviceId: client.id, ifaceId: iface.id })) {
      const device = state.devices[member.port.deviceId]
      if (!device || (device.kind !== 'server' && device.kind !== 'client')) continue
      if (device.name.toLowerCase() !== lower) continue
      const peerIp = device.interfaces.find((i) => i.id === member.port.ifaceId)
      return { device, ip: peerIp ? (effectiveIpv4(peerIp)?.address ?? null) : null }
    }
  }
  return null
}

/** Le jeton est-il reconnu par le serveur (compte du même domaine ou compte local du serveur) ? */
function tokenValidOn(state: LabState, server: ServerDevice, token: AccessToken): boolean {
  const local = token.sids.find((s) => s.startsWith('local:'))
  if (local) return local.startsWith(`local:${server.name.toLowerCase()}:`)
  const domain = server.host.domain ? state.domains[server.host.domain] : undefined
  return !!domain && token.account.toUpperCase().startsWith(`${domain.netbios.toUpperCase()}\\`)
}

/**
 * Ouvre un chemin réseau (\\SRV1\Compta\Budget) depuis un ordinateur avec le jeton de l'utilisateur.
 * Erreurs système réalistes : 53 (chemin réseau introuvable), 67 (nom de réseau introuvable),
 * 3 (chemin introuvable), 5 (accès refusé).
 */
export function openUnc(
  state: LabState,
  clientId: string,
  path: string,
  token: AccessToken | null,
  /** Références DFS déjà suivies (une seule redirection). */
  referred = false
): UncResult {
  // Espace de noms (\\lab.local\Partages\Compta) : redirection vers un dossier cible
  if (!referred)
    for (const module of roleModules()) {
      const target = module.resolveUnc?.(state, clientId, path)
      if (target) return openUnc(state, clientId, target, token, true)
    }
  const traces: PacketTrace[] = []
  const title = `SMB ${path}`
  const fail = (code: number, error: string): UncResult => ({
    ok: false,
    code,
    error,
    trace: concatTraces(title, traces)
  })
  const client = hostOf(state, clientId)
  const unc = parseUnc(path)
  if (!client || !client.powered || !unc) return fail(53, NETWORK_PATH_NOT_FOUND)
  const located = locateServer(state, client, unc.server, traces)
  if (!located || located.device.kind !== 'server' || !located.device.powered)
    return fail(53, NETWORK_PATH_NOT_FOUND)
  const server = located.device
  // Serveur Linux : partages Samba (smb.conf en vigueur, droits Unix), v2.9 #239
  if (isLinuxServer(server)) {
    if (located.ip) {
      const smb = serverExchange(state, clientId, located.ip, {
        protocol: 'SMB',
        port: 445,
        request: `SMB2 : connexion à \\\\${unc.server}\\${unc.share || 'IPC$'}`,
        reply: 'SMB2 : réponse du serveur Samba',
        fields: [['Chemin', formatUnc(unc)]]
      })
      traces.push(smb.trace)
      if (!smb.ok) return fail(53, NETWORK_PATH_NOT_FOUND)
    }
    const opened = openLinuxShare(state, client, server, located.ip, unc.share, unc.rest, token)
    if (!opened.ok) return fail(opened.code, opened.error)
    return {
      ok: true,
      target: {
        server: opened.server,
        share: opened.share,
        nodeId: opened.nodeId,
        localPath: opened.localPath,
        perms: opened.perms,
        sharePerms: opened.sharePerms
      },
      trace: concatTraces(title, traces)
    }
  }
  // Service « Serveur » (LanmanServer) arrêté : plus d'accès aux partages (Learn, net stop :
  // « Stopping the Server service prevents users from gaining access to the computer's shared resources »)
  if (!serviceRunning(server, 'LanmanServer')) return fail(53, NETWORK_PATH_NOT_FOUND)
  if (located.ip) {
    const smb = serverExchange(state, clientId, located.ip, {
      protocol: 'SMB',
      port: 445,
      request: `SMB2 : connexion à \\\\${unc.server}\\${unc.share || 'IPC$'}`,
      reply: 'SMB2 : réponse du serveur de fichiers',
      fields: [['Chemin', formatUnc(unc)]]
    })
    traces.push(smb.trace)
    if (!smb.ok) return fail(53, NETWORK_PATH_NOT_FOUND)
  }
  const share = unc.share ? findShare(server, unc.share) : undefined
  if (!share) return fail(67, NETWORK_NAME_NOT_FOUND)
  if (!token || !tokenValidOn(state, server, token)) return fail(5, 'Accès refusé.')
  // Jeton de domaine (Kerberos) : un poste ou un serveur dont l'horloge s'écarte de plus de 5 minutes
  // de celle du contrôleur de domaine n'obtient pas de ticket de service (erreur 1398, v2.8)
  if (
    !token.sids.some((s) => s.startsWith('local:')) &&
    (kerberosSkewExceeded(state, clientId) || kerberosSkewExceeded(state, server.id))
  )
    return fail(1398, TIME_SKEW_MESSAGE)
  const viaShare = sharePerms(share, token)
  if (viaShare.size === 0) return fail(5, 'Accès refusé.')
  const base = nodePath(server.storage, shareFolderId(share))
  const localPath = [base.replace(/\\$/, ''), ...unc.rest].join('\\')
  const node = findNode(server.storage, unc.rest.length === 0 ? base : localPath)
  if (node === undefined) return fail(3, 'Le chemin d’accès spécifié est introuvable.')
  const nodeId = node?.id ?? null
  return {
    ok: true,
    target: {
      server,
      share,
      nodeId,
      localPath: unc.rest.length === 0 ? base : localPath,
      perms: accessPerms(server.storage, nodeId, token, share),
      sharePerms: viaShare
    },
    trace: concatTraces(title, traces)
  }
}

/** Lecteur réseau visible dans la session : connecté manuellement ou par stratégie de groupe. */
export interface SessionDrive {
  letter: string
  path: string
  label: string
  source: 'manual' | 'gpo'
  persistent: boolean
}

/** Lecteurs réseau de la session ouverte (net use, « Ce PC »). */
export function sessionDrives(host: HostDevice, account: string | null): SessionDrive[] {
  const manual: SessionDrive[] = host.host.drives
    .filter((d) => account !== null && d.account.toLowerCase() === account.toLowerCase())
    .map((d) => ({ letter: d.letter, path: d.path, label: '', source: 'manual', persistent: d.persistent }))
  const policy: SessionDrive[] = (host.host.policy.user?.settings.driveMaps ?? [])
    .filter((m) => !manual.some((d) => d.letter === m.letter))
    .map((m) => ({ letter: m.letter, path: m.path, label: m.label, source: 'gpo', persistent: m.reconnect }))
  return [...manual, ...policy].sort((a, b) => a.letter.localeCompare(b.letter))
}

/** Remplace la lettre d'un lecteur réseau par son chemin UNC (Z:\Budget → \\SRV1\Compta\Budget). */
export function expandDrivePath(host: HostDevice, account: string | null, path: string): string {
  const m = /^([a-z]):(\\.*)?$/i.exec(path.trim())
  if (!m) return path
  const drive = sessionDrives(host, account).find((d) => d.letter === (m[1] as string).toUpperCase())
  if (!drive) return path
  return `${drive.path.replace(/\\$/, '')}${m[2] && m[2] !== '\\' ? m[2] : ''}`
}

export interface DriveOperation {
  state: LabState
  trace: PacketTrace
  ok: boolean
  /** Erreur système (53, 67, 85, 5…) ou 0. */
  code: number
  message: string
}

/** Connecte un lecteur réseau (net use Z: \\SRV1\Compta). */
export function mapDrive(
  state: LabState,
  clientId: string,
  letter: string,
  path: string,
  token: AccessToken | null,
  options: { persistent?: boolean } = {}
): DriveOperation {
  const empty: PacketTrace = { title: 'net use', events: [] }
  const client = hostOf(state, clientId)
  const upper = letter.replace(/:$/, '').toUpperCase()
  if (!client || !/^[A-Z]$/.test(upper) || upper === 'C')
    return {
      state,
      trace: empty,
      ok: false,
      code: 85,
      message: 'Le nom local du périphérique est déjà utilisé.'
    }
  if (sessionDrives(client, token?.account ?? null).some((d) => d.letter === upper))
    return {
      state,
      trace: empty,
      ok: false,
      code: 85,
      message: 'Le nom local du périphérique est déjà utilisé.'
    }
  const opened = openUnc(state, clientId, path, token)
  if (!opened.ok) return { state, trace: opened.trace, ok: false, code: opened.code, message: opened.error }
  const unc = parseUnc(path)
  const normalized = unc ? formatUnc(unc) : path
  const r = transact(state, (draft) => {
    const host = draft.devices[clientId] as Draft<HostDevice>
    const drive: MappedDrive = {
      letter: upper,
      path: normalized,
      account: token?.account ?? '',
      persistent: options.persistent ?? true
    }
    host.host.drives.push(drive)
    if (isLinuxServer(opened.target.server) && unc) {
      const user = authenticatedUser(state, client, opened.target.server, token)
      if (user) rememberLogin(draft, clientId, unc.server, user, unc.share)
    }
    return undefined
  })
  return { state: r.ok ? r.state : state, trace: opened.trace, ok: true, code: 0, message: '' }
}

/** Déconnecte un lecteur réseau (net use Z: /delete, « * » pour tous). */
export function unmapDrive(
  state: LabState,
  clientId: string,
  letter: string,
  account: string
): DriveOperation {
  const empty: PacketTrace = { title: 'net use', events: [] }
  const upper = letter.replace(/:$/, '').toUpperCase()
  const client = hostOf(state, clientId)
  const mine = (d: MappedDrive) => d.account.toLowerCase() === account.toLowerCase()
  if (!client || (upper !== '*' && !client.host.drives.some((d) => mine(d) && d.letter === upper)))
    return { state, trace: empty, ok: false, code: 2250, message: 'La connexion réseau n’existe pas.' }
  const r = transact(state, (draft) => {
    const host = draft.devices[clientId] as Draft<HostDevice>
    const removed = host.host.drives.filter((d) => mine(d) && (upper === '*' || d.letter === upper))
    host.host.drives = host.host.drives.filter((d) => !removed.includes(d))
    for (const d of removed) {
      const unc = parseUnc(d.path)
      if (unc) forgetShare(draft, clientId, unc.server, unc.share)
    }
    return undefined
  })
  return { state: r.ok ? r.state : state, trace: empty, ok: true, code: 0, message: '' }
}

/** Connexion à un partage sans lettre de lecteur (net use \\\\srv\\partage) : mémorise la connexion d'un serveur Samba. */
export function connectShare(
  state: LabState,
  clientId: string,
  path: string,
  token: AccessToken | null
): LabState {
  const client = hostOf(state, clientId)
  const unc = parseUnc(path)
  if (!client || !unc) return state
  const opened = openUnc(state, clientId, path, token)
  if (!opened.ok || !isLinuxServer(opened.target.server)) return state
  const user = authenticatedUser(state, client, opened.target.server, token)
  if (!user) return state
  const r = transact(state, (draft) => rememberLogin(draft, clientId, unc.server, user, unc.share))
  return r.ok ? r.state : state
}
