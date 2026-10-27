/**
 * Jeu de règles chargé dans pf, tel que l'affiche `pfctl -sr` (v2.10, #247).
 *
 * Dérivé de l'état du pare-feu (jamais stocké) : règles automatiques de pfSense (src/etc/inc/filter.inc,
 * pfSense CE 2.7.2 : blocage de l'IPv6, des adresses link-local, refus par défaut, bogons, réseaux
 * privés, anti-verrouillage) puis règles de l'utilisateur dans l'ordre. La mise en forme suit
 * `print_rule` de pfctl (FreeBSD 14, sbin/pfctl/pfctl_parser.c) : action, sens, journal, quick,
 * interface, famille, protocole, adresses, drapeaux, état, étiquettes, identifiant.
 *
 * Écarts assumés (docs/fidelite.md, P-52) : le vrai jeu contient en plus scrub, les règles « let out
 * anything from firewall host itself », les tables snort2c / virusprot / sshguard, le DHCP, etc.
 */
import { effectiveIpv4 } from '../../net/addressing'
import { inNetwork, networkAddress } from '../../net/ipv4'
import {
  isBogonAddress,
  isPrivateAddress,
  nicOf,
  PF_ANTI_LOCKOUT_PORTS,
  type PfDevice
} from '../../net/pf'
import {
  PF_DEFAULT_LAN_RULE_ID,
  PF_IFACE_KEYS,
  type PfEndpoint,
  type PfIfaceKey,
  type PfPortRange,
  type PfRule
} from '../../model/firewall'

/** Une ligne de `pfctl -sr` et l'identifiant de règle (« tracker ») qui la désigne dans filter.log. */
export interface PfRulesetLine {
  text: string
  tracker: number
}

/** Préfixe des étiquettes des règles de l'utilisateur (USER_LABEL_INTRO de filter.inc). */
const USER_LABEL_INTRO = 'USER_RULE: '
/** Longueur maximale d'une étiquette pf (PFLABEL_MAXLEN de filter.inc). */
const PFLABEL_MAXLEN = 63

const TRACKER_DEFAULT = 1000000000
const ANTILOCKOUT_TRACKER = 10000
const BOGONS_TRACKER = 11000
const RFC1918_TRACKER = 12000

/** Noms de services de /etc/services affichés à la place des numéros (pfctl sans -n). */
const SERVICES: Record<number, string> = {
  21: 'ftp',
  22: 'ssh',
  23: 'telnet',
  25: 'smtp',
  53: 'domain',
  67: 'bootps',
  68: 'bootpc',
  80: 'http',
  110: 'pop3',
  123: 'ntp',
  143: 'imap',
  443: 'https',
  445: 'microsoft-ds',
  3389: 'ms-wbt-server'
}

/** Nom d'un service (ou le numéro de port). */
export const serviceName = (port: number): string => SERVICES[port] ?? String(port)

/** `fix_rule_label` de filter.inc : guillemets retirés, 63 caractères au plus. */
function fixRuleLabel(text: string): string {
  const clean = text.replaceAll('"', '')
  return clean.length > PFLABEL_MAXLEN ? `${clean.slice(0, PFLABEL_MAXLEN - 3)}...` : clean
}

/**
 * Identifiant de suivi d'une règle de l'utilisateur, tel qu'écrit dans son étiquette `id:` (chaîne :
 * la règle d'usine garde son zéro initial, comme dans la configuration d'usine de pfSense).
 */
export function userTrackerText(rule: PfRule): string {
  if (rule.id === PF_DEFAULT_LAN_RULE_ID) return '0100000101'
  const n = Number(rule.id.replace(/\D/g, '')) || 0
  return String(1700000000 + n)
}

/** Identifiant numérique (`ridentifier`) d'une règle de l'utilisateur. */
export const userTracker = (rule: PfRule): number => Number(userTrackerText(rule))

/** Réseaux privés bloqués par « Block private networks » et leur libellé abrégé (filter.inc). */
const PRIVATE_RULES: [string, string][] = [
  ['10.0.0.0/8', '10/8'],
  ['127.0.0.0/8', '127/8'],
  ['172.16.0.0/12', '172.16/12'],
  ['192.168.0.0/16', '192.168/16']
]

