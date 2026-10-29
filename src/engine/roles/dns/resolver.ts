/**
 * Résolution DNS : client (suffixes, liste de serveurs), serveur (zones faisant autorité,
 * alias CNAME, redirecteurs, indications de racine) et résolveurs publics d'Internet.
 * Les requêtes et réponses sont acheminées comme de vrais paquets (traçables).
 */
import type { Device, LabState, ServerDevice } from '../../model/schema'

type FirewallDevice = Extract<Device, { kind: 'firewall' }>
import type { DnsRecord, DnsRecordType } from './schema'
import { effectiveIpv4 } from '../../net/addressing'
import { PUBLIC_DNS, PUBLIC_RESOLVERS, ROOT_HINT_IP } from '../../net/internet'
import { isLoopback } from '../../net/ipv4'
import { initialTtl } from '../../net/routing'
import { createContext, sendIp, sourceAddressFor, type SimContext } from '../../sim/forward'
import { createRecorder, type PacketTrace, type PduLayer } from '../../sim/trace'
import { findZoneFor, normalizeName, ptrQueryName, relativeName } from './server'
import { dnsServerOf } from './state'
import { serviceRunning } from '../../services/servicestate'
import { bindReply, runningServer } from '../../services/linuxbind'
import { findUnit } from '../../services/linuxcatalog'
import { isInstalled } from '../../services/linuxpackages'
import { unitStatus } from '../../services/linuxsystem'

/** Types interrogeables : ceux du DNS Windows, plus ceux que les zones Bind9 peuvent porter. */
export type DnsQueryType = DnsRecordType | 'AAAA' | 'MX' | 'TXT'

export interface DnsAnswerRecord {
  name: string
  type: DnsQueryType
  data: string
  ttl: number
}

export type DnsResult =
  | {
      kind: 'answer'
      qname: string
      records: DnsAnswerRecord[]
      authoritative: boolean
      /** Section AUTHORITY (SOA de la zone pour une réponse vide d'un serveur Bind9). */
      authority?: DnsAnswerRecord[]
    }
  | { kind: 'nxdomain'; qname: string; authoritative: boolean; authority?: DnsAnswerRecord[] }
  | { kind: 'servfail'; qname: string; refused?: true }
  | { kind: 'timeout'; qname: string }

const MAX_DEPTH = 5

function dnsLayer(kind: 'Requête' | 'Réponse', qname: string, qtype: string, answer?: string): PduLayer {
  const fields: [string, string][] = [
    ['Type', kind],
    ['Question', `${qname} (${qtype})`]
  ]
  if (answer) fields.push(['Réponse', answer])
  return { layer: 7, name: 'DNS', fields }
}

function udp(src: number, dst: number): PduLayer {
  return {
    layer: 4,
    name: 'UDP',
    fields: [
      ['Port source', String(src)],
      ['Port destination', String(dst)]
    ]
  }
}

function describe(result: DnsResult): string {
  switch (result.kind) {
    case 'answer': {
      const last = result.records[result.records.length - 1]
      return last ? `${last.type} ${last.data}` : 'aucune donnée'
    }
    case 'nxdomain':
      return 'Nom inexistant (NXDOMAIN)'
    case 'servfail':
      return result.refused ? 'Requête refusée (REFUSED)' : 'Échec du serveur (SERVFAIL)'
    case 'timeout':
      return 'pas de réponse'
  }
}

/** Serveur Linux dont named (Bind9) est démarré (v2.9, #240). */
function isBindServer(device: Device | undefined): boolean {
  const unit = findUnit('named')
  return (
    !!device &&
    device.kind === 'server' &&
    device.host.os === 'linux' &&
    device.powered &&
    !!unit &&
    isInstalled(device, 'bind9') &&
    unitStatus(device, unit).active
  )
}

/** Pare-feu pfSense dont le résolveur Unbound est activé (Services > DNS Resolver, v2.10 #245). */
function isPfResolver(device: Device | undefined): device is FirewallDevice {
  return !!device && device.kind === 'firewall' && device.powered && device.pf.dnsResolver.enabled
}

/** Le serveur exécute-t-il le service DNS ? */
function isDnsServer(device: Device | undefined): device is ServerDevice | FirewallDevice {
  if (isBindServer(device) || isPfResolver(device)) return true
  return (
    !!device &&
    device.kind === 'server' &&
    device.powered &&
    device.host.features.includes('DNS') &&
    !!dnsServerOf(device) &&
    // Service « DNS » arrêté (Stop-Service DNS, net stop dns) : le serveur ne répond plus
    serviceRunning(device, 'DNS')
  )
}

