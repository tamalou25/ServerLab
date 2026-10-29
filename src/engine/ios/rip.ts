/**
 * RIP calculé à partir de l'état (aucune table stockée) : interfaces RIP (instructions network de
 * classe), échanges entre voisins des segments de niveau 2 (version d'envoi et de réception,
 * interfaces passives, split horizon), résumé automatique aux frontières de classe, métrique en
 * sauts (16 : injoignable) et route par défaut annoncée (default-information originate).
 * La convergence est simulée par itérations de Bellman-Ford jusqu'à stabilité.
 * Comportements : RIP Command Reference (auto-summary, version, passive-interface)
 * https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/iproute_rip/command/irr-cr-book/irr-cr-rip.html
 */
import { isDraft } from 'immer'
import type { LabState, NetInterface, RipProcess } from '../model/schema'
import { networkAddress, parseIpv4 } from '../net/ipv4'
import type { Route } from '../net/routing'
import { l2Segment } from '../net/segment'
import { iosState } from './config'
import { isIos, type IosDevice } from './device'
import { ifaceStatus } from './status'

/** Métrique infinie de RIP. */
export const RIP_INFINITY = 16

/** Préfixe de classe d'une adresse (A /8, B /16, C /24). */
export function classfulPrefix(address: string): number {
  const first = Number(address.split('.')[0])
  return first < 128 ? 8 : first < 192 ? 16 : 24
}

/** Réseau de classe d'une adresse (network 10.1.1.0 → 10.0.0.0). */
export function classfulNetwork(address: string): string {
  return networkAddress(address, classfulPrefix(address))
}

export interface RipIface {
  iface: NetInterface
  network: string
  prefixLength: number
  passive: boolean
}

/** Entrée de la base RIP d'un routeur. */
export interface RipEntry {
  network: string
  prefixLength: number
  /** Sauts (0 : directement connecté). */
  metric: number
  /** Voisin annonceur (absent : connecté ou originé localement). */
  gateway?: string
  ifaceId?: string
  /** Route par défaut originée par ce routeur (default-information originate). */
  originated?: boolean
}

export interface RipRouter {
  device: IosDevice
  config: RipProcess
  ifaces: RipIface[]
  entries: Map<string, RipEntry>
  /** Voisins ayant envoyé une mise à jour acceptée (adresse → identifiant d'interface locale). */
  sources: Map<string, string>
}

const key = (network: string, prefixLength: number): string => `${network}/${prefixLength}`

/** Versions envoyées et acceptées (version absente : envoi v1, réception v1 et v2). */
export function ripVersions(config: RipProcess): { send: 1 | 2; receive: (1 | 2)[] } {
  if (config.version === 2) return { send: 2, receive: [2] }
  if (config.version === 1) return { send: 1, receive: [1] }
  return { send: 1, receive: [1, 2] }
}

/** Résumé automatique effectif (toujours en version 1). */
export function ripSummarizes(config: RipProcess): boolean {
  return ripVersions(config).send === 1 || config.autoSummary
}

function buildRouter(state: LabState, device: IosDevice): RipRouter | null {
  if (!device.powered) return null
  if (device.kind === 'switch' && !iosState(device).ipRouting) return null
  const config = iosState(device).rip
  if (!config) return null
  const ifaces: RipIface[] = []
  for (const iface of device.interfaces) {
    if (!iface.l3 || !iface.address || iface.prefixLength === null) continue
    if (ifaceStatus(state, device, iface).protocol !== 'up') continue
    if (!config.networks.includes(classfulNetwork(iface.address))) continue
    ifaces.push({
      iface,
      network: networkAddress(iface.address, iface.prefixLength),
      prefixLength: iface.prefixLength,
      passive: config.passive.includes(iface.name)
    })
  }
  const entries = new Map<string, RipEntry>()
  for (const i of ifaces)
    entries.set(key(i.network, i.prefixLength), {
      network: i.network,
      prefixLength: i.prefixLength,
      metric: 0
    })
  if (config.defaultOriginate)
    entries.set(key('0.0.0.0', 0), { network: '0.0.0.0', prefixLength: 0, metric: 0, originated: true })
  return { device, config, ifaces, entries, sources: new Map() }
}

