/**
 * Commandes d'affichage OSPF calculées depuis la base (ios/ospf.ts) : show ip ospf, show ip ospf
 * interface [brief], show ip ospf database, show ip protocols (OSPF et RIP), clear ip ospf process.
 * Sources : OSPF Command Reference
 * https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/iproute_ospf/command/iro-cr-book/ospf-s1.html
 * et IP Routing Protocol-Independent Command Reference (show ip protocols)
 * https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/iproute_pi/command/iri-cr-book/iri-cr-s1.html
 */
import type { LabState } from '../../model/schema'
import { parseIpv4, prefixToMask } from '../../net/ipv4'
import { iface } from '../cli/args'
import type { ArgContext, CliCommand, IosRunContext, SyntaxToken } from '../cli/types'
import { iosState } from '../config'
import { isIos } from '../device'
import { defineIosFeature } from '../feature'
import { ifaceLongName, IOS_MODEL_INFO } from '../models'
import { ospfDatabase, type OspfIface, type OspfNeighbor, type OspfRouter } from '../ospf'
import { deviceOf } from './base'
import { ripProtocolLines } from './rip'

const kw = (keyword: string, help: string): SyntaxToken => ({ keyword, help })
const SHOW = kw('show', 'Show running system information')
const SHOW_IP = kw('ip', 'IP information')
const OSPF = kw('ospf', 'OSPF information')

const routes = (ctx: ArgContext): boolean => {
  const d = ctx.state.devices[ctx.deviceId]
  return d?.kind === 'router' || (d?.kind === 'switch' && isIos(d) && IOS_MODEL_INFO[d.model].layer3)
}

const ridValue = (rid: string): number => parseIpv4(rid) ?? 0
const hex = (n: number, width: number): string => `0x${n.toString(16).toUpperCase().padStart(width, '0')}`

// ---------------------------------------------------------------------------
// Segments : DR / BDR (plus haut identifiant, priorités égales)
// ---------------------------------------------------------------------------

interface Segment {
  local: OspfIface
  neighbors: OspfNeighbor[]
  /** Identifiants et adresses du DR et du BDR (null : aucun). */
  dr: { rid: string; address: string } | null
  bdr: { rid: string; address: string } | null
  role: 'DR' | 'BDR' | 'DROTHER'
}

function segment(router: OspfRouter, list: OspfNeighbor[], local: OspfIface): Segment {
  const neighbors = local.passive ? [] : list.filter((n) => n.ifaceId === local.iface.id)
  const members = [
    { rid: router.routerId, address: local.iface.address as string },
    ...neighbors.map((n) => ({ rid: n.routerId, address: n.address }))
  ].sort((a, b) => ridValue(b.rid) - ridValue(a.rid))
  const dr = members[0] ?? null
  const bdr = members[1] ?? null
  const role = dr?.rid === router.routerId ? 'DR' : bdr?.rid === router.routerId ? 'BDR' : 'DROTHER'
  return { local, neighbors, dr, bdr, role }
}

/** Voisins en adjacence complète (FULL) : tous si DR / BDR, sinon seulement DR et BDR. */
const adjacent = (s: Segment): OspfNeighbor[] =>
  s.neighbors.filter((n) => s.role !== 'DROTHER' || n.routerId === s.dr?.rid || n.routerId === s.bdr?.rid)

function context(ctx: IosRunContext): { router: OspfRouter; segments: Segment[] } | null {
  const db = ospfDatabase(ctx.state)
  const router = db.routers.get(ctx.deviceId)
  if (!router) return null
  const list = db.neighbors.get(ctx.deviceId) ?? []
  return { router, segments: router.ifaces.map((i) => segment(router, list, i)) }
}

// ---------------------------------------------------------------------------
// LSA (somme de contrôle de Fletcher, RFC 2328 § 12.1.7)
// ---------------------------------------------------------------------------

