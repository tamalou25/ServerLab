/**
 * Tests golden Bind9 et isc-dhcp-server (v2.9, #240) : chaque sortie simulée est comparée, ligne par ligne,
 * à `docs/captures/bash/<nom>.txt` (en-tête « # Source: »). Les captures sont reconstituées d'après les
 * pages de manuel et les sources Debian bookworm (bind9 1:9.18 : lib/isccfg, lib/dns/master.c, zone.c,
 * bin/rndc ; isc-dhcp-server 4.4.3-P1 : server/dhcpd.c, server/confpars.c, common/parse.c) : pas de VM,
 * docs/fidelite.md, « À vérifier (v2.9 — Linux) », lignes L-90 à L-99.
 *
 * Le déroulé suit UN SEUL lab (serveur LSRV1, poste LNX1, poste Windows PC1) : l'ordre des étapes compte.
 */
import { describe, expect, it } from 'vitest'
import { diffLines, readCapture } from '../golden/golden'
import {
  buildBindLab,
  CONF_DEFAULTS,
  Consoles,
  DHCPD_LINES,
  INSTALL_BIND,
  INSTALL_DHCP,
  LOCAL_ZONES,
  localConf,
  REV_FILE,
  REV_LINES,
  writeFile,
  ZONE_FILE,
  ZONE_LINES,
  type Command,
  type Who
} from './bind-lab'

/** [capture, machine, ligne tapée, réponses aux invites, préparation (non comparée)] */
type Step = [string, Who, string, string[]?, Command[]?]

const ZONES: Command[] = [
  ...writeFile(ZONE_FILE, ZONE_LINES),
  ...writeFile(REV_FILE, REV_LINES),
  ...localConf(LOCAL_ZONES)
]
const MALFORMED = (lines: string[]) => writeFile('/tmp/zone.db', lines)
const HEAD = ['$TTL 604800', '@ IN SOA ns1.lab.lan. admin.lab.lan. ( 1 604800 86400 2419200 604800 )']
const DHCP_CONF = (lines: string[]) => writeFile('/etc/dhcp/dhcpd.conf', lines)
const DEFAULTS = writeFile('/etc/default/isc-dhcp-server', [CONF_DEFAULTS])

