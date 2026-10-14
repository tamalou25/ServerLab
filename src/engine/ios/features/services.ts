/**
 * Services IP IOS : relais DHCP (ip helper-address, interopérable avec le DHCP Windows Server),
 * serveur DHCP (ip dhcp pool, excluded-address, show ip dhcp binding) et NAT/PAT (ip nat inside / outside, ip nat inside source list … overload, NAT
 * statique, show ip nat translations). Le NAT s'applique par les crochets de transit du moteur.
 */
import type { Draft } from 'immer'
import type { DhcpScope } from '../../model/dhcp'
import type { IosState, NatRule, NetInterface } from '../../model/schema'
import { formatIpv4, maskToPrefix, networkAddress, parseIpv4, prefixToMaskInt } from '../../net/ipv4'
import type { TransitPacket } from '../../sim/transit'
import { aclPermits } from '../acl'
import { IPV4, WORD, iface, number } from '../cli/args'
import type { ArgContext, CliCommand, IosRunContext, SyntaxToken } from '../cli/types'
import { draftIfaceEntry, draftIosState, iosState } from '../config'
import { isIos, type IosDevice } from '../device'
import { defineIosFeature } from '../feature'
import { ifaceLongName } from '../models'
import type { ConfigBlock } from '../running-config'
import { currentIfaces, deviceOf, update } from './base'

const kw = (keyword: string, help: string): SyntaxToken => ({ keyword, help })

const layer3Iface = (ctx: ArgContext): boolean => currentIfaces(ctx).every((i) => i.l3)
const IF_MODES = ['config-if', 'config-subif'] as const

// ---------------------------------------------------------------------------
// Relais DHCP et rôle NAT des interfaces
// ---------------------------------------------------------------------------

function setHelpers(ctx: IosRunContext, change: (list: string[]) => string[]): void {
  const ids = new Set(currentIfaces(ctx).map((i) => i.id))
  update(ctx, (d) => {
    for (const i of d.interfaces) {
      if (!ids.has(i.id)) continue
      const next = change([...(i.helperAddresses ?? [])])
      if (next.length > 0) i.helperAddresses = next
      else delete i.helperAddresses
    }
  })
}

function setNatRole(ctx: IosRunContext, role: 'inside' | 'outside' | null): void {
  const names = currentIfaces(ctx).map((i) => i.name)
  update(ctx, (d) => {
    const ios = draftIosState(d)
    for (const name of names) draftIfaceEntry(ios, name).nat = role
  })
}

// ---------------------------------------------------------------------------
// Serveur DHCP
// ---------------------------------------------------------------------------

/** Pool sans réseau : étendue inactive. */
function emptyPool(name: string, excluded: IosState['dhcpExcluded']): DhcpScope {
  return {
    scopeId: '0.0.0.0',
    name,
    description: '',
    start: '0.0.0.0',
    end: '0.0.0.0',
    prefixLength: 24,
    state: 'Inactive',
    leaseDurationSec: 24 * 3600,
    exclusions: excluded.map((e) => ({ ...e })),
    reservations: [],
    leases: [],
    options: { router: [], dnsServers: [], dnsDomain: null }
  }
}

/** Serveur DHCP IOS modifiable (créé au premier pool) ; exclusions recopiées dans chaque pool. */
function draftDhcp(d: Draft<IosDevice>) {
  const ios = draftIosState(d)
  ios.dhcpServer ??= {
    authorized: true,
    configured: true,
    scopes: [],
    serverOptions: { router: [], dnsServers: [], dnsDomain: null }
  }
  return { ios, server: ios.dhcpServer }
}

function syncExclusions(ios: Draft<IosState>): void {
  for (const scope of ios.dhcpServer?.scopes ?? []) scope.exclusions = ios.dhcpExcluded.map((e) => ({ ...e }))
}

/** Modifie le pool en cours de configuration. */
function updatePool(ctx: IosRunContext, change: (pool: Draft<DhcpScope>) => void): void {
  const name = ctx.session.pool ?? ''
  update(ctx, (d) => {
    const pool = draftDhcp(d).server.scopes.find((s) => s.name === name)
    if (pool) change(pool)
  })
}