interface Lsa {
  type: 1 | 2 | 5
  id: string
  adv: string
  body: number[]
  links: number
}

const u32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
const ip32 = (ip: string): number[] => u32(parseIpv4(ip) ?? 0)

/** Somme de contrôle ISO 8473 de l'en-tête et du corps (âge exclu). */
function lsaChecksum(lsa: Lsa, seq: number): number {
  const length = 20 + lsa.body.length
  const bytes = [
    0x22,
    lsa.type,
    ...ip32(lsa.id),
    ...ip32(lsa.adv),
    ...u32(seq),
    0,
    0,
    (length >> 8) & 255,
    length & 255,
    ...lsa.body
  ]
  let c0 = 0
  let c1 = 0
  for (const b of bytes) {
    c0 = (c0 + b) % 255
    c1 = (c1 + c0) % 255
  }
  // Position de la somme dans les octets couverts (à partir des options) : 15
  const pos = 15
  let x = ((bytes.length - pos) * c0 - c1) % 255
  if (x <= 0) x += 255
  let y = 510 - c0 - x
  if (y > 255) y -= 255
  return ((x & 255) << 8) | (y & 255)
}

/** LSA de la zone de l'équipement, calculées depuis la base OSPF de l'état. */
function areaLsas(state: LabState): { lsas: Lsa[]; external: Lsa[] } {
  const db = ospfDatabase(state)
  const lsas: Lsa[] = []
  const external: Lsa[] = []
  for (const router of db.routers.values()) {
    const list = db.neighbors.get(router.device.id) ?? []
    const links: number[] = []
    let count = 0
    for (const local of router.ifaces) {
      const s = segment(router, list, local)
      const full = adjacent(s).length > 0 && s.dr !== null
      count++
      if (full && s.dr)
        links.push(...ip32(s.dr.address), ...ip32(local.iface.address as string), 2, 0, 0, local.cost)
      else links.push(...ip32(local.network), ...ip32(prefixToMask(local.prefixLength)), 3, 0, 0, local.cost)
      // LSA réseau émise par le DR d'un segment de transit
      if (s.role === 'DR' && s.neighbors.length > 0)
        lsas.push({
          type: 2,
          id: local.iface.address as string,
          adv: router.routerId,
          body: [
            ...ip32(prefixToMask(local.prefixLength)),
            ...ip32(router.routerId),
            ...s.neighbors.flatMap((n) => ip32(n.routerId))
          ],
          links: 0
        })
    }
    const flags = router.originatesDefault ? 0x02 : 0
    lsas.push({
      type: 1,
      id: router.routerId,
      adv: router.routerId,
      body: [flags, 0, (count >> 8) & 255, count & 255, ...links],
      links: count
    })
    if (router.originatesDefault)
      external.push({
        type: 5,
        id: '0.0.0.0',
        adv: router.routerId,
        body: [...ip32('0.0.0.0'), 0x80, 0, 0, 1, ...ip32('0.0.0.0'), ...u32(1)],
        links: 0
      })
  }
  const order = (a: Lsa, b: Lsa) => ridValue(a.id) - ridValue(b.id) || ridValue(a.adv) - ridValue(b.adv)
  return { lsas: lsas.sort(order), external: external.sort(order) }
}

/** Numéro de séquence initial (aucun renouvellement simulé). */
const SEQ = 0x80000001

const lsaAge = (state: LabState): number => Math.floor(state.clock / 1000) % 1800

// ---------------------------------------------------------------------------
// Affichages
// ---------------------------------------------------------------------------

