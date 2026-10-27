/**
 * Moteur de filtrage d'un pare-feu pfSense CE 2.7 simulé (v2.10, #243), branché sur le transit des
 * paquets (`sim/forward.ts`) par un crochet `filter`.
 *
 * Comportement reproduit (docs/fidelite.md, P-10 et suivants) :
 * - les règles d'une interface s'appliquent au trafic ENTRANT sur cette interface, dans l'ordre ;
 *   la première qui correspond s'applique (« quick ») ;
 * - tout ce qui ne correspond à aucune règle est refusé en silence (refus par défaut) ;
 * - le filtrage est à états : un paquet autorisé crée une entrée de la table d'états qui laisse
 *   passer les réponses ;
 * - Pass autorise, Block détruit en silence, Reject renvoie un TCP RST (TCP) ou un ICMP
 *   « port inaccessible » (UDP) ; les autres protocoles sont détruits en silence ;
 * - règles automatiques : anti-verrouillage du LAN, blocage des réseaux privés et des bogons du WAN ;
 * - les règles marquées « log » (et le refus par défaut) alimentent le journal `pf.log`.
 *
 * Moteur pur : aucune écriture dans l'état. Le journal et la table d'états sont des effets durables
 * de l'échange (`pf-log`, `pf-state`), appliqués par `applyPfEffects` quand la trace est validée.
 */
import type { Draft } from 'immer'
import type { Device, LabState, NetInterface } from '../model/schema'
import { PF_LOG_LIMIT, type PfEndpoint, type PfIfaceKey, type PfRule, type PfState } from '../model/firewall'
import { effectiveIpv4 } from './addressing'
import { inNetwork, isIpv4, networkAddress } from './ipv4'
import type { FilterDecision, FilterPacket, TransitHooks } from '../sim/transit'
import type { TraceEffect } from '../sim/trace'

type PfDevice = Extract<Device, { kind: 'firewall' }>

/** Ports de l'interface d'administration protégés par la règle anti-verrouillage (HTTPS, HTTP, SSH). */
export const PF_ANTI_LOCKOUT_PORTS = [443, 80, 22] as const

/** Réseaux privés et boucle locale (case « Block private networks and loopback addresses »). */
const PRIVATE_NETWORKS: [string, number][] = [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['127.0.0.0', 8]
]

/**
 * Réseaux réservés tenus pour des bogons (approximation : la vraie liste, mise à jour par Netgate,
 * contient aussi les plages non attribuées ; voir docs/fidelite.md, P-16).
 */
const BOGON_NETWORKS: [string, number][] = [
  ['0.0.0.0', 8],
  ['169.254.0.0', 16],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3]
]

const inAny = (ip: string, nets: [string, number][]): boolean => nets.some(([n, p]) => inNetwork(ip, n, p))

/** Adresse privée ou de boucle locale (RFC 1918 et 127/8). */
export const isPrivateAddress = (ip: string): boolean => inAny(ip, PRIVATE_NETWORKS)
/** Adresse réservée tenue pour un bogon. */
export const isBogonAddress = (ip: string): boolean => inAny(ip, BOGON_NETWORKS)

// --- Résolution des interfaces et des alias -----------------------------------------------------

/** Interface physique affectée à une interface logique (WAN, LAN, OPTx). */
function nicOf(device: PfDevice, key: PfIfaceKey): NetInterface | undefined {
  const id = device.pf.assignments.find((a) => a.key === key)?.ifaceId
  return id ? device.interfaces.find((i) => i.id === id) : undefined
}

/** Affectation à laquelle appartient une carte (undefined : non affectée). */
function assignmentOfNic(pf: PfState, ifaceId: string) {
  return pf.assignments.find((a) => a.ifaceId === ifaceId)
}

const MAX_ALIAS_DEPTH = 4

/** L'adresse correspond-elle à la valeur d'un alias (adresse, CIDR ou nom d'un autre alias) ? */
function aliasMatches(pf: PfState, name: string, ip: string, depth: number): boolean {
  if (depth > MAX_ALIAS_DEPTH) return false
  const alias = pf.aliases.find((a) => a.name === name)
  if (!alias || alias.type === 'port') return false
  return alias.values.some((value) => {
    const [address = '', prefix] = value.split('/')
    if (isIpv4(address)) return prefix === undefined ? address === ip : inNetwork(ip, address, Number(prefix))
    return aliasMatches(pf, value, ip, depth + 1)
  })
}

