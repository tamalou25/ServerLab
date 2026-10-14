/**
 * OSPF monozone calculé à partir de l'état (aucune base de données stockée) : interfaces OSPF
 * (instructions network), voisinages sur les segments de niveau 2 du moteur, plus courts chemins
 * (Dijkstra) et routes O. Couper un lien ou une interface recalcule immédiatement les routes.
 */
import { isDraft } from 'immer'
import type { LabState, NetInterface } from '../model/schema'
import { formatIpv4, networkAddress, parseIpv4 } from '../net/ipv4'
import type { Route } from '../net/routing'
import { l2Segment } from '../net/segment'
import { iosState } from './config'
import { isIos, type IosDevice } from './device'
import { ifaceStatus } from './status'

/** Interface d'un routeur qui participe à OSPF. */
export interface OspfIface {
  iface: NetInterface
  network: string
  prefixLength: number
  area: number
  passive: boolean
  cost: number
}

/** Routeur OSPF (équipement IOS avec un processus et un identifiant). */
export interface OspfRouter {
  device: IosDevice
  process: number
  routerId: string
  ifaces: OspfIface[]
  /**
   * Annonce une route par défaut externe (default-information originate) : `always`, ou une
   * route par défaut statique présente dans sa table.
   */
  originatesDefault: boolean
}

/** Voisin OSPF vu depuis un routeur. */
export interface OspfNeighbor {
  routerId: string
  deviceId: string
  /** Adresse du voisin sur le lien. */
  address: string
  /** Interface locale. */
  ifaceId: string
}

export interface OspfDatabase {
  routers: Map<string, OspfRouter>
  neighbors: Map<string, OspfNeighbor[]>
}

/** Coût d'une interface (bande passante de référence 100 Mbit/s : FastEthernet et Gigabit = 1). */
function ifaceCost(iface: NetInterface): number {
  const bwKbps = iface.name.startsWith('Fa') ? 100000 : 1000000
  return Math.max(1, Math.floor(100000 / bwKbps))
}

/** Vrai si l'adresse correspond à l'instruction network (masque générique). */
export function wildcardMatch(address: string, network: string, wildcard: string): boolean {
  const a = parseIpv4(address)
  const n = parseIpv4(network)
  const w = parseIpv4(wildcard)
  if (a === null || n === null || w === null) return false
  const mask = ~w >>> 0
  return (a & mask) >>> 0 === (n & mask) >>> 0
}

/** Identifiant de routeur : configuré, sinon la plus haute adresse d'une interface active. */
function routerIdOf(state: LabState, device: IosDevice, configured: string | null): string | null {
  if (configured) return configured
  let best: number | null = null
  for (const i of device.interfaces) {
    if (!i.address || ifaceStatus(state, device, i).protocol !== 'up') continue
    const ip = parseIpv4(i.address)
    if (ip !== null && (best === null || ip > best)) best = ip
  }
  return best === null ? null : formatIpv4(best)
}

function buildRouter(state: LabState, device: IosDevice): OspfRouter | null {
  if (!device.powered) return null
  if (device.kind === 'switch' && !iosState(device).ipRouting) return null
  const proc = iosState(device).ospf[0]
  if (!proc) return null
  const routerId = routerIdOf(state, device, proc.routerId)
  if (!routerId) return null
  const ifaces: OspfIface[] = []
  for (const iface of device.interfaces) {
    if (!iface.l3 || !iface.address || iface.prefixLength === null) continue
    if (ifaceStatus(state, device, iface).protocol !== 'up') continue
    const statement = proc.networks.find((n) => wildcardMatch(iface.address as string, n.network, n.wildcard))
    if (!statement) continue
    const passive = proc.passiveDefault
      ? !proc.active.includes(iface.name)
      : proc.passive.includes(iface.name)
    ifaces.push({
      iface,
      network: networkAddress(iface.address, iface.prefixLength),
      prefixLength: iface.prefixLength,
      area: statement.area,
      passive,
      cost: ifaceCost(iface)
    })
  }
  const originatesDefault =
    proc.defaultOriginate === 'always' ||
    (proc.defaultOriginate === 'on' && (device.routes ?? []).some((r) => r.prefixLength === 0))
  return { device, process: proc.process, routerId, ifaces, originatesDefault }
}

