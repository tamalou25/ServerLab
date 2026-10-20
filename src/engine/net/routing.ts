/**
 * Tables de routage : routes connectées, statiques et passerelle par défaut.
 */
import { isLinuxHost } from '../model/host'
import type { Device, LabState } from '../model/schema'
import { effectiveIpv4 } from './addressing'
import { inNetwork, networkAddress, parseIpv4, prefixToMaskInt } from './ipv4'
import { l2Segment } from './segment'
import { iosDynamicRoutes, iosInterfaceRoutes } from '../ios/registry'

export type RouteSource = 'connected' | 'static' | 'default' | 'ospf' | 'rip'

export interface Route {
  network: string
  prefixLength: number
  /** Passerelle (null pour un réseau directement connecté). */
  gateway: string | null
  ifaceId: string
  source: RouteSource
  /** Distance administrative et métrique (routage dynamique : OSPF 110/coût). */
  distance?: number
  metric?: number
  /** Route externe OSPF de type 2 (default-information originate : O*E2). */
  external?: boolean
}

/** TTL initial selon le type d'équipement. */
export function initialTtl(device: Device): number {
  if (device.kind === 'router' || device.kind === 'switch' || device.kind === 'cloud') return 255
  // Linux : net.ipv4.ip_default_ttl = 64 ; Windows : 128
  return isLinuxHost(device) ? 64 : 128
}

/**
 * Routes connectées (une par carte disposant d'une adresse). Équipement IOS : seulement les
 * interfaces up/up (la route disparaît quand le lien tombe).
 */
function connectedRoutes(state: LabState, device: Device): Route[] {
  const routes: Route[] = []
  if (!device.powered) return routes
  for (const iface of device.interfaces) {
    const eff = effectiveIpv4(iface)
    if (!eff || !iosInterfaceRoutes(state, device, iface)) continue
    routes.push({
      network: networkAddress(eff.address, eff.prefixLength),
      prefixLength: eff.prefixLength,
      gateway: null,
      ifaceId: iface.id,
      source: 'connected'
    })
  }
  return routes
}

/** Table de routage complète d'un équipement. */
export function routingTable(state: LabState, device: Device): Route[] {
  const connected = connectedRoutes(state, device)
  const onLink = (ip: string) => connected.find((r) => inNetwork(ip, r.network, r.prefixLength))
  const routes = [...connected]

  if (device.kind === 'server' || device.kind === 'client') {
    // Passerelle par défaut : première carte dont la passerelle est sur son propre sous-réseau
    for (const iface of device.interfaces) {
      const eff = effectiveIpv4(iface)
      if (!eff?.gateway) continue
      if (!inNetwork(eff.gateway, networkAddress(eff.address, eff.prefixLength), eff.prefixLength)) continue
      routes.push({
        network: '0.0.0.0',
        prefixLength: 0,
        gateway: eff.gateway,
        ifaceId: iface.id,
        source: 'default'
      })
      break
    }
  } else if (device.kind === 'router' || device.kind === 'switch') {
    // Une route statique n'est active que si son prochain saut est directement joignable
    for (const r of device.routes ?? []) {
      const via = onLink(r.nextHop)
      if (!via) continue
      routes.push({
        network: r.network,
        prefixLength: r.prefixLength,
        gateway: r.nextHop,
        ifaceId: via.ifaceId,
        source: r.prefixLength === 0 ? 'default' : 'static'
      })
    }
    // Routage dynamique des équipements IOS (OSPF), après les routes connectées et statiques
    const known = new Set(routes.map((r) => `${r.network}/${r.prefixLength}`))
    for (const r of iosDynamicRoutes(state, device))
      if (!known.has(`${r.network}/${r.prefixLength}`)) routes.push(r)
  } else if (device.kind === 'cloud') {
    // Le FAI renvoie tout le trafic vers le premier équipement adressé de son lien WAN
    const wan = device.interfaces[0]
    if (wan && effectiveIpv4(wan)) {
      for (const member of l2Segment(state, { deviceId: device.id, ifaceId: wan.id })) {
        const peer = state.devices[member.port.deviceId]
        const peerIface = peer?.interfaces.find((i) => i.id === member.port.ifaceId)
        const eff = peerIface ? effectiveIpv4(peerIface) : null
        if (eff && onLink(eff.address)) {
          routes.push({
            network: '0.0.0.0',
            prefixLength: 0,
            gateway: eff.address,
            ifaceId: wan.id,
            source: 'default'
          })
          break
        }
      }
    }
  }
  return routes
}

/** Recherche de la route la plus spécifique (plus long préfixe). */
export function lookupRoute(routes: Route[], destination: string): Route | null {
  const dst = parseIpv4(destination)
  if (dst === null) return null
  let best: Route | null = null
  for (const route of routes) {
    const net = parseIpv4(route.network)
    if (net === null) continue
    const mask = prefixToMaskInt(route.prefixLength)
    if ((dst & mask) >>> 0 !== (net & mask) >>> 0) continue
    if (!best || route.prefixLength > best.prefixLength) best = route
  }
  return best
}