function setPoolNetwork(ctx: IosRunContext, network: string, mask: string): void {
  const prefix = maskToPrefix(mask)
  if (prefix === null || prefix < 1 || prefix > 30) {
    ctx.print(`% Invalid network mask ${mask}`)
    return
  }
  const base = parseIpv4(networkAddress(network, prefix)) ?? 0
  const broadcast = (base | (~prefixToMaskInt(prefix) >>> 0)) >>> 0
  updatePool(ctx, (pool) => {
    pool.scopeId = formatIpv4(base)
    pool.prefixLength = prefix
    pool.start = formatIpv4(base + 1)
    pool.end = formatIpv4(broadcast - 1)
    pool.state = 'Active'
    pool.leases = []
  })
}

/** Date IOS d'une échéance de bail (horloge d'usine : 1er mars 1993). */
function leaseDate(ms: number): string {
  const date = new Date(Date.UTC(1993, 2, 1) + ms)
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const h = date.getUTCHours()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${months[date.getUTCMonth()]} ${pad(date.getUTCDate())} ${date.getUTCFullYear()} ${pad(h % 12 || 12)}:${pad(date.getUTCMinutes())} ${h < 12 ? 'AM' : 'PM'}`
}

/** Identifiant client DHCP (type 01 + MAC, par groupes de quatre chiffres). */
function clientId(mac: string): string {
  const hex = `01${mac.replace(/[^0-9a-f]/gi, '').toLowerCase()}`
  return hex.match(/.{1,4}/g)?.join('.') ?? hex
}

function showDhcpBinding(ctx: IosRunContext): void {
  const scopes = iosState(deviceOf(ctx)).dhcpServer?.scopes ?? []
  ctx.print('Bindings from all pools not associated with VRF:')
  ctx.print(`${'IP address'.padEnd(20)}${'Client-ID/'.padEnd(24)}${'Lease expiration'.padEnd(24)}Type`)
  ctx.print(`${''.padEnd(20)}Hardware address/`)
  ctx.print(`${''.padEnd(20)}User name`)
  for (const scope of scopes)
    for (const lease of scope.leases.filter((l) => l.state === 'Active'))
      ctx.print(
        `${lease.ip.padEnd(20)}${clientId(lease.mac).padEnd(24)}${leaseDate(lease.expiresAt).padEnd(24)}Automatic`
      )
}

// ---------------------------------------------------------------------------
// NAT
// ---------------------------------------------------------------------------

function addNatRule(ctx: IosRunContext, rule: NatRule): void {
  update(ctx, (d) => {
    const ios = draftIosState(d)
    const key = JSON.stringify(rule)
    if (!ios.natRules.some((r) => JSON.stringify(r) === key)) ios.natRules.push(rule)
  })
}

function removeNatRule(ctx: IosRunContext, match: (r: NatRule) => boolean): void {
  update(ctx, (d) => {
    const ios = draftIosState(d)
    ios.natRules = ios.natRules.filter((r) => !match(r))
  })
}

const pad22 = (s: string) => s.padEnd(22)

function showNatTranslations(ctx: IosRunContext): void {
  const ios = iosState(deviceOf(ctx))
  ctx.print(`Pro  ${pad22('Inside global')}${pad22('Inside local')}${pad22('Outside local')}Outside global`)
  for (const t of ios.natTranslations)
    ctx.print(
      `${t.protocol} ${pad22(t.insideGlobal)}${pad22(t.insideLocal)}${pad22(t.outsideLocal)}${t.outsideGlobal}`
    )
  for (const r of ios.natRules)
    if (r.kind === 'static') ctx.print(`--- ${pad22(r.global)}${pad22(r.local)}${pad22('---')}---`)
}

/** Rôle NAT d'une interface de l'équipement. */
function natRole(device: IosDevice, ifaceId: string | null): 'inside' | 'outside' | null {
  const name = device.interfaces.find((i) => i.id === ifaceId)?.name
  return name ? (iosState(device).interfaces[name]?.nat ?? null) : null
}

const protocolOf = (packet: TransitPacket): 'icmp' | 'tcp' | 'udp' =>
  /icmp|écho|echo|ping/i.test(packet.summary) ? 'icmp' : /udp|dns|dhcp/i.test(packet.summary) ? 'udp' : 'tcp'

/** Adresse publique de la traduction d'un paquet sortant (règle statique ou dynamique), ou null. */
function translation(
  device: IosDevice,
  egress: NetInterface | undefined,
  src: string,
  dst: string
): string | null {
  const ios = iosState(device)
  for (const rule of ios.natRules) {
    if (rule.kind === 'static' && rule.local === src) return rule.global
    if (rule.kind !== 'dynamic' || !egress || rule.iface !== egress.name || !egress.address) continue
    const acl = ios.acls.find((a) => a.name === rule.acl)
    if (acl && aclPermits(acl, { src, dst, protocol: 'other' })) return egress.address
  }
  return null
}

// ---------------------------------------------------------------------------
// Commandes
// ---------------------------------------------------------------------------

const DHCP = [
  kw('ip', 'Global IP configuration subcommands'),
  kw('dhcp', 'Configure DHCP server and relay parameters')
]
const NAT_SOURCE = [
  kw('ip', 'Global IP configuration subcommands'),
  kw('nat', 'NAT configuration commands'),
  kw('inside', 'Inside address translation'),
  kw('source', 'Source address translation')
]

const commands: CliCommand[] = [
  // --- relais DHCP et rôle NAT des interfaces ---
  {
    modes: IF_MODES,
    syntax: [
      kw('ip', 'Interface Internet Protocol config commands'),
      kw('helper-address', 'Specify a destination address for UDP broadcasts'),
      { arg: 'address', type: IPV4, help: 'IP destination address' }
    ],
    available: layer3Iface,
    run: (ctx, args) =>
      setHelpers(ctx, (l) => (l.includes(args.address ?? '') ? l : [...l, args.address ?? ''])),
    no: {
      min: 2,
      run: (ctx, args) => setHelpers(ctx, (l) => (args.address ? l.filter((a) => a !== args.address) : []))
    }
  },
  ...(['inside', 'outside'] as const).map((role): CliCommand => ({
    modes: IF_MODES,
    syntax: [
      kw('ip', 'Interface Internet Protocol config commands'),
      kw('nat', 'NAT interface commands'),
      kw(
        role,
        role === 'inside'
          ? 'Inside interface for address translation'
          : 'Outside interface for address translation'
      )
    ],
    available: layer3Iface,
    run: (ctx) => setNatRole(ctx, role),
    no: { run: (ctx) => setNatRole(ctx, null) }
  })),

  // --- serveur DHCP ---
  ...[false, true].map((range): CliCommand => ({
    modes: ['config'],
    syntax: [
      ...DHCP,
      kw('excluded-address', 'Prevent DHCP from assigning certain addresses'),
      { arg: 'low', type: IPV4, help: 'Low IP address' },
      ...(range ? [{ arg: 'high', type: IPV4, help: 'High IP address' }] : [])
    ],
    run: (ctx, args) =>
      update(ctx, (d) => {
        const ios = draftIosState(d)
        const entry = { start: args.low ?? '', end: args.high ?? args.low ?? '' }
        if (!ios.dhcpExcluded.some((e) => e.start === entry.start && e.end === entry.end))
          ios.dhcpExcluded.push(entry)
        syncExclusions(ios)
      }),
    no: {
      run: (ctx, args) =>
        update(ctx, (d) => {
          const ios = draftIosState(d)
          ios.dhcpExcluded = ios.dhcpExcluded.filter(
            (e) => !(e.start === args.low && e.end === (args.high ?? args.low))
          )
          syncExclusions(ios)
        })
    }
  })),
  {
    modes: ['config'],
    syntax: [
      ...DHCP,
      kw('pool', 'Configure DHCP address pools'),
      { arg: 'name', type: WORD, help: 'Pool name' }
    ],
    run: (ctx, args) => {
      const name = args.name ?? ''
      const ok = update(ctx, (d) => {
        const { ios, server } = draftDhcp(d)
        if (!server.scopes.some((s) => s.name === name)) server.scopes.push(emptyPool(name, ios.dhcpExcluded))
      })
      if (ok) ctx.setMode('dhcp-config', { pool: name })
    },
    no: {
      run: (ctx, args) =>
        update(ctx, (d) => {
          const server = draftIosState(d).dhcpServer
          if (server) server.scopes = server.scopes.filter((s) => s.name !== args.name)
        })
    }
  },
  {
    modes: ['dhcp-config'],
    syntax: [
      kw('network', 'Network number and mask'),
      { arg: 'network', type: IPV4, help: 'Network number in dotted-decimal notation' },
      { arg: 'mask', type: IPV4, help: 'Network mask or prefix length' }
    ],
    run: (ctx, args) => setPoolNetwork(ctx, args.network ?? '', args.mask ?? '')
  },
  ...[1, 2, 3, 4].flatMap((count): CliCommand[] =>
    (
      [
        ['default-router', 'Default routers', 'router'],
        ['dns-server', 'DNS servers', 'dnsServers']
      ] as const
    ).map(([word, help, field]) => ({
      modes: ['dhcp-config'],
      syntax: [
        kw(word, help),
        ...Array.from({ length: count }, (_, i) => ({
          arg: `a${i}`,
          type: IPV4,
          help: i === 0 ? 'IP address' : 'IP address'
        }))
      ],
      run: (ctx, args) => {
        const list = Array.from({ length: count }, (_, i) => args[`a${i}`] ?? '')
        updatePool(ctx, (pool) => {
          pool.options[field] = list
        })
      },
      no: {
        min: 1,
        run: (ctx) =>
          updatePool(ctx, (pool) => {
            pool.options[field] = []
          })
      }
    }))
  ),
  {
    modes: ['dhcp-config'],
    syntax: [kw('domain-name', 'Domain name'), { arg: 'domain', type: WORD, help: 'Domain name' }],
    run: (ctx, args) =>
      updatePool(ctx, (pool) => {
        pool.options.dnsDomain = args.domain ?? null
      }),
    no: {
      min: 1,
      run: (ctx) =>
        updatePool(ctx, (pool) => {
          pool.options.dnsDomain = null
        })
    }
  },
  {
    modes: ['user', 'exec'],
    syntax: [
      kw('show', 'Show running system information'),
      kw('ip', 'IP information'),
      kw('dhcp', 'Show items in the DHCP database'),
      kw('binding', 'DHCP address bindings')
    ],
    run: showDhcpBinding
  },

  // --- NAT ---
  ...[false, true].map((overload): CliCommand => ({
    modes: ['config'],
    syntax: [
      ...NAT_SOURCE,
      kw('list', 'Specify access list describing local addresses'),
      { arg: 'acl', type: number(1, 99), help: 'Access list number for local addresses' },
      kw('interface', 'Specify interface for global address'),
      { arg: 'iface', type: iface({ subinterfaces: true, vlans: true }), help: 'Interface' },
      ...(overload ? [kw('overload', 'Overload an address translation')] : [])
    ],
    run: (ctx, args) =>
      addNatRule(ctx, { kind: 'dynamic', acl: args.acl ?? '', iface: args.iface ?? '', overload }),
    no: {
      run: (ctx, args) =>
        removeNatRule(ctx, (r) => r.kind === 'dynamic' && r.acl === args.acl && r.iface === args.iface)
    }
  })),
  {
    modes: ['config'],
    syntax: [
      ...NAT_SOURCE,
      kw('static', 'Specify static local->global mapping'),
      { arg: 'local', type: IPV4, help: 'Inside local IP address' },
      { arg: 'global', type: IPV4, help: 'Inside global IP address' }
    ],
    run: (ctx, args) =>
      addNatRule(ctx, { kind: 'static', local: args.local ?? '', global: args.global ?? '' }),
    no: { run: (ctx, args) => removeNatRule(ctx, (r) => r.kind === 'static' && r.local === args.local) }
  },
  {
    modes: ['user', 'exec'],
    syntax: [
      kw('show', 'Show running system information'),
      kw('ip', 'IP information'),
      kw('nat', 'IP NAT information'),
      kw('translations', 'Translation entries')
    ],
    run: showNatTranslations
  },
  {
    modes: ['exec'],
    syntax: [
      kw('clear', 'Reset functions'),
      kw('ip', 'IP'),
      kw('nat', 'Clear NAT'),
      kw('translation', 'Clear dynamic translation'),
      kw('*', 'Delete all dynamic translations')
    ],
    run: (ctx) =>
      update(ctx, (d) => {
        draftIosState(d).natTranslations = []
      })
  }
]

function config(device: IosDevice): ConfigBlock[] {
  const ios = iosState(device)
  const blocks: ConfigBlock[] = []
  if (ios.dhcpExcluded.length > 0)
    blocks.push({
      order: 50,
      lines: ios.dhcpExcluded.map(
        (e) => `ip dhcp excluded-address ${e.start}${e.end !== e.start ? ` ${e.end}` : ''}`
      )
    })
  for (const pool of ios.dhcpServer?.scopes ?? []) {
    const lines = [`ip dhcp pool ${pool.name}`]
    if (pool.state === 'Active')
      lines.push(` network ${pool.scopeId} ${formatIpv4(prefixToMaskInt(pool.prefixLength))}`)
    if (pool.options.router.length) lines.push(` default-router ${pool.options.router.join(' ')}`)
    if (pool.options.dnsServers.length) lines.push(` dns-server ${pool.options.dnsServers.join(' ')}`)
    if (pool.options.dnsDomain) lines.push(` domain-name ${pool.options.dnsDomain}`)
    blocks.push({ order: 51, lines })
  }
  const nat = ios.natRules.map((r) =>
    r.kind === 'static'
      ? `ip nat inside source static ${r.local} ${r.global}`
      : `ip nat inside source list ${r.acl} interface ${ifaceLongName(r.iface)}${r.overload ? ' overload' : ''}`
  )
  if (nat.length) blocks.push({ order: 115, lines: nat })
  return blocks
}

function interfaceConfig(device: IosDevice, i: NetInterface): ConfigBlock[] {
  const blocks: ConfigBlock[] = []
  for (const h of i.helperAddresses ?? []) blocks.push({ order: 40, lines: [`ip helper-address ${h}`] })
  const role = iosState(device).interfaces[i.name]?.nat
  if (role) blocks.push({ order: 45, lines: [`ip nat ${role}`] })
  return blocks
}

export const services = defineIosFeature({
  id: 'services',
  commands,
  config,
  interfaceConfig,
  transit: {
    // NAT statique : le routeur répond à l'ARP pour l'adresse globale
    proxyArp: (_state, device, ip) =>
      isIos(device) && iosState(device).natRules.some((r) => r.kind === 'static' && r.global === ip),
    translate(ctx, device, ingressIfaceId, egressIfaceId, packet) {
      if (!isIos(device) || ingressIfaceId === null) return null
      if (natRole(device, ingressIfaceId) !== 'inside' || natRole(device, egressIfaceId) !== 'outside')
        return null
      const egress = device.interfaces.find((i) => i.id === egressIfaceId)
      const pub = translation(device, egress, packet.src, packet.dst)
      if (!pub) return null
      ctx.nat.set(`${device.id}|${pub}|${packet.dst}`, packet.src)
      const protocol = protocolOf(packet)
      const port = protocol === 'icmp' ? ':1' : ''
      const isStatic = iosState(device).natRules.some((r) => r.kind === 'static' && r.local === packet.src)
      if (!isStatic)
        ctx.effects.push({
          kind: 'nat',
          deviceId: device.id,
          data: {
            protocol,
            insideGlobal: `${pub}${port}`,
            insideLocal: `${packet.src}${port}`,
            outsideLocal: `${packet.dst}${port}`,
            outsideGlobal: `${packet.dst}${port}`
          }
        })
      return {
        src: pub,
        note: `${device.name} (NAT${isStatic ? ' statique' : ' PAT'}) traduit l’adresse source ${packet.src} en ${pub} (ip nat inside → outside).`
      }
    },
    untranslate(ctx, device, packet) {
      if (!isIos(device)) return null
      const dynamic = ctx.nat.get(`${device.id}|${packet.dst}|${packet.src}`)
      const local =
        dynamic ??
        iosState(device).natRules.find(
          (r): r is Extract<NatRule, { kind: 'static' }> => r.kind === 'static' && r.global === packet.dst
        )?.local
      if (!local) return null
      return {
        dst: local,
        note: `${device.name} (NAT) retraduit l’adresse de destination ${packet.dst} en ${local}.`
      }
    }
  },
  onEffect(device, effect) {
    if (effect.kind !== 'nat') return
    const ios = draftIosState(device)
    ios.natHits += 1
    const t = effect.data
    const entry = {
      protocol: t.protocol as 'icmp' | 'tcp' | 'udp',
      insideGlobal: String(t.insideGlobal),
      insideLocal: String(t.insideLocal),
      outsideLocal: String(t.outsideLocal),
      outsideGlobal: String(t.outsideGlobal)
    }
    if (!ios.natTranslations.some((x) => JSON.stringify(x) === JSON.stringify(entry)))
      ios.natTranslations.push(entry)
  }
})
