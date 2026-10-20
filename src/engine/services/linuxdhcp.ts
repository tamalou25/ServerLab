/**
 * isc-dhcp-server simulé (v2.9, #240) : lecture de /etc/dhcp/dhcpd.conf et de /etc/default/isc-dhcp-server,
 * contrôle (`dhcpd -t`), base des baux /var/lib/dhcp/dhcpd.leases, et service DHCP « dérivé » que le client
 * DHCP du moteur (roles/dhcp/client.ts) interroge comme celui d'un serveur Windows : les étendues viennent
 * des déclarations `subnet`, les réservations des `host`, les baux du fichier dhcpd.leases.
 *
 * Formats et messages : paquet Debian isc-dhcp-server 4.4.3-P1 (dhcpd.conf(5), dhcpd.leases(5), dhcpd(8),
 * sources server/confpars.c, common/parse.c, common/discover.c). Ce qui n'est pas relu sur une installation
 * réelle est listé dans docs/fidelite.md, « À vérifier (v2.9 — Linux) » (L-90 à L-99).
 */
import { LAB_EPOCH_MS } from '../core/clock'
import type { DhcpLease, DhcpScope, DhcpServer } from '../model/dhcp'
import type { HostDevice } from '../model/schema'
import { effectiveIpv4 } from '../net/addressing'
import { formatIpv4, inNetwork, isIpv4, maskToPrefix, parseIpv4 } from '../net/ipv4'
import { findPackage, type LinuxRelease } from './linuxcatalog'
import {
  DHCP_DEFAULT,
  DHCPD_CONF,
  DHCPD_LEASES,
  fileText,
  hostsTextOf,
  runningConfigText,
  unbundle
} from './linuxconfig'
import { leasesHeader } from './linuxdhcpdata'
import { isInstalled, linuxRelease } from './linuxpackages'
import { hostFiles } from './linuxtree'

export { DHCP_DEFAULT, DHCPD_CONF, DHCPD_LEASES }

/** Version affichée : « 4.4.3-P1 ». */
export function dhcpVersion(release: LinuxRelease): string {
  const full = findPackage('isc-dhcp-server')?.versions[release] ?? ''
  return full
    .replace(/^\d+:/, '')
    .replace(/-\d+(ubuntu.*)?$/, '')
    .replace(/-\d+\.\d+ubuntu.*$/, '')
}
export const hostDhcpVersion = (host: HostDevice) => dhcpVersion(linuxRelease(host))

// ---------------------------------------------------------------------------------------------
// Lecture de dhcpd.conf
// ---------------------------------------------------------------------------------------------

interface Tok {
  kind: 'word' | 'str' | 'sym'
  v: string
  line: number
  col: number
}

export interface DhcpdError {
  line: number
  message: string
  /** Texte de la ligne fautive (dhcpd la recopie, suivie d'un « ^ »). */
  source: string
  col: number
}