function endpointMatches(device: PfDevice, endpoint: PfEndpoint, ip: string): boolean {
  switch (endpoint.type) {
    case 'any':
      return true
    case 'address':
      return endpoint.address === ip
    case 'network':
      return isIpv4(endpoint.address) && inNetwork(ip, endpoint.address, endpoint.prefixLength)
    case 'alias':
      return aliasMatches(device.pf, endpoint.name, ip, 0)
    case 'interface': {
      const nic = nicOf(device, endpoint.key)
      const eff = nic ? effectiveIpv4(nic) : null
      if (!eff) return false
      return endpoint.what === 'address'
        ? eff.address === ip
        : inNetwork(ip, networkAddress(eff.address, eff.prefixLength), eff.prefixLength)
    }
  }
}

/** Libellé d'un point de terminaison, comme dans la liste des règles (« LAN net », « any »). */
export function describeEndpoint(pf: PfState, endpoint: PfEndpoint): string {
  switch (endpoint.type) {
    case 'any':
      return 'any'
    case 'address':
      return endpoint.address
    case 'network':
      return `${endpoint.address}/${endpoint.prefixLength}`
    case 'alias':
      return endpoint.name
    case 'interface': {
      const descr = pf.assignments.find((a) => a.key === endpoint.key)?.descr ?? endpoint.key
      return `${descr} ${endpoint.what === 'net' ? 'net' : 'address'}`
    }
  }
}

// --- Correspondance d'une règle -----------------------------------------------------------------

function protocolMatches(rule: PfRule, packet: FilterPacket): boolean {
  switch (rule.protocol) {
    case 'any':
      return true
    case 'tcp/udp':
      return packet.protocol === 'tcp' || packet.protocol === 'udp'
    default:
      return rule.protocol === packet.protocol
  }
}

/** La règle s'applique-t-elle à ce paquet (hors interface, déjà filtrée) ? */
function ruleMatches(device: PfDevice, rule: PfRule, packet: FilterPacket): boolean {
  if (!protocolMatches(rule, packet)) return false
  // Le port source d'un client est éphémère et n'est pas modélisé : un filtre sur le port source
  // est ignoré (docs/fidelite.md, P-17).
  if (rule.destinationPort) {
    if (packet.dstPort === undefined) return false
    if (packet.dstPort < rule.destinationPort.from || packet.dstPort > rule.destinationPort.to) return false
  }
  return (
    endpointMatches(device, rule.source, packet.src) && endpointMatches(device, rule.destination, packet.dst)
  )
}

/** Libellé d'une règle dans les explications (« Default allow LAN to any rule » ou son identifiant). */
export function ruleLabel(rule: PfRule): string {
  return rule.descr ? `« ${rule.descr} »` : `(${rule.id})`
}

// --- Table d'états ------------------------------------------------------------------------------

const stripPort = (endpoint: string): string => endpoint.split(':')[0] ?? endpoint

interface StateLike {
  iface: string
  protocol: string
  src: string
  dst: string
}

/** Entrées de la table d'états : celles déjà enregistrées puis celles créées pendant l'opération. */
function* stateEntries(device: PfDevice, effects: TraceEffect[]): Generator<StateLike> {
  yield* device.pf.states
  for (const e of effects)
    if (e.kind === 'pf-state' && e.deviceId === device.id) {
      const d = e.data
      yield { iface: String(d.iface), protocol: String(d.protocol), src: String(d.src), dst: String(d.dst) }
    }
}

/**
 * Une réponse appartient-elle à une connexion suivie ? La réponse arrive par une autre interface
 * que celle qui a vu la requête ; un message d'erreur ICMP est « lié » à toute connexion de son
 * destinataire.
 */
function stateAllowsReply(
  device: PfDevice,
  effects: TraceEffect[],
  ingressKey: PfIfaceKey,
  packet: FilterPacket
): 'state' | 'related' | null {
  let related = false
  for (const s of stateEntries(device, effects)) {
    if (s.iface === ingressKey || s.src !== packet.dst) continue
    if (stripPort(s.dst) === packet.src && s.protocol === packet.protocol) return 'state'
    if (packet.protocol === 'icmp') related = true
  }
  return related ? 'related' : null
}

// --- Évaluation ---------------------------------------------------------------------------------

