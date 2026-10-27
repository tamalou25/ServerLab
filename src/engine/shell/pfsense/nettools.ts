/**
 * Outils réseau du shell FreeBSD du pare-feu (v2.10, #247) : `ifconfig`, `netstat -rn` et `ping`,
 * calculés depuis l'état (cartes, adresses, passerelles, routes statiques, liens).
 * Mise en forme d'après les sources FreeBSD 14 (sbin/ifconfig, usr.bin/netstat, sbin/ping) ;
 * écarts documentés dans docs/fidelite.md (P-53 à P-55).
 */
import { ping, type EchoOutcome } from '../../net/diagnostics'
import { effectiveIpv4 } from '../../net/addressing'
import { broadcastInt, formatIpv4, networkAddress, parseIpv4, prefixToMaskInt } from '../../net/ipv4'
import { assignmentOfNic, type PfDevice } from '../../net/pf'
import type { LabState, NetInterface } from '../../model/schema'
import { linkOnInterface, otherEnd } from '../../topology/queries'
import type { ExecContext } from '../context'
import { padEnd, padStart } from './term'

/** Description du pilote `em` d'une carte Intel virtualisée, donnée par le noyau à l'écran d'affectation. */
export const EM_DRIVER_DESCRIPTION = 'Intel(R) Legacy PRO/1000 MT 82540EM'

/** Version affichée par la console (bannière et invite du shell). */
export const PFSENSE_RELEASE = '2.7.2-RELEASE'

/** Adresse MAC au format FreeBSD (minuscules, deux-points). */
export const bsdMac = (nic: NetInterface): string => nic.mac.toLowerCase().replaceAll('-', ':')

/** Porteuse présente : carte activée, câble branché et équipement du bout allumé avec sa carte activée. */
export function hasCarrier(state: LabState, device: PfDevice, nic: NetInterface): boolean {
  if (!device.powered || !nic.enabled) return false
  const link = linkOnInterface(state, device.id, nic.id)
  if (!link) return false
  const end = otherEnd(link, device.id, nic.id)
  const peer = state.devices[end.deviceId]
  const peerNic = peer?.interfaces.find((i) => i.id === end.ifaceId)
  return !!peer && !!peerNic && peer.powered && peerNic.enabled
}

/** Nom de l'hôte tel que la console l'affiche (nom d'hôte, suivi du domaine s'il existe). */
export const fqdn = (device: PfDevice): string =>
  device.pf.domain ? `${device.pf.hostname}.${device.pf.domain}` : device.pf.hostname

// --- ifconfig -------------------------------------------------------------------------------------

function nicLines(state: LabState, device: PfDevice, nic: NetInterface): string[] {
  const carrier = hasCarrier(state, device, nic)
  // UP (0x1), BROADCAST (0x2), RUNNING (0x40), SIMPLEX (0x800), MULTICAST (0x8000)
  const flags = nic.enabled
    ? carrier
      ? '8843<UP,BROADCAST,RUNNING,SIMPLEX,MULTICAST>'
      : '8803<UP,BROADCAST,SIMPLEX,MULTICAST>'
    : '8802<BROADCAST,SIMPLEX,MULTICAST>'
  const lines = [`${nic.name}: flags=${flags} metric 0 mtu 1500`]
  const assignment = assignmentOfNic(device.pf, nic.id)
  if (assignment) lines.push(`\tdescription: ${assignment.descr}`)
  lines.push(`\tether ${bsdMac(nic)}`)
  const eff = nic.enabled ? effectiveIpv4(nic) : null
  if (eff && assignment) {
    const mask = prefixToMaskInt(eff.prefixLength)
    let line = `\tinet ${eff.address} netmask 0x${mask.toString(16)}`
    const ip = parseIpv4(eff.address)
    if (ip !== null && eff.prefixLength < 31) line += ` broadcast ${formatIpv4(broadcastInt(ip, eff.prefixLength))}`
    lines.push(line)
  }
  lines.push(
    '\tmedia: Ethernet autoselect (1000baseT <full-duplex>)',
    `\tstatus: ${carrier ? 'active' : 'no carrier'}`,
    '\tnd6 options=21<PERFORMNUD,AUTO_LINKLOCAL>'
  )
  return lines
}

const LOOPBACK_LINES = [
  'lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> metric 0 mtu 16384',
  '\tinet 127.0.0.1 netmask 0xff000000',
  '\tgroups: lo',
  '\tnd6 options=21<PERFORMNUD,AUTO_LINKLOCAL>'
]

/** `ifconfig` (toutes les interfaces) ou `ifconfig <nom>` ; null si l'interface n'existe pas. */
export function ifconfigLines(state: LabState, device: PfDevice, name?: string): string[] | null {
  if (name === 'lo0') return LOOPBACK_LINES
  if (name !== undefined) {
    const nic = device.interfaces.find((i) => i.name === name)
    return nic ? nicLines(state, device, nic) : null
  }
  return [...device.interfaces.flatMap((nic) => nicLines(state, device, nic)), ...LOOPBACK_LINES]
}

// --- netstat -rn ----------------------------------------------------------------------------------

interface RouteRow {
  dest: string
  gateway: string
  flags: string
  netif: string
  key: [number, number]
}