function tokenize(text: string): Tok[] {
  const out: Tok[] = []
  const lines = text.split('\n')
  lines.forEach((raw, idx) => {
    let i = 0
    while (i < raw.length) {
      const c = raw[i] as string
      if (/\s/.test(c)) i++
      else if (c === '#') break
      else if ('{};,'.includes(c)) {
        out.push({ kind: 'sym', v: c, line: idx + 1, col: i })
        i++
      } else if (c === '"') {
        let j = i + 1
        while (j < raw.length && raw[j] !== '"') j++
        out.push({ kind: 'str', v: raw.slice(i + 1, j), line: idx + 1, col: i })
        i = j + 1
      } else {
        let j = i
        while (j < raw.length && !/[\s{};,"#]/.test(raw[j] as string)) j++
        out.push({ kind: 'word', v: raw.slice(i, j), line: idx + 1, col: i })
        i = j
      }
    }
  })
  return out
}

/** Paramètres hérités d'une déclaration à l'autre (global → subnet → host). */
export interface Params {
  routers: string[] | null
  dns: string[] | null
  domain: string | null
  broadcast: string | null
  defaultLease: number | null
  maxLease: number | null
}

const emptyParams = (): Params => ({
  routers: null,
  dns: null,
  domain: null,
  broadcast: null,
  defaultLease: null,
  maxLease: null
})
const inherit = (p: Params): Params => ({ ...p })

export interface DhcpdSubnet {
  network: string
  mask: string
  prefix: number
  ranges: { start: string; end: string }[]
  params: Params
  line: number
}
export interface DhcpdHost {
  name: string
  mac: string | null
  fixed: string | null
  params: Params
}
export interface DhcpdConf {
  authoritative: boolean
  global: Params
  subnets: DhcpdSubnet[]
  hosts: DhcpdHost[]
}

export interface DhcpdParse {
  conf: DhcpdConf
  errors: DhcpdError[]
}

/** Options DHCP standard (RFC 2132) reconnues par `option nom …;`. */
const OPTION_NAMES = new Set(
  `subnet-mask time-offset routers time-servers ien116-name-servers domain-name-servers log-servers cookie-servers
lpr-servers impress-servers resource-location-servers host-name boot-size merit-dump domain-name swap-server
root-path extensions-path ip-forwarding non-local-source-routing policy-filter max-dgram-reassembly default-ip-ttl
path-mtu-aging-timeout path-mtu-plateau-table interface-mtu all-subnets-local broadcast-address perform-mask-discovery
mask-supplier router-discovery router-solicitation-address static-routes trailer-encapsulation arp-cache-timeout
ieee802-3-encapsulation default-tcp-ttl tcp-keepalive-interval tcp-keepalive-garbage nis-domain nis-servers
ntp-servers vendor-encapsulated-options netbios-name-servers netbios-dd-server netbios-node-type netbios-scope
font-servers x-display-manager dhcp-requested-address dhcp-lease-time dhcp-message dhcp-server-identifier
dhcp-renewal-time dhcp-rebinding-time vendor-class-identifier nisplus-domain nisplus-servers tftp-server-name
bootfile-name mobile-ip-home-agent smtp-server pop-server nntp-server www-server finger-server irc-server
streettalk-server streettalk-directory-assistance-server user-class slp-directory-agent slp-service-scope
nds-server nds-tree-name nds-context uap-servers domain-search ntp-servers time-zone posix-timezone tzdb-timezone
classless-static-routes rfc3442-classless-static-routes ms-classless-static-routes wpad-url`.split(/\s+/)
)
const IP_LIST_OPTIONS = new Set([
  'routers',
  'domain-name-servers',
  'ntp-servers',
  'netbios-name-servers',
  'time-servers',
  'log-servers',
  'subnet-mask',
  'broadcast-address'
])
const STRING_OPTIONS = new Set([
  'domain-name',
  'host-name',
  'tftp-server-name',
  'bootfile-name',
  'domain-search'
])
/** Instructions simples reconnues (terminées par « ; »). */
const STATEMENTS = new Set(
  `default-lease-time max-lease-time min-lease-time authoritative ddns-update-style ddns-updates log-facility
next-server filename server-name server-identifier ping-check one-lease-per-client allow deny ignore
update-static-leases get-lease-hostnames use-host-decl-names lease-file-name pid-file-name local-address
omapi-port omapi-key dns-update ddns-domainname ddns-rev-domainname ddns-hostname do-forward-updates
authoritative not hardware fixed-address range option unknown-clients boot-unknown-clients always-broadcast
always-reply-rfc1048 site-option-space min-secs echo-client-id if else elsif set on include key zone`.split(
    /\s+/
  )
)
const BLOCKS = new Set([
  'subnet',
  'host',
  'group',
  'shared-network',
  'pool',
  'class',
  'subclass',
  'failover',
  'key',
  'zone'
])

/** Nom d'hôte → adresse d'après /etc/hosts du serveur (dhcpd résout les noms au chargement). */
export type HostResolver = (name: string) => string | null

/** Lit un dhcpd.conf. S'arrête à la première erreur de syntaxe (comme -t le fait pour la sortie utile). */
export function parseDhcpd(text: string, resolve: HostResolver): DhcpdParse {
  const lines = text.split('\n')
  const toks = tokenize(text)
  const errors: DhcpdError[] = []
  const conf: DhcpdConf = { authoritative: false, global: emptyParams(), subnets: [], hosts: [] }
  let pos = 0
  const fail = (t: Tok | undefined, message: string): never => {
    const last = toks[toks.length - 1]
    const line = t?.line ?? last?.line ?? 1
    errors.push({
      line,
      message,
      source: lines[line - 1] ?? '',
      col: t?.col ?? (lines[line - 1] ?? '').length
    })
    throw new Error('dhcpd-syntax')
  }
  const semi = () => {
    const t = toks[pos]
    if (!t || t.kind !== 'sym' || t.v !== ';') fail(t, 'semicolon expected.')
    pos++
  }
  /** Adresse ou nom : un nom inconnu est signalé mais la lecture continue (comme dhcpd). */
  const addr = (t: Tok | undefined): string | null => {
    if (!t || t.kind === 'sym') return fail(t, 'expecting IP address or hostname') as never
    if (isIpv4(t.v)) return t.v
    const ip = resolve(t.v)
    if (ip === null)
      errors.push({
        line: t.line,
        message: `${t.v}: host unknown.`,
        source: lines[t.line - 1] ?? '',
        col: t.col
      })
    return ip
  }
  const ipList = (): string[] => {
    const out: string[] = []
    for (;;) {
      const ip = addr(toks[pos])
      pos++
      if (ip) out.push(ip)
      const t = toks[pos]
      if (t && t.kind === 'sym' && t.v === ',') pos++
      else return out
    }
  }
  const number = (): number => {
    const t = toks[pos]
    if (!t || !/^\d+$/.test(t.v)) return fail(t, 'expecting numeric value.') as never
    pos++
    return Number(t.v)
  }
  const parseOption = (params: Params) => {
    const name = toks[pos]
    if (!name || name.kind !== 'word') return fail(name, 'expecting identifier after option keyword.')
    pos++
    if (!OPTION_NAMES.has(name.v)) return fail(name, `unknown option dhcp.${name.v}`)
    if (IP_LIST_OPTIONS.has(name.v)) {
      const list = ipList()
      if (name.v === 'routers') params.routers = list
      else if (name.v === 'domain-name-servers') params.dns = list
      else if (name.v === 'broadcast-address') params.broadcast = list[0] ?? null
    } else if (STRING_OPTIONS.has(name.v)) {
      const t = toks[pos]
      if (!t || t.kind !== 'str') return fail(t, 'expecting a string.')
      pos++
      if (name.v === 'domain-name') params.domain = t.v
    } else {
      // Option valide mais non modélisée : valeurs recopiées jusqu'au « ; »
      while (toks[pos] && !(toks[pos]!.kind === 'sym' && toks[pos]!.v === ';')) pos++
    }
    semi()
  }
  const parseScope = (
    params: Params,
    scope: 'global' | 'subnet' | 'host',
    subnet: DhcpdSubnet | null,
    host: DhcpdHost | null,
    nested: boolean
  ) => {
    for (;;) {
      const t = toks[pos]
      if (!t) {
        if (nested) fail(undefined, 'unexpected end of file')
        return
      }
      if (t.kind === 'sym' && t.v === '}') {
        if (nested) return
        return fail(t, 'expecting a declaration.')
      }
      if (t.kind !== 'word') return fail(t, 'expecting a declaration.')
      pos++
      const kw = t.v.toLowerCase()
      if (
        BLOCKS.has(kw) &&
        ['subnet', 'host', 'group', 'shared-network', 'pool', 'class', 'subclass', 'failover'].includes(kw)
      ) {
        if (kw === 'subnet') {
          const net = toks[pos]
          pos++
          const nm = toks[pos]
          if (!nm || nm.v !== 'netmask') return fail(nm, 'expecting netmask keyword')
          pos++
          const mask = toks[pos]
          pos++
          if (!net || !mask || !isIpv4(net.v) || !isIpv4(mask.v))
            return fail(net, 'expecting IP address or hostname')
          const prefix = maskToPrefix(mask.v)
          const n = parseIpv4(net.v) ?? 0
          const m = parseIpv4(mask.v) ?? 0
          if (prefix === null || (n & m) >>> 0 !== n >>> 0)
            return fail(net, `subnet ${net.v} netmask ${mask.v}: bad subnet number/mask combination.`)
          const open = toks[pos]
          if (!open || open.v !== '{') return fail(open, 'expecting left brace.')
          pos++
          const sub: DhcpdSubnet = {
            network: net.v,
            mask: mask.v,
            prefix,
            ranges: [],
            params: inherit(params),
            line: t.line
          }
          parseScope(sub.params, 'subnet', sub, null, true)
          pos++ // }
          conf.subnets.push(sub)
        } else if (kw === 'host') {
          const nameTok = toks[pos]
          pos++
          const open = toks[pos]
          if (!nameTok || !open || open.v !== '{') return fail(open, 'expecting left brace.')
          pos++
          const h: DhcpdHost = { name: nameTok.v, mac: null, fixed: null, params: inherit(params) }
          parseScope(h.params, 'host', subnet, h, true)
          pos++
          conf.hosts.push(h)
        } else {
          // group, shared-network, pool, class… : les déclarations contenues s'appliquent comme si elles étaient à plat
          while (toks[pos] && toks[pos]!.v !== '{') pos++
          const open = toks[pos]
          if (!open) return fail(undefined, 'unexpected end of file')
          pos++
          parseScope(
            kw === 'group' || kw === 'shared-network' ? params : inherit(params),
            scope,
            subnet,
            host,
            true
          )
          pos++
        }
        // Un « ; » après l'accolade fermante est toléré
        const s = toks[pos]
        if (s && s.kind === 'sym' && s.v === ';') pos++
        continue
      }
      if (!STATEMENTS.has(kw)) return fail(t, 'expecting a declaration.')
      switch (kw) {
        case 'option':
          parseOption(params)
          break
        case 'default-lease-time':
          params.defaultLease = number()
          semi()
          break
        case 'max-lease-time':
          params.maxLease = number()
          semi()
          break
        case 'authoritative':
          conf.authoritative = true
          semi()
          break
        case 'range': {
          if (!subnet || scope === 'host') return fail(t, 'expecting a declaration.')
          if (toks[pos]?.v === 'dynamic-bootp') pos++
          const start = addr(toks[pos])
          pos++
          let end = start
          if (toks[pos] && toks[pos]!.kind === 'word') {
            end = addr(toks[pos])
            pos++
          }
          if (start && end) {
            for (const a of [start, end])
              if (!inNetwork(a, subnet.network, subnet.prefix))
                errors.push({
                  line: t.line,
                  message: `bad range, address ${a} not in subnet ${subnet.network} netmask ${subnet.mask}`,
                  source: lines[t.line - 1] ?? '',
                  col: t.col
                })
            subnet.ranges.push({ start, end })
          }
          semi()
          break
        }
        case 'hardware': {
          if (!host) return fail(t, 'expecting a declaration.')
          const type = toks[pos]
          pos++
          const mac = toks[pos]
          if (!type || type.v !== 'ethernet' || !mac || !/^([0-9a-f]{1,2}:){5}[0-9a-f]{1,2}$/i.test(mac.v))
            return fail(mac ?? type, 'expecting hardware address')
          pos++
          host.mac = mac.v
            .split(':')
            .map((b) => b.padStart(2, '0').toUpperCase())
            .join('-')
          semi()
          break
        }
        case 'fixed-address': {
          if (!host) return fail(t, 'expecting a declaration.')
          const list = ipList()
          host.fixed = list[0] ?? null
          semi()
          break
        }
        default:
          // Instruction valide mais non modélisée : recopiée jusqu'au « ; »
          while (toks[pos] && !(toks[pos]!.kind === 'sym' && toks[pos]!.v === ';')) pos++
          semi()
      }
    }
  }
  try {
    parseScope(conf.global, 'global', null, null, false)
  } catch (e) {
    if (!(e instanceof Error) || e.message !== 'dhcpd-syntax') throw e
  }
  return { conf, errors }
}

/** Lignes écrites par dhcpd pour une erreur : message, ligne fautive et « ^ » (tabulations conservées). */
export function errorLines(path: string, e: DhcpdError): string[] {
  const caret = e.source.slice(0, e.col).replace(/[^\t]/g, ' ')
  return [`${path} line ${e.line}: ${e.message}`, e.source, `${caret}^`]
}

// ---------------------------------------------------------------------------------------------
// /etc/default/isc-dhcp-server
// ---------------------------------------------------------------------------------------------

/** Interfaces de INTERFACESv4 (dernière affectation non commentée). */
export function interfacesV4(defaultFile: string): string[] {
  let value = ''
  for (const line of defaultFile.split('\n')) {
    const m = /^\s*INTERFACESv4\s*=\s*"?([^"#]*)"?/.exec(line)
    if (m) value = (m[1] as string).trim()
  }
  return value === '' ? [] : value.split(/\s+/)
}

// ---------------------------------------------------------------------------------------------
// Serveur en fonctionnement
// ---------------------------------------------------------------------------------------------

export interface DhcpdRunning {
  confPath: string
  parse: DhcpdParse
  /** Interfaces d'écoute (INTERFACESv4). */
  interfaces: string[]
}

const hostResolver = (host: HostDevice): HostResolver => {
  const hosts = hostsTextOf(host.host.linux?.files, host.name)
  return (name) => {
    for (const line of hosts.split('\n')) {
      const [ip, ...names] = line.replace(/#.*/, '').trim().split(/\s+/)
      if (ip && isIpv4(ip) && names.some((n) => n.toLowerCase() === name.toLowerCase())) return ip
    }
    return null
  }
}

/** Configuration lue à partir de textes (courants pour `dhcpd -t`, en vigueur pour le service). */
export function readDhcpd(host: HostDevice, conf: string | null, defaults: string | null): DhcpdRunning {
  return {
    confPath: DHCPD_CONF,
    parse: parseDhcpd(conf ?? '', hostResolver(host)),
    interfaces: interfacesV4(defaults ?? '')
  }
}

/** Configuration en vigueur (celle du dernier démarrage de l'unité). */
export function runningDhcpd(host: HostDevice): DhcpdRunning {
  const b = unbundle(runningConfigText(host.host.linux, 'isc-dhcp-server'))
  return readDhcpd(host, b.get(DHCPD_CONF) ?? null, b.get(DHCP_DEFAULT) ?? null)
}

/** Interface (nom, adresse) dont l'adresse appartient au sous-réseau. */
function boundInterface(host: HostDevice, names: string[], sub: DhcpdSubnet) {
  for (const i of host.interfaces) {
    if (!names.includes(i.name)) continue
    const eff = effectiveIpv4(i)
    if (eff && eff.source === 'static' && inNetwork(eff.address, sub.network, sub.prefix))
      return { name: i.name, address: eff.address }
  }
  return null
}

/** Message de démarrage de dhcpd quand une interface d'écoute n'a aucun sous-réseau (common/discover.c). */
export function ignoredInterfaceLines(host: HostDevice, running: DhcpdRunning): string[] {
  const out: string[] = []
  for (const name of running.interfaces) {
    const iface = host.interfaces.find((i) => i.name === name)
    const eff = iface ? effectiveIpv4(iface) : null
    if (!iface || !eff) continue
    if (running.parse.conf.subnets.some((s) => inNetwork(eff.address, s.network, s.prefix))) continue
    out.push(
      `No subnet declaration for ${name} (${eff.address}).`,
      `** Ignoring requests on ${name}.  If this is not what`,
      '   you want, please write a subnet declaration',
      '   in your dhcpd.conf file for the network segment',
      `   to which interface ${name} is attached. **`
    )
  }
  return out
}

/**
 * Raison pour laquelle dhcpd refuse de démarrer, sous forme de lignes de son journal ; null si le démarrage
 * est possible (configuration lisible et au moins une interface d'écoute servie).
 */
export function dhcpdStartProblem(host: HostDevice, running: DhcpdRunning): string[] | null {
  if (running.parse.errors.length > 0)
    return [
      ...running.parse.errors.flatMap((e) => errorLines(running.confPath, e)),
      'Configuration file errors encountered -- exiting'
    ]
  const listening = running.interfaces.filter((n) => {
    const iface = host.interfaces.find((i) => i.name === n)
    const eff = iface ? effectiveIpv4(iface) : null
    return !!eff && running.parse.conf.subnets.some((s) => inNetwork(eff.address, s.network, s.prefix))
  })
  if (listening.length > 0) return null
  return [...ignoredInterfaceLines(host, running), 'Not configured to listen on any interfaces!']
}

// ---------------------------------------------------------------------------------------------
// Base des baux (dhcpd.leases)
// ---------------------------------------------------------------------------------------------

export interface LeaseEntry {
  ip: string
  /** Début et fin en millisecondes de l'horloge du lab. */
  starts: number
  ends: number
  state: 'active' | 'free' | 'expired' | 'abandoned'
  mac: string | null
  hostname: string | null
}

const DOW = [0, 1, 2, 3, 4, 5, 6]
const p2 = (n: number) => String(n).padStart(2, '0')

/** Date au format de dhcpd.leases : « 2 2026/10/20 14:10:03 ». */
export function leaseDate(clock: number): string {
  const d = new Date(LAB_EPOCH_MS + clock)
  return `${DOW[d.getUTCDay()]} ${d.getUTCFullYear()}/${p2(d.getUTCMonth() + 1)}/${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`
}
const parseLeaseDate = (text: string): number | null => {
  const m = /^\d (\d{4})\/(\d\d)\/(\d\d) (\d\d):(\d\d):(\d\d)$/.exec(text.trim())
  return m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) - LAB_EPOCH_MS : null
}

/** Entrées de la base ; pour une adresse présente plusieurs fois, la dernière gagne (comme dhcpd). */
export function parseLeases(text: string): LeaseEntry[] {
  const byIp = new Map<string, LeaseEntry>()
  for (const m of text.matchAll(/lease\s+(\d+\.\d+\.\d+\.\d+)\s*\{([^}]*)\}/g)) {
    const body = m[2] as string
    const get = (key: string) => new RegExp(`${key}\\s+([^;]+);`).exec(body)?.[1]?.trim() ?? null
    const starts = parseLeaseDate(get('starts') ?? '')
    const ends = parseLeaseDate(get('ends') ?? '')
    if (starts === null || ends === null) continue
    const state = (get('binding state') ?? 'free') as LeaseEntry['state']
    const mac = /hardware ethernet\s+([0-9a-f:]+);/i.exec(body)?.[1] ?? null
    const name = /client-hostname\s+"([^"]*)";/.exec(body)?.[1] ?? null
    byIp.set(m[1] as string, {
      ip: m[1] as string,
      starts,
      ends,
      state,
      mac: mac
        ? mac
            .split(':')
            .map((b) => b.padStart(2, '0').toUpperCase())
            .join('-')
        : null,
      hostname: name
    })
  }
  return [...byIp.values()]
}

