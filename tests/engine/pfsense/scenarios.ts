/**
 * Scénarios des captures docs/captures/pfsense/ : chaque capture rejoue une session sur le laboratoire type
 * (voir console.ts). Les captures sont écrites une fois (WRITE_CAPTURES=1) puis relues par golden.test.ts.
 */
import { ping, type LabState } from '@engine/index'
import { applyTraceEffects } from '@engine/ios/registry'
import { lab, open, transcript, type, type Session } from './console'

const SRC_SCRIPTS =
  'https://github.com/pfsense/pfsense/tree/RELENG_2_7_2/src/etc (scripts de la console pfSense CE 2.7.2 : rc.initial, rc.banner, rc.initial.setports, config.console.inc, rc.initial.setlanip, rc.initial.password, rc.initial.defaults, rc.initial.reboot, rc.initial.ping) ; https://docs.netgate.com/pfsense/en/latest/config/console-menu.html. Noms de cartes, adresses et durées du lab ServerLab'
const SRC_PFCTL =
  'https://github.com/freebsd/freebsd-src/tree/stable/14/sbin/pfctl (pfctl.c, pfctl_parser.c : print_rule, print_status ; pf_print_state.c : print_state), https://github.com/pfsense/pfsense/blob/RELENG_2_7_2/src/etc/inc/filter.inc (règles générées), https://docs.netgate.com/pfsense/en/latest/firewall/pf-ruleset.html. Jeu de règles réduit (docs/fidelite.md, P-52) ; valeurs du lab ServerLab'

export interface Scenario {
  source: string
  command: string
  run: () => string[]
}

/** Session au shell (option 8), laboratoire éventuellement transformé par `prep`. */
function shell(prep?: (s: LabState, ids: ReturnType<typeof lab>) => LabState): Session {
  const l = lab()
  const s = prep ? prep(l.s, l) : l.s
  return type(open(s, l.id), '8')
}

/** Ping complet d'un poste vers une adresse, effets durables appliqués (états, journal). */
function exchange(s: LabState, from: string, to: string): LabState {
  const r = ping(s, from, to, { count: 1 })
  if (!r.ok) throw new Error(r.error.message)
  return applyTraceEffects(s, r.value.trace)
}

/** Sortie d'une commande du shell seule (sans l'écho de l'invite ni la transcription d'ouverture). */
function one(sess: Session, command: string): string[] {
  const done = type(sess, command)
  return done.lines.slice(sess.lines.length + 1)
}

const menu = (): Session => {
  const l = lab()
  return open(l.s, l.id)
}

export const SCENARIOS: Record<string, Scenario> = {
  menu: { source: SRC_SCRIPTS, command: '(ouverture de la console)', run: () => transcript(menu()) },
  'option-1-assign': {
    source: SRC_SCRIPTS,
    command: '1 [réponses : n, em0, em1, em2, y]',
    run: () => transcript(type(menu(), '1', ['n', 'em0', 'em1', 'em2', 'y']))
  },
  'option-2-ip': {
    source: SRC_SCRIPTS,
    command:
      '2 [réponses : 2, n, 192.168.10.1, 24, (vide), n, (vide), y, 192.168.10.100, 192.168.10.199, n, (vide)]',
    run: () =>
      transcript(
        type(menu(), '2', [
          '2',
          'n',
          '192.168.10.1',
          '24',
          '',
          'n',
          '',
          'y',
          '192.168.10.100',
          '192.168.10.199',
          'n',
          ''
        ])
      )
  },
  'option-3-password': {
    source: SRC_SCRIPTS,
    command: '3 [réponses : y, (vide)]',
    run: () => transcript(type(menu(), '3', ['y', '']))
  },
  'option-4-factory': {
    source: SRC_SCRIPTS,
    command: '4 [réponse : y]',
    run: () => transcript(type(menu(), '4', ['y']))
  },
  'option-5-reboot': {
    source: SRC_SCRIPTS,
    command: '5 [réponse : y]',
    run: () => transcript(type(menu(), '5', ['y']))
  },
  'option-7-ping': {
    source: `${SRC_SCRIPTS} ; https://github.com/freebsd/freebsd-src/tree/stable/14/sbin/ping (ping.c, main.c : pr_summary)`,
    command: '7 [réponses : 192.168.1.10, (vide)]',
    run: () => transcript(type(menu(), '7', ['192.168.1.10', '']))
  },
  'pfctl-sr': {
    source: SRC_PFCTL,
    command: 'pfctl -sr',
    run: () => one(shell(), 'pfctl -sr')
  },
  'pfctl-si': {
    source: SRC_PFCTL,
    command: 'pfctl -si',
    run: () => one(shell(), 'pfctl -si')
  },
  'pfctl-ss': {
    source: SRC_PFCTL,
    command: 'pfctl -ss',
    run: () =>
      one(
        shell((s, l) => exchange(s, l.pc, '203.0.113.1')),
        'pfctl -ss'
      )
  },
  'pfctl-d': { source: SRC_PFCTL, command: 'pfctl -d', run: () => one(shell(), 'pfctl -d') },
  'pfctl-d-deja': {
    source: SRC_PFCTL,
    command: 'pfctl -d (deuxième fois)',
    run: () => one(type(shell(), 'pfctl -d'), 'pfctl -d')
  },
  'pfctl-e': {
    source: SRC_PFCTL,
    command: 'pfctl -d puis pfctl -e',
    run: () => one(type(shell(), 'pfctl -d'), 'pfctl -e')
  },
  ifconfig: {
    source:
      'https://github.com/freebsd/freebsd-src/tree/stable/14/sbin/ifconfig (ifconfig.c, af_inet.c) ; valeurs du lab ServerLab (docs/fidelite.md, P-53)',
    command: 'ifconfig',
    run: () => one(shell(), 'ifconfig')
  },
  'netstat-rn': {
    source:
      'https://docs.netgate.com/pfsense/en/latest/monitoring/status/routes.html (« Route Table CLI ») et https://github.com/freebsd/freebsd-src/tree/stable/14/usr.bin/netstat/route.c (pr_rthdr) ; valeurs du lab ServerLab (docs/fidelite.md, P-54)',
    command: 'netstat -rn',
    run: () => one(shell(), 'netstat -rn')
  },
  'tail-filter-log': {
    source:
      'https://docs.netgate.com/pfsense/en/latest/monitoring/logs/raw-filter-format.html et https://docs.netgate.com/pfsense/en/latest/monitoring/logs/firewall.html (exemple « filterlog: 5,16777216,,1000000103,igb1,match,block,in,4,0x10,,128,0,0,none,17,udp,328,… ») ; valeurs du lab ServerLab (docs/fidelite.md, P-55)',
    command: 'tail /var/log/filter.log',
    run: () =>
      one(
        shell((s, l) => exchange(s, l.isp, '203.0.113.2')),
        'tail /var/log/filter.log'
      )
  },
  'ping-shell': {
    source: `${SRC_SCRIPTS} ; https://github.com/freebsd/freebsd-src/tree/stable/14/sbin/ping (ping.c, main.c : pr_summary)`,
    command: 'ping -c 2 192.168.1.10',
    run: () => one(shell(), 'ping -c 2 192.168.1.10')
  }
}
