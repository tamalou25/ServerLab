/**
 * HSRP (redondance de passerelle) : standby <groupe> ip / priority / preempt, show standby brief.
 * L'élection est recalculée après chaque modification du lab (stabilisation IOS) : le routeur
 * actif garde son rôle tant qu'il est joignable, sauf préemption par un routeur prioritaire.
 * Le routeur actif porte l'adresse virtuelle (crochet de transit `owns`).
 */
import { produce } from 'immer'
import type { LabState, NetInterface } from '../../model/schema'
import { parseIpv4 } from '../../net/ipv4'
import { l2Segment } from '../../net/segment'
import { IPV4, number } from '../cli/args'
import type { ArgContext, CliCommand, IosRunContext, SyntaxToken } from '../cli/types'
import { draftIfaceEntry, draftIosState, iosState } from '../config'
import { isIos, type IosDevice } from '../device'
import { defineIosFeature } from '../feature'
import { ifaceLongName } from '../models'
import type { ConfigBlock } from '../running-config'
import { ifaceStatus } from '../status'
import { currentIfaces, deviceOf, update } from './base'

const kw = (keyword: string, help: string): SyntaxToken => ({ keyword, help })

type HsrpState = 'Active' | 'Standby' | 'Listen' | 'Init'

/** Membre d'un groupe HSRP : interface d'un routeur IOS configurée pour ce groupe. */
interface Member {
  device: IosDevice
  iface: NetInterface
  group: number
  ip: string | null
  priority: number
  preempt: boolean
  key: string
  up: boolean
}

const keyOf = (iface: NetInterface, group: number): string => `${iface.name}|${group}`

function members(state: LabState): Member[] {
  const list: Member[] = []
  for (const device of Object.values(state.devices)) {
    if (!isIos(device)) continue
    const ios = iosState(device)
    for (const iface of device.interfaces) {
      for (const g of ios.interfaces[iface.name]?.hsrp ?? []) {
        const up = device.powered && !!iface.address && ifaceStatus(state, device, iface).protocol === 'up'
        list.push({
          device,
          iface,
          group: g.group,
          ip: g.ip,
          priority: g.priority,
          preempt: g.preempt,
          key: keyOf(iface, g.group),
          up
        })
      }
    }
  }
  return list
}

const ipValue = (m: Member): number => parseIpv4(m.iface.address ?? '0.0.0.0') ?? 0
/** Ordre d'élection : priorité, puis plus haute adresse d'interface. */
const better = (a: Member, b: Member): number => b.priority - a.priority || ipValue(b) - ipValue(a)

/** Groupes HSRP : membres actifs d'un même numéro de groupe sur un même segment de niveau 2. */
function clusters(state: LabState, all: Member[]): Member[][] {
  const live = all.filter((m) => m.up)
  const assigned = new Set<Member>()
  const result: Member[][] = []
  for (const m of live) {
    if (assigned.has(m)) continue
    const reach = new Set(
      l2Segment(state, { deviceId: m.device.id, ifaceId: m.iface.id }).map(
        (x) => `${x.port.deviceId}/${x.port.ifaceId}`
      )
    )
    const cluster = live.filter(
      (o) => !assigned.has(o) && o.group === m.group && (o === m || reach.has(`${o.device.id}/${o.iface.id}`))
    )
    cluster.forEach((o) => assigned.add(o))
    result.push(cluster)
  }
  return result
}

const stateOf = (m: Member): HsrpState => iosState(m.device).hsrpStates[m.key] ?? 'Init'

/** Élection de chaque groupe : nouvel état HSRP de chaque membre. */
function elect(state: LabState): Map<Member, HsrpState> {
  const all = members(state)
  const next = new Map<Member, HsrpState>(all.map((m) => [m, 'Init']))
  for (const cluster of clusters(state, all)) {
    const ranked = [...cluster].sort(better)
    const best = ranked[0]
    if (!best) continue
    const current = cluster.find((m) => stateOf(m) === 'Active')
    const active = current && !(best.preempt && best.priority > current.priority) ? current : best
    const standby = ranked.find((m) => m !== active)
    for (const m of cluster) next.set(m, m === active ? 'Active' : m === standby ? 'Standby' : 'Listen')
  }
  return next
}

function settle(state: LabState): LabState {
  const next = elect(state)
  return produce(state, (draft) => {
    for (const [m, s] of next) {
      const d = draft.devices[m.device.id]
      if (!d || !isIos(d as IosDevice)) continue
      const ios = draftIosState(d as IosDevice)
      if (ios.hsrpStates[m.key] !== s) ios.hsrpStates[m.key] = s
    }
    // Groupes supprimés : leur état disparaît
    for (const device of Object.values(draft.devices)) {
      if (!isIos(device as IosDevice) || !(device as IosDevice).ios) continue
      const ios = draftIosState(device as IosDevice)
      for (const key of Object.keys(ios.hsrpStates))
        if (![...next.keys()].some((m) => m.device.id === device.id && m.key === key))
          delete ios.hsrpStates[key]
    }
  })
}