/** Baux actifs à l'instant `clock`. */
export const activeLeases = (entries: LeaseEntry[], clock: number) =>
  entries.filter((l) => l.state === 'active' && l.ends > clock)

/** Bloc `lease … { … }` tel qu'écrit par dhcpd. */
export function leaseBlock(l: {
  ip: string
  starts: number
  ends: number
  state: 'active' | 'free'
  mac: string
  hostname: string | null
}): string {
  const mac = l.mac.toLowerCase().replace(/-/g, ':')
  const date = leaseDate(l.starts)
  return [
    `lease ${l.ip} {`,
    `  starts ${date};`,
    `  ends ${leaseDate(l.ends)};`,
    `  cltt ${date};`,
    `  binding state ${l.state};`,
    ...(l.state === 'active' ? ['  next binding state free;', '  rewind binding state free;'] : []),
    `  hardware ethernet ${mac};`,
    ...(l.hostname ? [`  client-hostname "${l.hostname}";`] : []),
    '}',
    ''
  ].join('\n')
}

export const leasesText = (host: HostDevice): string =>
  fileText(host.host.linux?.files, DHCPD_LEASES) ?? leasesHeader('4.4.3-P1')

// ---------------------------------------------------------------------------------------------
// Service DHCP dérivé (consommé par roles/dhcp)
// ---------------------------------------------------------------------------------------------

