/**
 * Routage IOS : routes statiques (ip route, route par défaut) et OSPF monozone (router ospf,
 * network … area, router-id, passive-interface), show ip route et show ip ospf neighbor.
 * Les routes sont installées dans la table de routage du moteur (pas de second moteur).
 */
import type { Draft } from 'immer'
import { raise } from '../../core/result'
import type { LabState, OspfProcess } from '../../model/schema'
import { maskToPrefix, networkAddress, parseIpv4, prefixToMask } from '../../net/ipv4'
import { routingTable, type Route } from '../../net/routing'
import { IPV4, iface, number } from '../cli/args'
import type { ArgContext, CliCommand, IosRunContext, SyntaxToken } from '../cli/types'
import { draftIosState, iosState } from '../config'
import { isIos, type IosDevice } from '../device'
import { defineIosFeature } from '../feature'
import { ifaceLongName, IOS_MODEL_INFO } from '../models'
import { ospfDatabase, ospfRoutes, type OspfNeighbor } from '../ospf'
import type { ConfigBlock } from '../running-config'
import { ifaceStatus } from '../status'
import { deviceOf, update } from './base'
import { inRip, ripAge, updateRip } from './rip'

const kw = (keyword: string, help: string): SyntaxToken => ({ keyword, help })

/** Routeur, ou switch de niveau 3 (9200). */
const routes = (ctx: ArgContext): boolean => {
  const d = ctx.state.devices[ctx.deviceId]
  return d?.kind === 'router' || (d?.kind === 'switch' && isIos(d) && IOS_MODEL_INFO[d.model].layer3)
}

// ---------------------------------------------------------------------------
// Routes statiques
// ---------------------------------------------------------------------------

function addRoute(ctx: IosRunContext, network: string, mask: string, nextHop: string): void {
  const prefix = maskToPrefix(mask)
  if (prefix === null || networkAddress(network, prefix) !== network) {
    ctx.print('%Inconsistent address and mask')
    return
  }
  if (deviceOf(ctx).interfaces.some((i) => i.address === nextHop)) {
    ctx.print("%Invalid next hop address (it's this router)")
    return
  }
  update(ctx, (d) => {
    const list = (d.routes ??= [])
    if (!list.some((r) => r.network === network && r.prefixLength === prefix && r.nextHop === nextHop))
      list.push({ network, prefixLength: prefix, nextHop })
  })
}

function removeRoute(ctx: IosRunContext, network: string, mask: string, nextHop?: string): void {
  const prefix = maskToPrefix(mask)
  update(ctx, (d) => {
    if (!d.routes) return
    d.routes = d.routes.filter(
      (r) =>
        !(
          r.network === network &&
          r.prefixLength === prefix &&
          (nextHop === undefined || r.nextHop === nextHop)
        )
    )
  })
}

// ---------------------------------------------------------------------------
// OSPF
// ---------------------------------------------------------------------------

/** Voisins OSPF de l'équipement (clé : interface + identifiant). */
function neighborKeys(state: LabState, deviceId: string): Map<string, OspfNeighbor> {
  return new Map(
    (ospfDatabase(state).neighbors.get(deviceId) ?? []).map((n) => [`${n.ifaceId}|${n.routerId}`, n])
  )
}

/** Modifie le processus OSPF courant et affiche les changements de voisinage (%OSPF-5-ADJCHG). */
function updateOspf(ctx: IosRunContext, change: (proc: Draft<OspfProcess>) => void): void {
  const process = ctx.session.router?.process ?? 0
  const before = neighborKeys(ctx.state, ctx.deviceId)
  const ok = update(ctx, (d) => {
    const proc = draftIosState(d).ospf.find((p) => p.process === process)
    if (!proc) raise('NoProcess', `Processus OSPF ${process} introuvable.`)
    change(proc)
  })
  if (!ok) return
  const after = neighborKeys(ctx.state, ctx.deviceId)
  const name = (id: string) => ifaceLongName(deviceOf(ctx).interfaces.find((i) => i.id === id)?.name ?? '')
  for (const [key, n] of after)
    if (!before.has(key))
      ctx.print(
        `%OSPF-5-ADJCHG: Process ${process}, Nbr ${n.routerId} on ${name(n.ifaceId)} from LOADING to FULL, Loading Done`
      )
  for (const [key, n] of before)
    if (!after.has(key))
      ctx.print(
        `%OSPF-5-ADJCHG: Process ${process}, Nbr ${n.routerId} on ${name(n.ifaceId)} from FULL to DOWN, Neighbor Down: Interface down or detached`
      )
}

