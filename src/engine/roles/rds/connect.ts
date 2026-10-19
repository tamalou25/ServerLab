/**
 * Connexion Bureau à distance (mstsc) : résolution du nom, connexion TCP 3389 tracée,
 * authentification, puis autorisation (administrateurs, groupes de la collection sur un hôte de
 * session, sinon groupe Utilisateurs du Bureau à distance). Évènements 4624 / 4625 de type 10.
 */
import type { Draft } from 'immer'
import { logAudited } from '../gpo/auditpolicy'
import { transact } from '../../core/result'
import { nextSeq } from '../../model/factory'
import type { HostDevice, LabState } from '../../model/schema'
import { effectiveIpv4 } from '../../net/addressing'
import { tcpListening } from '../../services/listening'
import type { PacketTrace } from '../../sim/trace'
import { concatTraces } from '../../sim/trace'
import { authenticate } from '../adds/credentials'
import { findPrincipal } from '../adds/directory'
import { serverExchange } from '../adds/locator'
import { firstAddress, resolveName } from '../dns/resolver'
import type { AccessToken } from '../files/acl'
import { RDP_PORT, rdsServerOf } from './state'

export interface RdpInput {
  /** Ordinateur distant (nom ou adresse IP). */
  computer: string
  /** Compte : LAB\jdupont, jdupont@lab.local ou SRV1\Administrateur. */
  user: string
  password: string
  /** Programme RemoteApp (alias) au lieu du bureau complet. */
  app?: string | null
}

export interface RdpOutcome {
  state: LabState
  trace: PacketTrace
  ok: boolean
  message: string
  /** Identifiant de la session ouverte. */
  sessionId?: number
}

export const RDP_UNREACHABLE =
  'Le Bureau à distance ne peut pas se connecter à l’ordinateur distant pour l’une des raisons suivantes : 1) L’accès à distance au serveur n’est pas activé ; 2) L’ordinateur distant est désactivé ; 3) L’ordinateur distant n’est pas disponible sur le réseau.'
export const RDP_BAD_CREDENTIALS = 'Vos informations d’identification n’ont pas fonctionné.'
export const RDP_DENIED =
  'La connexion a été refusée, car le compte d’utilisateur n’est pas autorisé pour l’ouverture de session à distance.'

function hosts(state: LabState): HostDevice[] {
  return Object.values(state.devices).filter(
    (d): d is HostDevice => (d.kind === 'server' || d.kind === 'client') && d.powered
  )
}

/** Le jeton contient-il l'un des comptes ou groupes (DOMAINE\nom) ? */
function memberOfAny(state: LabState, target: HostDevice, token: AccessToken, principals: string[]): boolean {
  const domain = target.host.domain ? state.domains[target.host.domain] : undefined
  if (!domain) return false
  return principals.some((p) => {
    const found = findPrincipal(domain, p)
    return !!found && token.sids.includes(found.obj.id)
  })
}