/** Rôle DNS installé mais service arrêté (note de la trace). */
function dnsServiceStopped(device: Device | undefined): boolean {
  if (device?.kind === 'server' && device.host.os === 'linux') return isInstalled(device, 'bind9')
  return (
    !!device &&
    device.kind === 'server' &&
    device.host.features.includes('DNS') &&
    !serviceRunning(device, 'DNS')
  )
}

/** Réponse des résolveurs publics (Internet). */
function publicLookup(qname: string, qtype: DnsQueryType): DnsResult {
  const name = normalizeName(qname)
  if (qtype === 'PTR') {
    const ip = name
      .replace(/\.in-addr\.arpa$/, '')
      .split('.')
      .reverse()
      .join('.')
    const host = Object.entries(PUBLIC_DNS).find(([, v]) => v === ip)?.[0]
    return host
      ? {
          kind: 'answer',
          qname: name,
          records: [{ name, type: 'PTR', data: `${host}.`, ttl: 3600 }],
          authoritative: false
        }
      : { kind: 'nxdomain', qname: name, authoritative: false }
  }
  const ip = PUBLIC_DNS[name]
  if (!ip) return { kind: 'nxdomain', qname: name, authoritative: false }
  return {
    kind: 'answer',
    qname: name,
    records: [{ name, type: 'A', data: ip, ttl: 300 }],
    authoritative: false
  }
}

/** Résolution effectuée par un serveur DNS du lab. */
function serverLookup(
  ctx: SimContext,
  server: ServerDevice | FirewallDevice,
  qname: string,
  qtype: DnsQueryType,
  depth: number,
  clientIp = '127.0.0.1'
): DnsResult {
  if (server.kind === 'firewall') return pfLookup(ctx, server, qname, qtype, depth)
  if (isBindServer(server)) return bindLookup(ctx, server, qname, qtype, depth, clientIp)
  const dns = dnsServerOf(server)
  const name = normalizeName(qname)
  if (!dns || depth > MAX_DEPTH) return { kind: 'servfail', qname: name }
  const zone = findZoneFor(dns, name)
  if (zone) {
    const rel = relativeName(zone, name)
    // Noms DNS insensibles à la casse (RFC 4343)
    const records = zone.records.filter((r) => r.name.toLowerCase() === rel)
    const toAnswer = (r: DnsRecord): DnsAnswerRecord => ({ name, type: r.type, data: r.data, ttl: r.ttl })
    const matches = records.filter((r) => r.type === qtype)
    if (matches.length > 0)
      return { kind: 'answer', qname: name, records: matches.map(toAnswer), authoritative: true }
    const cname = records.find((r) => r.type === 'CNAME')
    if (cname && qtype !== 'CNAME') {
      const target = normalizeName(cname.data)
      const next = findZoneFor(dns, target)
        ? serverLookup(ctx, server, target, qtype, depth + 1)
        : recurse(ctx, server, target, qtype, depth + 1)
      if (next.kind === 'answer') return { ...next, qname: name, records: [toAnswer(cname), ...next.records] }
      return next
    }
    return { kind: 'nxdomain', qname: name, authoritative: true }
  }
  return recurse(ctx, server, name, qtype, depth)
}

/**
 * Réponse du résolveur Unbound de pfSense : Host Overrides (réponse locale), puis redirection vers les
 * serveurs DNS généraux (mode forwarding) ou résolution depuis les indications de racine.
 */
function pfLookup(
  ctx: SimContext,
  server: FirewallDevice,
  qname: string,
  qtype: DnsQueryType,
  depth: number
): DnsResult {
  const name = normalizeName(qname)
  if (depth > MAX_DEPTH) return { kind: 'servfail', qname: name }
  const dns = server.pf.dnsResolver
  const local = dns.hostOverrides.filter((o) => (o.host ? `${o.host}.${o.domain}` : o.domain) === name)
  if (local.length > 0)
    return {
      kind: 'answer',
      qname: name,
      authoritative: true,
      records:
        qtype === 'A' ? local.map((o) => ({ name, type: 'A' as const, data: o.address, ttl: 3600 })) : []
    }
  const upstream = dns.forwarding ? server.pf.dnsServers : [ROOT_HINT_IP]
  for (const s of upstream) {
    const r = queryServer(ctx, server.id, s, name, qtype, depth + 1)
    if (r.kind !== 'timeout') return r.kind === 'answer' ? { ...r, authoritative: false } : r
  }
  return { kind: 'servfail', qname: name }
}