function messages(before: LabState, after: LabState, deviceId: string): string[] {
  const b = before.devices[deviceId]
  const a = after.devices[deviceId]
  if (!isIos(a)) return []
  const was = isIos(b) ? iosState(b).hsrpStates : {}
  const out: string[] = []
  for (const [key, now] of Object.entries(iosState(a).hsrpStates)) {
    const prev = was[key] ?? 'Init'
    if (prev === now) continue
    const [name, group] = key.split('|')
    const line = (from: string, to: string) =>
      `%HSRP-6-STATECHANGE: ${ifaceLongName(name ?? '')} Grp ${group} state ${from} -> ${to}`
    if (now === 'Active' && prev !== 'Standby') out.push(line('Speak', 'Standby'), line('Standby', 'Active'))
    else if (now === 'Standby' && prev === 'Active')
      out.push(line('Active', 'Speak'), line('Speak', 'Standby'))
    else if (now === 'Standby') out.push(line('Speak', 'Standby'))
    else out.push(line(prev, now))
  }
  return out
}

// ---------------------------------------------------------------------------
// Commandes
// ---------------------------------------------------------------------------

const layer3 = (ctx: ArgContext): boolean => currentIfaces(ctx).every((i) => i.l3)

/** Modifie (ou crée) le groupe HSRP des interfaces en cours de configuration. */
function setGroup(
  ctx: IosRunContext,
  group: number,
  change: (g: { group: number; ip: string | null; priority: number; preempt: boolean }) => void
): void {
  const names = currentIfaces(ctx).map((i) => i.name)
  update(ctx, (d) => {
    const ios = draftIosState(d)
    for (const name of names) {
      const entry = draftIfaceEntry(ios, name)
      let g = entry.hsrp.find((x) => x.group === group)
      if (!g) {
        g = { group, ip: null, priority: 100, preempt: false }
        entry.hsrp.push(g)
        entry.hsrp.sort((x, y) => x.group - y.group)
      }
      change(g)
    }
  })
}

function removeGroup(ctx: IosRunContext, group: number): void {
  const names = currentIfaces(ctx).map((i) => i.name)
  update(ctx, (d) => {
    const ios = draftIosState(d)
    for (const name of names) {
      const entry = ios.interfaces[name]
      if (entry) entry.hsrp = entry.hsrp.filter((x) => x.group !== group)
    }
  })
}

function showStandbyBrief(ctx: IosRunContext): void {
  const device = deviceOf(ctx)
  const all = members(ctx.state)
  ctx.print('                     P indicates configured to preempt.')
  ctx.print('                     |')
  ctx.print('Interface   Grp  Pri P State   Active          Standby         Virtual IP')
  for (const m of all.filter((x) => x.device.id === device.id)) {
    const s = stateOf(m)
    const peers = all.filter((o) => o.group === m.group && o.ip === m.ip && o.up)
    const role = (wanted: HsrpState) => {
      const who = peers.find((o) => stateOf(o) === wanted)
      return who ? (who === m ? 'local' : (who.iface.address ?? 'unknown')) : 'unknown'
    }
    const display = s === 'Init' && !m.up ? 'Init' : s
    ctx.print(
      `${m.iface.name.padEnd(12)}${String(m.group).padEnd(5)}${String(m.priority).padStart(3)} ${m.preempt ? 'P' : ' '} ${display.padEnd(8)}${role('Active').padEnd(16)}${role('Standby').padEnd(16)}${m.ip ?? 'unknown'}`
    )
  }
}

/**
 * show standby : état détaillé de chaque groupe (champs de l'exemple de la FHRP Command Reference,
 * https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipapp_fhrp/command/fhp-cr-book/fhp-s1.html).
 * Temporisateurs d'usine (hello 3 s, hold 10 s), MAC virtuelle HSRP v1 0000.0c07.acXX.
 */