/** Identifiant de la règle de refus par défaut IPv4 en entrée (docs.netgate.com, « Viewing the Firewall Log »). */
export const DEFAULT_DENY_TRACKER = TRACKER_DEFAULT + 103

function endpointText(device: PfDevice, endpoint: PfEndpoint): string | null {
  switch (endpoint.type) {
    case 'any':
      return 'any'
    case 'address':
      return endpoint.address
    case 'network':
      return endpoint.prefixLength === 32 ? endpoint.address : `${endpoint.address}/${endpoint.prefixLength}`
    case 'alias':
      return `<${endpoint.name}>`
    case 'interface': {
      const nic = nicOf(device, endpoint.key)
      if (!nic) return null
      if (endpoint.what === 'address') return `(${nic.name})`
      const eff = effectiveIpv4(nic)
      return eff ? `${networkAddress(eff.address, eff.prefixLength)}/${eff.prefixLength}` : null
    }
  }
}

const portText = (range: PfPortRange): string =>
  range === null
    ? ''
    : range.from === range.to
      ? ` port = ${serviceName(range.from)}`
      : ` port ${range.from}:${range.to}`

/** Lignes (une ou deux : « tcp/udp » donne deux règles) d'une règle de l'utilisateur. */
function userRuleLines(device: PfDevice, rule: PfRule): PfRulesetLine[] {
  const assignment = device.pf.assignments.find((a) => a.key === rule.iface)
  const nic = nicOf(device, rule.iface)
  if (!assignment?.enabled || !nic) return []
  const src = endpointText(device, rule.source)
  const dst = endpointText(device, rule.destination)
  if (src === null || dst === null) return []
  const action = rule.action === 'pass' ? 'pass' : rule.action === 'block' ? 'block drop' : 'block return'
  const gateway = device.pf.gateways.find((g) => g.iface === rule.iface)
  const replyTo = gateway ? ` reply-to (${nic.name} ${gateway.address})` : ''
  const all = src === 'any' && dst === 'any' && !rule.sourcePort && !rule.destinationPort
  const tracker = userTracker(rule)
  const labels =
    ` label "${fixRuleLabel(rule.descr ? USER_LABEL_INTRO + rule.descr : 'USER_RULE')}"` +
    ` label "id:${userTrackerText(rule)}"`
  const protocols = rule.protocol === 'tcp/udp' ? ['tcp', 'udp'] : [rule.protocol]
  return protocols.map((protocol) => {
    const proto = protocol === 'any' ? '' : ` proto ${protocol}`
    const fromTo = all
      ? ' all'
      : ` from ${src}${portText(rule.sourcePort)} to ${dst}${portText(rule.destinationPort)}`
    // Règles Pass : « flags S/SA » par défaut pour TCP (ou tout protocole), puis « keep state »
    const state =
      rule.action === 'pass' ? `${protocol === 'any' || protocol === 'tcp' ? ' flags S/SA' : ''} keep state` : ''
    return {
      text:
        `${action} in${rule.log ? ' log' : ''} quick on ${nic.name}${replyTo} inet${proto}${fromTo}` +
        `${state}${labels} ridentifier ${tracker}`,
      tracker
    }
  })
}

