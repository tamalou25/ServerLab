/**
 * Spanning-tree des switchs IOS (PVST+ et Rapid PVST+) : mode, priorité de pont par VLAN (root
 * primary / secondary, priority), portfast, BPDU Guard, et show spanning-tree calculé : élection du
 * pont racine (identifiant = priorité + VLAN, adresse MAC du switch dérivée de state.seq), coût vers
 * la racine, rôles et états des ports. Le calcul est fait à la demande, pour un VLAN, sur la seule
 * composante de switchs reliés (parcours en largeur et Dijkstra à tas binaire, sans boucle
 * quadratique sur la topologie).
 *
 * Sources :
 * - Command Reference 2960 15.0(2)SE (spanning-tree vlan, portfast, bpduguard ; show spanning-tree) :
 *   https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/15-0_2_se/command/reference/cr2960/cli3.html
 *   https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/15-0_2_se/command/reference/cr2960/cli2.html
 * - Colonnes de show spanning-tree : https://www.cisco.com/c/en/us/support/docs/lan-switching/spanning-tree-protocol/28943-170.html
 * - Avertissement portfast : https://www.cisco.com/c/en/us/support/docs/lan-switching/etherchannel/98469-ios-etherchannel.html
 * - Messages BPDU Guard : https://www.cisco.com/c/en/us/support/docs/lan-switching/spanning-tree-protocol/69980-errdisable-recovery.html
 */
import { produce } from 'immer'
import type { LabState, NetInterface } from '../../model/schema'
import { switchportOf, trunkAllows } from '../../net/switchport'
import { unsimulatedIosMessage } from '../../shell/unsimulated'
import { linkOnInterface, otherEnd } from '../../topology/queries'
import { number, parseVlanList, vlanList } from '../cli/args'
import type { ArgContext, ArgType, CliCommand, IosRunContext, SyntaxToken } from '../cli/types'
import { draftIfaceEntry, draftIosState, iosState } from '../config'
import { isIos, type IosDevice } from '../device'
import { defineIosFeature } from '../feature'
import { ifaceLongName } from '../models'
import type { ConfigBlock } from '../running-config'
import { ifaceStatus, iosMac } from '../status'
import { currentIfaces, deviceOf, update } from './base'

const kw = (keyword: string, help: string): SyntaxToken => ({ keyword, help })
const SPANNING = kw('spanning-tree', 'Spanning Tree Subsystem')

const DEFAULT_PRIORITY = 32768
const isSwitch = (ctx: ArgContext): boolean => ctx.state.devices[ctx.deviceId]?.kind === 'switch'
const switchPorts = (ctx: ArgContext): boolean =>
  isSwitch(ctx) && currentIfaces(ctx).every((i) => !i.svi && !i.l3)
const physical = (i: NetInterface): boolean => !i.svi && !i.subinterface

// ---------------------------------------------------------------------------
// Élection
// ---------------------------------------------------------------------------

/** Identifiant de pont : priorité (avec sys-id-ext = VLAN) puis adresse MAC. */
interface BridgeId {
  priority: number
  mac: string
}

const priorityOf = (device: IosDevice, vlan: number): number =>
  iosState(device).stpPriorities[String(vlan)] ?? DEFAULT_PRIORITY

function bridgeId(device: IosDevice, vlan: number): BridgeId {
  return { priority: priorityOf(device, vlan) + vlan, mac: iosMac(device.interfaces[0]?.mac ?? '') }
}

const compareBid = (a: BridgeId, b: BridgeId): number =>
  a.priority - b.priority || (a.mac < b.mac ? -1 : a.mac > b.mac ? 1 : 0)

/** Coût court (802.1D) : 19 à 100 Mbit/s, 4 à 1 Gbit/s. */
const portCost = (port: NetInterface): number => (port.name.startsWith('Gi') ? 4 : 19)

