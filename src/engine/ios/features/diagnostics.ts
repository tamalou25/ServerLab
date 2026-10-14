/**
 * Diagnostic des services du routeur IOS : compteurs de trafic et cache ARP appris des trames
 * simulées, show ip nat statistics, show ip dhcp pool / conflict, clear ip dhcp binding *,
 * show ip interface, show arp / show ip arp, debug ip packet / debug ip ospf events, undebug all.
 * Sources :
 * - IP Addressing Services Command Reference (show arp, show ip arp, show ip dhcp pool / conflict,
 *   show ip interface) : https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipaddr/command/ipaddr-cr-book/ipaddr-r1.html
 * - show ip nat statistics : https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipaddr/command/ipaddr-cr-book/ipaddr-cr-book_chapter_01000.html
 */
import type { Draft } from 'immer'
import type { LabState, NetInterface } from '../../model/schema'
import { networkAddress, parseIpv4 } from '../../net/ipv4'
import { unsimulatedIosMessage } from '../../shell/unsimulated'
import type { PacketTrace, PduEvent } from '../../sim/trace'
import { iface } from '../cli/args'
import type { ArgContext, CliCommand, IosRunContext, SyntaxToken } from '../cli/types'
import { draftIosState, iosState } from '../config'
import { isIos, type IosDevice } from '../device'
import { defineIosFeature } from '../feature'
import { ifaceLongName } from '../models'
import { ifaceStatus, iosMac } from '../status'
import { deviceOf, update } from './base'
import { appendSyslog } from './logging'

const kw = (keyword: string, help: string): SyntaxToken => ({ keyword, help })
const SHOW = kw('show', 'Show running system information')
const SHOW_IP = kw('ip', 'IP information')

const isRouter = (ctx: ArgContext): boolean => ctx.state.devices[ctx.deviceId]?.kind === 'router'

// ---------------------------------------------------------------------------
// Trafic des trames simulées : compteurs, cache ARP, debug ip packet
// ---------------------------------------------------------------------------

const field = (e: PduEvent, layer: string, name: string): string | undefined =>
  e.layers.find((l) => l.name === layer)?.fields.find(([k]) => k === name)?.[1]

/** Taille estimée d'une trame (ARP : trame minimale de 60 octets ; écho ICMP de 100 octets + Ethernet). */
const frameBytes = (e: PduEvent): number => (e.protocol === 'ARP' ? 60 : e.protocol === 'ICMP' ? 114 : 64)

/** Longueur IP du paquet (debug ip packet). */
const ipLength = (e: PduEvent): number => frameBytes(e) - 14

function endOf(draft: Draft<LabState>, e: PduEvent, deviceId: string): Draft<NetInterface> | undefined {
  const link = draft.links[e.linkId]
  const device = draft.devices[deviceId]
  if (!link || !device) return undefined
  const end = link.a.deviceId === deviceId ? link.a : link.b
  return device.interfaces.find((i) => i.id === end.ifaceId)
}

type Counters = ReturnType<typeof draftIosState>['ifaceCounters'][string]
const counters = (device: Draft<IosDevice>, name: string): Draft<Counters> =>
  (draftIosState(device).ifaceCounters[name] ??= {
    inPackets: 0,
    inBytes: 0,
    inBroadcasts: 0,
    outPackets: 0,
    outBytes: 0,
    lastIn: null,
    lastOut: null
  })

