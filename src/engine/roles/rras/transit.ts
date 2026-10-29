/**
 * Acheminement par un serveur RRAS : routage LAN, traduction d'adresses (NAT) sur l'interface
 * publique, proxy ARP et tunnels des clients VPN.
 */
import type { Device, HostDevice, ServerDevice } from '../../model/schema'
import { effectiveIpv4 } from '../../net/addressing'
import { inNetwork, networkAddress } from '../../net/ipv4'
import type { TransitHooks, Tunnel } from '../../sim/transit'
import { natEnabled, rrasOf, vpnEnabled } from './state'
import { serviceRunning } from '../../services/servicestate'

const serverRras = (device: Device) =>
  device.kind === 'server' &&
  device.powered &&
  device.host.features.includes('RemoteAccess') &&
  // Service Routage et accès distant arrêté : plus de routage, de NAT ni de VPN
  serviceRunning(device, 'RemoteAccess')
    ? rrasOf(device)
    : null

/** Adresse de l'interface publique du serveur. */
function publicAddress(server: ServerDevice): string | null {
  const rras = rrasOf(server)
  const iface = server.interfaces.find((i) => i.id === rras?.publicIfaceId)
  return iface ? (effectiveIpv4(iface)?.address ?? null) : null
}

/** Réseaux privés du serveur VPN (toutes ses interfaces sauf l'interface publique). */
function privateNetworks(server: ServerDevice): { network: string; prefix: number }[] {
  const rras = rrasOf(server)
  return server.interfaces.flatMap((i) => {
    const eff = i.id !== rras?.publicIfaceId ? effectiveIpv4(i) : null
    return eff ? [{ network: networkAddress(eff.address, eff.prefixLength), prefix: eff.prefixLength }] : []
  })
}

const vpnLayer = (inner: { src: string; dst: string; summary: string }) => [
  { layer: 4 as const, name: 'TCP', fields: [['Port destination', '443']] as [string, string][] },
  {
    layer: 7 as const,
    name: 'SSTP',
    fields: [
      ['Paquet encapsulé', inner.summary],
      ['Source interne', inner.src],
      ['Destination interne', inner.dst]
    ] as [string, string][]
  }
]

export const rrasTransit: TransitHooks = {
  forwards(_state, device) {
    return !!serverRras(device)?.mode
  },

  proxyArp(_state, device, ip) {
    const rras = serverRras(device)
    return !!rras && vpnEnabled(rras) && rras.sessions.some((s) => s.address === ip)
  },

  translate(ctx, device, ingressIfaceId, egressIfaceId, packet) {
    const rras = serverRras(device)
    if (!rras || !natEnabled(rras) || egressIfaceId !== rras.publicIfaceId) return null
    if (ingressIfaceId === rras.publicIfaceId) return null
    const pub = publicAddress(device as ServerDevice)
    if (!pub || pub === packet.src) return null
    ctx.nat.set(`${device.id}|${pub}|${packet.dst}`, packet.src)
    return { src: pub, note: `${device.name} (NAT) traduit l’adresse source ${packet.src} en ${pub}.` }
  },

  untranslate(ctx, device, packet) {
    const original = ctx.nat.get(`${device.id}|${packet.dst}|${packet.src}`)
    if (!original) return null
    return {
      dst: original,
      note: `${device.name} (NAT) retraduit l’adresse de destination ${packet.dst} en ${original} et transmet la réponse.`
    }
  },

  tunnel(state, device, packet): Tunnel | null {
    // Serveur VPN : paquet destiné à l'adresse attribuée à un client connecté
    const rras = serverRras(device)
    if (rras && vpnEnabled(rras)) {
      const session = rras.sessions.find((s) => s.address === packet.dst)
      const client = session ? state.devices[session.clientDeviceId] : undefined
      const pub = publicAddress(device as ServerDevice)
      if (session && client?.powered && pub)
        return {
          outerSrc: pub,
          outerDst: session.clientAddress,
          endpointId: client.id,
          deliver: true,
          reply: true,
          summary: `VPN (SSTP) ${pub} → ${session.clientAddress}`,
          upper: vpnLayer(packet),
          note: `${client.name} reçoit le paquet par le tunnel VPN (adresse ${packet.dst}).`
        }
    }
    // Client VPN : paquet destiné au réseau privé du serveur
    if (device.kind !== 'server' && device.kind !== 'client') return null
    for (const conn of (device as HostDevice).host.vpnConnections) {
      const c = conn.connected
      if (!c) continue
      const server = state.devices[c.serverDeviceId]
      if (server?.kind !== 'server' || !server.powered || packet.dst === c.serverAddress) continue
      if (!rrasOf(server)?.sessions.some((s) => s.clientDeviceId === device.id)) continue
      if (!privateNetworks(server).some((n) => inNetwork(packet.dst, n.network, n.prefix))) continue
      return {
        outerSrc: c.clientAddress,
        outerDst: c.serverAddress,
        endpointId: server.id,
        innerSrc: c.address,
        deliver: false,
        reply: false,
        summary: `VPN (SSTP) ${c.clientAddress} → ${c.serverAddress}`,
        upper: vpnLayer({ ...packet, src: c.address }),
        note: `${server.name} reçoit le paquet par le tunnel VPN et le désencapsule (source ${c.address}).`
      }
    }
    return null
  }
}
