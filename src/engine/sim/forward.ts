/**
 * Moteur d'acheminement : résolution ARP et transfert IP saut par saut.
 * Chaque trame produite est enregistrée dans la trace (mode Simulation).
 */
import type { Device, LabState, NetInterface } from '../model/schema'
import { effectiveIpv4 } from '../net/addressing'
import { isInternetHost } from '../net/internet'
import { initialTtl, lookupRoute, routingTable } from '../net/routing'
import { evaluateFirewall, PROFILE_LABELS, type FirewallTransport } from '../services/firewall'
import { roleModules } from '../roles/registry'
import { iosL2Inspect, iosTransitHooks } from '../ios/registry'
import { pfTransitHooks } from '../net/pf'
import { pfNatTransitHooks } from '../net/pf-nat-transit'
import type { FilterPacket, TransitHooks } from './transit'
import { l2Segment, reversePath, type PortRef, type SegmentMember } from '../net/segment'
import {
  BROADCAST_MAC,
  ethernetLayer,
  ipv4Layer,
  taggedLayers,
  type PduEvent,
  type PduLayer,
  type PduOutcome,
  type Protocol,
  type TraceEffect,
  type TraceRecorder
} from './trace'

/** Contexte de calcul : état (lecture seule), trace et cache ARP de l'opération. */
export interface SimContext {
  state: LabState
  rec: TraceRecorder
  /** Cache ARP par équipement : IP → port qui la porte. */
  arp: Map<string, Map<string, SegmentMember>>
  /** Traductions d'adresses (NAT) établies pendant l'opération. */
  nat: Map<string, string>
  /** Effets durables de l'opération (traductions NAT, compteurs d'ACL…). */
  effects: TraceEffect[]
}

export function createContext(state: LabState, rec: TraceRecorder): SimContext {
  return { state, rec, arp: new Map(), nat: new Map(), effects: [] }
}

function deviceName(ctx: SimContext, id: string): string {
  return ctx.state.devices[id]?.name ?? id
}

function ifaceOf(ctx: SimContext, port: PortRef) {
  return ctx.state.devices[port.deviceId]?.interfaces.find((i) => i.id === port.ifaceId)
}

/** Vrai si l'équipement possède l'adresse IP (cartes actives, hôtes Internet pour le nuage). */
export function ownsAddress(device: Device, ip: string): boolean {
  if (!device.powered) return false
  if (device.kind === 'cloud' && isInternetHost(ip)) return true
  return device.interfaces.some((i) => effectiveIpv4(i)?.address === ip)
}

/** Port de l'équipement portant cette adresse IP. */
export function portWithAddress(device: Device, ip: string): PortRef | null {
  const iface = device.interfaces.find((i) => effectiveIpv4(i)?.address === ip)
  return iface ? { deviceId: device.id, ifaceId: iface.id } : null
}

interface FrameSpec {
  protocol: Protocol
  summary: string
  layers: PduLayer[]
}

/** Précision d'une commutation sur un trunk : la trame repart étiquetée. */
function vlanNote(vlan: number | undefined): string {
  return vlan === undefined ? '' : ` ; sur le trunk, elle est étiquetée 802.1Q VLAN ${vlan}`
}

/**
 * Enregistre une trame unicast le long d'un chemin (à travers les switchs).
 * Renvoie l'index du dernier événement (arrivée sur la destination).
 */
export function recordUnicast(
  ctx: SimContext,
  path: SegmentMember['path'],
  frame: FrameSpec,
  finalOutcome: PduOutcome,
  finalNote: string
): number {
  path.forEach((hop, i) => {
    const last = i === path.length - 1
    const to = ctx.state.devices[hop.to]
    const port = to?.interfaces.find((p) => p.id === hop.toIfaceId)?.name ?? ''
    const next = path[i + 1]
    const outPort = to?.interfaces.find((p) => p.id === next?.fromIfaceId)?.name ?? ''
    ctx.rec.step += 1
    ctx.rec.events.push({
      step: ctx.rec.step,
      protocol: frame.protocol,
      linkId: hop.linkId,
      fromDeviceId: hop.from,
      toDeviceId: hop.to,
      summary: frame.summary,
      layers: taggedLayers(frame.layers, hop.vlan),
      outcome: last ? finalOutcome : 'forwarded',
      note: last
        ? finalNote
        : `${to?.name ?? '?'} reçoit la trame sur ${port} et la commute vers ${outPort} (adresse MAC de destination connue)${vlanNote(next?.vlan)}.`
    })
  })
  return ctx.rec.events.length - 1
}