export function rdpConnect(state: LabState, clientId: string, input: RdpInput): RdpOutcome {
  const client = state.devices[clientId]
  const traces: PacketTrace[] = []
  const done = (ok: boolean, message: string, next = state, sessionId?: number): RdpOutcome => ({
    state: next,
    trace: concatTraces(`Bureau à distance ${input.computer}`, traces),
    ok,
    message,
    ...(sessionId !== undefined ? { sessionId } : {})
  })
  if (!client || (client.kind !== 'server' && client.kind !== 'client')) return done(false, RDP_UNREACHABLE)

  // Résolution du nom puis connexion TCP 3389
  const name = input.computer.trim()
  let ip: string | null = name
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) {
    const resolution = resolveName(state, clientId, name)
    traces.push(resolution.trace)
    ip = firstAddress(resolution)
  }
  const target = ip
    ? hosts(state).find((h) => h.interfaces.some((i) => effectiveIpv4(i)?.address === ip))
    : undefined
  // Port 3389 : connexions autorisées ET service Services Bureau à distance (TermService) démarré.
  // Arrêté, rien n'écoute : la connexion est refusée avec le message déjà simulé pour un port fermé.
  const listening = !!target && tcpListening(target, RDP_PORT)
  if (!ip) return done(false, RDP_UNREACHABLE)
  const exchange = serverExchange(state, clientId, ip, {
    protocol: 'RDP',
    port: RDP_PORT,
    request: 'RDP Connection Request',
    reply: listening ? 'RDP Connection Confirm' : 'TCP RST',
    fields: [['Ordinateur', name]]
  })
  traces.push(exchange.trace)
  if (!exchange.ok || !target || !listening) return done(false, RDP_UNREACHABLE)

  const audit = (draft: Draft<LabState>, ok: boolean, account: string, detail: string) =>
    logAudited(draft, target.id, 'logon', ok ? 'success' : 'failure', {
      level: ok ? 'information' : 'warning',
      source: 'Security-Auditing',
      eventId: ok ? 4624 : 4625,
      log: 'Sécurité',
      message: ok
        ? `Ouverture de session réussie : ${account}. Type d’ouverture de session : 10 (RemoteInteractive), depuis ${client.name}.`
        : `Échec d’ouverture de session pour ${account}. Type d’ouverture de session : 10 (RemoteInteractive), depuis ${client.name}. ${detail}`
    })
  const failed = (message: string, account: string, detail: string) => {
    const r = transact(state, (draft) => {
      audit(draft, false, account, detail)
      return undefined
    })
    return done(false, message, r.ok ? r.state : state)
  }

  const token = authenticate(state, target, input.user, input.password)
  if (!token)
    return failed(
      RDP_BAD_CREDENTIALS,
      input.user.trim(),
      'Nom d’utilisateur inconnu ou mot de passe incorrect.'
    )

  // Autorisation : administrateurs ; collections de l'hôte de session ; sinon groupe local
  const rds = target.host.features.includes('RDS-RD-Server') ? rdsServerOf(target) : null
  const collections = rds?.collections ?? []
  const allowedCollections = collections.filter((c) => memberOfAny(state, target, token, c.userGroups))
  const authorized =
    token.admin ||
    (collections.length > 0
      ? allowedCollections.length > 0
      : memberOfAny(state, target, token, target.host.remoteDesktop.users))
  const denial = 'L’utilisateur n’a pas reçu le type d’ouverture de session demandé sur cet ordinateur.'
  if (!authorized) return failed(RDP_DENIED, token.account, denial)

  // Programme RemoteApp : publié dans une collection accessible à l'utilisateur
  const alias = input.app?.trim().toLowerCase() || null
  if (alias) {
    const pool = token.admin ? collections : allowedCollections
    if (!pool.some((c) => c.remoteApps.some((a) => a.alias === alias)))
      return failed(
        `Le programme RemoteApp « ${input.app} » n’est pas publié pour ce compte sur ${target.name}.`,
        token.account,
        denial
      )
  }

  const r = transact(state, (draft) => {
    const d = draft.devices[target.id] as Draft<HostDevice>
    const id = nextSeq(draft)
    d.host.remoteSessions.push({ id, account: token.account, from: client.name, app: alias, at: draft.clock })
    audit(draft, true, token.account, '')
    return id
  })
  if (!r.ok) return done(false, r.error.message)
  return done(true, '', r.state, r.value)
}

/** Ferme une session Bureau à distance (déconnexion ou fermeture de session). */
export function rdpDisconnect(state: LabState, deviceId: string, sessionId: number) {
  return transact(state, (draft) => {
    const d = draft.devices[deviceId]
    if (!d || (d.kind !== 'server' && d.kind !== 'client')) return undefined
    d.host.remoteSessions = d.host.remoteSessions.filter((s) => s.id !== sessionId)
    return undefined
  })
}