function showOspf(ctx: IosRunContext): void {
  const c = context(ctx)
  if (!c) return
  const { lsas, external } = areaLsas(ctx.state)
  const sum = (list: Lsa[]) => list.reduce((n, l) => n + lsaChecksum(l, SEQ), 0)
  const areas = [...new Set(c.router.ifaces.map((i) => i.area))].sort((a, b) => a - b)
  const out = [
    ` Routing Process "ospf ${c.router.process}" with ID ${c.router.routerId}`,
    ' Supports only single TOS(TOS0) routes',
    ' Supports opaque LSA',
    ...(c.router.originatesDefault ? [' It is an autonomous system boundary router'] : []),
    ' SPF schedule delay 5 secs, Hold time between two SPFs 10 secs',
    ' Minimum LSA interval 5 secs. Minimum LSA arrival 1 secs',
    ' LSA group pacing timer 100 secs',
    ' Interface flood pacing timer 55 msecs',
    ' Retransmission pacing timer 100 msecs',
    ` Number of external LSA ${external.length}. Checksum Sum ${hex(sum(external), 0)}`,
    ' Number of opaque AS LSA 0. Checksum Sum 0x0',
    ' Number of DCbitless external and opaque AS LSA 0',
    ' Number of DoNotAge external and opaque AS LSA 0',
    ` Number of areas in this router is ${areas.length}. ${areas.length} normal 0 stub 0 nssa`,
    ' External flood list length 0'
  ]
  for (const area of areas) {
    out.push(`    Area ${area === 0 ? 'BACKBONE(0)' : area}`)
    out.push(
      `        Number of interfaces in this area is ${c.router.ifaces.filter((i) => i.area === area).length}`
    )
    out.push('        Area has no authentication')
    out.push('        Area ranges are')
    out.push(`        Number of LSA ${lsas.length}. Checksum Sum ${hex(sum(lsas), 0)}`)
    out.push('        Number of opaque link LSA 0. Checksum Sum 0x0')
    out.push('        Number of DCbitless LSA 0')
    out.push('        Number of indication LSA 0')
    out.push('        Number of DoNotAge LSA 0')
    out.push('        Flood list length 0')
  }
  out.forEach((l) => ctx.print(l))
}

const ROLE_TEXT: Record<string, string> = { DR: 'Designated Router', BDR: 'Backup Designated Router' }

function showOspfInterface(ctx: IosRunContext, only?: string): void {
  const c = context(ctx)
  if (!c) return
  for (const s of c.segments) {
    const i = s.local.iface
    if (only && i.name !== only) continue
    ctx.print(`${ifaceLongName(i.name)} is up, line protocol is up`)
    ctx.print(`  Internet Address ${i.address}/${s.local.prefixLength}, Area ${s.local.area}`)
    ctx.print(
      `  Process ID ${c.router.process}, Router ID ${c.router.routerId}, Network Type BROADCAST, Cost: ${s.local.cost}`
    )
    ctx.print(`  Transmit Delay is 1 sec, State ${s.role}, Priority 1`)
    if (s.dr) ctx.print(`  Designated Router (ID) ${s.dr.rid}, Interface address ${s.dr.address}`)
    if (s.bdr) ctx.print(`  Backup Designated router (ID) ${s.bdr.rid}, Interface address ${s.bdr.address}`)
    else ctx.print('  No backup designated router on this network')
    ctx.print('  Timer intervals configured, Hello 10, Dead 40, Wait 40, Retransmit 5')
    ctx.print('    oob-resync timeout 40')
    if (s.local.passive) ctx.print('    No Hellos (Passive interface)')
    else
      ctx.print(
        `    Hello due in 00:00:${String(10 - (Math.floor(ctx.state.clock / 1000) % 10)).padStart(2, '0')}`
      )
    ctx.print('  Supports Link-local Signaling (LLS)')
    ctx.print('  Cisco NSF helper support enabled')
    ctx.print('  IETF NSF helper support enabled')
    ctx.print('  Index 1/1, flood queue length 0')
    ctx.print('  Next 0x0(0)/0x0(0)')
    ctx.print('  Last flood scan length is 1, maximum is 1')
    ctx.print('  Last flood scan time is 0 msec, maximum is 0 msec')
    const adj = adjacent(s)
    ctx.print(`  Neighbor Count is ${s.neighbors.length}, Adjacent neighbor count is ${adj.length}`)
    for (const n of adj) {
      const role = n.routerId === s.dr?.rid ? 'DR' : n.routerId === s.bdr?.rid ? 'BDR' : ''
      ctx.print(`    Adjacent with neighbor ${n.routerId}${role ? `  (${ROLE_TEXT[role]})` : ''}`)
    }
    ctx.print('  Suppress hello for 0 neighbor(s)')
  }
}

