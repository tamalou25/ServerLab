/**
 * Écriture des baux d'isc-dhcp-server (v2.9, #240) : appelée par le client DHCP du moteur quand un
 * serveur Linux accorde, prolonge ou reprend un bail. Écrit dhcpd.leases (blocs `lease`) et le journal
 * de l'unité (`dhcpd[pid]: DHCPDISCOVER from …`, mêmes messages que dhcpd, syslog).
 */
import type { Draft } from 'immer'
import { logEvent } from '../core/eventlog'
import type { HostDevice, LabState } from '../model/schema'
import { findUnit } from './linuxcatalog'
import { appendLeases, leaseBlock } from './linuxdhcp'
import { unitPid } from './linuxsystem'

const colonMac = (mac: string) => mac.toLowerCase().replace(/-/g, ':')

function log(draft: Draft<LabState>, server: HostDevice, lines: string[]) {
  const unit = findUnit('isc-dhcp-server')
  if (!unit) return
  const pid = unitPid(server, unit)
  for (const message of lines)
    logEvent(draft, server.id, {
      level: 'information',
      source: 'systemd',
      eventId: 0,
      message: `dhcpd[${pid}]: ${message}`,
      account: unit.name
    })
}

export interface LinuxLeaseInfo {
  ip: string
  mac: string
  hostName: string
  serverIp: string
  /** Nom de l'interface du serveur qui reçoit la requête. */
  via: string
  now: number
  ends: number
}

const who = (i: LinuxLeaseInfo) => `${colonMac(i.mac)}${i.hostName ? ` (${i.hostName})` : ''}`
const block = (i: LinuxLeaseInfo, state: 'active' | 'free') =>
  leaseBlock({
    ip: i.ip,
    starts: i.now,
    ends: i.ends,
    state,
    mac: i.mac,
    hostname: i.hostName || null
  })

/** Échange complet (DISCOVER, OFFER, REQUEST, ACK) : un nouveau bail est écrit. */
export function leaseGranted(draft: Draft<LabState>, server: HostDevice, i: LinuxLeaseInfo): void {
  appendLeases(server, [block(i, 'active')])
  log(draft, server, [
    `DHCPDISCOVER from ${colonMac(i.mac)} via ${i.via}`,
    `DHCPOFFER on ${i.ip} to ${who(i)} via ${i.via}`,
    `DHCPREQUEST for ${i.ip} (${i.serverIp}) from ${who(i)} via ${i.via}`,
    `DHCPACK on ${i.ip} to ${who(i)} via ${i.via}`
  ])
}

/** Renouvellement : REQUEST puis ACK, le bail est réécrit avec de nouvelles dates. */
export function leaseRenewed(draft: Draft<LabState>, server: HostDevice, i: LinuxLeaseInfo): void {
  appendLeases(server, [block(i, 'active')])
  log(draft, server, [
    `DHCPREQUEST for ${i.ip} from ${who(i)} via ${i.via}`,
    `DHCPACK on ${i.ip} to ${who(i)} via ${i.via}`
  ])
}

/** DHCPRELEASE : le bail passe à l'état `free`. */
export function leaseReleased(draft: Draft<LabState>, server: HostDevice, i: LinuxLeaseInfo): void {
  appendLeases(server, [block({ ...i, ends: i.now }, 'free')])
  log(draft, server, [`DHCPRELEASE of ${i.ip} from ${who(i)} via ${i.via} (found)`])
}