export const BIND_STEPS: Step[] = [
  // --- named-checkconf ---------------------------------------------------------------------------
  ['named-checkconf', 'srv', 'sudo named-checkconf', [], [INSTALL_BIND]],
  ['named-checkconf-z-defaut', 'srv', 'sudo named-checkconf -z'],
  [
    'named-checkconf-point-virgule',
    'srv',
    'sudo named-checkconf',
    [],
    localConf(['zone "lab.lan" {', '    type master;', '    file "db.lab.lan"', '};'])
  ],
  [
    'named-checkconf-option-inconnue',
    'srv',
    'sudo named-checkconf',
    [],
    localConf(['zone "lab.lan" {', '    type master;', '    file "x";', '    bogus yes;', '};'])
  ],
  ['named-checkconf-instruction-inconnue', 'srv', 'sudo named-checkconf', [], localConf(['foo bar;'])],
  [
    'named-checkconf-sans-file',
    'srv',
    'sudo named-checkconf',
    [],
    localConf(['zone "lab.lan" {', '    type master;', '};'])
  ],
  [
    'named-checkconf-sans-type',
    'srv',
    'sudo named-checkconf',
    [],
    localConf(['zone "lab.lan" {', '    file "x";', '};'])
  ],
  [
    'named-checkconf-doublon',
    'srv',
    'sudo named-checkconf',
    [],
    localConf([
      'zone "lab.lan" {',
      '    type master;',
      '    file "x";',
      '};',
      'zone "lab.lan" {',
      '    type master;',
      '    file "y";',
      '};'
    ])
  ],
  [
    'named-checkconf-include-absent',
    'srv',
    'sudo named-checkconf',
    [],
    localConf(['include "/etc/bind/nexiste.conf";'])
  ],
  ['named-checkconf-fichier-absent', 'srv', 'sudo named-checkconf /etc/bind/nexiste.conf'],
  ['named-checkconf-z-fichier-absent', 'srv', 'sudo named-checkconf -z', [], localConf(LOCAL_ZONES)],
  // --- named-checkzone ---------------------------------------------------------------------------
  [
    'named-checkzone',
    'srv',
    'named-checkzone lab.lan /var/cache/bind/db.lab.lan',
    [],
    [...writeFile(ZONE_FILE, ZONE_LINES), ...writeFile(REV_FILE, REV_LINES)]
  ],
  ['named-checkzone-inverse', 'srv', 'named-checkzone 2.168.192.in-addr.arpa /var/cache/bind/db.192.168.2'],
  [
    'named-checkzone-ns-sans-adresse',
    'srv',
    'named-checkzone lab.lan /tmp/zone.db',
    [],
    MALFORMED([...HEAD, '@ IN NS ns2.lab.lan.'])
  ],
  [
    'named-checkzone-dotted-quad',
    'srv',
    'named-checkzone lab.lan /tmp/zone.db',
    [],
    MALFORMED([...HEAD, '@ IN NS ns1.lab.lan.', 'ns1 IN A 192.168.2', 'www IN A 192.168.2.20'])
  ],
  [
    'named-checkzone-sans-soa',
    'srv',
    'named-checkzone lab.lan /tmp/zone.db',
    [],
    MALFORMED(['$TTL 604800', '@ IN NS ns1.lab.lan.', 'ns1 IN A 192.168.2.10'])
  ],
  [
    'named-checkzone-cname-autres-donnees',
    'srv',
    'named-checkzone lab.lan /tmp/zone.db',
    [],
    MALFORMED([
      ...HEAD,
      '@ IN NS ns1.lab.lan.',
      'ns1 IN A 192.168.2.10',
      'www IN A 192.168.2.20',
      'www IN CNAME ns1'
    ])
  ],
  [
    'named-checkzone-hors-zone',
    'srv',
    'named-checkzone lab.lan /tmp/zone.db',
    [],
    MALFORMED([...HEAD, '@ IN NS ns1.lab.lan.', 'ns1 IN A 192.168.2.10', 'www.autre.org. IN A 192.168.2.20'])
  ],
  ['named-checkzone-fichier-absent', 'srv', 'named-checkzone lab.lan /tmp/nexiste.db'],
  ['named-checkzone-usage', 'srv', 'named-checkzone lab.lan'],
  // --- named-checkconf -z, rndc ------------------------------------------------------------------
  ['named-checkconf-z', 'srv', 'sudo named-checkconf -z', [], ZONES],
  ['rndc-sans-sudo', 'srv', 'rndc status'],
  ['rndc-reload', 'srv', 'sudo rndc reload'],
  ['rndc-status', 'srv', 'sudo rndc status'],
  ['rndc-reload-zone-a-jour', 'srv', 'sudo rndc reload lab.lan'],
  [
    'rndc-reload-zone',
    'srv',
    'sudo rndc reload lab.lan',
    [],
    [['srv', "echo 'ftp IN A 192.168.2.40' | sudo tee -a /var/cache/bind/db.lab.lan"]]
  ],
  ['rndc-reload-zone-inconnue', 'srv', 'sudo rndc reload nexiste.lan'],
  [
    'rndc-reload-erreur',
    'srv',
    'sudo rndc reload',
    [],
    localConf(['zone "x.lan" {', '    type master;', '};'])
  ],
  ['rndc-flush', 'srv', 'sudo rndc flush', [], localConf(LOCAL_ZONES)],
  // --- Clients DNS : dig, host, nslookup -----------------------------------------------------------
  ['dig-autoritaire', 'srv', 'dig @192.168.2.10 www.lab.lan', [], [['srv', 'sudo rndc reload']]],
  ['dig-alias', 'srv', 'dig @192.168.2.10 web.lab.lan'],
  ['dig-nxdomain', 'srv', 'dig @192.168.2.10 nope.lab.lan'],
  ['dig-sans-donnee', 'srv', 'dig @192.168.2.10 www.lab.lan AAAA'],
  ['dig-mx-court', 'srv', 'dig @192.168.2.10 lab.lan MX +short'],
  ['dig-inverse', 'srv', 'dig @192.168.2.10 -x 192.168.2.20'],
  ['host-adresse', 'srv', 'host www.lab.lan 192.168.2.10'],
  ['host-alias', 'srv', 'host web.lab.lan 192.168.2.10'],
  ['host-mx', 'srv', 'host -t MX lab.lan 192.168.2.10'],
  ['host-inverse', 'srv', 'host 192.168.2.20 192.168.2.10'],
  ['host-nxdomain', 'srv', 'host nope.lab.lan 192.168.2.10'],
  ['host-sans-enregistrement', 'srv', 'host -t AAAA www.lab.lan 192.168.2.10'],
  ['nslookup-bind', 'pc', 'nslookup www.lab.lan 192.168.2.10'],
  ['nslookup-bind-inverse', 'pc', 'nslookup 192.168.2.20 192.168.2.10'],
  ['nslookup-bind-nxdomain', 'pc', 'nslookup nope.lab.lan 192.168.2.10'],
  ['rndc-named-arrete', 'srv', 'sudo rndc reload', [], [['srv', 'sudo systemctl stop named']]],
  // --- isc-dhcp-server -----------------------------------------------------------------------------
  ['systemctl-start-dhcp-echec', 'srv', 'sudo systemctl start isc-dhcp-server', [], [INSTALL_DHCP]],
  ['cat-default-isc-dhcp-server', 'srv', 'cat /etc/default/isc-dhcp-server'],
  ['dhcpd-t-defaut', 'srv', 'sudo dhcpd -t'],
  [
    'dhcpd-t-point-virgule',
    'srv',
    'sudo dhcpd -t',
    [],
    DHCP_CONF(['default-lease-time 600', 'max-lease-time 7200;'])
  ],
  ['dhcpd-t-option-inconnue', 'srv', 'sudo dhcpd -t', [], DHCP_CONF(['option domain-nom "lab.lan";'])],
  ['dhcpd-t-instruction-inconnue', 'srv', 'sudo dhcpd -t', [], DHCP_CONF(['default-lease-times 600;'])],
  [
    'dhcpd-t-plage-hors-reseau',
    'srv',
    'sudo dhcpd -t',
    [],
    DHCP_CONF(['subnet 192.168.2.0 netmask 255.255.255.0 {', '  range 192.168.3.100 192.168.3.110;', '}'])
  ],
  [
    'dhcpd-t-masque',
    'srv',
    'sudo dhcpd -t',
    [],
    DHCP_CONF(['subnet 192.168.2.5 netmask 255.255.255.0 {', '}'])
  ],
  [
    'dhcpd-t-accolade',
    'srv',
    'sudo dhcpd -t',
    [],
    DHCP_CONF(['subnet 192.168.2.0 netmask 255.255.255.0 {', '  range 192.168.2.100 192.168.2.110;'])
  ],
  ['dhcpd-t-fichier-absent', 'srv', 'sudo dhcpd -t -cf /etc/dhcp/nexiste.conf'],
  ['dhcpd-t', 'srv', 'sudo dhcpd -t', [], DHCP_CONF(DHCPD_LINES)],
  ['systemctl-restart-dhcp-interface-vide', 'srv', 'sudo systemctl restart isc-dhcp-server'],
  [
    'cat-dhcpd-leases-vide',
    'srv',
    'cat /var/lib/dhcp/dhcpd.leases',
    [],
    [...DEFAULTS, ['srv', 'sudo systemctl restart isc-dhcp-server']]
  ],
  ['cat-dhcpd-leases', 'srv', 'cat /var/lib/dhcp/dhcpd.leases', [], [['pc', 'sudo dhclient eth0']]]
]