function showOspfInterfaceBrief(ctx: IosRunContext): void {
  const c = context(ctx)
  if (!c) return
  ctx.print('Interface    PID   Area            IP Address/Mask    Cost  State Nbrs F/C')
  for (const s of c.segments) {
    const i = s.local.iface
    ctx.print(
      `${i.name.padEnd(13)}${String(c.router.process).padEnd(6)}${String(s.local.area).padEnd(16)}${`${i.address}/${s.local.prefixLength}`.padEnd(19)}${String(s.local.cost).padEnd(6)}${s.role.padEnd(6)}${adjacent(s).length}/${s.neighbors.length}`
    )
  }
}

function showOspfDatabase(ctx: IosRunContext): void {
  const c = context(ctx)
  if (!c) return
  const { lsas, external } = areaLsas(ctx.state)
  const age = String(lsaAge(ctx.state))
  const row = (l: Lsa, extra: string) =>
    `${l.id.padEnd(16)}${l.adv.padEnd(16)}${age.padEnd(12)}${hex(SEQ, 8)} ${hex(lsaChecksum(l, SEQ), 6)} ${extra}`.trimEnd()
  ctx.print('')
  ctx.print(`            OSPF Router with ID (${c.router.routerId}) (Process ID ${c.router.process})`)
  for (const area of [...new Set(c.router.ifaces.map((i) => i.area))]) {
    ctx.print('')
    ctx.print(`\t\tRouter Link States (Area ${area})`)
    ctx.print('')
    ctx.print('Link ID         ADV Router      Age         Seq#       Checksum Link count')
    for (const l of lsas.filter((x) => x.type === 1)) ctx.print(row(l, String(l.links)))
    const nets = lsas.filter((x) => x.type === 2)
    if (nets.length) {
      ctx.print('')
      ctx.print(`\t\tNet Link States (Area ${area})`)
      ctx.print('')
      ctx.print('Link ID         ADV Router      Age         Seq#       Checksum')
      for (const l of nets) ctx.print(row(l, ''))
    }
  }
  if (external.length) {
    ctx.print('')
    ctx.print('\t\tType-5 AS External Link States')
    ctx.print('')
    ctx.print('Link ID         ADV Router      Age         Seq#       Checksum Tag')
    for (const l of external) ctx.print(row(l, '1'))
  }
}

/** show ip protocols : processus OSPF puis RIP. */
function showIpProtocols(ctx: IosRunContext): void {
  const device = deviceOf(ctx)
  const db = ospfDatabase(ctx.state)
  for (const proc of iosState(device).ospf) {
    const router = db.routers.get(device.id)
    const areas = new Set(router?.ifaces.map((i) => i.area) ?? [])
    ctx.print(`Routing Protocol is "ospf ${proc.process}"`)
    ctx.print('  Outgoing update filter list for all interfaces is not set')
    ctx.print('  Incoming update filter list for all interfaces is not set')
    if (router) ctx.print(`  Router ID ${router.routerId}`)
    if (router?.originatesDefault) ctx.print('  It is an autonomous system boundary router')
    ctx.print(`  Number of areas in this router is ${areas.size}. ${areas.size} normal 0 stub 0 nssa`)
    ctx.print('  Maximum path: 4')
    ctx.print('  Routing for Networks:')
    for (const n of proc.networks) ctx.print(`    ${n.network} ${n.wildcard} area ${n.area}`)
    const passive = router?.ifaces.filter((i) => i.passive) ?? []
    if (passive.length) {
      ctx.print('  Passive Interface(s):')
      for (const p of passive) ctx.print(`    ${ifaceLongName(p.iface.name)}`)
    }
    ctx.print('  Routing Information Sources:')
    ctx.print('    Gateway         Distance      Last Update')
    const sources = [...new Set((db.neighbors.get(device.id) ?? []).map((n) => n.routerId))].sort(
      (a, b) => ridValue(a) - ridValue(b)
    )
    for (const rid of sources) ctx.print(`    ${rid.padEnd(15)}${'110'.padStart(9)}      00:00:35`)
    ctx.print('  Distance: (default is 110)')
    ctx.print('')
  }
  for (const line of ripProtocolLines(ctx, device)) ctx.print(line)
}