/** Modifie le devenir du dernier événement enregistré (décision prise à l'arrivée). */
export function setLastOutcome(ctx: SimContext, outcome: PduOutcome, note: string): void {
  const last = ctx.rec.events[ctx.rec.events.length - 1]
  if (last) {
    last.outcome = outcome
    last.note = note
  }
}

/**
 * Diffusion (broadcast) dans le domaine de niveau 2 : la trame est inondée par les switchs.
 * `accept` indique si un membre traite la trame (sinon il l'ignore).
 */
export function recordBroadcast(
  ctx: SimContext,
  origin: PortRef,
  frame: FrameSpec,
  accept: (member: SegmentMember) => { outcome: PduOutcome; note: string }
): SegmentMember[] {
  const members = l2Segment(ctx.state, origin)
  const base = ctx.rec.step
  const seen = new Set<string>()
  let maxDepth = 0
  for (const member of members) {
    member.path.forEach((hop, depth) => {
      const key = `${hop.linkId}>${hop.to}`
      const last = depth === member.path.length - 1
      maxDepth = Math.max(maxDepth, depth + 1)
      if (seen.has(key)) return
      seen.add(key)
      const to = ctx.state.devices[hop.to]
      const decision = last ? accept(member) : null
      const event: PduEvent = {
        step: base + depth + 1,
        protocol: frame.protocol,
        linkId: hop.linkId,
        fromDeviceId: hop.from,
        toDeviceId: hop.to,
        summary: frame.summary,
        layers: taggedLayers(frame.layers, hop.vlan),
        outcome: decision ? decision.outcome : 'forwarded',
        note: decision
          ? decision.note
          : `${to?.name ?? '?'} diffuse la trame (broadcast) sur ses autres ports du même VLAN.`
      }
      ctx.rec.events.push(event)
    })
  }
  ctx.rec.events.sort((a, b) => a.step - b.step)
  ctx.rec.step = base + maxDepth
  return members
}

/** L'adresse IP de la carte est-elle un bail DHCP (entrée de la base du DHCP snooping) ? */
function leasedAddress(iface: NetInterface | undefined, ip: string): boolean {
  return !!iface && iface.addressing === 'dhcp' && iface.dhcpLease?.address === ip
}

/**
 * Résolution ARP de `targetIp` depuis un port. Renvoie le membre du segment qui répond,
 * ou null si personne ne répond.
 */
