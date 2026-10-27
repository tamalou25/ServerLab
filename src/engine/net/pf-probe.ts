/**
 * Sonde de joignabilité à travers le moteur de paquets (v2.10, #248) : un échange TCP / UDP ou un
 * ping est acheminé comme un vrai paquet (routage, filtrage et NAT du pare-feu pfSense, pare-feu des
 * ordinateurs) sans modifier l'état. Sert aux critères de lab (`pfReachable`) et aux pannes du mode
 * panne (domaine `pare-feu`) : les deux jugent donc le fonctionnement sur le même test que l'élève
 * peut refaire avec `ping`, `curl` ou `Test-NetConnection`.
 *
 * Pour TCP / UDP, la destination doit aussi écouter sur le port visé (après une éventuelle
 * redirection de port) : un serveur web arrêté ne répond pas, comme un vrai.
 */
import type { LabState } from '../model/schema'
import { listeningPorts } from '../services/listening'
import { createContext, sendIp, sourceAddressFor } from '../sim/forward'
import { createRecorder } from '../sim/trace'
import { effectiveIpv4 } from './addressing'
import { initialTtl } from './routing'
import { ping } from './diagnostics'

export type PfProbeProtocol = 'icmp' | 'tcp' | 'udp'

/** Port visé après la traduction d'une redirection (effet `pf-state` « pub:port → cible:port »). */
function translatedPort(
  effects: readonly { kind: string; data: Record<string, unknown> }[],
  owns: (address: string) => boolean
): number | null {
  for (const e of effects) {
    if (e.kind !== 'pf-state') continue
    const m = /→ ([\d.]+):(\d+)$/.exec(String(e.data['translation'] ?? ''))
    if (m && owns(m[1] ?? '')) return Number(m[2])
  }
  return null
}

/** `fromId` joint-il `dstIp` (ping, ou échange TCP / UDP sur `port`) et la réponse revient-elle ? */
export function pfProbe(
  state: LabState,
  fromId: string,
  dstIp: string,
  protocol: PfProbeProtocol,
  port?: number
): boolean {
  if (protocol === 'icmp') {
    const r = ping(state, fromId, dstIp, { count: 1 })
    return r.ok && r.value.success
  }
  if (port === undefined) return false
  const from = state.devices[fromId]
  const src = from ? sourceAddressFor(state, from, dstIp) : null
  if (!from || !src) return false
  const rec = createRecorder()
  const ctx = createContext(state, rec)
  const transport = protocol === 'tcp' ? 'TCP' : 'UDP'
  const ipProtocol = protocol === 'tcp' ? '6 (TCP)' : '17 (UDP)'
  const layers = (message: string) => [
    {
      layer: 4 as const,
      name: transport,
      fields: [['Port destination', String(port)]] as [string, string][]
    },
    { layer: 7 as const, name: 'Application', fields: [['Message', message]] as [string, string][] }
  ]
  const req = sendIp(ctx, fromId, {
    src,
    dst: dstIp,
    ttl: initialTtl(from),
    protocol: 'HTTP',
    ipProtocol,
    summary: `Sonde ${transport} ${dstIp}:${port}`,
    upper: layers(`Sonde ${transport} ${dstIp}:${port}`),
    transport,
    port
  })
  if (req.kind !== 'delivered') return false
  const target = state.devices[req.deviceId]
  if (!target) return false
  // Un ordinateur doit écouter sur le port (traduit par une redirection) ; un pare-feu : pas d'information
  if (target.kind === 'server' || target.kind === 'client') {
    const wanted =
      translatedPort(ctx.effects, (a) => target.interfaces.some((i) => effectiveIpv4(i)?.address === a)) ??
      port
    if (!listeningPorts(target).some((p) => p.protocol === transport && p.port === wanted)) return false
  }
  const rep = sendIp(ctx, target.id, {
    src: dstIp,
    dst: req.src,
    ttl: initialTtl(target),
    protocol: 'HTTP',
    ipProtocol,
    summary: `Réponse ${transport} ${dstIp}:${port}`,
    upper: layers(`Réponse ${transport} ${dstIp}:${port}`),
    transport,
    reply: true
  })
  return rep.kind === 'delivered'
}