function compute(state: LabState): OspfDatabase {
  const routers = new Map<string, OspfRouter>()
  for (const device of Object.values(state.devices)) {
    if (!isIos(device)) continue
    const router = buildRouter(state, device)
    if (router) routers.set(device.id, router)
  }
  const neighbors = new Map<string, OspfNeighbor[]>()
  for (const router of routers.values()) {
    const list: OspfNeighbor[] = []
    for (const local of router.ifaces) {
      if (local.passive) continue
      for (const member of l2Segment(state, { deviceId: router.device.id, ifaceId: local.iface.id })) {
        const peer = routers.get(member.port.deviceId)
        const remote = peer?.ifaces.find((x) => x.iface.id === member.port.ifaceId)
        if (!peer || !remote || remote.passive || peer.device.id === router.device.id) continue
        if (remote.network !== local.network || remote.prefixLength !== local.prefixLength) continue
        if (remote.area !== local.area) continue
        list.push({
          routerId: peer.routerId,
          deviceId: peer.device.id,
          address: remote.iface.address as string,
          ifaceId: local.iface.id
        })
      }
    }
    neighbors.set(router.device.id, list)
  }
  return { routers, neighbors }
}

const cache = new WeakMap<LabState, OspfDatabase>()

/** Base OSPF de l'état (mémorisée par état, jamais sur un brouillon immer). */
export function ospfDatabase(state: LabState): OspfDatabase {
  if (isDraft(state)) return compute(state)
  let db = cache.get(state)
  if (!db) {
    db = compute(state)
    cache.set(state, db)
  }
  return db
}

/**
 * Routes O d'un routeur : plus courts chemins vers les réseaux annoncés par les autres routeurs
 * OSPF (premier saut, coût cumulé des interfaces de sortie).
 */
export function ospfRoutes(state: LabState, device: IosDevice): Route[] {
  const db = ospfDatabase(state)
  const self = db.routers.get(device.id)
  if (!self) return []
  const dist = new Map<string, number>([[device.id, 0]])
  const firstHop = new Map<string, { gateway: string; ifaceId: string }>()
  const done = new Set<string>()
  for (;;) {
    let current: string | null = null
    for (const [id, d] of dist)
      if (!done.has(id) && (current === null || d < (dist.get(current) ?? Infinity))) current = id
    if (current === null) break
    done.add(current)
    const base = dist.get(current) ?? 0
    const router = db.routers.get(current)
    for (const n of db.neighbors.get(current) ?? []) {
      const out = router?.ifaces.find((i) => i.iface.id === n.ifaceId)
      const cost = base + (out?.cost ?? 1)
      if (cost < (dist.get(n.deviceId) ?? Infinity)) {
        dist.set(n.deviceId, cost)
        firstHop.set(
          n.deviceId,
          current === device.id
            ? { gateway: n.address, ifaceId: n.ifaceId }
            : (firstHop.get(current) as { gateway: string; ifaceId: string })
        )
      }
    }
  }
  const own = new Set(
    device.interfaces.flatMap((i) =>
      i.address && i.prefixLength !== null
        ? [`${networkAddress(i.address, i.prefixLength)}/${i.prefixLength}`]
        : []
    )
  )
  const best = new Map<string, Route>()
  for (const [id, d] of dist) {
    if (id === device.id) continue
    const hop = firstHop.get(id)
    const router = db.routers.get(id)
    if (!hop || !router) continue
    for (const net of router.ifaces) {
      const key = `${net.network}/${net.prefixLength}`
      if (own.has(key)) continue
      const metric = d + net.cost
      const current = best.get(key)
      if (current && (current.metric ?? Infinity) <= metric) continue
      best.set(key, {
        network: net.network,
        prefixLength: net.prefixLength,
        gateway: hop.gateway,
        ifaceId: hop.ifaceId,
        source: 'ospf',
        distance: 110,
        metric
      })
    }
  }
  // Route par défaut externe de type 2 (métrique 1 quel que soit le chemin) : ASBR le plus proche
  let asbr: { id: string; d: number } | null = null
  for (const [id, d] of dist)
    if (id !== device.id && db.routers.get(id)?.originatesDefault && (!asbr || d < asbr.d)) asbr = { id, d }
  const hop = asbr ? firstHop.get(asbr.id) : undefined
  if (hop && !self.originatesDefault)
    best.set('0.0.0.0/0', {
      network: '0.0.0.0',
      prefixLength: 0,
      gateway: hop.gateway,
      ifaceId: hop.ifaceId,
      source: 'ospf',
      distance: 110,
      metric: 1,
      external: true
    })
  return [...best.values()]
}