function enterOspf(ctx: IosRunContext, process: number): void {
  const ok = update(ctx, (d) => {
    const ospf = draftIosState(d).ospf
    if (ospf.some((p) => p.process === process)) return
    if (ospf.length > 0) raise('OneProcess', 'Un seul processus OSPF est simulé par équipement.')
    ospf.push({
      process,
      routerId: null,
      networks: [],
      passive: [],
      passiveDefault: false,
      active: [],
      defaultOriginate: null
    })
  })
  if (ok) ctx.setMode('config-router', { router: { protocol: 'ospf', process } })
}

// ---------------------------------------------------------------------------
// show ip route
// ---------------------------------------------------------------------------

const CODES = [
  'Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP',
  '       D - EIGRP, EX - EIGRP external, O - OSPF, IA - OSPF inter area ',
  '       N1 - OSPF NSSA external type 1, N2 - OSPF NSSA external type 2',
  '       E1 - OSPF external type 1, E2 - OSPF external type 2',
  '       i - IS-IS, su - IS-IS summary, L1 - IS-IS level-1, L2 - IS-IS level-2',
  '       ia - IS-IS inter area, * - candidate default, U - per-user static route',
  '       o - ODR, P - periodic downloaded static route, H - NHRP, l - LISP',
  '       + - replicated route, % - next hop override'
]

interface RouteLine {
  network: string
  prefixLength: number
  code: string
  text: string
}

/** Masque de classe (A /8, B /16, C /24). */
function classfulPrefix(network: string): number {
  const first = Number(network.split('.')[0])
  return first < 128 ? 8 : first < 192 ? 16 : 24
}

const sortKey = (l: RouteLine): number => (parseIpv4(l.network) ?? 0) * 64 + l.prefixLength