/** Enregistre sur les équipements IOS les trames d'un échange (appelé par applyTraceEffects). */
export function recordTraffic(draft: Draft<LabState>, trace: PacketTrace): void {
  for (const e of trace.events) {
    const from = draft.devices[e.fromDeviceId]
    const to = draft.devices[e.toDeviceId]
    const src = field(e, 'IPv4', 'IP source')
    const dst = field(e, 'IPv4', 'IP destination')
    if (isIos(from as never)) {
      const out = endOf(draft, e, e.fromDeviceId)
      if (out) {
        const c = counters(from as Draft<IosDevice>, out.name)
        c.outPackets += 1
        c.outBytes += frameBytes(e)
        c.lastOut = draft.clock
        const ios = draftIosState(from as Draft<IosDevice>)
        if (src && dst && ios.debugs.includes('ip packet') && out.address === src)
          appendSyslog(
            draft,
            e.fromDeviceId,
            `IP: s=${src} (local), d=${dst} (${ifaceLongName(out.name)}), len ${ipLength(e)}, sending`
          )
      }
    }
    if (!isIos(to as never)) continue
    const port = endOf(draft, e, e.toDeviceId)
    if (!port) continue
    const c = counters(to as Draft<IosDevice>, port.name)
    c.inPackets += 1
    c.inBytes += frameBytes(e)
    c.lastIn = draft.clock
    if (field(e, 'Ethernet II', 'MAC destination') === 'FF-FF-FF-FF-FF-FF') c.inBroadcasts += 1
    const ios = draftIosState(to as Draft<IosDevice>)
    // Cache ARP : émetteur d'une requête ou d'une réponse adressée au routeur, sur son sous-réseau
    if (e.protocol === 'ARP' && e.outcome === 'delivered' && port.address && port.prefixLength !== null) {
      const ip = field(e, 'ARP', 'IP émetteur')
      const mac = field(e, 'ARP', 'MAC émetteur')
      if (
        ip &&
        mac &&
        networkAddress(ip, port.prefixLength) === networkAddress(port.address, port.prefixLength)
      ) {
        const entry = ios.arpTable.find((a) => a.ip === ip)
        if (entry) Object.assign(entry, { mac, iface: port.name, at: draft.clock })
        else ios.arpTable.push({ ip, mac, iface: port.name, at: draft.clock })
      }
    }
    if (src && dst && ios.debugs.includes('ip packet') && e.outcome === 'delivered' && port.address === dst)
      appendSyslog(
        draft,
        e.toDeviceId,
        `IP: s=${src} (${ifaceLongName(port.name)}), d=${dst}, len ${ipLength(e)}, rcvd 3`
      )
  }
}

/** Lignes de débogage ajoutées au journal pendant la commande : affichées sur la console. */
function debugMessages(before: LabState, after: LabState, deviceId: string): string[] {
  const b = before.devices[deviceId]
  const a = after.devices[deviceId]
  if (!isIos(a) || !iosState(a).debugs.length) return []
  const old = new Set(isIos(b) ? iosState(b).syslog : [])
  return iosState(a).syslog.filter((l) => !old.has(l) && l.includes(': IP: s='))
}

// ---------------------------------------------------------------------------
// show ip nat statistics
// ---------------------------------------------------------------------------

function showNatStatistics(ctx: IosRunContext): void {
  const device = deviceOf(ctx)
  const ios = iosState(device)
  const statics = ios.natRules.filter((r) => r.kind === 'static').length
  const dynamic = ios.natTranslations.length
  const extended = ios.natTranslations.filter((t) => t.protocol !== '---').length
  const role = (r: 'inside' | 'outside') =>
    device.interfaces
      .filter((i) => ios.interfaces[i.name]?.nat === r)
      .map((i) => ifaceLongName(i.name))
      .join(', ')
  ctx.print(
    `Total translations: ${statics + dynamic} (${statics} static, ${dynamic} dynamic; ${extended} extended)`
  )
  ctx.print(`Outside interfaces: ${role('outside')}`)
  ctx.print(`Inside interfaces: ${role('inside')}`)
  ctx.print(`Hits: ${ios.natHits}  Misses: 0`)
  ctx.print('Expired translations: 0')
  ctx.print('Dynamic mappings:')
  const rules = ios.natRules.filter((r) => r.kind === 'dynamic')
  if (rules.length) ctx.print('-- Inside Source')
  for (const r of rules)
    if (r.kind === 'dynamic')
      ctx.print(`access-list ${r.acl} interface ${ifaceLongName(r.iface)} refcount ${dynamic}`)
}

// ---------------------------------------------------------------------------
// DHCP
// ---------------------------------------------------------------------------

const ipNum = (ip: string): number => parseIpv4(ip) ?? 0

function showDhcpPool(ctx: IosRunContext): void {
  const ios = iosState(deviceOf(ctx))
  for (const scope of ios.dhcpServer?.scopes ?? []) {
    ctx.print(`Pool ${scope.name} :`)
    ctx.print(' Utilization mark (high/low)    : 100 / 0')
    ctx.print(' Subnet size (first/next)       : 0 / 0')
    const active = scope.state === 'Active'
    const total = active ? ipNum(scope.end) - ipNum(scope.start) + 1 : 0
    const leased = scope.leases.filter((l) => l.state === 'Active')
    ctx.print(` Total addresses                : ${total}`)
    ctx.print(` Leased addresses               : ${leased.length}`)
    ctx.print(' Pending event                  : none')
    if (!active) {
      ctx.print(' 0 subnet is currently in the pool :')
      continue
    }
    ctx.print(' 1 subnet is currently in the pool :')
    ctx.print(' Current index        IP address range           Leased addresses')
    // Index courant : première adresse libre (ni attribuée ni exclue)
    const taken = new Set(leased.map((l) => l.ip))
    const excluded = (n: number) => ios.dhcpExcluded.some((e) => n >= ipNum(e.start) && n <= ipNum(e.end))
    let index = ipNum(scope.start)
    while (index <= ipNum(scope.end) && (excluded(index) || taken.has(numIp(index)))) index++
    const range = `${scope.start} - ${scope.end}`
    ctx.print(` ${numIp(index).padEnd(21)}${`${range} `.padEnd(27)}${leased.length}`)
  }
}

