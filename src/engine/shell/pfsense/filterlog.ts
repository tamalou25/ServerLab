/**
 * Journal du filtre (`/var/log/filter.log`) du pare-feu pfSense (v2.10, #247). Depuis pfSense CE 2.5 le
 * journal est un fichier texte (docs.netgate.com, « Working with Log Files ») : `cat` et `tail` le lisent,
 * `clog` n'existe plus pour lui. Les lignes sont dérivées du journal de l'état (`pf.log`) au format brut
 * décrit par « Raw Filter Log Format » : horodatage, nom d'hôte, `filterlog:` puis les champs séparés par
 * des virgules (numéro de règle, sous-règle, ancre, identifiant de suivi, interface, raison, action,
 * sens, version IP, TOS, ECN, TTL, ID, décalage, drapeaux, protocole, longueur, source, destination,
 * puis les champs du protocole).
 */
import { clockParts } from '../../core/clock'
import { nicOf, type PfDevice } from '../../net/pf'
import type { PfState } from '../../model/firewall'
import { ruleForLogEntry } from './ruleset'

export const FILTER_LOG_PATH = '/var/log/filter.log'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Horodatage syslog BSD : « Aug  3 08:59:02 » (jour sur deux colonnes). */
export function syslogStamp(clock: number): string {
  const t = clockParts(clock)
  const p2 = (n: number): string => String(n).padStart(2, '0')
  return `${MONTHS[t.month]} ${String(t.date).padStart(2, ' ')} ${p2(t.h)}:${p2(t.m)}:${p2(t.s)}`
}

type LogEntry = PfState['log'][number]

/** Port source éphémère déterministe : les ports sources ne sont pas modélisés (docs/fidelite.md, P-17). */
const ephemeralPort = (index: number): number => 49152 + ((index * 7919) % 16384)

const PROTOCOL_NUMBER: Record<string, number> = { icmp: 1, tcp: 6, udp: 17 }

function splitHost(text: string): { ip: string; port: number | null } {
  const [ip = '', port] = text.split(':')
  return { ip, port: port === undefined ? null : Number(port) }
}

/** Ligne brute de filter.log pour l'entrée `index` du journal. */
export function rawLogLine(device: PfDevice, entry: LogEntry, index: number): string {
  const rule = ruleForLogEntry(device, entry)
  const nic = nicOf(device, entry.iface)
  const dst = splitHost(entry.dst)
  const action = entry.action === 'pass' ? 'pass' : 'block'
  const protoNumber = PROTOCOL_NUMBER[entry.protocol] ?? 0
  const protoText = PROTOCOL_NUMBER[entry.protocol] ? entry.protocol : 'none'
  const sport = ephemeralPort(index)
  const length = entry.protocol === 'tcp' ? 60 : entry.protocol === 'icmp' ? 84 : 28
  const head = [
    rule.index,
    16777216,
    '',
    rule.tracker,
    nic?.name ?? entry.iface,
    'match',
    action,
    'in',
    4,
    '0x0',
    '',
    64,
    0,
    0,
    'none',
    protoNumber,
    protoText,
    length,
    entry.src,
    dst.ip
  ]
  let tail: (string | number)[] = []
  if (entry.protocol === 'tcp')
    tail = [sport, dst.port ?? 0, 0, 'S', 1000000000 + index, '', 65535, '', 'mss']
  else if (entry.protocol === 'udp') tail = [sport, dst.port ?? 0, 0]
  else if (entry.protocol === 'icmp') tail = ['request', 1 + index, 1]
  return `${syslogStamp(entry.at)} ${device.pf.hostname} filterlog: ${[...head, ...tail].join(',')}`
}

/** Toutes les lignes de filter.log. */
export const filterLogLines = (device: PfDevice): string[] =>
  device.pf.log.map((entry, i) => rawLogLine(device, entry, i))

/**
 * Sortie de `filterparser.php` (docs.netgate.com, « Viewing the Firewall Log ») : une ligne simplifiée
 * par entrée TCP / UDP (« Aug  3 08:59:02 block igb1 UDP 198.51.100.1:67 198.51.100.2:68 »).
 */
export function filterParserLines(device: PfDevice): string[] {
  return device.pf.log.map((entry, i) => {
    const nic = nicOf(device, entry.iface)
    const dst = splitHost(entry.dst)
    const action = entry.action === 'pass' ? 'pass' : 'block'
    const proto = entry.protocol.toUpperCase()
    const ports = entry.protocol === 'tcp' || entry.protocol === 'udp'
    const src = ports ? `${entry.src}:${ephemeralPort(i)}` : entry.src
    const to = ports ? `${dst.ip}:${dst.port ?? 0}` : dst.ip
    return `${syslogStamp(entry.at)} ${action} ${nic?.name ?? entry.iface} ${proto} ${src} ${to}`
  })
}