export function arpResolve(ctx: SimContext, origin: PortRef, targetIp: string): SegmentMember | null {
  let cache = ctx.arp.get(origin.deviceId)
  if (!cache) {
    cache = new Map()
    ctx.arp.set(origin.deviceId, cache)
  }
  const cached = cache.get(targetIp)
  if (cached) return cached

  const srcIface = ifaceOf(ctx, origin)
  const srcIp = srcIface ? (effectiveIpv4(srcIface)?.address ?? '0.0.0.0') : '0.0.0.0'
  const srcMac = srcIface?.mac ?? ''
  const requester = deviceName(ctx, origin.deviceId)
  let responder: SegmentMember | null = null

  const owns = (member: SegmentMember): boolean => {
    const iface = ifaceOf(ctx, member.port)
    if (iface && effectiveIpv4(iface)?.address === targetIp) return true
    // Proxy ARP (serveur VPN répondant pour l'adresse attribuée à un client)
    const device = ctx.state.devices[member.port.deviceId]
    return (
      !!device &&
      transitHooks().some(
        (h) => h.proxyArp?.(ctx.state, device, targetIp) || h.owns?.(ctx.state, device, targetIp)
      )
    )
  }

  recordBroadcast(
    ctx,
    origin,
    {
      protocol: 'ARP',
      summary: `ARP : qui a ${targetIp} ? Répondre à ${srcIp}`,
      layers: [
        ethernetLayer(srcMac, BROADCAST_MAC, 'ARP'),
        {
          layer: 3,
          name: 'ARP',
          fields: [
            ['Opération', '1 (requête)'],
            ['MAC émetteur', srcMac],
            ['IP émetteur', srcIp],
            ['MAC cible', '00-00-00-00-00-00'],
            ['IP cible', targetIp]
          ]
        }
      ]
    },
    (member) => {
      const name = deviceName(ctx, member.port.deviceId)
      if (!responder && owns(member)) {
        // Inspection ARP dynamique : requête d'un émetteur absent de la base du DHCP snooping
        const refused = iosL2Inspect(ctx.state, member.path, {
          kind: 'arp',
          ip: srcIp,
          mac: srcMac,
          leased: leasedAddress(srcIface, srcIp)
        })
        if (refused) return { outcome: 'dropped', note: refused.reason }
        responder = member
        return {
          outcome: 'delivered',
          note: `${name} reconnaît son adresse IP ${targetIp} et prépare une réponse ARP.`
        }
      }
      return {
        outcome: 'ignored',
        note: `${name} ignore la requête ARP : ${targetIp} n’est pas son adresse.`
      }
    }
  )

  const found = responder as SegmentMember | null
  if (!found) return null
  const targetIface = ifaceOf(ctx, found.port)
  const targetMac = targetIface?.mac ?? ''
  const back = reversePath(found.path)
  // Inspection ARP dynamique : la réponse est rejetée par un switch si son couple IP / MAC n'est pas un bail
  const replyLayers = [
    ethernetLayer(targetMac, srcMac, 'ARP'),
    {
      layer: 3 as const,
      name: 'ARP',
      fields: [
        ['Opération', '2 (réponse)'],
        ['MAC émetteur', targetMac],
        ['IP émetteur', targetIp],
        ['MAC cible', srcMac],
        ['IP cible', srcIp]
      ] as [string, string][]
    }
  ]
  const denied = iosL2Inspect(ctx.state, back, {
    kind: 'arp',
    ip: targetIp,
    mac: targetMac,
    leased: leasedAddress(targetIface, targetIp)
  })
  if (denied) {
    recordUnicast(
      ctx,
      back.slice(0, denied.hopIndex + 1),
      { protocol: 'ARP', summary: `ARP : ${targetIp} est à ${targetMac}`, layers: replyLayers },
      'dropped',
      denied.reason
    )
    return null
  }
  recordUnicast(
    ctx,
    back,
    {
      protocol: 'ARP',
      summary: `ARP : ${targetIp} est à ${targetMac}`,
      layers: [
        ethernetLayer(targetMac, srcMac, 'ARP'),
        {
          layer: 3,
          name: 'ARP',
          fields: [
            ['Opération', '2 (réponse)'],
            ['MAC émetteur', targetMac],
            ['IP émetteur', targetIp],
            ['MAC cible', srcMac],
            ['IP cible', srcIp]
          ]
        }
      ]
    },
    'delivered',
    `${requester} enregistre ${targetIp} → ${targetMac} dans son cache ARP.`
  )
  cache.set(targetIp, found)
  // La cible a appris l'adresse du demandeur grâce à la requête : pas de nouvel ARP pour répondre
  if (srcIp !== '0.0.0.0') {
    let targetCache = ctx.arp.get(found.port.deviceId)
    if (!targetCache) {
      targetCache = new Map()
      ctx.arp.set(found.port.deviceId, targetCache)
    }
    if (!targetCache.has(srcIp)) targetCache.set(srcIp, { port: origin, path: back })
  }
  return found
}

export interface IpPacket {
  src: string
  dst: string
  ttl: number
  protocol: Protocol
  /** Nom du protocole IP (champ « Protocole » de l'en-tête). */
  ipProtocol: string
  summary: string
  /** Couches 4 à 7. */
  upper: PduLayer[]
  /** Transport et port de destination (par défaut, d'après le protocole). */
  transport?: FirewallTransport
  port?: number
  /** Réponse à un échange autorisé : les pare-feu à états la laissent passer. */
  reply?: boolean
}

/** Port TCP du tunnel VPN (SSTP). */
export const VPN_PORT = 443