/** Le serveur DHCP en fonctionnement ; null si le paquet manque, l'ordinateur est éteint ou dhcpd arrêté. */
export function linuxDhcpServer(host: HostDevice, active: boolean): DhcpServer | null {
  if (!host.powered || !active || !isInstalled(host, 'isc-dhcp-server')) return null
  const running = runningDhcpd(host)
  if (dhcpdStartProblem(host, running)) return null
  const { conf } = running.parse
  const entries = parseLeases(leasesText(host))
  const scopes: DhcpScope[] = []
  for (const sub of conf.subnets) {
    if (sub.ranges.length === 0 || !boundInterface(host, running.interfaces, sub)) continue
    const starts = sub.ranges.map((r) => parseIpv4(r.start) ?? 0)
    const ends = sub.ranges.map((r) => parseIpv4(r.end) ?? 0)
    const lo = Math.min(...starts)
    const hi = Math.max(...ends)
    // Les trous entre plusieurs plages deviennent des exclusions
    const sorted = sub.ranges
      .map((r) => [parseIpv4(r.start) ?? 0, parseIpv4(r.end) ?? 0] as const)
      .sort((a, b) => a[0] - b[0])
    const exclusions: { start: string; end: string }[] = []
    for (let k = 1; k < sorted.length; k++) {
      const gapStart = (sorted[k - 1]![1] as number) + 1
      const gapEnd = (sorted[k]![0] as number) - 1
      if (gapEnd >= gapStart) exclusions.push({ start: formatIpv4(gapStart), end: formatIpv4(gapEnd) })
    }
    const p = sub.params
    const reservations = conf.hosts
      .filter((h) => h.mac && h.fixed && inNetwork(h.fixed, sub.network, sub.prefix))
      .map((h) => ({ ip: h.fixed as string, mac: h.mac as string, name: h.name, description: '' }))
    const leases: DhcpLease[] = entries
      .filter((l) => l.state === 'active' && l.mac && inNetwork(l.ip, sub.network, sub.prefix))
      .map((l) => ({
        ip: l.ip,
        mac: l.mac as string,
        hostName: l.hostname ?? '',
        expiresAt: l.ends,
        state: 'Active' as const
      }))
    scopes.push({
      scopeId: sub.network,
      name: `subnet ${sub.network} netmask ${sub.mask}`,
      description: '',
      start: formatIpv4(lo),
      end: formatIpv4(hi),
      prefixLength: sub.prefix,
      state: 'Active',
      leaseDurationSec: p.defaultLease ?? 43200,
      exclusions,
      reservations,
      leases,
      options: { router: p.routers ?? [], dnsServers: p.dns ?? [], dnsDomain: p.domain }
    })
  }
  return {
    authorized: true,
    configured: true,
    scopes,
    serverOptions: { router: [], dnsServers: [], dnsDomain: null }
  }
}

/** Fichiers modifiables d'un ordinateur (copie de l'arborescence, nœuds des paquets inclus). */
export const filesOf = (host: HostDevice) => hostFiles(host)

/** Ajoute des blocs `lease` à dhcpd.leases (l'ordinateur est un brouillon immer modifiable). */
export function appendLeases(host: HostDevice, blocks: string[]): void {
  const files = JSON.parse(JSON.stringify(filesOf(host))) as ReturnType<typeof filesOf>
  const node = files[DHCPD_LEASES]
  files[DHCPD_LEASES] = {
    type: 'file',
    mode: node?.mode ?? 0o644,
    owner: node?.owner ?? 'root',
    group: node?.group ?? 'root',
    mtime: node?.mtime ?? 0,
    content: (node?.content ?? leasesText(host)) + blocks.join('')
  }
  host.host.linux = { ...host.host.linux, distro: host.host.linux?.distro ?? 'debian12', files }
}
