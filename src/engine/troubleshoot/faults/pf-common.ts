/**
 * Socle des pannes du pare-feu pfSense (v2.10, #248, domaine `pare-feu`). Une panne casse et répare avec les
 * commandes nommées `pf.*` (celles de l'interface web et de la console du pare-feu). Le symptôme est lu
 * par la sonde de joignabilité `pfProbe` (le moteur de paquets, filtrage et NAT compris : ce que montrent
 * `ping` et `curl`), jamais par un texte : aucune sortie nouvelle.
 *
 * Paramètres communs : `device` (le pare-feu, acteur), `service` (détail de la cible, pour écarter les
 * tirages qui agissent deux fois sur la même chose), `from` / `dst` / `proto` / `port` (la sonde).
 */
import type { PfIfaceKey, PfRule } from '../../model/firewall'
import type { Device, HostDevice, LabState } from '../../model/schema'
import { effectiveIpv4 } from '../../net/addressing'
import { inNetwork } from '../../net/ipv4'
import { endpointMatches, nicOf, type PfDevice } from '../../net/pf'
import { pfProbe, type PfProbeProtocol } from '../../net/pf-probe'
import { listeningPorts } from '../../services/listening'
import type { FaultTargetParams } from '../types'

/** Pare-feux pfSense allumés du lab. */
export const firewalls = (state: LabState): PfDevice[] =>
  Object.values(state.devices).filter((d): d is PfDevice => d.kind === 'firewall' && d.powered)

/** Pare-feu d'un identifiant (undefined : absent ou autre équipement). */
export function firewallOf(state: LabState, id: unknown): PfDevice | undefined {
  const d: Device | undefined = state.devices[String(id)]
  return d?.kind === 'firewall' ? d : undefined
}

/** Postes et serveurs allumés qui ont une adresse. */
export const hostsWithIp = (state: LabState): { host: HostDevice; ip: string }[] =>
  Object.values(state.devices).flatMap((d) => {
    if ((d.kind !== 'client' && d.kind !== 'server') || !d.powered) return []
    for (const i of d.interfaces) {
      const eff = effectiveIpv4(i)
      if (eff) return [{ host: d, ip: eff.address }]
    }
    return []
  })

/** Zone d'une adresse vue du pare-feu : LAN, DMZ (opt1) ou « wan » (tout ce qui est au-delà du WAN). */
export function zoneOf(fw: PfDevice, ip: string): PfIfaceKey {
  for (const key of ['lan', 'opt1'] as const) {
    const nic = nicOf(fw, key)
    const eff = nic ? effectiveIpv4(nic) : null
    if (eff && inNetwork(ip, eff.address, eff.prefixLength)) return key
  }
  return 'wan'
}

/** Adresse de l'interface WAN du pare-feu. */
export function wanAddress(fw: PfDevice): string | null {
  const nic = nicOf(fw, 'wan')
  return nic ? (effectiveIpv4(nic)?.address ?? null) : null
}

/** Adresse libre proche de `ip` (même /24, de .250 vers le bas) : aucune carte du lab ne la porte. */
export function unusedNear(state: LabState, ip: string): string | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  const used = new Set(
    Object.values(state.devices).flatMap((d) => d.interfaces.map((i) => effectiveIpv4(i)?.address ?? ''))
  )
  for (let last = 250; last >= 200; last--) {
    const candidate = `${parts[0]}.${parts[1]}.${parts[2]}.${last}`
    if (!used.has(candidate)) return candidate
  }
  return null
}

// --- Sonde ---------------------------------------------------------------------------------------

/** Test de joignabilité d'une panne : qui émet, vers quelle adresse, quel protocole. */
export interface Probe {
  from: string
  dst: string
  protocol: PfProbeProtocol
  port?: number
}

/** Paramètres de sonde d'une cible (clés `from`, `dst`, `proto`, `port`, `fromName`, `dstName`). */
export function probeParams(state: LabState, probe: Probe, dstName?: string): FaultTargetParams {
  return {
    from: probe.from,
    fromName: state.devices[probe.from]?.name ?? 'un poste',
    dst: probe.dst,
    dstName: dstName ?? probe.dst,
    proto: probe.protocol,
    port: probe.port ?? 0
  }
}

export function probeOf(p: FaultTargetParams): Probe {
  return {
    from: String(p['from']),
    dst: String(p['dst']),
    protocol: String(p['proto']) as PfProbeProtocol,
    ...(Number(p['port']) > 0 ? { port: Number(p['port']) } : {})
  }
}