/** Jeu de règles complet, dans l'ordre d'évaluation de pf. */
export function pfRuleset(device: PfDevice): PfRulesetLine[] {
  const lines: PfRulesetLine[] = []
  const add = (text: string, tracker: number): void => {
    lines.push({ text: `${text} ridentifier ${tracker}`, tracker })
  }
  let t = TRACKER_DEFAULT
  // Blocage de l'IPv6 (IPv6 non autorisé par défaut)
  add('pass in quick on lo0 inet6 all flags S/SA keep state label "pass IPv6 loopback"', ++t)
  add('pass out quick on lo0 inet6 all flags S/SA keep state label "pass IPv6 loopback"', ++t)
  add('block drop in log quick inet6 all label "Block all IPv6"', ++t)
  add('block drop out log quick inet6 all label "Block all IPv6"', ++t)
  // Adresses link-local (RFC 3927)
  t = TRACKER_DEFAULT + 100
  add('block drop in log quick inet from 169.254.0.0/16 to any label "Block IPv4 link-local"', ++t)
  add('block drop in log quick inet from any to 169.254.0.0/16 label "Block IPv4 link-local"', ++t)
  // Refus par défaut
  add('block drop in log inet all label "Default deny rule IPv4"', ++t)
  add('block drop out log inet all label "Default deny rule IPv4"', ++t)
  add('block drop in log inet6 all label "Default deny rule IPv6"', ++t)
  add('block drop out log inet6 all label "Default deny rule IPv6"', ++t)

  // Par interface : bogons puis réseaux privés (compteurs d'identifiants communs à toutes les interfaces)
  let bogons = BOGONS_TRACKER
  let rfc1918 = RFC1918_TRACKER
  for (const key of PF_IFACE_KEYS) {
    const assignment = device.pf.assignments.find((a) => a.key === key)
    const nic = nicOf(device, key)
    if (!assignment?.enabled || !nic) continue
    const descr = assignment.descr
    if (assignment.blockBogons)
      add(
        `block drop in log quick on ${nic.name} from <bogons> to any label "block bogon IPv4 networks from ${descr}"`,
        ++bogons
      )
    if (assignment.blockPrivate) {
      for (const [net, short] of PRIVATE_RULES) {
        add(
          `block drop in log quick on ${nic.name} inet from ${net} to any label "Block private networks from ${descr} block ${short}"`,
          ++rfc1918
        )
      }
      add(
        `block drop in log quick on ${nic.name} inet6 from fc00::/7 to any label "Block ULA networks from ${descr} block fc00::/7"`,
        ++rfc1918
      )
    }
  }

  // Anti-verrouillage : le LAN joint l'administration (les ports se développent en une règle chacun)
  const lan = nicOf(device, 'lan')
  const tracks = device.pf.assignments.filter((a) => nicOf(device, a.key)).length
  if (lan && tracks > 1)
    for (const port of PF_ANTI_LOCKOUT_PORTS)
      add(
        `pass in quick on ${lan.name} proto tcp from any to (${lan.name}) port = ${serviceName(port)} flags S/SA keep state label "anti-lockout rule"`,
        ANTILOCKOUT_TRACKER + 1
      )

  for (const rule of device.pf.rules) {
    if (rule.disabled) continue
    lines.push(...userRuleLines(device, rule))
  }
  return lines
}

/**
 * Règle (indice dans le jeu et identifiant) qui a produit une entrée du journal : la règle de
 * l'utilisateur, sinon la règle automatique (réseaux privés, bogons) ou le refus par défaut.
 */
export function ruleForLogEntry(
  device: PfDevice,
  entry: { ruleId: string | null; iface: PfIfaceKey; src: string }
): { index: number; tracker: number } {
  const lines = pfRuleset(device)
  const find = (pred: (l: PfRulesetLine) => boolean): { index: number; tracker: number } | null => {
    const index = lines.findIndex(pred)
    return index < 0 ? null : { index, tracker: (lines[index] as PfRulesetLine).tracker }
  }
  if (entry.ruleId) {
    const rule = device.pf.rules.find((r) => r.id === entry.ruleId)
    const found = rule ? find((l) => l.tracker === userTracker(rule)) : null
    if (found) return found
  }
  const assignment = device.pf.assignments.find((a) => a.key === entry.iface)
  const nic = nicOf(device, entry.iface)
  if (assignment && nic) {
    if (assignment.blockPrivate && isPrivateAddress(entry.src)) {
      const net = PRIVATE_RULES.find(([n]) => {
        const [address = '', prefix = '0'] = n.split('/')
        return inNetwork(entry.src, address, Number(prefix))
      })
      const found = net ? find((l) => l.text.includes(`on ${nic.name} inet from ${net[0]} `)) : null
      if (found) return found
    }
    if (assignment.blockBogons && isBogonAddress(entry.src)) {
      const found = find((l) => l.text.includes(`on ${nic.name} from <bogons>`))
      if (found) return found
    }
  }
  return find((l) => l.tracker === DEFAULT_DENY_TRACKER) ?? { index: 0, tracker: DEFAULT_DENY_TRACKER }
}
