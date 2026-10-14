/**
 * VTP des switchs IOS : vtp mode server | client | transparent, vtp domain, show vtp status.
 * Les annonces VTP entre switchs ne sont pas simulées (chaque switch garde sa base de VLAN).
 *
 * Sources :
 * - Note technique 98154, Configure VTP on Catalyst Switches (show vtp status, « Changing VTP domain
 *   name from … to … », « Setting device to VTP Client mode for VLANS. ») :
 *   https://www.cisco.com/c/en/us/support/docs/lan-switching/vtp/98154-conf-vlan.html
 * - Command Reference 2960 15.0(2)SE, show vtp :
 *   https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/15-0_2_se/command/reference/cr2960/cli2.html
 */
import { WORD } from '../cli/args'
import type { ArgContext, CliCommand, IosRunContext, SyntaxToken } from '../cli/types'
import { draftIosState, iosState } from '../config'
import type { IosDevice } from '../device'
import { defineIosFeature } from '../feature'
import { iosMac } from '../status'
import { deviceOf, update } from './base'

const kw = (keyword: string, help: string): SyntaxToken => ({ keyword, help })
const VTP = kw('vtp', 'Configure global VTP state')
const isSwitch = (ctx: ArgContext): boolean => ctx.state.devices[ctx.deviceId]?.kind === 'switch'

type VtpMode = 'server' | 'client' | 'transparent'
const LABEL: Record<VtpMode, string> = { server: 'Server', client: 'Client', transparent: 'Transparent' }

function setMode(ctx: IosRunContext, mode: VtpMode): void {
  ctx.print(`Setting device to VTP ${LABEL[mode]} mode for VLANS.`)
  update(ctx, (d) => {
    draftIosState(d).vtpMode = mode
  })
}

function setDomain(ctx: IosRunContext, name: string): void {
  const before = iosState(deviceOf(ctx)).vtpDomain
  ctx.print(`Changing VTP domain name from ${before || 'NULL'} to ${name}`)
  update(ctx, (d) => {
    draftIosState(d).vtpDomain = name
  })
}

/** Empreinte de 16 octets de la configuration VTP (déterministe, pas un vrai MD5). */
function digest(device: IosDevice): string[] {
  const text = JSON.stringify([iosState(device).vtpDomain, device.kind === 'switch' ? device.vlans : []])
  const bytes: string[] = []
  let h = 2166136261
  for (let i = 0; i < 16; i++) {
    for (let j = 0; j < text.length; j++) h = Math.imul(h ^ (text.charCodeAt(j) + i), 16777619) >>> 0
    bytes.push(`0x${(h & 0xff).toString(16).toUpperCase().padStart(2, '0')}`)
  }
  return bytes
}

function showVtpStatus(ctx: IosRunContext): void {
  const device = deviceOf(ctx)
  if (device.kind !== 'switch') return
  const ios = iosState(device)
  const row = (label: string, value: string | number, width = 32) =>
    ctx.print(`${label.padEnd(width)}: ${value}`.trimEnd())
  row('VTP Version capable', '1 to 3')
  row('VTP version running', 1)
  row('VTP Domain Name', ios.vtpDomain)
  row('VTP Pruning Mode', 'Disabled')
  row('VTP Traps Generation', 'Disabled')
  row('Device ID', iosMac(device.interfaces[0]?.mac ?? ''))
  ctx.print('Configuration last modified by 0.0.0.0 at 0-0-00 00:00:00')
  const svi = device.interfaces
    .filter((i) => i.svi && i.address)
    .sort((a, b) => (a.svi?.vlan ?? 0) - (b.svi?.vlan ?? 0))[0]
  if (ios.vtpMode === 'server' && svi)
    ctx.print(
      `Local updater ID is ${svi.address} on interface ${svi.name} (lowest numbered VLAN interface found)`
    )
  ctx.print('')
  ctx.print('Feature VLAN:')
  ctx.print('--------------')
  row('VTP Operating Mode', LABEL[ios.vtpMode], 34)
  row('Maximum VLANs supported locally', 255, 34)
  // VLAN 1002 à 1005 compris, comme show vlan brief
  row('Number of existing VLANs', device.vlans.length + 4, 34)
  row('Configuration Revision', 0, 34)
  const md5 = digest(device)
  ctx.print(`${'MD5 digest'.padEnd(34)}: ${md5.slice(0, 8).join(' ')} `)
  ctx.print(`${' '.repeat(36)}${md5.slice(8).join(' ')} `)
}

const commands: CliCommand[] = [
  ...(['server', 'client', 'transparent'] as const).map((mode): CliCommand => ({
    modes: ['config'],
    syntax: [
      VTP,
      kw('mode', 'Configure VTP device mode'),
      kw(
        mode,
        mode === 'server'
          ? 'Set the device to server mode.'
          : mode === 'client'
            ? 'Set the device to client mode.'
            : 'Set the device to transparent mode.'
      )
    ],
    available: isSwitch,
    run: (ctx) => setMode(ctx, mode),
    no: { min: 2, run: (ctx) => setMode(ctx, 'server') }
  })),
  {
    modes: ['config'],
    syntax: [
      VTP,
      kw('domain', 'Set the name of the VTP administrative domain.'),
      { arg: 'name', type: WORD, help: 'The ascii name for the VTP administrative domain.' }
    ],
    available: isSwitch,
    run: (ctx, args) => setDomain(ctx, args.name ?? '')
  },
  {
    modes: ['user', 'exec'],
    syntax: [
      kw('show', 'Show running system information'),
      kw('vtp', 'VTP information'),
      kw('status', 'VTP domain status')
    ],
    available: isSwitch,
    run: showVtpStatus
  }
]

export const vtp = defineIosFeature({ id: 'vtp', commands })