/** Transport et port de destination usuels de chaque protocole applicatif. */
const DEFAULT_PORTS: Partial<Record<Protocol, { transport: FirewallTransport; port: number | null }>> = {
  ICMP: { transport: 'ICMPv4', port: null },
  DNS: { transport: 'UDP', port: 53 },
  DHCP: { transport: 'UDP', port: 67 },
  LDAP: { transport: 'TCP', port: 389 },
  KERBEROS: { transport: 'TCP', port: 88 },
  SMB: { transport: 'TCP', port: 445 },
  HTTP: { transport: 'TCP', port: 80 },
  RDP: { transport: 'TCP', port: 3389 },
  VPN: { transport: 'TCP', port: 443 },
  RADIUS: { transport: 'UDP', port: 1812 }
}

/**
 * Pare-feu de l'hôte émetteur (sortant) ou destinataire (entrant). Les réponses ne sont pas
 * filtrées. Renvoie l'explication du blocage, ou null si le paquet passe.
 */
function firewallBlocks(device: Device, packet: IpPacket, direction: 'Inbound' | 'Outbound'): string | null {
  if (packet.reply || (device.kind !== 'server' && device.kind !== 'client')) return null
  const defaults = DEFAULT_PORTS[packet.protocol] ?? { transport: 'TCP' as const, port: null }
  const verdict = evaluateFirewall(device, {
    direction,
    transport: packet.transport ?? defaults.transport,
    localPort: direction === 'Inbound' ? (packet.port ?? defaults.port) : null,
    remoteAddress: direction === 'Inbound' ? packet.src : packet.dst
  })
  if (verdict.allowed) return null
  return `Le pare-feu de ${device.name} (profil ${PROFILE_LABELS[verdict.profile]}) bloque ce trafic ${
    direction === 'Inbound' ? 'entrant' : 'sortant'
  } : ${verdict.reason}.`
}

export type Delivery =
  | {
      kind: 'delivered'
      deviceId: string
      ingress: PortRef | null
      ttl: number
      latency: number
      /** Adresse source vue par le destinataire (après traduction NAT ou tunnel). */
      src: string
    }
  | { kind: 'no-route'; deviceId: string; ingress: PortRef | null; latency: number }
  | { kind: 'unresolved'; deviceId: string; ingress: PortRef | null; nextHop: string; latency: number }
  | { kind: 'ttl-expired'; deviceId: string; ingress: PortRef | null; latency: number }
  | {
      kind: 'dropped'
      deviceId: string
      latency: number
      /** Rejeté par un pare-feu (TCP RST ou ICMP renvoyé à l'émetteur), et non détruit en silence. */
      rejected?: boolean
    }

/** Vue d'un paquet pour les filtres (listes d'accès) : transport et port de destination. */
function filterView(packet: IpPacket): FilterPacket {
  const defaults = DEFAULT_PORTS[packet.protocol] ?? { transport: 'TCP' as const, port: null }
  const transport = packet.transport ?? defaults.transport
  const protocol =
    transport === 'ICMPv4' ? 'icmp' : transport === 'TCP' ? 'tcp' : transport === 'UDP' ? 'udp' : 'other'
  const port = packet.reply ? null : (packet.port ?? defaults.port)
  return {
    src: packet.src,
    dst: packet.dst,
    summary: packet.summary,
    protocol,
    ...(port !== null ? { dstPort: port } : {}),
    ...(packet.reply ? { reply: true } : {})
  }
}

/** Refus d'un filtre (liste d'accès, pare-feu) et explications des paquets autorisés. */
interface FilterOutcome {
  refused: { note: string; rejectWith?: 'tcp-rst' | 'icmp-port-unreachable' } | null
  /** Règle appliquée à un paquet autorisé (pare-feu à états), à placer dans la trace. */
  passNote: string
}

function filtered(
  ctx: SimContext,
  hooks: TransitHooks[],
  device: Device,
  ingressIfaceId: string | null,
  egressIfaceId: string | null,
  packet: IpPacket
): FilterOutcome {
  const view = filterView(packet)
  let passNote = ''
  for (const hook of hooks) {
    const verdict = hook.filter?.(ctx, device, ingressIfaceId, egressIfaceId, view)
    if (!verdict) continue
    if (typeof verdict === 'string') return { refused: { note: verdict }, passNote }
    if (verdict.action === 'pass') {
      passNote += `${verdict.note} `
      continue
    }
    return {
      refused: {
        note: verdict.note,
        ...(verdict.rejectWith ? { rejectWith: verdict.rejectWith } : {})
      },
      passNote
    }
  }
  return { refused: null, passNote }
}

