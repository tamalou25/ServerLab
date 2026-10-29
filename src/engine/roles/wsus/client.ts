/**
 * Côté client de WSUS : un ordinateur dont la stratégie de groupe désigne un serveur intranet
 * (« Spécifier l'emplacement intranet du service de mise à jour ») contacte ce serveur en HTTP
 * (port 8530) et ne reçoit que les mises à jour approuvées pour son groupe d'ordinateurs.
 */
import type { HostDevice, LabState, ServerDevice } from '../../model/schema'
import { effectiveIpv4 } from '../../net/addressing'
import type { PacketTrace } from '../../sim/trace'
import { serviceRunning } from '../../services/servicestate'
import { serverExchange } from '../adds/locator'
import { firstAddress, resolveName } from '../dns/resolver'
import { appliesTo, catalogUpdate, type CatalogUpdate } from './catalog'
import type { WsusServer } from './schema'
import { ALL_COMPUTERS, UNASSIGNED_COMPUTERS, findWsusGroup, wsusServerOf } from './state'

/**
 * Message d'un client dont le serveur WSUS a son service arrêté (v2.8, #222). Code 0x80244022
 * WU_E_PT_HTTP_STATUS_SERVICE_UNAVAIL « Same as HTTP status 503 - the service is temporarily
 * overloaded. » : https://learn.microsoft.com/en-us/windows/deployment/update/windows-update-error-reference
 * Que ce soit ce code que le client reçoit n'est pas sourcé (docs/fidelite.md, « À vérifier »).
 */
export function wsusServiceStoppedMessage(server: string): string {
  return `Le service Service WSUS (WsusService) est arrêté sur ${server} (code 0x80244022, WU_E_PT_HTTP_STATUS_SERVICE_UNAVAIL : équivalent du statut HTTP 503).`
}

/** Port HTTP du service WSUS. */
export const WSUS_HTTP_PORT = 8530

export type WsusClientStatus =
  /** Aucun serveur intranet configuré par stratégie : le poste utilise le service en ligne. */
  | { kind: 'none' }
  /** Serveur configuré mais injoignable (nom, port, réseau ou rôle non configuré). */
  | { kind: 'error'; url: string; message: string; trace: PacketTrace | null }
  | {
      kind: 'ok'
      url: string
      server: ServerDevice
      /** Groupe d'ordinateurs WSUS du poste. */
      group: string
      /** Mises à jour approuvées pour le poste (installables). */
      updates: CatalogUpdate[]
      trace: PacketTrace
    }

function host(state: LabState, id: string): HostDevice | null {
  const d = state.devices[id]
  return d && (d.kind === 'server' || d.kind === 'client') ? d : null
}

/** Analyse « http://srv1.lab.local:8530 » (null si l'URL n'est pas une URL HTTP). */
export function parseWsusUrl(url: string): { scheme: string; host: string; port: number } | null {
  const m = /^(https?):\/\/([^/:\s]+)(?::(\d+))?\/?$/i.exec(url.trim())
  if (!m) return null
  const scheme = (m[1] as string).toLowerCase()
  return { scheme, host: m[2] as string, port: m[3] ? Number(m[3]) : scheme === 'https' ? 443 : 80 }
}

/** Groupe WSUS d'un ordinateur sur ce serveur (ciblage côté serveur ou côté client). */
export function computerGroup(wsus: WsusServer, computer: HostDevice): string {
  if (wsus.targeting === 'server')
    return wsus.assignments.find((a) => a.computerId === computer.id)?.group ?? UNASSIGNED_COMPUTERS
  const policy = computer.host.policy.computer?.settings.wuTargetGroup
  const requested = policy?.state === 'Enabled' ? findWsusGroup(wsus, policy.group) : null
  return requested && requested !== ALL_COMPUTERS ? requested : UNASSIGNED_COMPUTERS
}

/** Mises à jour approuvées pour un ordinateur de ce groupe (approbations héritées de la racine). */
export function approvedUpdatesFor(
  wsus: WsusServer,
  group: string,
  kind: 'server' | 'client'
): CatalogUpdate[] {
  const approved = new Set(
    wsus.approvals.filter((a) => a.group === group || a.group === ALL_COMPUTERS).map((a) => a.updateId)
  )
  return wsus.updates
    .filter((id) => approved.has(id) && !wsus.declined.includes(id))
    .flatMap((id) => {
      const update = catalogUpdate(id)
      return update && appliesTo(update, kind) ? [update] : []
    })
}