/** Résultat de l'évaluation d'un paquet entrant sur une interface du pare-feu. */
export interface PfVerdict {
  action: 'pass' | 'block' | 'reject'
  /** Règle appliquée (null : règle automatique, état ou refus par défaut). */
  rule: PfRule | null
  /** Origine de la décision. */
  source: 'rule' | 'state' | 'anti-lockout' | 'private' | 'bogon' | 'default-deny' | 'interface'
  /** Explication en français pour la trace. */
  note: string
  /** Écrire une entrée dans le journal. */
  log: boolean
  /** Créer une entrée de la table d'états. */
  track: boolean
  rejectWith?: 'tcp-rst' | 'icmp-port-unreachable'
}

/** Évalue un paquet entrant sur `ingressIfaceId` d'un pare-feu (fonction pure). */
export function evaluatePf(
  device: PfDevice,
  ingressIfaceId: string,
  packet: FilterPacket,
  effects: TraceEffect[] = []
): PfVerdict {
  const pf = device.pf
  const assignment = assignmentOfNic(pf, ingressIfaceId)
  const nic = device.interfaces.find((i) => i.id === ingressIfaceId)
  if (!assignment || !assignment.enabled)
    return {
      action: 'block',
      rule: null,
      source: 'interface',
      note: `${device.name} (pfSense) : ${nic?.name ?? 'cette carte'} n’est pas une interface affectée et activée, le paquet est détruit.`,
      log: false,
      track: false
    }
  const key = assignment.key
  const where = `${assignment.descr} (${nic?.name ?? ''})`

  // Réponse d'une connexion autorisée : la table d'états la laisse passer sans consulter les règles
  if (packet.reply) {
    const found = stateAllowsReply(device, effects, key, packet)
    if (found)
      return {
        action: 'pass',
        rule: null,
        source: 'state',
        note:
          found === 'state'
            ? `${device.name} (pfSense) : ce paquet est la réponse d’une connexion suivie par la table d’états, il passe sur ${where} sans consulter les règles.`
            : `${device.name} (pfSense) : ce message ICMP est lié à une connexion suivie par la table d’états, il passe sur ${where}.`,
        log: false,
        track: false
      }
  }

  // Règle automatique d'anti-verrouillage : l'interface d'administration reste joignable depuis le LAN
  if (
    key === 'lan' &&
    packet.protocol === 'tcp' &&
    packet.dstPort !== undefined &&
    (PF_ANTI_LOCKOUT_PORTS as readonly number[]).includes(packet.dstPort)
  ) {
    const lan = nicOf(device, 'lan')
    if (lan && effectiveIpv4(lan)?.address === packet.dst)
      return {
        action: 'pass',
        rule: null,
        source: 'anti-lockout',
        note: `${device.name} (pfSense) : la règle d’anti-verrouillage (Anti-Lockout Rule) autorise l’accès à l’administration depuis ${where}.`,
        log: false,
        track: true
      }
  }

  // Blocage des réseaux privés et des bogons : règles automatiques placées avant les règles de l'utilisateur
  if (assignment.blockPrivate && isPrivateAddress(packet.src))
    return {
      action: 'block',
      rule: null,
      source: 'private',
      note: `${device.name} (pfSense) bloque sur ${where} : « Block private networks and loopback addresses » détruit les paquets dont la source ${packet.src} est un réseau privé.`,
      log: true,
      track: false
    }
  if (assignment.blockBogons && isBogonAddress(packet.src))
    return {
      action: 'block',
      rule: null,
      source: 'bogon',
      note: `${device.name} (pfSense) bloque sur ${where} : « Block bogon networks » détruit les paquets dont la source ${packet.src} est un réseau réservé.`,
      log: true,
      track: false
    }

  // Règles de l'interface, dans l'ordre : la première qui correspond s'applique
  for (const rule of pf.rules) {
    if (rule.iface !== key || rule.disabled || !ruleMatches(device, rule, packet)) continue
    const label = ruleLabel(rule)
    if (rule.action === 'pass')
      return {
        action: 'pass',
        rule,
        source: 'rule',
        note: `${device.name} (pfSense) : la règle ${label} de ${where} autorise le paquet (Pass).`,
        log: rule.log,
        track: true
      }
    const rejectWith =
      rule.action === 'reject'
        ? packet.protocol === 'tcp'
          ? ('tcp-rst' as const)
          : packet.protocol === 'udp'
            ? ('icmp-port-unreachable' as const)
            : undefined
        : undefined
    const note =
      rule.action === 'block'
        ? `${device.name} (pfSense) : la règle ${label} de ${where} bloque le paquet (Block) : il est détruit sans réponse.`
        : rejectWith === 'tcp-rst'
          ? `${device.name} (pfSense) : la règle ${label} de ${where} rejette le paquet (Reject) : il est détruit et un TCP RST est renvoyé à ${packet.src}.`
          : rejectWith === 'icmp-port-unreachable'
            ? `${device.name} (pfSense) : la règle ${label} de ${where} rejette le paquet (Reject) : il est détruit et un message ICMP « port inaccessible » est renvoyé à ${packet.src}.`
            : `${device.name} (pfSense) : la règle ${label} de ${where} rejette le paquet (Reject), mais ce protocole ne peut pas être rejeté : il est détruit en silence.`
    return {
      action: rule.action,
      rule,
      source: 'rule',
      note,
      log: rule.log,
      track: false,
      ...(rejectWith ? { rejectWith } : {})
    }
  }

  // Refus par défaut (journalisé par défaut dans pfSense)
  return {
    action: 'block',
    rule: null,
    source: 'default-deny',
    note: `${device.name} (pfSense) : aucune règle de ${where} ne correspond, la règle de refus par défaut (Default deny) détruit le paquet.`,
    log: true,
    track: false
  }
}