/** Réponse d'un pare-feu à un paquet rejeté : TCP RST ou ICMP « port inaccessible » vers la source. */
function rejectionReply(packet: IpPacket, how: 'tcp-rst' | 'icmp-port-unreachable'): IpPacket {
  const port = packet.port ?? DEFAULT_PORTS[packet.protocol]?.port ?? null
  const tcp = how === 'tcp-rst'
  return {
    src: packet.dst,
    dst: packet.src,
    ttl: 64,
    protocol: tcp ? packet.protocol : 'ICMP',
    ipProtocol: tcp ? '6 (TCP)' : '1 (ICMP)',
    summary: tcp
      ? `TCP RST ${packet.dst} → ${packet.src} (connexion rejetée)`
      : `ICMP Destination inaccessible — port (${packet.dst} → ${packet.src})`,
    upper: tcp
      ? [
          {
            layer: 4,
            name: 'TCP',
            fields: [
              ['Port source', port === null ? '?' : String(port)],
              ['Drapeaux', 'RST, ACK']
            ]
          }
        ]
      : [
          {
            layer: 4,
            name: 'ICMP',
            fields: [
              ['Type', '3 (Destination inaccessible)'],
              ['Code', '3 (Port inaccessible)']
            ]
          }
        ],
    reply: true
  }
}

/** Latence ajoutée par la traversée d'un équipement (ms, aller simple). */
function hopLatency(device: Device): number {
  if (device.kind === 'cloud') return 7
  if (device.kind === 'router') return 1
  return 0
}

/** Crochets de transit déclarés par les modules de rôles et les fonctionnalités IOS (routage, NAT, tunnels). */
function transitHooks(): TransitHooks[] {
  return [
    ...roleModules().flatMap((m) => (m.transit ? [m.transit] : [])),
    ...iosTransitHooks(),
    pfNatTransitHooks,
    pfTransitHooks
  ]
}

/**
 * Achemine un paquet IP depuis `fromDeviceId` jusqu'à sa destination (ou son échec).
 * Les décisions de chaque équipement sont expliquées dans la trace.
 */
/**
 * Garde-fou du parcours : un équipement par tour. Le TTL (255 au plus) arrête une boucle de routage
 * avant cette limite, même avec des switchs entre les routeurs ; elle ne sert qu'aux boucles de
 * niveau 2 (pas de TTL). Une limite plus basse coupait une boucle de routage avant l'expiration du
 * TTL : le ping affichait « Délai d'attente dépassé » au lieu de « TTL expirée » (audit T-03).
 */
const MAX_TRANSIT_STEPS = 1024