/** Ordinateur désigné par le nom (DNS) ou l'adresse de l'URL. */
function locate(
  state: LabState,
  client: HostDevice,
  name: string
): { ip: string | null; trace: PacketTrace | null } {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return { ip: name, trace: null }
  const resolution = resolveName(state, client.id, name)
  return { ip: firstAddress(resolution), trace: resolution.trace }
}

/** Situation de Windows Update sur un ordinateur (stratégie appliquée, serveur joint, groupe). */
export function wsusClientStatus(state: LabState, clientId: string): WsusClientStatus {
  const client = host(state, clientId)
  const policy = client?.host.policy.computer?.settings.wuServer
  if (!client || policy?.state !== 'Enabled' || !policy.url.trim()) return { kind: 'none' }
  const url = policy.url.trim()
  const error = (message: string, trace: PacketTrace | null = null): WsusClientStatus => ({
    kind: 'error',
    url,
    message,
    trace
  })
  const parsed = parseWsusUrl(url)
  if (!parsed) return error(`L’adresse « ${url} » n’est pas une URL valide (http://serveur:8530).`)
  const { ip, trace: dnsTrace } = locate(state, client, parsed.host)
  if (!ip) return error(`Le nom « ${parsed.host} » n’a pas pu être résolu.`, dnsTrace)
  const server = Object.values(state.devices).find(
    (d): d is ServerDevice =>
      d.kind === 'server' && d.powered && d.interfaces.some((i) => effectiveIpv4(i)?.address === ip)
  )
  const wsus = server?.host.features.includes('UpdateServices') ? wsusServerOf(server) : null
  const listening = !!wsus?.configured && parsed.scheme === 'http' && parsed.port === WSUS_HTTP_PORT
  const exchange = serverExchange(state, client.id, ip, {
    protocol: 'HTTP',
    port: parsed.port,
    request: 'POST /ClientWebService/client.asmx',
    reply: listening ? 'HTTP/1.1 200 OK' : 'TCP RST',
    fields: [['Hôte', `${parsed.host}:${parsed.port}`]]
  })
  if (!exchange.ok) return error(`Le serveur ${parsed.host} est injoignable sur le réseau.`, exchange.trace)
  if (!server || !wsus || !listening)
    return error(
      `Aucun service WSUS ne répond sur ${parsed.host}:${parsed.port} (code 0x80072EFD : impossible d’établir une connexion avec le serveur).`,
      exchange.trace
    )
  // Service WSUS (WsusService) arrêté : le client ne remonte plus (v2.8, #222)
  if (!serviceRunning(server, 'WsusService'))
    return error(wsusServiceStoppedMessage(server.name), exchange.trace)
  const group = computerGroup(wsus, client)
  return {
    kind: 'ok',
    url,
    server,
    group,
    updates: approvedUpdatesFor(wsus, group, client.kind),
    trace: exchange.trace
  }
}

/** Ordinateur connu d'un serveur WSUS (il le contacte par sa stratégie). */
export interface WsusComputer {
  deviceId: string
  name: string
  ip: string
  kind: 'server' | 'client'
  group: string
}

/** Ordinateurs qui contactent ce serveur WSUS. */
export function wsusComputers(state: LabState, serverId: string): WsusComputer[] {
  const list: WsusComputer[] = []
  for (const d of Object.values(state.devices)) {
    if ((d.kind !== 'server' && d.kind !== 'client') || !d.powered) continue
    const status = wsusClientStatus(state, d.id)
    if (status.kind !== 'ok' || status.server.id !== serverId) continue
    const ip = d.interfaces.map((i) => effectiveIpv4(i)?.address).find((a) => !!a) ?? ''
    list.push({
      deviceId: d.id,
      name: d.host.domain ? `${d.name}.${d.host.domain}`.toLowerCase() : d.name.toLowerCase(),
      ip,
      kind: d.kind,
      group: status.group
    })
  }
  return list.sort((a, b) => a.name.localeCompare(b.name))
}