const numIp = (n: number): string => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.')

// ---------------------------------------------------------------------------
// show ip interface
// ---------------------------------------------------------------------------

function showIpInterface(ctx: IosRunContext, device: IosDevice, i: NetInterface): void {
  const s = ifaceStatus(ctx.state, device, i)
  const entry = iosState(device).interfaces[i.name]
  ctx.print(`${ifaceLongName(i.name)} is ${s.status}, line protocol is ${s.protocol}`)
  if (!i.address || i.prefixLength === null) {
    ctx.print('  Internet protocol processing disabled')
    return
  }
  const helpers = i.helperAddresses ?? []
  const lines = [
    `  Internet address is ${i.address}/${i.prefixLength}`,
    '  Broadcast address is 255.255.255.255',
    '  Address determined by setup command',
    '  MTU is 1500 bytes',
    helpers.length ? `  Helper address is ${helpers.join(', ')}` : '  Helper address is not set',
    '  Directed broadcast forwarding is disabled',
    `  Outgoing access list is ${entry?.aclOut ?? 'not set'}`,
    `  Inbound access list is ${entry?.aclIn ?? 'not set'}`,
    '  Proxy ARP is enabled',
    '  Local Proxy ARP is disabled',
    '  Security level is default',
    '  Split horizon is enabled',
    '  ICMP redirects are always sent',
    '  ICMP unreachables are always sent',
    '  ICMP mask replies are never sent',
    '  IP fast switching is enabled',
    '  IP fast switching on the same interface is disabled',
    '  IP Flow switching is disabled',
    '  IP CEF switching is enabled',
    '  IP Feature Fast switching turbo vector',
    '  IP VPN Flow CEF switching turbo vector',
    '  IP multicast fast switching is enabled',
    '  IP multicast distributed fast switching is disabled',
    '  IP route-cache flags are Fast, CEF',
    '  Router Discovery is disabled',
    '  IP output packet accounting is disabled',
    '  IP access violation accounting is disabled',
    '  TCP/IP header compression is disabled',
    '  RTP/IP header compression is disabled',
    '  Policy routing is disabled',
    entry?.nat
      ? `  Network address translation is enabled, interface in domain ${entry.nat}`
      : '  Network address translation is disabled',
    '  BGP Policy Mapping is disabled'
  ]
  lines.forEach((l) => ctx.print(l))
}

// ---------------------------------------------------------------------------
// show arp / show ip arp
// ---------------------------------------------------------------------------

interface ArpRow {
  ip: string
  age: string
  mac: string
  iface: string
}

function arpRows(ctx: IosRunContext): ArpRow[] {
  const device = deviceOf(ctx)
  const up = (name: string) => {
    const i = device.interfaces.find((x) => x.name === name)
    return !!i && ifaceStatus(ctx.state, device, i).protocol === 'up'
  }
  const rows: ArpRow[] = []
  for (const i of device.interfaces)
    if (i.address && i.l3 && up(i.name))
      rows.push({ ip: i.address, age: '-', mac: iosMac(i.mac), iface: ifaceLongName(i.name) })
  for (const a of iosState(device).arpTable)
    if (up(a.iface) && !rows.some((r) => r.ip === a.ip))
      rows.push({
        ip: a.ip,
        age: String(Math.floor((ctx.state.clock - a.at) / 60000)),
        mac: iosMac(a.mac),
        iface: ifaceLongName(a.iface)
      })
  return rows.sort((a, b) => ipNum(a.ip) - ipNum(b.ip))
}

/** show arp : colonnes de l'exemple « show arp ». */
function showArp(ctx: IosRunContext): void {
  ctx.print('Protocol   Address          Age (min)   Hardware Addr    Type    Interface')
  for (const r of arpRows(ctx))
    ctx.print(
      `${'Internet'.padEnd(11)}${r.ip.padEnd(17)}${r.age.padEnd(12)}${r.mac.padEnd(17)}${'ARPA'.padEnd(8)}${r.iface}`
    )
}

/** show ip arp : colonnes de l'exemple « show ip arp ». */
function showIpArp(ctx: IosRunContext): void {
  ctx.print('Protocol  Address              Age(min)       Hardware Addr     Type      Interface')
  for (const r of arpRows(ctx))
    ctx.print(
      `${'Internet'.padEnd(10)}${r.ip.padEnd(21)}${r.age.padEnd(15)}${r.mac.padEnd(18)}${'ARPA'.padEnd(10)}${r.iface}`
    )
}