/** Numéro de port (Prio.Nbr) : rang parmi les ports physiques. */
const portNumber = (device: IosDevice, port: NetInterface): number =>
  device.interfaces.filter(physical).findIndex((i) => i.id === port.id) + 1

/** Le port actif transporte-t-il le VLAN (accès dans le VLAN ou trunk qui l'autorise) ? */
function carries(state: LabState, device: IosDevice, port: NetInterface, vlan: number): boolean {
  if (!physical(port) || device.kind !== 'switch' || !device.vlans.some((v) => v.id === vlan)) return false
  if (ifaceStatus(state, device, port).status !== 'up') return false
  const sp = switchportOf(port)
  return sp.mode === 'access' ? sp.accessVlan === vlan : trunkAllows(sp, vlan)
}

/** Switch IOS voisin du port, si son port transporte aussi le VLAN (échange de BPDU). */
function stpPeer(
  state: LabState,
  device: IosDevice,
  port: NetInterface,
  vlan: number
): { device: IosDevice; port: NetInterface } | null {
  const link = linkOnInterface(state, device.id, port.id)
  if (!link) return null
  const end = otherEnd(link, device.id, port.id)
  const peer = state.devices[end.deviceId]
  if (!isIos(peer) || peer.kind !== 'switch') return null
  const peerPort = peer.interfaces.find((i) => i.id === end.ifaceId)
  return peerPort && carries(state, peer, peerPort, vlan) ? { device: peer, port: peerPort } : null
}

/** Tas binaire minimal (Dijkstra). */
class Heap<T> {
  private readonly items: T[] = []
  constructor(private readonly less: (a: T, b: T) => boolean) {}
  get size(): number {
    return this.items.length
  }
  push(item: T): void {
    const a = this.items
    a.push(item)
    let i = a.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (!this.less(a[i] as T, a[p] as T)) break
      ;[a[i], a[p]] = [a[p] as T, a[i] as T]
      i = p
    }
  }
  pop(): T | undefined {
    const a = this.items
    const top = a[0]
    const last = a.pop()
    if (a.length > 0 && last !== undefined) {
      a[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < a.length && this.less(a[l] as T, a[m] as T)) m = l
        if (r < a.length && this.less(a[r] as T, a[m] as T)) m = r
        if (m === i) break
        ;[a[i], a[m]] = [a[m] as T, a[i] as T]
        i = m
      }
    }
    return top
  }
}

export interface StpPort {
  port: NetInterface
  role: 'Root' | 'Desg' | 'Altn'
  state: 'FWD' | 'BLK'
  cost: number
  number: number
}

export interface StpInstance {
  vlan: number
  root: BridgeId
  bridge: BridgeId
  isRoot: boolean
  rootCost: number
  rootPort: NetInterface | null
  ports: StpPort[]
}

