/**
 * Couleurs associées aux protocoles (enveloppes animées, liste d'événements, légende du canvas).
 */
import type { Protocol } from '@engine/index'

/** Classes de couleur (tokens --sl-proto-*) : toujours accompagnées du nom du protocole. */
export const PROTOCOL_COLORS: Record<Protocol, { fill: string; chip: string }> = {
  ARP: { fill: 'fill-proto-arp', chip: 'bg-proto-arp' },
  ICMP: { fill: 'fill-proto-icmp', chip: 'bg-proto-icmp' },
  DHCP: { fill: 'fill-proto-dhcp', chip: 'bg-proto-dhcp' },
  DNS: { fill: 'fill-proto-dns', chip: 'bg-proto-dns' },
  LDAP: { fill: 'fill-proto-ldap', chip: 'bg-proto-ldap' },
  KERBEROS: { fill: 'fill-proto-kerberos', chip: 'bg-proto-kerberos' },
  SMB: { fill: 'fill-proto-smb', chip: 'bg-proto-smb' },
  HTTP: { fill: 'fill-proto-http', chip: 'bg-proto-http' },
  RDP: { fill: 'fill-proto-rdp', chip: 'bg-proto-rdp' },
  VPN: { fill: 'fill-proto-vpn', chip: 'bg-proto-vpn' },
  RADIUS: { fill: 'fill-proto-radius', chip: 'bg-proto-radius' },
  DTP: { fill: 'fill-proto-dtp', chip: 'bg-proto-dtp' }
}

/** Issue d'un événement de la simulation (clés de traduction `outcome.<issue>`). */
export const OUTCOME_LABELS = {
  forwarded: 'outcome.forwarded',
  delivered: 'outcome.delivered',
  ignored: 'outcome.ignored',
  dropped: 'outcome.dropped'
} as const