/** Valeurs de dig qu'aucune capture ne peut reproduire (identifiant, durée, date, taille) : remplacées par un jeton. */
export const normalizeDig = (lines: string[]): string[] =>
  lines.map((l) =>
    l
      .replace(/status: (\w+), id: \d+/, 'status: $1, id: {id}')
      .replace(/^;; Query time: .*/, ';; Query time: {n} msec')
      .replace(/^;; WHEN: .*/, ';; WHEN: {date}')
      .replace(/rcvd: \d+/, 'rcvd: {size}')
  )

/** Lignes non reproductibles de `rndc status` (noyau, dates, processeurs) : ignorées de part et d'autre. */
const STATUS_VOLATILE = /^(running on|boot time|last configured|CPUs found|worker threads)/

/** Rejoue le déroulé et transmet la sortie de chaque étape à `visit`. */
export function playBind(visit: (name: string, output: string, line: string) => void): void {
  const consoles = new Consoles(buildBindLab())
  for (const [name, who, line, answers = [], prepare = []] of BIND_STEPS) {
    for (const [pwho, pline, panswers] of prepare) consoles.run(pwho, pline, panswers)
    visit(name, consoles.run(who, line, answers), line)
  }
}

describe('captures golden : Bind9 et isc-dhcp-server (docs/captures/bash)', () => {
  it('chaque sortie simulée est identique à sa capture', () => {
    playBind((name, output) => {
      const keep = (lines: string[]) =>
        name === 'rndc-status'
          ? lines.filter((l) => !STATUS_VOLATILE.test(l))
          : name.startsWith('dig-')
            ? normalizeDig(lines)
            : name === 'cat-dhcpd-leases'
              ? lines.map((l) => l.replace(/\d \d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d/, '{date}'))
              : lines
      const actual = keep(output === '' ? [] : output.split('\n'))
      const expected = keep(readCapture(`bash/${name}`).lines)
      expect(diffLines(actual, expected), name).toEqual([])
    })
  })
})