/** Instance spanning-tree d'un VLAN sur le switch (null : aucun port actif dans le VLAN). */
export function stpInstance(state: LabState, device: IosDevice, vlan: number): StpInstance | null {
  const own = device.interfaces.filter((p) => carries(state, device, p, vlan))
  if (own.length === 0) return null
  // Composante des switchs reliés dans ce VLAN (parcours en largeur)
  const nodes = new Map<string, IosDevice>([[device.id, device]])
  const queue: IosDevice[] = [device]
  for (let i = 0; i < queue.length; i++) {
    const d = queue[i] as IosDevice
    for (const p of d.interfaces) {
      if (!carries(state, d, p, vlan)) continue
      const peer = stpPeer(state, d, p, vlan)
      if (peer && !nodes.has(peer.device.id)) {
        nodes.set(peer.device.id, peer.device)
        queue.push(peer.device)
      }
    }
  }
  const bids = new Map([...nodes.values()].map((d) => [d.id, bridgeId(d, vlan)]))
  let rootId = device.id
  for (const [id, bid] of bids) if (compareBid(bid, bids.get(rootId) as BridgeId) < 0) rootId = id
  // Coût vers la racine : Dijkstra, coût du port de réception
  const dist = new Map<string, number>([[rootId, 0]])
  const heap = new Heap<[number, string]>((a, b) => a[0] < b[0])
  heap.push([0, rootId])
  while (heap.size > 0) {
    const [d, id] = heap.pop() as [number, string]
    if (d > (dist.get(id) ?? Infinity)) continue
    const dev = nodes.get(id) as IosDevice
    for (const p of dev.interfaces) {
      if (!carries(state, dev, p, vlan)) continue
      const peer = stpPeer(state, dev, p, vlan)
      if (!peer) continue
      const nd = d + portCost(peer.port)
      if (nd < (dist.get(peer.device.id) ?? Infinity)) {
        dist.set(peer.device.id, nd)
        heap.push([nd, peer.device.id])
      }
    }
  }
  const myBid = bids.get(device.id) as BridgeId
  const myCost = dist.get(device.id) ?? 0
  const isRoot = rootId === device.id
  // Port racine : meilleur (coût, pont voisin, port voisin, port local)
  let rootPort: NetInterface | null = null
  let best: [number, BridgeId, number, number] | null = null
  if (!isRoot)
    for (const p of own) {
      const peer = stpPeer(state, device, p, vlan)
      if (!peer) continue
      const offer: [number, BridgeId, number, number] = [
        (dist.get(peer.device.id) ?? Infinity) + portCost(p),
        bids.get(peer.device.id) as BridgeId,
        portNumber(peer.device, peer.port),
        portNumber(device, p)
      ]
      const cmp = best
        ? offer[0] - best[0] || compareBid(offer[1], best[1]) || offer[2] - best[2] || offer[3] - best[3]
        : -1
      if (cmp < 0) {
        best = offer
        rootPort = p
      }
    }
  const ports = own.map((p): StpPort => {
    const n = portNumber(device, p)
    if (p === rootPort) return { port: p, role: 'Root', state: 'FWD', cost: portCost(p), number: n }
    const peer = stpPeer(state, device, p, vlan)
    if (!peer) return { port: p, role: 'Desg', state: 'FWD', cost: portCost(p), number: n }
    // Port désigné du segment : meilleur (coût vers la racine, pont, port)
    const peerCost = dist.get(peer.device.id) ?? Infinity
    const cmp =
      myCost - peerCost ||
      compareBid(myBid, bids.get(peer.device.id) as BridgeId) ||
      n - portNumber(peer.device, peer.port)
    return cmp < 0
      ? { port: p, role: 'Desg', state: 'FWD', cost: portCost(p), number: n }
      : { port: p, role: 'Altn', state: 'BLK', cost: portCost(p), number: n }
  })
  return {
    vlan,
    root: bids.get(rootId) as BridgeId,
    bridge: myBid,
    isRoot,
    rootCost: myCost,
    rootPort,
    ports
  }
}

// ---------------------------------------------------------------------------
// show spanning-tree
// ---------------------------------------------------------------------------

const vlanName = (vlan: number): string => `VLAN${String(vlan).padStart(4, '0')}`
const TIMERS = '             Hello Time   2 sec  Max Age 20 sec  Forward Delay 15 sec'