const asAnswer = (r: { name: string; type: string; data: string; ttl: number }): DnsAnswerRecord => ({
  name: r.name,
  type: r.type as DnsQueryType,
  data: r.data,
  ttl: r.ttl
})

/** Réponse d'un serveur Bind9 (configuration en vigueur de named, services/linuxbind.ts). */
function bindLookup(
  ctx: SimContext,
  server: ServerDevice,
  qname: string,
  qtype: DnsQueryType,
  depth: number,
  clientIp: string
): DnsResult {
  const name = normalizeName(qname)
  if (depth > MAX_DEPTH) return { kind: 'servfail', qname: name }
  const reply = bindReply(runningServer(server), name, qtype, clientIp)
  const upstream = (servers: string[], only: boolean): DnsResult => {
    for (const s of servers) {
      const r = queryServer(ctx, server.id, s, name, qtype, depth + 1)
      if (r.kind !== 'timeout') return r.kind === 'answer' ? { ...r, authoritative: false } : r
    }
    if (!only) {
      const r = queryServer(ctx, server.id, ROOT_HINT_IP, name, qtype, depth + 1)
      if (r.kind !== 'timeout') return r.kind === 'answer' ? { ...r, authoritative: false } : r
    }
    return { kind: 'servfail', qname: name }
  }
  switch (reply.kind) {
    case 'answer':
      return {
        kind: 'answer',
        qname: name,
        authoritative: reply.authoritative,
        ...(reply.authority ? { authority: reply.authority.map(asAnswer) } : {}),
        records: reply.records.map((r) => ({
          name: r.name,
          type: r.type as DnsQueryType,
          data: r.data,
          ttl: r.ttl
        }))
      }
    case 'nxdomain':
      return { kind: 'nxdomain', qname: name, authoritative: true, authority: reply.authority.map(asAnswer) }
    case 'servfail':
      return { kind: 'servfail', qname: name }
    case 'refused':
      return { kind: 'servfail', qname: name, refused: true }
    case 'forward':
      return upstream(reply.servers, reply.only)
    case 'recurse':
      return upstream([], false)
  }
}

/** Résolution récursive : redirecteurs puis indications de racine. */
function recurse(
  ctx: SimContext,
  server: ServerDevice,
  qname: string,
  qtype: DnsQueryType,
  depth: number
): DnsResult {
  const dns = dnsServerOf(server)
  if (!dns) return { kind: 'servfail', qname }
  for (const forwarder of dns.forwarders) {
    const r = queryServer(ctx, server.id, forwarder, qname, qtype, depth + 1)
    if (r.kind !== 'timeout') return r.kind === 'answer' ? { ...r, authoritative: false } : r
  }
  if (dns.useRootHints) {
    const r = queryServer(ctx, server.id, ROOT_HINT_IP, qname, qtype, depth + 1)
    if (r.kind !== 'timeout') return r.kind === 'answer' ? { ...r, authoritative: false } : r
  }
  return { kind: 'servfail', qname }
}

/**
 * Envoie une requête DNS de `fromId` vers le serveur `serverIp` et attend la réponse.
 * 127.0.0.1 ou une adresse locale : le service DNS de l'ordinateur répond sans passer par le réseau.
 */
export function queryServer(
  ctx: SimContext,
  fromId: string,
  serverIp: string,
  qname: string,
  qtype: DnsQueryType,
  depth = 0
): DnsResult {
  const name = normalizeName(qname)
  const from = ctx.state.devices[fromId]
  if (!from || depth > MAX_DEPTH) return { kind: 'servfail', qname: name }
  const local = isLoopback(serverIp) || from.interfaces.some((i) => effectiveIpv4(i)?.address === serverIp)
  if (local)
    return isDnsServer(from) ? serverLookup(ctx, from, name, qtype, depth) : { kind: 'timeout', qname: name }

  const srcIp = sourceAddressFor(ctx.state, from, serverIp)
  if (!srcIp) return { kind: 'timeout', qname: name }
  const request = sendIp(ctx, fromId, {
    src: srcIp,
    dst: serverIp,
    ttl: initialTtl(from),
    protocol: 'DNS',
    ipProtocol: '17 (UDP)',
    summary: `DNS requête ${qtype} ${name}`,
    upper: [udp(49152, 53), dnsLayer('Requête', name, qtype)]
  })
  if (request.kind !== 'delivered') return { kind: 'timeout', qname: name }
  const responder = ctx.state.devices[request.deviceId]
  let result: DnsResult
  if (responder?.kind === 'cloud') {
    result =
      PUBLIC_RESOLVERS.includes(serverIp) || serverIp === ROOT_HINT_IP
        ? publicLookup(name, qtype)
        : { kind: 'timeout', qname: name }
  } else if (isDnsServer(responder)) {
    result = serverLookup(ctx, responder, name, qtype, depth, request.src)
  } else {
    const last = ctx.rec.events[ctx.rec.events.length - 1]
    if (last) {
      last.outcome = 'dropped'
      last.note = dnsServiceStopped(responder)
        ? `Le service Serveur DNS de ${responder?.name ?? '?'} est arrêté : la requête reste sans réponse.`
        : `${responder?.name ?? '?'} n’exécute pas de service DNS : la requête reste sans réponse.`
    }
    return { kind: 'timeout', qname: name }
  }
  if (result.kind === 'timeout' || !responder) return result
  const reply = sendIp(ctx, responder.id, {
    src: serverIp,
    // Adresse vue par le serveur (traduite par un NAT éventuel)
    dst: request.src,
    ttl: initialTtl(responder),
    protocol: 'DNS',
    ipProtocol: '17 (UDP)',
    summary: `DNS réponse ${name} : ${describe(result)}`,
    reply: true,
    upper: [udp(53, 49152), dnsLayer('Réponse', name, qtype, describe(result))]
  })
  if (reply.kind !== 'delivered') return { kind: 'timeout', qname: name }
  return result
}

