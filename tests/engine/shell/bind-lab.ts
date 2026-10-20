/**
 * Lab des tests Bind9 et isc-dhcp-server (v2.9, #240) : le lab Samba (serveur Linux LSRV1 192.168.2.10, poste
 * Linux LNX1, poste Windows PC1, serveur Windows SRV1 192.168.2.1) et des commandes qui écrivent des fichiers.
 */
import type { Command } from './samba-lab'

export { buildSambaLab as buildBindLab, Consoles, type Command, type Who } from './samba-lab'

/** Écrit un fichier (une commande tee par ligne ; la première écrase). */
export function writeFile(path: string, lines: string[]): Command[] {
  return lines.map((l, i) => ['srv', `echo '${l}' | sudo tee ${i === 0 ? '' : '-a '}${path}`] as Command)
}

export const ZONE_FILE = '/var/cache/bind/db.lab.lan'
export const REV_FILE = '/var/cache/bind/db.192.168.2'
export const NAMED_LOCAL = '/etc/bind/named.conf.local'

/** Zone directe lab.lan : serveur de noms, www, un alias, un MX. */
export const ZONE_LINES = [
  '$TTL 604800',
  '@ IN SOA ns1.lab.lan. admin.lab.lan. (',
  '        2         ; Serial',
  '        604800    ; Refresh',
  '        86400     ; Retry',
  '        2419200   ; Expire',
  '        604800 )  ; Negative Cache TTL',
  '@ IN NS ns1.lab.lan.',
  '@ IN MX 10 mail.lab.lan.',
  'ns1 IN A 192.168.2.10',
  'www IN A 192.168.2.20',
  'mail IN A 192.168.2.25',
  'web IN CNAME www'
]

/** Zone inverse 2.168.192.in-addr.arpa. */
export const REV_LINES = [
  '$TTL 604800',
  '@ IN SOA ns1.lab.lan. admin.lab.lan. (',
  '        1         ; Serial',
  '        604800    ; Refresh',
  '        86400     ; Retry',
  '        2419200   ; Expire',
  '        604800 )  ; Negative Cache TTL',
  '@ IN NS ns1.lab.lan.',
  '10 IN PTR ns1.lab.lan.',
  '20 IN PTR www.lab.lan.'
]

export const LOCAL_ZONES = [
  'zone "lab.lan" {',
  '    type master;',
  '    file "db.lab.lan";',
  '};',
  'zone "2.168.192.in-addr.arpa" {',
  '    type master;',
  '    file "db.192.168.2";',
  '};'
]

export const INSTALL_BIND: Command = ['srv', 'sudo apt install bind9', ['y']]

/** named.conf.local d'origine remplacé par un commentaire, puis les lignes données. */
export const localConf = (lines: string[]): Command[] => writeFile(NAMED_LOCAL, ['// vide', ...lines])

/** Installation de bind9 et zones lab.lan (directe et inverse) chargées par named. */
export const BIND_READY: Command[] = [
  INSTALL_BIND,
  ...writeFile(ZONE_FILE, ZONE_LINES),
  ...writeFile(REV_FILE, REV_LINES),
  ...localConf(LOCAL_ZONES),
  ['srv', 'sudo rndc reload']
]

export const CONF_DEFAULTS = 'INTERFACESv4="eth0"'

/** dhcpd.conf du lab : sous-réseau 192.168.2.0/24, plage .100 à .110, passerelle, DNS et domaine. */
export const DHCPD_LINES = [
  'default-lease-time 600;',
  'max-lease-time 7200;',
  'authoritative;',
  'subnet 192.168.2.0 netmask 255.255.255.0 {',
  '  range 192.168.2.100 192.168.2.110;',
  '  option routers 192.168.2.254;',
  '  option domain-name-servers 192.168.2.10;',
  '  option domain-name "lab.lan";',
  '}'
]

export const INSTALL_DHCP: Command = ['srv', 'sudo apt install isc-dhcp-server', ['y']]

/** isc-dhcp-server configuré et démarré. */
export const DHCP_READY: Command[] = [
  INSTALL_DHCP,
  ...writeFile('/etc/default/isc-dhcp-server', [CONF_DEFAULTS]),
  ...writeFile('/etc/dhcp/dhcpd.conf', DHCPD_LINES),
  ['srv', 'sudo systemctl restart isc-dhcp-server']
]