function printInstance(ctx: IosRunContext, device: IosDevice, inst: StpInstance): void {
  const ios = iosState(device)
  ctx.print(vlanName(inst.vlan))
  ctx.print(`  Spanning tree enabled protocol ${ios.stpMode === 'rapid-pvst' ? 'rstp' : 'ieee'}`)
  ctx.print(`  Root ID    Priority    ${inst.root.priority}`)
  ctx.print(`             Address     ${inst.root.mac}`)
  if (inst.isRoot) ctx.print('             This bridge is the root')
  else {
    ctx.print(`             Cost        ${inst.rootCost}`)
    const rp = inst.rootPort as NetInterface
    ctx.print(`             Port        ${portNumber(device, rp)} (${ifaceLongName(rp.name)})`)
  }
  ctx.print(TIMERS)
  ctx.print('')
  ctx.print(
    `  Bridge ID  Priority    ${inst.bridge.priority}  (priority ${inst.bridge.priority - inst.vlan} sys-id-ext ${inst.vlan})`
  )
  ctx.print(`             Address     ${inst.bridge.mac}`)
  ctx.print(TIMERS)
  ctx.print('             Aging Time  300')
  ctx.print('')
  ctx.print('Interface        Role Sts Cost      Prio.Nbr Type')
  ctx.print('---------------- ---- --- --------- -------- --------------------------------')
  for (const p of inst.ports) {
    const edge = iosState(device).interfaces[p.port.name]?.portfast && switchportOf(p.port).mode === 'access'
    ctx.print(
      `${p.port.name.padEnd(17)}${p.role.padEnd(5)}${p.state.padEnd(4)}${String(p.cost).padEnd(10)}${`128.${p.number}`.padEnd(9)}P2p${edge ? ' Edge' : ''}`
    )
  }
}