/** Serveurs DNS configurés sur l'ordinateur (première carte qui en possède). */
export function dnsServersOf(device: Device): string[] {
  if (device.kind === 'firewall') return device.pf.dnsServers
  for (const iface of device.interfaces) {
    const eff = effectiveIpv4(iface)
    if (eff && eff.dnsServers.length > 0) return eff.dnsServers
  }
  return []
}

/** Suffixes de recherche (suffixe principal du domaine, suffixe de connexion DHCP). */
export function searchSuffixes(device: Device): string[] {
  const suffixes: string[] = []
  if (device.kind === 'server' || device.kind === 'client') {
    if (device.host.domain) suffixes.push(device.host.domain)
  }
  for (const iface of device.interfaces) {
    const s = iface.addressing === 'dhcp' ? iface.dhcpLease?.dnsSuffix : null
    if (s && !suffixes.includes(s)) suffixes.push(s)
  }
  return suffixes
}

export interface Resolution {
  result: DnsResult
  /** Serveur DNS ayant répondu (ou dernier interrogé). */
  server: string | null
  trace: PacketTrace
  /** Nom effectivement interrogé (avec suffixe). */
  fqdn: string
}

/** Résolution de nom par le client DNS de l'ordinateur. */
export function resolveName(
  state: LabState,
  clientId: string,
  name: string,
  qtype: DnsQueryType = 'A',
  serverOverride?: string
): Resolution {
  const rec = createRecorder()
  const ctx = createContext(state, rec)
  const device = state.devices[clientId]
  const trace = (fqdn: string): PacketTrace => ({ title: `DNS ${fqdn}`, events: rec.events })
  const clean = normalizeName(name)
  if (!device)
    return { result: { kind: 'servfail', qname: clean }, server: null, trace: trace(clean), fqdn: clean }
  const servers = serverOverride ? [serverOverride] : dnsServersOf(device)
  const candidates =
    qtype === 'PTR' || clean.includes('.')
      ? [clean]
      : [...searchSuffixes(device).map((s) => `${clean}.${s}`), clean]
  let last: Resolution = {
    result: { kind: 'timeout', qname: clean },
    server: servers[0] ?? null,
    trace: trace(clean),
    fqdn: clean
  }
  for (const candidate of candidates) {
    let answered = false
    for (const server of servers) {
      const result = queryServer(ctx, clientId, server, candidate, qtype)
      last = { result, server, trace: trace(candidate), fqdn: candidate }
      if (result.kind === 'timeout') continue
      answered = true
      if (result.kind === 'answer') return last
      break
    }
    if (!answered) break
  }
  return { ...last, trace: trace(last.fqdn) }
}

/** Résolution inverse d'une adresse IP (PTR). */
export function reverseLookup(
  state: LabState,
  clientId: string,
  ip: string,
  serverOverride?: string
): Resolution {
  return resolveName(state, clientId, ptrQueryName(ip), 'PTR', serverOverride)
}

/** Adresse IPv4 d'un nom (première réponse A). */
export function firstAddress(resolution: Resolution): string | null {
  if (resolution.result.kind !== 'answer') return null
  return resolution.result.records.find((r) => r.type === 'A')?.data ?? null
}