// ---------------------------------------------------------------------------
// Commandes
// ---------------------------------------------------------------------------

function setDebug(ctx: IosRunContext, name: 'ip packet' | 'ip ospf events', on: boolean): void {
  if (
    update(ctx, (d) => {
      const ios = draftIosState(d)
      ios.debugs = ios.debugs.filter((x) => x !== name)
      if (on) ios.debugs.push(name)
    })
  )
    ctx.print(`${name === 'ip packet' ? 'IP packet' : 'OSPF events'} debugging is ${on ? 'on' : 'off'}`)
}

function undebugAll(ctx: IosRunContext): void {
  if (
    update(ctx, (d) => {
      draftIosState(d).debugs = []
    })
  )
    ctx.print('All possible debugging has been turned off')
}

const DEBUG = kw('debug', "Debugging functions (see also 'undebug')")
const DEBUG_IP = kw('ip', 'IP information')

const commands: CliCommand[] = [
  {
    modes: ['user', 'exec'],
    syntax: [SHOW, SHOW_IP, kw('nat', 'IP NAT information'), kw('statistics', 'Translation statistics')],
    run: showNatStatistics
  },
  {
    modes: ['user', 'exec'],
    syntax: [
      SHOW,
      SHOW_IP,
      kw('dhcp', 'Show items in the DHCP database'),
      kw('pool', 'DHCP pools information')
    ],
    run: showDhcpPool
  },
  {
    modes: ['user', 'exec'],
    syntax: [
      SHOW,
      SHOW_IP,
      kw('dhcp', 'Show items in the DHCP database'),
      kw('conflict', 'DHCP address conflicts')
    ],
    // Aucune détection de conflit simulée (ping / ARP gratuit avant attribution) : en-tête seul
    run: (ctx) => ctx.print('IP address    Detection method     Detection time         VRF')
  },
  {
    modes: ['exec'],
    syntax: [
      kw('clear', 'Reset functions'),
      kw('ip', 'IP'),
      kw('dhcp', 'Delete items from the DHCP database'),
      kw('binding', 'DHCP address bindings'),
      kw('*', 'Clear all automatic bindings')
    ],
    run: (ctx) =>
      update(ctx, (d) => {
        for (const scope of draftIosState(d).dhcpServer?.scopes ?? []) scope.leases = []
      })
  },
  {
    modes: ['user', 'exec'],
    syntax: [SHOW, SHOW_IP, kw('interface', 'IP interface status and configuration')],
    run: (ctx) => {
      const device = deviceOf(ctx)
      for (const i of device.interfaces) showIpInterface(ctx, device, i)
    }
  },
  {
    modes: ['user', 'exec'],
    syntax: [
      SHOW,
      SHOW_IP,
      kw('interface', 'IP interface status and configuration'),
      { arg: 'iface', type: iface({ subinterfaces: true, vlans: true }), help: 'Interface' }
    ],
    run: (ctx, args) => {
      const device = deviceOf(ctx)
      const i = device.interfaces.find((x) => x.name === args.iface)
      if (i) showIpInterface(ctx, device, i)
    }
  },
  { modes: ['user', 'exec'], syntax: [SHOW, kw('arp', 'ARP table')], run: showArp },
  { modes: ['user', 'exec'], syntax: [SHOW, SHOW_IP, kw('arp', 'IP ARP table')], run: showIpArp },
  {
    modes: ['exec'],
    syntax: [DEBUG, DEBUG_IP, kw('packet', 'General IP debugging and IPSO security transactions')],
    available: isRouter,
    run: (ctx) => setDebug(ctx, 'ip packet', true)
  },
  {
    modes: ['exec'],
    syntax: [DEBUG, DEBUG_IP, kw('ospf', 'OSPF information'), kw('events', 'OSPF events')],
    available: isRouter,
    run: (ctx) => setDebug(ctx, 'ip ospf events', true)
  },
  {
    modes: ['exec'],
    syntax: [
      kw('undebug', "Disable debugging functions (see also 'debug')"),
      kw('all', 'Disable all debugging')
    ],
    run: undebugAll
  },
  {
    // no debug all : forme négative de debug all (debug all lui-même n'est pas simulé)
    modes: ['exec'],
    syntax: [DEBUG, kw('all', 'Enable all debugging')],
    run: (ctx) => ctx.print(`% ${unsimulatedIosMessage('debug all')}`),
    no: { run: undebugAll }
  }
]

export const diagnostics = defineIosFeature({ id: 'diagnostics', commands, settleMessages: debugMessages })