// --- Branchement sur le transit -----------------------------------------------------------------

const dstWithPort = (packet: FilterPacket): string =>
  packet.dstPort === undefined ? packet.dst : `${packet.dst}:${packet.dstPort}`

export const pfTransitHooks: TransitHooks = {
  forwards: (_state, device) => device.kind === 'firewall' && device.powered,

  filter(ctx, device, ingressIfaceId, _egressIfaceId, packet): FilterDecision | null {
    // Seul le trafic entrant d'un pare-feu pfSense est filtré ; ses propres paquets ne le sont pas
    if (device.kind !== 'firewall' || ingressIfaceId === null) return null
    const verdict = evaluatePf(device, ingressIfaceId, packet, ctx.effects)
    const key = assignmentOfNic(device.pf, ingressIfaceId)?.key ?? 'lan'
    if (verdict.log)
      ctx.effects.push({
        kind: 'pf-log',
        deviceId: device.id,
        data: {
          ruleId: verdict.rule?.id ?? '',
          action: verdict.action,
          iface: key,
          protocol: packet.protocol,
          src: packet.src,
          dst: dstWithPort(packet)
        }
      })
    if (verdict.track)
      ctx.effects.push({
        kind: 'pf-state',
        deviceId: device.id,
        data: { iface: key, protocol: packet.protocol, src: packet.src, dst: dstWithPort(packet) }
      })
    return {
      action: verdict.action,
      note: verdict.note,
      ...(verdict.rejectWith ? { rejectWith: verdict.rejectWith } : {})
    }
  }
}

// --- Effets durables ----------------------------------------------------------------------------

/**
 * Applique les effets `pf-log` et `pf-state` d'une trace validée : journal du pare-feu (plafonné à
 * PF_LOG_LIMIT) et table d'états (sans doublon, même plafond).
 */
export function applyPfEffects(draft: Draft<LabState>, effects: readonly TraceEffect[]): void {
  for (const effect of effects) {
    if (effect.kind !== 'pf-log' && effect.kind !== 'pf-state') continue
    const device = draft.devices[effect.deviceId]
    if (!device || device.kind !== 'firewall') continue
    const d = effect.data
    const iface = String(d.iface) as PfIfaceKey
    if (effect.kind === 'pf-log') {
      device.pf.log.push({
        at: draft.clock,
        ruleId: d.ruleId === '' ? null : String(d.ruleId),
        action: String(d.action) as 'pass' | 'block' | 'reject',
        iface,
        protocol: String(d.protocol),
        src: String(d.src),
        dst: String(d.dst)
      })
      if (device.pf.log.length > PF_LOG_LIMIT) device.pf.log.splice(0, device.pf.log.length - PF_LOG_LIMIT)
      continue
    }
    const entry = { iface, protocol: String(d.protocol), src: String(d.src), dst: String(d.dst) }
    const known = device.pf.states.some(
      (s) => s.iface === iface && s.protocol === entry.protocol && s.src === entry.src && s.dst === entry.dst
    )
    if (known) continue
    device.pf.states.push({ ...entry, createdAt: draft.clock })
    if (device.pf.states.length > PF_LOG_LIMIT)
      device.pf.states.splice(0, device.pf.states.length - PF_LOG_LIMIT)
  }
}
