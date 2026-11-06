/**
 * Zones réseau du plan (regroupement visuel, lecture seule) : une zone par réseau IPv4 calculé
 * depuis l'adresse et le masque **effectifs** de chaque interface (statique ou bail DHCP ; APIPA,
 * interfaces désactivées, sans adresse ou débranchées exclues).
 *
 * Membres enveloppés : les hôtes (serveurs, postes) adressés dans le réseau, et un switch seulement
 * si tous ses ports d'accès reliés à des hôtes adressés appartiennent à ce même réseau. Routeurs et
 * pare-feu ne sont jamais membres : ils sont la frontière, leur interface dans le réseau figure dans
 * les passerelles de la zone. Le VLAN n'est donné que si tous les hôtes membres sont raccordés par
 * un port d'accès du même VLAN. La zone est descriptive (« ces adresses partagent un préfixe ») et
 * n'implique pas la connectivité : aucun test ARP ni L2.
 */
import type { Device, LabState } from '../model/schema'
import { effectiveIpv4 } from '../net/addressing'
import { isApipa, networkAddress, parseIpv4 } from '../net/ipv4'
import { memoByNetwork } from '../net/network-key'
import { switchportOf } from '../net/switchport'
import { isHostDevice, linkOnInterface, otherEnd } from './queries'

export interface ZoneGateway {
  deviceId: string
  deviceName: string
  ifaceName: string
  address: string
}

export interface NetworkZone {
  /** Réseau en notation CIDR, ex. « 192.168.10.0/24 » (identifiant stable de la zone). */
  cidr: string
  /** VLAN d'accès commun à tous les hôtes membres, sinon absent. */
  vlan?: number
  /** Interfaces de routeurs et de pare-feu adressées dans ce réseau (frontière de la zone). */
  gateways: ZoneGateway[]
  /** Hôtes et switchs enveloppés par la zone. */
  deviceIds: string[]
}

interface Membership {
  cidr: string
  vlan: number | null
}

/** Réseau IPv4 effectif d'une interface adressée (ni APIPA, ni désactivée), sinon null. */
function networkOf(iface: Device['interfaces'][number]): string | null {
  const ip = effectiveIpv4(iface)
  if (!ip || isApipa(ip.address) || parseIpv4(ip.address) === null) return null
  return `${networkAddress(ip.address, ip.prefixLength)}/${ip.prefixLength}`
}

/** VLAN d'accès du port de switch en face d'une interface d'hôte (null : pas de switch, trunk…). */
function accessVlanFacing(state: LabState, deviceId: string, ifaceId: string): number | null {
  const link = linkOnInterface(state, deviceId, ifaceId)
  if (!link) return null
  const peer = otherEnd(link, deviceId, ifaceId)
  const sw = state.devices[peer.deviceId]
  if (!sw || sw.kind !== 'switch') return null
  const port = sw.interfaces.find((i) => i.id === peer.ifaceId)
  if (!port) return null
  const sp = switchportOf(port)
  return sp.mode === 'access' ? sp.accessVlan : null
}

function computeNetworkZones(state: LabState): NetworkZone[] {
  const zones = new Map<string, NetworkZone & { vlans: Set<number | null>; hostCount: number }>()
  const zone = (cidr: string) => {
    let z = zones.get(cidr)
    if (!z) {
      z = { cidr, gateways: [], deviceIds: [], vlans: new Set(), hostCount: 0 }
      zones.set(cidr, z)
    }
    return z
  }
  // Appartenance de chaque hôte (par interface adressée) et interfaces de frontière
  const hostMemberships = new Map<string, Membership[]>()
  for (const device of Object.values(state.devices)) {
    if (!device.powered) continue
    if (isHostDevice(device)) {
      const memberships: Membership[] = []
      for (const iface of device.interfaces) {
        const cidr = networkOf(iface)
        if (!cidr) continue
        memberships.push({ cidr, vlan: accessVlanFacing(state, device.id, iface.id) })
      }
      if (memberships.length > 0) hostMemberships.set(device.id, memberships)
    } else if (device.kind === 'router' || device.kind === 'firewall') {
      for (const iface of device.interfaces) {
        const cidr = networkOf(iface)
        const ip = effectiveIpv4(iface)
        if (!cidr || !ip) continue
        zone(cidr).gateways.push({
          deviceId: device.id,
          deviceName: device.name,
          ifaceName: iface.name,
          address: ip.address
        })
      }
    }
  }
  for (const [deviceId, memberships] of hostMemberships) {
    for (const m of memberships) {
      const z = zone(m.cidr)
      if (!z.deviceIds.includes(deviceId)) {
        z.deviceIds.push(deviceId)
        z.hostCount++
      }
      z.vlans.add(m.vlan)
    }
  }
  // Switch membre d'une zone si tous ses ports d'accès vers des hôtes adressés sont dans ce réseau
  for (const device of Object.values(state.devices)) {
    if (device.kind !== 'switch' || !device.powered) continue
    const networks = new Set<string>()
    let hosts = 0
    for (const port of device.interfaces) {
      const link = linkOnInterface(state, device.id, port.id)
      if (!link) continue
      const peer = otherEnd(link, device.id, port.id)
      const memberships = hostMemberships.get(peer.deviceId)
      if (!memberships) continue
      const facing = memberships.find((m) => {
        const peerIface = state.devices[peer.deviceId]?.interfaces.find((i) => i.id === peer.ifaceId)
        return peerIface ? networkOf(peerIface) === m.cidr : false
      })
      if (!facing) continue
      hosts++
      networks.add(facing.cidr)
    }
    if (hosts > 0 && networks.size === 1) {
      const [cidr] = networks
      zone(cidr!).deviceIds.push(device.id)
    }
  }
  // Zones avec au moins un hôte, triées par réseau ; VLAN seulement s'il est unique et connu
  return [...zones.values()]
    .filter((z) => z.hostCount > 0)
    .sort((a, b) => a.cidr.localeCompare(b.cidr, undefined, { numeric: true }))
    .map(({ vlans, hostCount: _hosts, ...z }) => {
      const list = [...vlans]
      const unique = list.length === 1 && list[0] !== null ? list[0] : undefined
      return unique === undefined ? z : { ...z, vlan: unique }
    })
}

/** Zones réseau du plan, recalculées seulement quand le réseau change (pas au déplacement). */
export const networkZones: (state: LabState) => NetworkZone[] = memoByNetwork(computeNetworkZones)
