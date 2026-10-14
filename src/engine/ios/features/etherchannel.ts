/**
 * EtherChannel des switchs IOS : channel-group N mode active | passive | desirable | auto | on,
 * interface port-channel N, show etherchannel summary. La négociation est calculée depuis l'état :
 * un port est groupé (P) si son câble est actif et que le port d'en face est dans un groupe de mode
 * compatible (LACP active/passive, PAgP desirable/auto, on uniquement avec on) ; sinon il reste
 * isolé (I) ou coupé (D).
 *
 * Simplification : l'interface Port-channel n'est pas une carte du moteur ; ses commandes de
 * configuration s'appliquent aux ports membres, et son bloc de running-config reprend leur
 * configuration 802.1Q.
 *
 * Sources :
 * - Command Reference 2960 15.0(2)SE, channel-group (groupes 1 à 6, modes compatibles) :
 *   https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/15-0_2_se/command/reference/cr2960/cli1.html
 * - Note technique 98469 (Creating a port-channel interface…, show etherchannel summary) :
 *   https://www.cisco.com/c/en/us/support/docs/lan-switching/etherchannel/98469-ios-etherchannel.html
 */
import type { LabState, NetInterface } from '../../model/schema'
import { switchportOf } from '../../net/switchport'
import { linkOnInterface, otherEnd } from '../../topology/queries'
import { number } from '../cli/args'
import type { ArgContext, CliCommand, IosRunContext, SyntaxToken } from '../cli/types'
import { draftIfaceEntry, draftIosState, iosState } from '../config'
import { isIos, type IosDevice } from '../device'
import { defineIosFeature } from '../feature'
import type { ConfigBlock } from '../running-config'
import { ifaceStatus } from '../status'
import { currentIfaces, deviceOf, update } from './base'

const kw = (keyword: string, help: string): SyntaxToken => ({ keyword, help })

export type ChannelMode = 'active' | 'passive' | 'desirable' | 'auto' | 'on'
const MODES: ChannelMode[] = ['active', 'auto', 'desirable', 'on', 'passive']
const MODE_HELP: Record<ChannelMode, string> = {
  active: 'Enable LACP unconditionally',
  auto: 'Enable PAgP only if a PAgP device is detected',
  desirable: 'Enable PAgP unconditionally',
  on: 'Enable Etherchannel only',
  passive: 'Enable LACP only if a LACP device is detected'
}

const isSwitch = (ctx: ArgContext): boolean => ctx.state.devices[ctx.deviceId]?.kind === 'switch'
const switchPorts = (ctx: ArgContext): boolean =>
  isSwitch(ctx) && currentIfaces(ctx).length > 0 && currentIfaces(ctx).every((i) => !i.svi && !i.l3)

/** Les deux modes forment-ils un canal (Command Reference, channel-group) ? */
export function compatible(a: ChannelMode, b: ChannelMode): boolean {
  if (a === 'on' || b === 'on') return a === 'on' && b === 'on'
  const lacp = (m: ChannelMode) => m === 'active' || m === 'passive'
  if (lacp(a) !== lacp(b)) return false
  // Au moins un côté actif (active, desirable)
  return a === 'active' || a === 'desirable' || b === 'active' || b === 'desirable'
}

const protocolOf = (mode: ChannelMode): string =>
  mode === 'on' ? '-' : mode === 'active' || mode === 'passive' ? 'LACP' : 'PAgP'

/** État d'un port membre : P (groupé), I (isolé), D (coupé). */
export function memberFlag(state: LabState, device: IosDevice, port: NetInterface): 'P' | 'I' | 'D' {
  const own = iosState(device).interfaces[port.name]?.channelGroup
  if (!own || ifaceStatus(state, device, port).status !== 'up') return 'D'
  const link = linkOnInterface(state, device.id, port.id)
  if (!link) return 'D'
  const end = otherEnd(link, device.id, port.id)
  const peer = state.devices[end.deviceId]
  const peerPort = peer?.interfaces.find((i) => i.id === end.ifaceId)
  const theirs = isIos(peer) && peerPort ? iosState(peer).interfaces[peerPort.name]?.channelGroup : null
  return theirs && compatible(own.mode, theirs.mode) ? 'P' : 'I'
}