/** La sonde de la cible aboutit-elle ? */
export const probeWorks = (state: LabState, p: FaultTargetParams): boolean => {
  const probe = probeOf(p)
  return pfProbe(state, probe.from, probe.dst, probe.protocol, probe.port)
}

/** « le ping vers INTERNET », « une connexion TCP 80 vers WEB1 ». */
export function describeProbe(p: FaultTargetParams): string {
  const to = String(p['dstName'])
  return p['proto'] === 'icmp'
    ? `le ping vers ${to}`
    : `une connexion ${String(p['proto']).toUpperCase()} ${String(p['port'])} vers ${to}`
}

/** « PC1 → INTERNET (ping) » pour les indices. */
export function describeFlow(p: FaultTargetParams): string {
  const what = p['proto'] === 'icmp' ? 'ping' : `${String(p['proto']).toUpperCase()} ${String(p['port'])}`
  return `${String(p['fromName'])} vers ${String(p['dstName'])} (${what})`
}

/** Première sonde qui aboutit dans l'état sain, parmi des candidats. */
export function firstWorking(state: LabState, candidates: Probe[]): Probe | null {
  return candidates.find((c) => pfProbe(state, c.from, c.dst, c.protocol, c.port)) ?? null
}

/** Premier port en écoute du protocole sur la machine visée (règle sans port). */
function listeningPort(host: HostDevice, protocol: 'tcp' | 'udp'): number | undefined {
  const wanted = protocol === 'tcp' ? 'TCP' : 'UDP'
  return listeningPorts(host).find((p) => p.protocol === wanted)?.port
}

/** Ordinateurs allumés qui correspondent à un point de terminaison de règle. */
function endpointHosts(
  state: LabState,
  fw: PfDevice,
  endpoint: PfRule['source']
): { host: HostDevice; ip: string }[] {
  return hostsWithIp(state).filter((h) => endpointMatches(fw, endpoint, h.ip))
}

/**
 * Sonde qui exerce une règle Pass : un ordinateur de la zone de la règle vers un ordinateur d'une autre zone
 * qu'elle autorise (le premier couple qui aboutit dans l'état sain). Une règle du WAN est exercée par la
 * redirection de port qui l'a créée. Null : règle sans ordinateur à tester.
 */
export function ruleProbe(state: LabState, fw: PfDevice, rule: PfRule): Probe | null {
  if (rule.action !== 'pass' || rule.disabled) return null
  if (rule.iface === 'wan') {
    const fwd = fw.pf.nat.portForwards.find((f) => f.ruleId === rule.id)
    const wan = wanAddress(fw)
    if (!fwd || fwd.disabled || !fwd.destinationPort || !wan) return null
    return firstWorking(
      state,
      hostsWithIp(state)
        .filter((h) => zoneOf(fw, h.ip) === 'wan')
        .map((h) => ({
          from: h.host.id,
          dst: wan,
          protocol: fwd.protocol === 'udp' ? ('udp' as const) : ('tcp' as const),
          port: fwd.destinationPort!.from
        }))
    )
  }
  const sources = endpointHosts(state, fw, rule.source).filter((h) => zoneOf(fw, h.ip) === rule.iface)
  const targets = endpointHosts(state, fw, rule.destination).filter((h) => zoneOf(fw, h.ip) !== rule.iface)
  const candidates: Probe[] = []
  for (const s of sources)
    for (const t of targets) {
      const base = { from: s.host.id, dst: t.ip }
      if (rule.protocol === 'icmp' || rule.protocol === 'any') {
        candidates.push({ ...base, protocol: 'icmp' })
        continue
      }
      const protocol = rule.protocol === 'udp' ? 'udp' : 'tcp'
      const port = rule.destinationPort?.from ?? listeningPort(t.host, protocol)
      if (port !== undefined) candidates.push({ ...base, protocol, port })
    }
  return firstWorking(state, candidates)
}

/** Paramètres d'une panne sur une règle : pare-feu, règle, sonde. */
export function ruleTarget(state: LabState, fw: PfDevice, rule: PfRule): FaultTargetParams | null {
  const probe = ruleProbe(state, fw, rule)
  if (!probe) return null
  const dstName = hostsWithIp(state).find((h) => h.ip === probe.dst)?.host.name
  return {
    device: fw.id,
    service: `rule:${rule.id}`,
    rule: rule.id,
    ...probeParams(state, probe, dstName ?? (rule.iface === 'wan' ? `l’adresse WAN ${probe.dst}` : probe.dst))
  }
}

/** Description lisible d'une règle dans les causes (« Mises à jour HTTP » ou son identifiant). */
export const ruleName = (rule: PfRule | undefined, id: unknown): string =>
  rule?.descr ? `« ${rule.descr} »` : `(${String(id)})`