function showSpanningTree(ctx: IosRunContext, vlan?: number): void {
  const device = deviceOf(ctx)
  if (device.kind !== 'switch') return
  const ids = vlan === undefined ? device.vlans.map((v) => v.id) : [vlan]
  let shown = 0
  for (const id of ids) {
    const inst = stpInstance(ctx.state, device, id)
    if (!inst) continue
    ctx.print('')
    printInstance(ctx, device, inst)
    shown++
  }
  if (shown === 0)
    ctx.print(
      vlan === undefined
        ? 'No spanning tree instance exists.'
        : `Spanning tree instance(s) for vlan ${vlan} does not exist.`
    )
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function setPriority(ctx: IosRunContext, list: string, priority: number | null): void {
  const ids = parseVlanList(list) ?? []
  update(ctx, (d) => {
    const prio = draftIosState(d).stpPriorities
    for (const id of ids)
      if (priority === null || priority === DEFAULT_PRIORITY) delete prio[String(id)]
      else prio[String(id)] = priority
  })
}

/**
 * root primary : 24576 si cela suffit à devenir racine, sinon 4096 de moins que la plus basse
 * priorité de racine ; root secondary : 28672 (Command Reference, spanning-tree vlan).
 */
function setRoot(ctx: IosRunContext, list: string, primary: boolean): void {
  const device = deviceOf(ctx)
  for (const vlan of parseVlanList(list) ?? []) {
    let priority = primary ? 24576 : 28672
    const inst = primary ? stpInstance(ctx.state, device, vlan) : null
    if (inst && !inst.isRoot) {
      const mine = { priority: priority + vlan, mac: inst.bridge.mac }
      if (compareBid(mine, inst.root) > 0) priority = Math.max(0, inst.root.priority - vlan - 4096)
    }
    setPriority(ctx, String(vlan), priority)
  }
}

function setMode(ctx: IosRunContext, mode: 'pvst' | 'rapid-pvst'): void {
  update(ctx, (d) => {
    draftIosState(d).stpMode = mode
  })
}

function setPortOption(ctx: IosRunContext, key: 'portfast' | 'bpduGuard', on: boolean): void {
  const names = currentIfaces(ctx).map((i) => i.name)
  update(ctx, (d) => {
    const ios = draftIosState(d)
    for (const name of names) draftIfaceEntry(ios, name)[key] = on
  })
}

function enablePortfast(ctx: IosRunContext): void {
  for (const port of currentIfaces(ctx)) {
    ctx.print('%Warning: portfast should only be enabled on ports connected to a single')
    ctx.print(' host. Connecting hubs, concentrators, switches, bridges, etc... to this')
    ctx.print(' interface  when portfast is enabled, can cause temporary bridging loops.')
    ctx.print(' Use with CAUTION')
    ctx.print('')
    ctx.print(`%Portfast has been configured on ${ifaceLongName(port.name)} but will only`)
    ctx.print(' have effect when the interface is in a non-trunking mode.')
  }
  setPortOption(ctx, 'portfast', true)
}

/** Priorité de pont : 0 à 61440 par pas de 4096. */
const BRIDGE_PRIORITY: ArgType = {
  ...number(0, 61440),
  match: (t, i, ctx) => {
    const m = number(0, 61440).match(t, i, ctx)
    return m && Number(m.value) % 4096 === 0 ? m : null
  }
}

const VLAN_ARG = { arg: 'list', type: vlanList(), help: 'vlan range, example: 1,3-5,7,9-11' }
const STP_VLAN = [SPANNING, kw('vlan', 'VLAN Switch Spanning Tree'), VLAN_ARG]

const commands: CliCommand[] = [
  ...(['pvst', 'rapid-pvst'] as const).map((mode): CliCommand => ({
    modes: ['config'],
    syntax: [
      SPANNING,
      kw('mode', 'Spanning tree operating mode'),
      kw(mode, mode === 'pvst' ? 'Per-Vlan spanning tree mode' : 'Per-Vlan rapid spanning tree mode')
    ],
    available: isSwitch,
    run: (ctx) => setMode(ctx, mode),
    no: { min: 2, run: (ctx) => setMode(ctx, 'pvst') }
  })),
  {
    modes: ['config'],
    syntax: [SPANNING, kw('mode', 'Spanning tree operating mode'), kw('mst', 'Multiple spanning tree mode')],
    available: isSwitch,
    run: (ctx) => ctx.print(`% ${unsimulatedIosMessage('spanning-tree mode mst')}`)
  },
  ...(['primary', 'secondary'] as const).map((which): CliCommand => ({
    modes: ['config'],
    syntax: [
      ...STP_VLAN,
      kw('root', 'Configure switch as root'),
      kw(
        which,
        which === 'primary'
          ? 'Configure this switch as primary root for this spanning tree'
          : 'Configure switch as secondary root'
      )
    ],
    available: isSwitch,
    run: (ctx, args) => setRoot(ctx, args.list ?? '', which === 'primary'),
    no: { min: 4, run: (ctx, args) => setPriority(ctx, args.list ?? '', null) }
  })),
  {
    modes: ['config'],
    syntax: [
      ...STP_VLAN,
      kw('priority', 'Set the bridge priority for the spanning tree'),
      { arg: 'prio', type: BRIDGE_PRIORITY, help: 'bridge priority in increments of 4096' }
    ],
    available: isSwitch,
    run: (ctx, args) => setPriority(ctx, args.list ?? '', Number(args.prio)),
    no: { min: 4, run: (ctx, args) => setPriority(ctx, args.list ?? '', null) }
  },
  {
    modes: ['config-if'],
    syntax: [SPANNING, kw('portfast', 'Portfast options for the interface')],
    available: switchPorts,
    run: enablePortfast,
    no: { run: (ctx) => setPortOption(ctx, 'portfast', false) }
  },
  ...(['enable', 'disable'] as const).map((which): CliCommand => ({
    modes: ['config-if'],
    syntax: [
      SPANNING,
      kw('bpduguard', "Don't accept BPDUs on this interface"),
      kw(
        which,
        which === 'enable' ? 'Enable BPDU guard for this interface' : 'Disable BPDU guard for this interface'
      )
    ],
    available: switchPorts,
    run: (ctx) => setPortOption(ctx, 'bpduGuard', which === 'enable'),
    no: { min: 2, run: (ctx) => setPortOption(ctx, 'bpduGuard', false) }
  })),
  {
    modes: ['user', 'exec'],
    syntax: [kw('show', 'Show running system information'), kw('spanning-tree', 'Spanning tree topology')],
    available: isSwitch,
    run: (ctx) => showSpanningTree(ctx)
  },
  {
    modes: ['user', 'exec'],
    syntax: [
      kw('show', 'Show running system information'),
      kw('spanning-tree', 'Spanning tree topology'),
      kw('vlan', 'VLAN Switch Spanning Trees'),
      { arg: 'vlan', type: number(1, 4094), help: 'vlan range, example: 1,3-5,7,9-11' }
    ],
    available: isSwitch,
    run: (ctx, args) => showSpanningTree(ctx, Number(args.vlan))
  }
]

// ---------------------------------------------------------------------------
// BPDU Guard : err-disabled dès qu'un BPDU est reçu (switch branché sur le port)
// ---------------------------------------------------------------------------

function receivesBpdu(state: LabState, device: IosDevice, port: NetInterface): boolean {
  const link = linkOnInterface(state, device.id, port.id)
  if (!link || !device.powered) return false
  const end = otherEnd(link, device.id, port.id)
  const peer = state.devices[end.deviceId]
  const peerPort = peer?.interfaces.find((i) => i.id === end.ifaceId)
  return peer?.kind === 'switch' && peer.powered && !!peerPort?.enabled
}

function settle(state: LabState): LabState {
  // Sans BPDU Guard configuré, rien à faire (pas de brouillon immer)
  const guarded = Object.values(state.devices).filter(
    (d) => d.kind === 'switch' && isIos(d) && Object.values(d.ios?.interfaces ?? {}).some((e) => e.bpduGuard)
  )
  if (guarded.length === 0) return state
  return produce(state, (draft) => {
    for (const d of guarded) {
      const device = d as IosDevice
      for (const port of device.interfaces) {
        const entry = device.ios?.interfaces[port.name]
        if (!entry?.bpduGuard || entry.errDisabled || !port.enabled) continue
        if (!receivesBpdu(state, device, port)) continue
        const target = draft.devices[device.id] as IosDevice
        const iface = target.interfaces.find((i) => i.id === port.id)
        const e = target.ios?.interfaces[port.name]
        if (!iface || !e) continue
        e.errDisabled = true
        iface.enabled = false
      }
    }
  })
}

function messages(before: LabState, after: LabState, deviceId: string): string[] {
  const b = before.devices[deviceId]
  const a = after.devices[deviceId]
  if (!isIos(a) || a.kind !== 'switch') return []
  const out: string[] = []
  for (const port of a.interfaces) {
    const now = iosState(a).interfaces[port.name]
    const was = isIos(b) ? iosState(b).interfaces[port.name] : undefined
    if (!now?.bpduGuard || !now.errDisabled || was?.errDisabled) continue
    const long = ifaceLongName(port.name)
    out.push(
      `%SPANTREE-2-BLOCK_BPDUGUARD: Received BPDU on port ${long} with BPDU Guard enabled. Disabling port.`,
      `%PM-4-ERR_DISABLE: bpduguard error detected on ${port.name}, putting ${port.name} in err-disable state`,
      `%LINEPROTO-5-UPDOWN: Line protocol on Interface ${long}, changed state to down`,
      `%LINK-3-UPDOWN: Interface ${long}, changed state to down`
    )
  }
  return out
}

function config(device: IosDevice): ConfigBlock[] {
  if (device.kind !== 'switch') return []
  const ios = iosState(device)
  const lines: string[] = []
  if (ios.stpMode === 'rapid-pvst') lines.push('spanning-tree mode rapid-pvst')
  for (const [vlan, prio] of Object.entries(ios.stpPriorities).sort((x, y) => Number(x[0]) - Number(y[0])))
    lines.push(`spanning-tree vlan ${vlan} priority ${prio}`)
  return [{ order: 47, lines }]
}

function interfaceConfig(device: IosDevice, i: NetInterface): ConfigBlock[] {
  const entry = iosState(device).interfaces[i.name]
  const lines: string[] = []
  if (entry?.portfast) lines.push('spanning-tree portfast')
  if (entry?.bpduGuard) lines.push('spanning-tree bpduguard enable')
  return lines.length ? [{ order: 60, lines }] : []
}

export const stp = defineIosFeature({
  id: 'stp',
  commands,
  config,
  interfaceConfig,
  settle,
  settleMessages: messages
})