/** Ports membres d'un groupe. */
export function members(device: IosDevice, group: number): NetInterface[] {
  const ios = iosState(device)
  return device.interfaces.filter((i) => ios.interfaces[i.name]?.channelGroup?.group === group)
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function setChannelGroup(ctx: IosRunContext, group: number, mode: ChannelMode): void {
  const device = deviceOf(ctx)
  const created = !iosState(device).portChannels.includes(group)
  if (created) {
    ctx.print('')
    ctx.print(`Creating a port-channel interface Port-channel ${group}`)
    ctx.print('')
  }
  const names = currentIfaces(ctx).map((i) => i.name)
  update(ctx, (d) => {
    const ios = draftIosState(d)
    if (!ios.portChannels.includes(group)) ios.portChannels.push(group)
    ios.portChannels.sort((a, b) => a - b)
    for (const name of names) draftIfaceEntry(ios, name).channelGroup = { group, mode }
  })
}

function clearChannelGroup(ctx: IosRunContext): void {
  const names = currentIfaces(ctx).map((i) => i.name)
  update(ctx, (d) => {
    const ios = draftIosState(d)
    for (const name of names) if (ios.interfaces[name]) ios.interfaces[name].channelGroup = null
  })
}

/** interface port-channel N : crée l'interface si besoin, configuration appliquée aux membres. */
export function enterPortChannel(ctx: IosRunContext, name: string): void {
  const group = Number(name.slice(2))
  if (!iosState(deviceOf(ctx)).portChannels.includes(group))
    update(ctx, (d) => {
      const ios = draftIosState(d)
      ios.portChannels.push(group)
      ios.portChannels.sort((a, b) => a - b)
    })
  ctx.setMode('config-if', { ifaces: members(deviceOf(ctx), group).map((i) => i.id) })
}

/** no interface port-channel N : supprime l'interface et retire ses membres du groupe. */
export function removePortChannel(ctx: IosRunContext, name: string): void {
  const group = Number(name.slice(2))
  update(ctx, (d) => {
    const ios = draftIosState(d)
    ios.portChannels = ios.portChannels.filter((g) => g !== group)
    for (const entry of Object.values(ios.interfaces))
      if (entry.channelGroup?.group === group) entry.channelGroup = null
  })
}

// ---------------------------------------------------------------------------
// show etherchannel summary
// ---------------------------------------------------------------------------

function showSummary(ctx: IosRunContext): void {
  const device = deviceOf(ctx)
  const groups = iosState(device).portChannels
  for (const line of [
    'Flags:  D - down        P - in port-channel',
    '        I - stand-alone s - suspended',
    '        H - Hot-standby (LACP only)',
    '        R - Layer3      S - Layer2',
    '        U - in use      f - failed to allocate aggregator',
    '        u - unsuitable for bundling',
    '        w - waiting to be aggregated',
    '        d - default port',
    '',
    '',
    `Number of channel-groups in use: ${groups.length}`,
    `Number of aggregators:           ${groups.length}`,
    '',
    'Group  Port-channel  Protocol    Ports',
    '------+-------------+-----------+-----------------------------'
  ])
    ctx.print(line)
  for (const group of groups) {
    const ports = members(device, group)
    const flags = ports.map((p) => memberFlag(ctx.state, device, p))
    const mode = ports[0] ? iosState(device).interfaces[ports[0].name]?.channelGroup?.mode : undefined
    const po = `Po${group}(S${flags.includes('P') ? 'U' : 'D'})`
    const list = ports.map((p, i) => `${p.name}(${flags[i]})`).join(' ')
    ctx.print(
      `${String(group).padEnd(7)}${po.padEnd(16)}${(mode ? protocolOf(mode) : '').padEnd(10)}${list}`.trimEnd()
    )
  }
}

const commands: CliCommand[] = [
  ...MODES.map((mode): CliCommand => ({
    modes: ['config-if'],
    syntax: [
      kw('channel-group', 'Etherchannel/port bundling configuration'),
      { arg: 'group', type: number(1, 6), help: 'Channel group number' },
      kw('mode', 'Etherchannel Mode of the interface'),
      kw(mode, MODE_HELP[mode])
    ],
    available: switchPorts,
    run: (ctx, args) => setChannelGroup(ctx, Number(args.group), mode),
    no: { min: 1, run: clearChannelGroup }
  })),
  {
    modes: ['user', 'exec'],
    syntax: [
      kw('show', 'Show running system information'),
      kw('etherchannel', 'EtherChannel information'),
      kw('summary', 'One-line summary per channel-group')
    ],
    available: isSwitch,
    run: showSummary
  }
]

function config(device: IosDevice): ConfigBlock[] {
  // Interfaces Port-channel, avant les ports physiques : configuration 802.1Q du premier membre
  return iosState(device).portChannels.map((group) => {
    const first = members(device, group)[0]
    const lines = [`interface Port-channel${group}`]
    if (first && device.kind === 'switch') {
      const sp = switchportOf(first)
      if (sp.mode === 'trunk') lines.push(' switchport mode trunk')
      else if (sp.accessVlan !== 1) lines.push(` switchport access vlan ${sp.accessVlan}`)
    }
    return { order: 99, lines }
  })
}

function interfaceConfig(device: IosDevice, i: NetInterface): ConfigBlock[] {
  const cg = iosState(device).interfaces[i.name]?.channelGroup
  return cg ? [{ order: 70, lines: [`channel-group ${cg.group} mode ${cg.mode}`] }] : []
}

export const etherchannel = defineIosFeature({ id: 'etherchannel', commands, config, interfaceConfig })