function showStandby(ctx: IosRunContext): void {
  const device = deviceOf(ctx)
  const all = members(ctx.state)
  const secs = Math.floor(ctx.state.clock / 1000)
  for (const m of all.filter((x) => x.device.id === device.id)) {
    const s = stateOf(m)
    const peers = all.filter((o) => o !== m && o.group === m.group && o.ip === m.ip && o.up)
    const mac = `0000.0c07.ac${m.group.toString(16).padStart(2, '0')}`
    const who = (wanted: HsrpState): string => {
      if (s === wanted) return 'local'
      const peer = peers.find((o) => stateOf(o) === wanted)
      return peer
        ? `${peer.iface.address ?? 'unknown'}, priority ${peer.priority} (expires in ${10 - (secs % 3)}.000 sec)`
        : 'unknown'
    }
    ctx.print(`${ifaceLongName(m.iface.name)} - Group ${m.group}`)
    ctx.print(`  State is ${s === 'Init' && !m.up ? 'Init' : s}`)
    ctx.print(`  Virtual IP address is ${m.ip ?? 'unknown'}`)
    ctx.print(
      `  Active virtual MAC address is ${s === 'Active' || peers.some((o) => stateOf(o) === 'Active') ? mac : 'unknown'}`
    )
    ctx.print(`   Local virtual MAC address is ${mac} (v1 default)`)
    ctx.print('  Hello time 3 sec, hold time 10 sec')
    ctx.print(`   Next hello sent in ${3 - (secs % 3)}.000 secs`)
    ctx.print(`  Preemption ${m.preempt ? 'enabled' : 'disabled'}`)
    ctx.print(`  Active router is ${who('Active')}`)
    ctx.print(`  Standby router is ${who('Standby')}`)
    ctx.print(`  Priority ${m.priority} (${m.priority === 100 ? 'default' : 'configured'} ${m.priority})`)
    ctx.print(`  Group name is "hsrp-${m.iface.name}-${m.group}" (default)`)
  }
}

const STANDBY = kw('standby', 'HSRP interface configuration commands')
const GROUP = { arg: 'group', type: number(0, 255), help: 'group number' }
const IF_MODES = ['config-if', 'config-subif'] as const

const commands: CliCommand[] = [
  {
    modes: IF_MODES,
    syntax: [
      STANDBY,
      GROUP,
      kw('ip', 'Enable HSRP IPv4 and set the virtual IP address'),
      { arg: 'ip', type: IPV4, help: 'Virtual IP address' }
    ],
    available: layer3,
    run: (ctx, args) => setGroup(ctx, Number(args.group), (g) => (g.ip = args.ip ?? null)),
    no: { min: 3, run: (ctx, args) => removeGroup(ctx, Number(args.group)) }
  },
  {
    modes: IF_MODES,
    syntax: [
      STANDBY,
      GROUP,
      kw('priority', 'Priority level'),
      { arg: 'priority', type: number(0, 255), help: 'Priority value' }
    ],
    available: layer3,
    run: (ctx, args) => setGroup(ctx, Number(args.group), (g) => (g.priority = Number(args.priority))),
    no: { min: 3, run: (ctx, args) => setGroup(ctx, Number(args.group), (g) => (g.priority = 100)) }
  },
  {
    modes: IF_MODES,
    syntax: [STANDBY, GROUP, kw('preempt', 'Overthrow lower priority Active routers')],
    available: layer3,
    run: (ctx, args) => setGroup(ctx, Number(args.group), (g) => (g.preempt = true)),
    no: { run: (ctx, args) => setGroup(ctx, Number(args.group), (g) => (g.preempt = false)) }
  },
  {
    modes: ['user', 'exec'],
    syntax: [
      kw('show', 'Show running system information'),
      kw('standby', 'HSRP information'),
      kw('brief', 'Brief output')
    ],
    available: (ctx) =>
      ctx.state.devices[ctx.deviceId]?.kind === 'router' ||
      ctx.state.devices[ctx.deviceId]?.kind === 'switch',
    run: showStandbyBrief
  },
  {
    modes: ['user', 'exec'],
    syntax: [kw('show', 'Show running system information'), kw('standby', 'HSRP information')],
    available: (ctx) =>
      ctx.state.devices[ctx.deviceId]?.kind === 'router' ||
      ctx.state.devices[ctx.deviceId]?.kind === 'switch',
    run: showStandby
  }
]

function interfaceConfig(device: IosDevice, iface: NetInterface): ConfigBlock[] {
  const lines: string[] = []
  for (const g of iosState(device).interfaces[iface.name]?.hsrp ?? []) {
    if (g.ip) lines.push(`standby ${g.group} ip ${g.ip}`)
    if (g.priority !== 100) lines.push(`standby ${g.group} priority ${g.priority}`)
    if (g.preempt) lines.push(`standby ${g.group} preempt`)
  }
  return lines.length ? [{ order: 50, lines }] : []
}

export const hsrp = defineIosFeature({
  id: 'hsrp',
  commands,
  interfaceConfig,
  settle,
  settleMessages: messages,
  transit: {
    // Le routeur actif porte l'adresse virtuelle : il répond à l'ARP et aux paquets qui lui sont adressés
    owns(state, device, ip) {
      if (!isIos(device) || !device.powered) return false
      const ios = iosState(device)
      return device.interfaces.some((iface) =>
        (ios.interfaces[iface.name]?.hsrp ?? []).some(
          (g) =>
            g.ip === ip &&
            ios.hsrpStates[keyOf(iface, g.group)] === 'Active' &&
            ifaceStatus(state, device, iface).protocol === 'up'
        )
      )
    }
  }
})
