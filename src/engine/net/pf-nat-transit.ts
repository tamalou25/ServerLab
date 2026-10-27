/**
 * Traduction d'adresses d'un pare-feu pfSense CE 2.7 sur le transit des paquets (v2.10, #244) :
 * redirections de port (destination traduite AVANT le filtrage), NAT sortant (source traduite à la
 * sortie, après le routage) et retraduction des réponses. Les traductions sont visibles dans la trace
 * et inscrites dans la table d'états (effet `pf-nat`, appliqué par `applyPfEffects`).
 * Les ports sources ne sont pas modélisés (docs/fidelite.md, P-17 et P-23).
 */
import type { Device, LabState } from '../model/schema'
import type { PfIfaceKey, PfOutboundNat, PfState } from '../model/firewall'
import { effectiveIpv4 } from './addressing'
import { inNetwork, networkAddress } from './ipv4'
import { assignmentOfNic, describeEndpoint, endpointMatches, nicOf, type PfDevice } from './pf'
import { natOutKey, rdrBackKey, rdrKey, rdrTextKey } from './pf-nat'
import type { TransitHooks } from '../sim/transit'

// `pfctl -d` arrête aussi le NAT (docs.netgate.com, « Locked out of the GUI »)
const isPf = (device: Device): device is PfDevice =>
  device.kind === 'firewall' && device.powered && !device.pf.filterDisabled

const ifaceLabel = (pf: PfState, key: PfIfaceKey): string =>
  pf.assignments.find((a) => a.key === key)?.descr ?? key.toUpperCase()

/** Adresse IPv4 d'une interface logique du pare-feu. */
const addressOf = (device: PfDevice, key: PfIfaceKey): string | null => {
  const nic = nicOf(device, key)
  return nic ? (effectiveIpv4(nic)?.address ?? null) : null
}

/** Règle de NAT sortant qui s'applique (manuelle d'abord, puis automatique), ou null. */
function outboundMatch(
  device: PfDevice,
  egress: PfIfaceKey,
  packet: { src: string; dst: string }
): { pub: string; origin: string } | null {
  const pf = device.pf
  const mode = pf.nat.outboundMode
  if (mode === 'disabled') return null
  if (mode === 'manual' || mode === 'hybrid') {
    const rule = pf.nat.outbound.find(
      (r: PfOutboundNat) =>
        !r.disabled &&
        r.iface === egress &&
        endpointMatches(device, r.source, packet.src) &&
        endpointMatches(device, r.destination, packet.dst)
    )
    if (rule) {
      const pub = rule.translation ?? addressOf(device, egress)
      if (pub)
        return {
          pub,
          origin: `règle manuelle${rule.descr ? ` « ${rule.descr} »` : ` (${rule.id})`}, source ${describeEndpoint(pf, rule.source)}`
        }
    }
    if (mode === 'manual') return null
  }
  // Automatique : le réseau de chaque interface interne est traduit en adresse du WAN
  if (egress !== 'wan') return null
  const pub = addressOf(device, 'wan')
  if (!pub) return null
  for (const a of pf.assignments) {
    if (a.key === 'wan' || !a.enabled) continue
    const nic = nicOf(device, a.key)
    const eff = nic ? effectiveIpv4(nic) : null
    if (eff && inNetwork(packet.src, networkAddress(eff.address, eff.prefixLength), eff.prefixLength))
      return { pub, origin: `automatique, réseau ${a.descr}` }
  }
  return null
}