function age(state: LabState): string {
  const s = Math.floor(state.clock / 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`
}

function showIpRoute(ctx: IosRunContext): void {
  const device = deviceOf(ctx)
  const table = routingTable(ctx.state, device)
  const ifName = (id: string) => ifaceLongName(device.interfaces.find((i) => i.id === id)?.name ?? '')
  const lines: RouteLine[] = []
  for (const i of device.interfaces) {
    if (!i.address || i.prefixLength === null || ifaceStatus(ctx.state, device, i).protocol !== 'up') continue
    const name = ifaceLongName(i.name)
    lines.push({
      network: networkAddress(i.address, i.prefixLength),
      prefixLength: i.prefixLength,
      code: 'C',
      text: `is directly connected, ${name}`
    })
    lines.push({ network: i.address, prefixLength: 32, code: 'L', text: `is directly connected, ${name}` })
  }
  for (const r of table) {
    if (r.source === 'connected') continue
    const gw = r.gateway ?? ''
    if (r.source === 'rip')
      lines.push({
        network: r.network,
        prefixLength: r.prefixLength,
        code: r.prefixLength === 0 ? 'R*' : 'R',
        text: `[120/${r.metric ?? 1}] via ${gw}, ${ripAge(ctx.state.clock)}, ${ifName(r.ifaceId)}`
      })
    else if (r.source === 'ospf' && r.external)
      lines.push({
        network: r.network,
        prefixLength: r.prefixLength,
        code: 'O*E2',
        text: `[110/${r.metric ?? 1}] via ${gw}, ${age(ctx.state)}, ${ifName(r.ifaceId)}`
      })
    else if (r.source === 'ospf')
      lines.push({
        network: r.network,
        prefixLength: r.prefixLength,
        code: 'O',
        text: `[110/${r.metric ?? 1}] via ${gw}, ${age(ctx.state)}, ${ifName(r.ifaceId)}`
      })
    else
      lines.push({
        network: r.network,
        prefixLength: r.prefixLength,
        code: r.prefixLength === 0 ? 'S*' : 'S',
        text: `[1/0] via ${gw}`
      })
  }
  lines.sort((a, b) => sortKey(a) - sortKey(b))
  const fallback = table.find((r: Route) => r.prefixLength === 0 && r.gateway)
  CODES.forEach((l) => ctx.print(l))
  ctx.print('')
  ctx.print(
    fallback
      ? `Gateway of last resort is ${fallback.gateway} to network 0.0.0.0`
      : 'Gateway of last resort is not set'
  )
  ctx.print('')
  // Regroupement par réseau de classe
  const groups = new Map<string, RouteLine[]>()
  for (const l of lines) {
    const key =
      l.prefixLength === 0
        ? '0.0.0.0/0'
        : `${networkAddress(l.network, classfulPrefix(l.network))}/${classfulPrefix(l.network)}`
    groups.set(key, [...(groups.get(key) ?? []), l])
  }
  for (const [key, group] of groups) {
    const [net, cls] = key.split('/')
    const masks = new Set(group.map((g) => g.prefixLength))
    const single = group.length === 1 && group[0]?.prefixLength === Number(cls)
    if (single || key === '0.0.0.0/0') {
      for (const g of group) ctx.print(`${g.code.padEnd(6)}${g.network}/${g.prefixLength} ${g.text}`)
      continue
    }
    const count = `${group.length} subnet${group.length > 1 ? 's' : ''}`
    ctx.print(
      masks.size === 1
        ? `      ${net}/${[...masks][0]} is subnetted, ${count}`
        : `      ${net}/${cls} is variably subnetted, ${count}, ${masks.size} masks`
    )
    for (const g of group) ctx.print(`${g.code.padEnd(9)}${g.network}/${g.prefixLength} ${g.text}`)
  }
}

// ---------------------------------------------------------------------------
// show ip ospf neighbor
// ---------------------------------------------------------------------------

const ridValue = (rid: string): number => parseIpv4(rid) ?? 0

function showOspfNeighbor(ctx: IosRunContext): void {
  const db = ospfDatabase(ctx.state)
  const self = db.routers.get(ctx.deviceId)
  const list = db.neighbors.get(ctx.deviceId) ?? []
  if (!self) return
  ctx.print('')
  ctx.print('Neighbor ID     Pri   State           Dead Time   Address         Interface')
  for (const n of list) {
    // Élection DR / BDR sur le segment : plus haut identifiant de routeur (priorités égales)
    const rids = [self.routerId, ...list.filter((x) => x.ifaceId === n.ifaceId).map((x) => x.routerId)].sort(
      (a, b) => ridValue(b) - ridValue(a)
    )
    const role = (rid: string) => (rid === rids[0] ? 'DR' : rid === rids[1] ? 'BDR' : 'DROTHER')
    const full = role(self.routerId) !== 'DROTHER' || role(n.routerId) !== 'DROTHER'
    const state = `${full ? 'FULL' : '2WAY'}/${role(n.routerId)}`
    const name = ifaceLongName(deviceOf(ctx).interfaces.find((i) => i.id === n.ifaceId)?.name ?? '')
    ctx.print(
      `${n.routerId.padEnd(15)}${'1'.padStart(4)}   ${state.padEnd(16)}${'00:00:35'.padEnd(12)}${n.address.padEnd(16)}${name}`
    )
  }
}

// ---------------------------------------------------------------------------
// Commandes
// ---------------------------------------------------------------------------

const IP_ROUTE = [
  kw('ip', 'Global IP configuration subcommands'),
  kw('route', 'Establish static routes'),
  { arg: 'network', type: IPV4, help: 'Destination prefix' },
  { arg: 'mask', type: IPV4, help: 'Destination prefix mask' }
]
const NETWORK = [
  kw('network', 'Enable routing on an IP network'),
  { arg: 'network', type: IPV4, help: 'Network number' },
  { arg: 'wildcard', type: IPV4, help: 'OSPF wild card bits' },
  kw('area', 'Set the OSPF area ID'),
  { arg: 'area', type: number(0, 4294967295), help: 'OSPF area ID as a decimal value' }
]
const PASSIVE = kw('passive-interface', 'Suppress routing updates on an interface')

/** Mode config-router d'un processus OSPF. */
const inOspf = (ctx: ArgContext): boolean => ctx.session.router?.protocol === 'ospf'

const commands: CliCommand[] = [
  {
    modes: ['config'],
    syntax: [...IP_ROUTE, { arg: 'nextHop', type: IPV4, help: "Forwarding router's address" }],
    available: routes,
    run: (ctx, args) => addRoute(ctx, args.network ?? '', args.mask ?? '', args.nextHop ?? ''),
    no: { min: 4, run: (ctx, args) => removeRoute(ctx, args.network ?? '', args.mask ?? '', args.nextHop) }
  },
  {
    modes: ['config'],
    syntax: [
      kw('router', 'Enable a routing process'),
      kw('ospf', 'Open Shortest Path First (OSPF)'),
      { arg: 'process', type: number(1, 65535), help: 'Process ID' }
    ],
    available: routes,
    run: (ctx, args) => enterOspf(ctx, Number(args.process)),
    no: {
      run: (ctx, args) =>
        update(ctx, (d) => {
          const ios = draftIosState(d)
          ios.ospf = ios.ospf.filter((p) => p.process !== Number(args.process))
        })
    }
  },
  {
    modes: ['config-router'],
    syntax: NETWORK,
    available: inOspf,
    run: (ctx, args) =>
      updateOspf(ctx, (proc) => {
        const entry = { network: args.network ?? '', wildcard: args.wildcard ?? '', area: Number(args.area) }
        if (!proc.networks.some((n) => n.network === entry.network && n.wildcard === entry.wildcard))
          proc.networks.push(entry)
      }),
    no: {
      run: (ctx, args) =>
        updateOspf(ctx, (proc) => {
          proc.networks = proc.networks.filter(
            (n: { network: string; wildcard: string }) =>
              !(n.network === args.network && n.wildcard === args.wildcard)
          )
        })
    }
  },
  {
    modes: ['config-router'],
    syntax: [
      kw('router-id', 'router-id for this OSPF process'),
      { arg: 'id', type: IPV4, help: 'OSPF router-id in IP address format' }
    ],
    available: inOspf,
    run: (ctx, args) => {
      updateOspf(ctx, (proc) => {
        proc.routerId = args.id ?? null
      })
      ctx.print('Reload or use "clear ip ospf process" command, for this to take effect')
    },
    no: { min: 1, run: (ctx) => updateOspf(ctx, (proc) => (proc.routerId = null)) }
  },
  {
    modes: ['config-router'],
    syntax: [PASSIVE, { arg: 'iface', type: iface({ subinterfaces: true, vlans: true }), help: 'Interface' }],
    run: (ctx, args) =>
      inRip(ctx)
        ? updateRip(ctx, (rip) => {
            if (!rip.passive.includes(args.iface ?? '')) rip.passive.push(args.iface ?? '')
          })
        : updateOspf(ctx, (proc) => {
            const name = args.iface ?? ''
            proc.active = proc.active.filter((n) => n !== name)
            if (!proc.passive.includes(name)) proc.passive.push(name)
          }),
    no: {
      run: (ctx, args) =>
        inRip(ctx)
          ? updateRip(ctx, (rip) => {
              rip.passive = rip.passive.filter((n) => n !== args.iface)
            })
          : updateOspf(ctx, (proc) => {
              const name = args.iface ?? ''
              proc.passive = proc.passive.filter((n) => n !== name)
              if (proc.passiveDefault && !proc.active.includes(name)) proc.active.push(name)
            })
    }
  },
  {
    modes: ['config-router'],
    syntax: [PASSIVE, kw('default', 'Suppress routing updates on all interfaces')],
    available: inOspf,
    run: (ctx) =>
      updateOspf(ctx, (proc) => {
        proc.passiveDefault = true
        proc.active = []
      }),
    no: {
      run: (ctx) =>
        updateOspf(ctx, (proc) => {
          proc.passiveDefault = false
          proc.active = []
        })
    }
  },
  ...[false, true].map((always): CliCommand => ({
    modes: ['config-router'],
    syntax: [
      kw('default-information', 'Control distribution of default information'),
      kw('originate', 'Distribute a default route'),
      ...(always ? [kw('always', 'Always advertise default route')] : [])
    ],
    // RIP : default-information originate sans « always »
    available: always ? inOspf : undefined,
    run: (ctx) =>
      inRip(ctx)
        ? updateRip(ctx, (rip) => (rip.defaultOriginate = true))
        : updateOspf(ctx, (proc) => (proc.defaultOriginate = always ? 'always' : 'on')),
    no: {
      min: 2,
      run: (ctx) =>
        inRip(ctx)
          ? updateRip(ctx, (rip) => (rip.defaultOriginate = false))
          : updateOspf(ctx, (proc) => (proc.defaultOriginate = null))
    }
  })),
  {
    modes: ['user', 'exec'],
    syntax: [
      kw('show', 'Show running system information'),
      kw('ip', 'IP information'),
      kw('route', 'IP routing table')
    ],
    available: routes,
    run: showIpRoute
  },
  {
    modes: ['user', 'exec'],
    syntax: [
      kw('show', 'Show running system information'),
      kw('ip', 'IP information'),
      kw('ospf', 'OSPF information'),
      kw('neighbor', 'Neighbor list')
    ],
    available: routes,
    run: showOspfNeighbor
  }
]

function config(device: IosDevice): ConfigBlock[] {
  const blocks: ConfigBlock[] = []
  for (const proc of iosState(device).ospf) {
    const lines = [`router ospf ${proc.process}`]
    if (proc.routerId) lines.push(` router-id ${proc.routerId}`)
    if (proc.passiveDefault) lines.push(' passive-interface default')
    for (const name of proc.active) lines.push(` no passive-interface ${ifaceLongName(name)}`)
    for (const name of proc.passive) lines.push(` passive-interface ${ifaceLongName(name)}`)
    for (const n of proc.networks) lines.push(` network ${n.network} ${n.wildcard} area ${n.area}`)
    if (proc.defaultOriginate)
      lines.push(` default-information originate${proc.defaultOriginate === 'always' ? ' always' : ''}`)
    blocks.push({ order: 110, lines })
  }
  const statics = device.routes ?? []
  if (statics.length > 0)
    blocks.push({
      order: 120,
      lines: statics.map((r) => `ip route ${r.network} ${prefixToMask(r.prefixLength)} ${r.nextHop}`)
    })
  return blocks
}

export const routing = defineIosFeature({
  id: 'routing',
  commands,
  config,
  routes: (state, device) => ospfRoutes(state, device)
})