/** `netstat -rn` : table de routage IPv4 du pare-feu. */
export function netstatRoutes(device: PfDevice): string[] {
  const rows: RouteRow[] = []
  const nics = device.interfaces
  const linkOf = (nic: NetInterface): string => `link#${nics.indexOf(nic) + 1}`
  const loLink = `link#${nics.length + 2}`
  const key = (ip: string, prefix: number): [number, number] => [parseIpv4(ip) ?? 0, prefix]

  const defaultGw = device.pf.gateways.find((g) => g.isDefault)
  const gwNic = (iface: string) => nics.find((n) => assignmentOfNic(device.pf, n.id)?.key === iface)
  if (defaultGw) {
    const nic = gwNic(defaultGw.iface)
    if (nic) rows.push({ dest: 'default', gateway: defaultGw.address, flags: 'UGS', netif: nic.name, key: [-1, 0] })
  }
  rows.push({ dest: '127.0.0.1', gateway: loLink, flags: 'UH', netif: 'lo0', key: key('127.0.0.1', 32) })
  for (const nic of nics) {
    const eff = nic.enabled && assignmentOfNic(device.pf, nic.id) ? effectiveIpv4(nic) : null
    if (!eff) continue
    const net = networkAddress(eff.address, eff.prefixLength)
    rows.push({
      dest: `${net}/${eff.prefixLength}`,
      gateway: linkOf(nic),
      flags: 'U',
      netif: nic.name,
      key: key(net, eff.prefixLength)
    })
    rows.push({ dest: eff.address, gateway: linkOf(nic), flags: 'UHS', netif: 'lo0', key: key(eff.address, 32) })
  }
  for (const route of device.pf.staticRoutes) {
    if (route.disabled) continue
    const gw = device.pf.gateways.find((g) => g.name === route.gateway)
    const nic = gw ? gwNic(gw.iface) : undefined
    if (!gw || !nic) continue
    rows.push({
      dest: route.prefixLength === 32 ? route.network : `${route.network}/${route.prefixLength}`,
      gateway: gw.address,
      flags: route.prefixLength === 32 ? 'UGHS' : 'UGS',
      netif: nic.name,
      key: key(route.network, route.prefixLength)
    })
  }
  rows.sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1])
  const row = (r: RouteRow): string =>
    `${padEnd(r.dest, 18)} ${padEnd(r.gateway, 18)} ${padEnd(r.flags, 6)} ${padStart(r.netif, 12)}`.trimEnd()
  return [
    'Routing tables',
    '',
    'Internet:',
    `${padEnd('Destination', 18)} ${padEnd('Gateway', 18)} ${padEnd('Flags', 6)} ${padStart('Netif', 12)} ${padStart('Expire', 6)}`,
    ...rows.map(row)
  ]
}

// --- ping -----------------------------------------------------------------------------------------

/** Message ICMP du type « Destination … Unreachable » d'après le texte du moteur. */
const unreachableText = (message: string): string =>
  message.includes('réseau') ? 'Destination Net Unreachable' : 'Destination Host Unreachable'

/**
 * `ping -c <n> -n <adresse>` (FreeBSD) : lignes de sortie. La trace des paquets est ajoutée au contexte
 * (mode Simulation). Les durées sont celles du simulateur, en millisecondes entières.
 */
export function bsdPing(ctx: ExecContext, host: string, count: number): string[] {
  const res = ping(ctx.state, ctx.deviceId, host, { count, size: 56 })
  if (!res.ok) return [`ping: ${res.error.message}`]
  ctx.addTrace(res.value.trace)
  const lines = [`PING ${host} (${host}): 56 data bytes`]
  const times: number[] = []
  res.value.outcomes.forEach((o: EchoOutcome, seq: number) => {
    switch (o.kind) {
      case 'reply':
        times.push(o.time)
        lines.push(`64 bytes from ${o.from}: icmp_seq=${seq} ttl=${o.ttl} time=${o.time.toFixed(3)} ms`)
        break
      case 'unreachable':
        lines.push(`36 bytes from ${o.from}: ${unreachableText(o.message)}`)
        break
      case 'ttl-expired':
        lines.push(`36 bytes from ${o.from}: Time to live exceeded`)
        break
      case 'transmit-failed':
        lines.push('ping: sendto: No route to host')
        break
      case 'timeout':
        break
    }
  })
  const sent = res.value.outcomes.length
  lines.push('', `--- ${host} ping statistics ---`)
  lines.push(
    `${sent} packets transmitted, ${times.length} packets received, ${(((sent - times.length) * 100) / sent).toFixed(1)}% packet loss`
  )
  if (times.length > 0) {
    const n = times.length
    const avg = times.reduce((a, b) => a + b, 0) / n
    const sq = times.reduce((a, b) => a + b * b, 0) / n
    const stddev = Math.sqrt(Math.max(0, sq - avg * avg))
    lines.push(
      `round-trip min/avg/max/stddev = ${Math.min(...times).toFixed(3)}/${avg.toFixed(3)}/${Math.max(...times).toFixed(3)}/${stddev.toFixed(3)} ms`
    )
  }
  return lines
}