export const pfNatTransitHooks: TransitHooks = {
  redirect(ctx, device, ingressIfaceId, packet) {
    if (!isPf(device) || ingressIfaceId === null || packet.reply || packet.dstPort === undefined) return null
    if (packet.protocol !== 'tcp' && packet.protocol !== 'udp') return null
    const key = assignmentOfNic(device.pf, ingressIfaceId)?.key
    if (!key) return null
    for (const fwd of device.pf.nat.portForwards) {
      const range = fwd.destinationPort
      if (fwd.disabled || fwd.iface !== key || !range) continue
      if (fwd.protocol !== 'tcp/udp' && fwd.protocol !== packet.protocol) continue
      if (packet.dstPort < range.from || packet.dstPort > range.to) continue
      if (!endpointMatches(device, fwd.destination, packet.dst)) continue
      const dstPort = (fwd.targetPort ?? range.from) + (packet.dstPort - range.from)
      const text = `${packet.dst}:${packet.dstPort} → ${fwd.targetAddress}:${dstPort}`
      ctx.nat.set(rdrKey(device.id, packet.src, fwd.targetAddress), packet.dst)
      ctx.nat.set(rdrBackKey(device.id, packet.src, packet.dst), fwd.targetAddress)
      ctx.nat.set(rdrTextKey(device.id, packet.src, fwd.targetAddress), text)
      return {
        dst: fwd.targetAddress,
        dstPort,
        note: `${device.name} (pfSense) : la redirection de port${fwd.descr ? ` « ${fwd.descr} »` : ` (${fwd.id})`} de ${ifaceLabel(device.pf, key)} traduit la destination ${packet.dst}:${packet.dstPort} en ${fwd.targetAddress}:${dstPort} (NAT, avant le filtrage).`
      }
    }
    return null
  },

  translate(ctx, device, ingressIfaceId, egressIfaceId, packet) {
    if (!isPf(device) || ingressIfaceId === egressIfaceId) return null
    const egress = assignmentOfNic(device.pf, egressIfaceId)?.key
    if (!egress) return null
    // Réponse d'une connexion redirigée : la source redevient l'adresse publique visée par le client
    const pub = ctx.nat.get(rdrKey(device.id, packet.dst, packet.src))
    const known = pub ?? (ctx.nat.has(rdrBackKey(device.id, packet.dst, packet.src)) ? packet.src : null)
    if (known)
      return {
        src: known,
        note: `${device.name} (pfSense) : la réponse part avec la source ${known}, adresse visée par le client (redirection de port).`
      }
    const match = outboundMatch(device, egress, packet)
    if (!match || match.pub === packet.src) return null
    ctx.nat.set(natOutKey(device.id, match.pub, packet.dst), packet.src)
    ctx.effects.push({
      kind: 'pf-nat',
      deviceId: device.id,
      data: { src: packet.src, dst: packet.dst, translation: `${packet.src} → ${match.pub}` }
    })
    return {
      src: match.pub,
      note: `${device.name} (pfSense, NAT sortant ${match.origin}) traduit l’adresse source ${packet.src} en ${match.pub} sur ${ifaceLabel(device.pf, egress)}.`
    }
  },

  untranslate(ctx, device, packet) {
    if (!isPf(device)) return null
    const original = ctx.nat.get(natOutKey(device.id, packet.dst, packet.src))
    if (!original) return null
    return {
      dst: original,
      note: `${device.name} (pfSense, NAT sortant) retraduit l’adresse de destination ${packet.dst} en ${original} d’après la table d’états et transmet la réponse.`
    }
  }
}

/**
 * Cible d'une redirection de port pour une connexion TCP vers `dstIp:port` (adresse d'une interface d'un
 * pare-feu pfSense) : adresse et port de la machine interne, ou null si aucune redirection active ne
 * correspond. Même choix que le crochet `redirect` du transit (première redirection qui correspond) ; sert
 * aux clients applicatifs (curl, navigateur) pour savoir quel serveur répond derrière le NAT.
 */
export function pfRedirectTarget(
  state: LabState,
  dstIp: string,
  port: number
): { address: string; port: number } | null {
  for (const device of Object.values(state.devices)) {
    if (!isPf(device) || !device.interfaces.some((i) => effectiveIpv4(i)?.address === dstIp)) continue
    for (const fwd of device.pf.nat.portForwards) {
      const range = fwd.destinationPort
      if (fwd.disabled || !range || fwd.protocol === 'udp') continue
      if (port < range.from || port > range.to) continue
      if (!endpointMatches(device, fwd.destination, dstIp)) continue
      return { address: fwd.targetAddress, port: (fwd.targetPort ?? range.from) + (port - range.from) }
    }
  }
  return null
}