/** clear ip ospf process : confirmation puis réinitialisation des adjacences. */
function clearOspfProcess(ctx: IosRunContext): void {
  if (iosState(deviceOf(ctx)).ospf.length === 0) return
  const answer = ctx.ask('Reset ALL OSPF processes? [no]: ').trim().toLowerCase()
  if (answer !== 'yes' && answer !== 'y') return
  const c = context(ctx)
  if (!c) return
  const name = (id: string) => ifaceLongName(deviceOf(ctx).interfaces.find((i) => i.id === id)?.name ?? '')
  const neighbors = c.segments.flatMap((s) => adjacent(s))
  for (const n of neighbors)
    ctx.print(
      `%OSPF-5-ADJCHG: Process ${c.router.process}, Nbr ${n.routerId} on ${name(n.ifaceId)} from FULL to DOWN, Neighbor Down: Interface down or detached`
    )
  for (const n of neighbors)
    ctx.print(
      `%OSPF-5-ADJCHG: Process ${c.router.process}, Nbr ${n.routerId} on ${name(n.ifaceId)} from LOADING to FULL, Loading Done`
    )
}

const commands: CliCommand[] = [
  { modes: ['user', 'exec'], syntax: [SHOW, SHOW_IP, OSPF], available: routes, run: showOspf },
  {
    modes: ['user', 'exec'],
    syntax: [SHOW, SHOW_IP, OSPF, kw('interface', 'Interface information')],
    available: routes,
    run: (ctx) => showOspfInterface(ctx)
  },
  {
    modes: ['user', 'exec'],
    syntax: [
      SHOW,
      SHOW_IP,
      OSPF,
      kw('interface', 'Interface information'),
      kw('brief', 'Brief summary of OSPF interface information')
    ],
    available: routes,
    run: showOspfInterfaceBrief
  },
  {
    modes: ['user', 'exec'],
    syntax: [
      SHOW,
      SHOW_IP,
      OSPF,
      kw('interface', 'Interface information'),
      { arg: 'iface', type: iface({ subinterfaces: true, vlans: true }), help: 'Interface' }
    ],
    available: routes,
    run: (ctx, args) => showOspfInterface(ctx, args.iface ?? '')
  },
  {
    modes: ['user', 'exec'],
    syntax: [SHOW, SHOW_IP, OSPF, kw('database', 'Database summary')],
    available: routes,
    run: showOspfDatabase
  },
  {
    modes: ['user', 'exec'],
    syntax: [SHOW, SHOW_IP, kw('protocols', 'IP routing protocol process parameters and statistics')],
    available: routes,
    run: showIpProtocols
  },
  {
    modes: ['exec'],
    syntax: [
      kw('clear', 'Reset functions'),
      kw('ip', 'IP'),
      kw('ospf', 'OSPF clear commands'),
      kw('process', 'Reset OSPF process')
    ],
    available: routes,
    run: clearOspfProcess
  }
]

export const ospfShow = defineIosFeature({ id: 'ospf-show', commands })