/** Routes annoncées par `router` sur l'interface `out` (split horizon, résumé de classe). */
function advertised(router: RipRouter, out: RipIface): RipEntry[] {
  const summarize = ripSummarizes(router.config)
  const outMajor = classfulNetwork(out.network)
  const result = new Map<string, RipEntry>()
  for (const e of router.entries.values()) {
    if (e.ifaceId === out.iface.id) continue
    let network = e.network
    let prefixLength = e.prefixLength
    if (summarize && prefixLength > 0 && classfulNetwork(network) !== outMajor) {
      network = classfulNetwork(network)
      prefixLength = classfulPrefix(network)
    }
    const k = key(network, prefixLength)
    const current = result.get(k)
    if (!current || e.metric < current.metric) result.set(k, { network, prefixLength, metric: e.metric })
  }
  return [...result.values()]
}

function compute(state: LabState): Map<string, RipRouter> {
  const routers = new Map<string, RipRouter>()
  for (const device of Object.values(state.devices)) {
    if (!isIos(device)) continue
    const router = buildRouter(state, device)
    if (router) routers.set(device.id, router)
  }
  // Liens RIP : interface émettrice → interfaces réceptrices du même sous-réseau
  const links: { from: RipRouter; out: RipIface; to: RipRouter; via: RipIface }[] = []
  for (const from of routers.values())
    for (const out of from.ifaces) {
      if (out.passive) continue
      for (const member of l2Segment(state, { deviceId: from.device.id, ifaceId: out.iface.id })) {
        const to = routers.get(member.port.deviceId)
        const via = to?.ifaces.find((x) => x.iface.id === member.port.ifaceId)
        if (!to || !via || to === from) continue
        if (via.network !== out.network || via.prefixLength !== out.prefixLength) continue
        // Version : la mise à jour n'est acceptée que dans une version reçue par le voisin
        if (!ripVersions(to.config).receive.includes(ripVersions(from.config).send)) continue
        links.push({ from, out, to, via })
      }
    }
  // Bellman-Ford jusqu'à stabilité (au plus 16 tours : métrique infinie)
  for (let round = 0; round < RIP_INFINITY; round++) {
    let changed = false
    for (const { from, out, to, via } of links) {
      const gateway = out.iface.address as string
      to.sources.set(gateway, via.iface.id)
      for (const adv of advertised(from, out)) {
        const metric = adv.metric + 1
        if (metric >= RIP_INFINITY) continue
        const k = key(adv.network, adv.prefixLength)
        const current = to.entries.get(k)
        // Premier annonceur conservé à métrique égale (un seul chemin simulé)
        if (current && current.metric <= metric) continue
        to.entries.set(k, { ...adv, metric, gateway, ifaceId: via.iface.id })
        changed = true
      }
    }
    if (!changed) break
  }
  return routers
}

const cache = new WeakMap<LabState, Map<string, RipRouter>>()

/** Bases RIP de l'état (mémorisées par état, jamais sur un brouillon immer). */
export function ripDatabase(state: LabState): Map<string, RipRouter> {
  if (isDraft(state)) return compute(state)
  let db = cache.get(state)
  if (!db) {
    db = compute(state)
    cache.set(state, db)
  }
  return db
}

/** Routes R d'un routeur (distance 120, métrique en sauts). */
export function ripRoutes(state: LabState, device: IosDevice): Route[] {
  const router = ripDatabase(state).get(device.id)
  if (!router) return []
  const routes: Route[] = []
  for (const e of router.entries.values()) {
    if (!e.gateway || !e.ifaceId) continue
    routes.push({
      network: e.network,
      prefixLength: e.prefixLength,
      gateway: e.gateway,
      ifaceId: e.ifaceId,
      source: 'rip',
      distance: 120,
      metric: e.metric
    })
  }
  return routes
}

/** Tri par adresse puis longueur de préfixe. */
export function byAddress(a: { network: string; prefixLength: number }, b: typeof a): number {
  return (parseIpv4(a.network) ?? 0) - (parseIpv4(b.network) ?? 0) || a.prefixLength - b.prefixLength
}