export function sendIp(ctx: SimContext, fromDeviceId: string, original: IpPacket): Delivery {
  let packet = original
  let current = fromDeviceId
  let ingress: PortRef | null = null
  let ttl = packet.ttl
  let latency = 0
  const hooks = transitHooks()
  /** Le paquet a-t-il quitté l'émetteur (premier équipement traversé ou tunnel) ? */
  let transit = false
  /** Explication à placer avant la décision de routage (retraduction NAT, sortie de tunnel). */
  let arrival = ''

  for (let guard = 0; guard < MAX_TRANSIT_STEPS; guard++) {
    const device = ctx.state.devices[current]
    if (!device || !device.powered) return { kind: 'dropped', deviceId: current, latency }

    // Liste d'accès ou règles de pare-feu en entrée de l'interface de réception
    let filterNote = ''
    if (transit && ingress) {
      // Redirection de port (pare-feu) : la destination est traduite avant le filtrage
      let redirectNote = ''
      for (const hook of hooks) {
        const rdr = hook.redirect?.(ctx, device, ingress.ifaceId, filterView(packet))
        if (!rdr) continue
        redirectNote = `${rdr.note} `
        packet = {
          ...packet,
          dst: rdr.dst,
          port: rdr.dstPort,
          upper: packet.upper.map((l) =>
            l.layer === 4
              ? {
                  ...l,
                  fields: l.fields.map((f) => (f[0] === 'Port destination' ? [f[0], String(rdr.dstPort)] : f))
                }
              : l
          ) as typeof packet.upper
        }
        break
      }
      const outcome = filtered(ctx, hooks, device, ingress.ifaceId, null, packet)
      if (outcome.refused) {
        setLastOutcome(ctx, 'dropped', redirectNote + outcome.refused.note)
        // Reject : le pare-feu répond à l'émetteur (TCP RST ou ICMP), visible dans la trace
        if (outcome.refused.rejectWith)
          sendIp(ctx, device.id, rejectionReply(packet, outcome.refused.rejectWith))
        return {
          kind: 'dropped',
          deviceId: current,
          latency,
          ...(outcome.refused.rejectWith ? { rejected: true } : {})
        }
      }
      filterNote = redirectNote + outcome.passNote
    }

    // Retraduction NAT d'une réponse adressée à l'adresse publique
    if (transit)
      for (const hook of hooks) {
        const back = hook.untranslate?.(ctx, device, packet)
        if (back) {
          setLastOutcome(ctx, 'forwarded', back.note)
          arrival += `${back.note} `
          packet = { ...packet, dst: back.dst }
          break
        }
      }

    if (ownsAddress(device, packet.dst) || hooks.some((h) => h.owns?.(ctx.state, device, packet.dst))) {
      if (transit) {
        const blocked = firewallBlocks(device, packet, 'Inbound')
        if (blocked) {
          setLastOutcome(ctx, 'dropped', blocked)
          return { kind: 'dropped', deviceId: current, latency }
        }
        setLastOutcome(
          ctx,
          'delivered',
          `${filterNote}${device.name} est le destinataire (${packet.dst}) : le paquet est traité.`
        )
      }
      return { kind: 'delivered', deviceId: current, ingress, ttl, latency, src: packet.src }
    }

    // Pare-feu de l'émetteur : trafic sortant
    if (!transit && firewallBlocks(device, packet, 'Outbound'))
      return { kind: 'dropped', deviceId: current, latency }

    if (transit) {
      const routes = hooks.some((h) => h.forwards?.(ctx.state, device))
      if ((device.kind === 'server' || device.kind === 'client') && !routes) {
        setLastOutcome(
          ctx,
          'dropped',
          `${device.name} n’est pas un routeur : le paquet destiné à ${packet.dst} est ignoré.`
        )
        return { kind: 'dropped', deviceId: current, latency }
      }
      // Switch : routage seulement s'il est de niveau 3 et configuré pour (ip routing)
      if (device.kind === 'switch' && !routes) {
        setLastOutcome(
          ctx,
          'dropped',
          `${device.name} ne route pas (ip routing désactivé) : le paquet destiné à ${packet.dst} est ignoré.`
        )
        return { kind: 'dropped', deviceId: current, latency }
      }
      if (device.kind === 'cloud') {
        setLastOutcome(ctx, 'dropped', `Aucun hôte Internet ne répond à l’adresse ${packet.dst}.`)
        return { kind: 'dropped', deviceId: current, latency }
      }
      ttl -= 1
      latency += hopLatency(device)
      if (ttl <= 0) {
        setLastOutcome(
          ctx,
          'dropped',
          `${device.name} décrémente le TTL qui atteint 0 : le paquet est détruit.`
        )
        return { kind: 'ttl-expired', deviceId: current, ingress, latency }
      }
    }

    // Tunnel (VPN) : le paquet est encapsulé jusqu'à l'autre extrémité
    const tunnel = hooks.map((h) => h.tunnel?.(ctx.state, device, packet)).find((t) => !!t)
    if (tunnel) {
      if (transit)
        setLastOutcome(
          ctx,
          'forwarded',
          `${device.name} encapsule le paquet dans le tunnel VPN vers ${tunnel.outerDst}.`
        )
      const outer = sendIp(ctx, device.id, {
        src: tunnel.outerSrc,
        dst: tunnel.outerDst,
        ttl: initialTtl(device),
        protocol: 'VPN',
        ipProtocol: '6 (TCP)',
        summary: tunnel.summary,
        upper: tunnel.upper,
        transport: 'TCP',
        port: VPN_PORT,
        reply: tunnel.reply
      })
      if (outer.kind !== 'delivered') return { kind: 'dropped', deviceId: current, latency }
      latency += outer.latency
      setLastOutcome(ctx, 'delivered', tunnel.note)
      arrival = `${tunnel.note} `
      if (tunnel.deliver)
        return {
          kind: 'delivered',
          deviceId: tunnel.endpointId,
          ingress: null,
          ttl,
          latency,
          src: packet.src
        }
      packet = { ...packet, src: tunnel.innerSrc ?? packet.src }
      current = tunnel.endpointId
      ingress = null
      transit = true
      continue
    }

    const route = lookupRoute(routingTable(ctx.state, device), packet.dst)
    if (!route) {
      if (transit)
        setLastOutcome(
          ctx,
          'dropped',
          `${device.name} n’a aucune route vers ${packet.dst} : le paquet est rejeté.`
        )
      return { kind: 'no-route', deviceId: current, ingress, latency }
    }
    const egress: PortRef = { deviceId: current, ifaceId: route.ifaceId }
    const nextHop = route.gateway ?? packet.dst
    if (transit) {
      const egressName = ifaceOf(ctx, egress)?.name ?? ''
      // Traduction d'adresse (NAT) par l'interface de sortie
      let translated = ''
      for (const hook of hooks) {
        const nat = hook.translate?.(ctx, device, ingress?.ifaceId ?? null, route.ifaceId, packet)
        if (nat) {
          packet = { ...packet, src: nat.src }
          translated = ` ${nat.note}`
          break
        }
      }
      // Liste d'accès en sortie (après la traduction d'adresse)
      const egressFilter = filtered(ctx, hooks, device, null, route.ifaceId, packet)
      if (egressFilter.refused) {
        setLastOutcome(ctx, 'dropped', arrival + egressFilter.refused.note)
        return { kind: 'dropped', deviceId: current, latency }
      }
      setLastOutcome(
        ctx,
        'forwarded',
        filterNote +
          arrival +
          (route.gateway
            ? `${device.name} route le paquet vers ${packet.dst} par ${egressName}, via la passerelle ${route.gateway} (TTL ${ttl}).`
            : `${device.name} route le paquet vers ${packet.dst} : réseau directement connecté sur ${egressName} (TTL ${ttl}).`) +
          translated
      )
    }

    const target = arpResolve(ctx, egress, nextHop)
    if (!target) return { kind: 'unresolved', deviceId: current, ingress, nextHop, latency }

    const srcMac = ifaceOf(ctx, egress)?.mac ?? ''
    const dstMac = ifaceOf(ctx, target.port)?.mac ?? ''
    const targetDevice = ctx.state.devices[target.port.deviceId]
    recordUnicast(
      ctx,
      target.path,
      {
        protocol: packet.protocol,
        summary: packet.summary,
        layers: [
          ethernetLayer(srcMac, dstMac, 'IPv4'),
          ipv4Layer(packet.src, packet.dst, ttl, packet.ipProtocol),
          ...packet.upper
        ]
      },
      'forwarded',
      `${targetDevice?.name ?? '?'} reçoit le paquet.`
    )
    current = target.port.deviceId
    ingress = target.port
    transit = true
    arrival = ''
  }
  return { kind: 'dropped', deviceId: current, latency }
}

/** Adresse source utilisée par un équipement pour joindre `dst` (carte de sortie). */
export function sourceAddressFor(state: LabState, device: Device, dst: string): string | null {
  const route = lookupRoute(routingTable(state, device), dst)
  if (!route) return null
  const iface = device.interfaces.find((i) => i.id === route.ifaceId)
  return iface ? (effectiveIpv4(iface)?.address ?? null) : null
}

/** Adresse IP du port d'entrée d'un équipement (adresse affichée par tracert). */
export function ingressAddress(state: LabState, port: PortRef | null): string | null {
  if (!port) return null
  const iface = state.devices[port.deviceId]?.interfaces.find((i) => i.id === port.ifaceId)
  return iface ? (effectiveIpv4(iface)?.address ?? null) : null
}
