/**
 * Switch 2960 : passerelle par défaut (ip default-gateway), état des ports (show interfaces status,
 * show interfaces … switchport), table d'adresses MAC alimentée par les trames simulées
 * (show mac address-table) et CDP (show cdp neighbors, calculé depuis les câbles du lab).
 *
 * Sources (Cisco IOS 15.0(2)SE, Catalyst 2960) :
 * - Command Reference : https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/15-0_2_se/command/reference/cr2960/cli2.html
 * - Guide, adresse IP et passerelle : https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/15-0_2_se/configuration/guide/scg2960/swipaddr.html
 * - Colonnes de show interfaces status : https://www.cisco.com/c/en/us/support/docs/switches/catalyst-6500-series-switches/12027-53.html
 * - CDP : https://www.cisco.com/c/en/us/support/docs/network-management/discovery-protocol-cdp/43485-cdponios43485.html
 */
import type { Draft } from 'immer'
import type { LabState, NetInterface } from '../../model/schema'
import { inNetwork, networkAddress } from '../../net/ipv4'
import type { Route } from '../../net/routing'
import { switchportOf } from '../../net/switchport'
import type { PacketTrace } from '../../sim/trace'
import { linkOnInterface, otherEnd } from '../../topology/queries'
import { IPV4, iface } from '../cli/args'
import type { ArgContext, CliCommand, IosRunContext, SyntaxToken } from '../cli/types'
import { draftIosState, iosState } from '../config'
import { isIos, type IosDevice } from '../device'
import { defineIosFeature } from '../feature'
import { ifaceLongName, IOS_MODEL_INFO } from '../models'
import type { ConfigBlock } from '../running-config'
import { ifaceStatus, iosMac } from '../status'
import { deviceOf, update } from './base'

const kw = (keyword: string, help: string): SyntaxToken => ({ keyword, help })
const SHOW = kw('show', 'Show running system information')
const INTERFACES = kw('interfaces', 'Interface status and configuration')

const isSwitch = (ctx: ArgContext): boolean => ctx.state.devices[ctx.deviceId]?.kind === 'switch'

/** Port physique (ni interface VLAN, ni sous-interface). */
const physical = (i: NetInterface): boolean => !i.svi && !i.subinterface

// ---------------------------------------------------------------------------
// ip default-gateway
// ---------------------------------------------------------------------------

function setGateway(ctx: IosRunContext, gateway: string | null): void {
  update(ctx, (d) => {
    draftIosState(d).defaultGateway = gateway
  })
}

/**
 * Route par défaut d'un switch sans routage IP : passerelle joignable par une interface VLAN
 * active de son sous-réseau (ignorée quand ip routing est actif, comme sur IOS).
 */
function gatewayRoutes(state: LabState, device: IosDevice): Route[] {
  const ios = iosState(device)
  if (device.kind !== 'switch' || ios.ipRouting || !ios.defaultGateway) return []
  const gw = ios.defaultGateway
  const via = device.interfaces.find(
    (i) =>
      i.svi &&
      i.address &&
      i.prefixLength !== null &&
      inNetwork(gw, networkAddress(i.address, i.prefixLength), i.prefixLength) &&
      ifaceStatus(state, device, i).protocol === 'up'
  )
  return via ? [{ network: '0.0.0.0', prefixLength: 0, gateway: gw, ifaceId: via.id, source: 'default' }] : []
}

// ---------------------------------------------------------------------------
// show interfaces status, show interfaces … switchport
// ---------------------------------------------------------------------------

const pad = (text: string, width: number): string => text.padEnd(width)

/** Colonne Status : connected, notconnect, disabled, err-disabled. */
function portState(state: LabState, device: IosDevice, port: NetInterface): string {
  const s = ifaceStatus(state, device, port)
  if (s.errDisabled) return 'err-disabled'
  if (s.status === 'administratively down') return 'disabled'
  return s.status === 'up' ? 'connected' : 'notconnect'
}

function showInterfacesStatus(ctx: IosRunContext): void {
  const device = deviceOf(ctx)
  const ios = iosState(device)
  ctx.print('')
  ctx.print('Port    Name               Status       Vlan       Duplex  Speed Type')
  for (const port of device.interfaces.filter(physical)) {
    const sp = switchportOf(port)
    const status = portState(ctx.state, device, port)
    const up = status === 'connected'
    const giga = port.name.startsWith('Gi')
    const name = (ios.interfaces[port.name]?.description ?? '').slice(0, 18)
    const vlan = sp.mode === 'trunk' ? 'trunk' : String(sp.accessVlan)
    const duplex = up ? 'a-full' : 'auto'
    const speed = up ? (giga ? 'a-1000' : 'a-100') : 'auto'
    ctx.print(
      `${pad(port.name, 8)}${pad(name, 19)}${pad(status, 13)}${pad(vlan, 11)}${duplex.padStart(6)}  ${speed.padStart(5)} ${giga ? '10/100/1000BaseTX' : '10/100BaseTX'}`
    )
  }
}

/** « 10 (VLAN0010) », « 11 ((Inactive)) » si le VLAN n'existe pas dans la base. */
function vlanLabel(device: IosDevice, id: number): string {
  const vlan = device.kind === 'switch' ? device.vlans.find((v) => v.id === id) : undefined
  return `${id} (${vlan ? vlan.name : '(Inactive)'})`
}

function showSwitchport(ctx: IosRunContext, name: string): void {
  const device = deviceOf(ctx)
  const port = device.interfaces.find((i) => i.name === name)
  if (!port || !physical(port)) return
  const sp = switchportOf(port)
  const trunk = sp.mode === 'trunk'
  const up = ifaceStatus(ctx.state, device, port).status === 'up'
  const nonegotiate = iosState(device).interfaces[port.name]?.nonegotiate ?? false
  const allowed = sp.allowedVlans
  ctx.print(`Name: ${port.name}`)
  ctx.print('Switchport: Enabled')
  ctx.print(`Administrative Mode: ${trunk ? 'trunk' : 'static access'}`)
  ctx.print(`Operational Mode: ${up ? (trunk ? 'trunk' : 'static access') : 'down'}`)
  ctx.print('Administrative Trunking Encapsulation: dot1q')
  ctx.print(`Operational Trunking Encapsulation: ${trunk && up ? 'dot1q' : 'native'}`)
  ctx.print(`Negotiation of Trunking: ${trunk && !nonegotiate ? 'On' : 'Off'}`)
  ctx.print(`Access Mode VLAN: ${vlanLabel(device, sp.accessVlan)}`)
  ctx.print(`Trunking Native Mode VLAN: ${vlanLabel(device, sp.nativeVlan)}`)
  ctx.print('Voice VLAN: none')
  ctx.print('Administrative private-vlan host-association: none')
  ctx.print('Administrative private-vlan mapping: none')
  ctx.print('Administrative private-vlan trunk native VLAN: none')
  ctx.print('Administrative private-vlan trunk encapsulation: dot1q')
  ctx.print('Administrative private-vlan trunk normal VLANs: none')
  ctx.print('Administrative private-vlan trunk private VLANs: none')
  ctx.print('Operational private-vlan: none')
  ctx.print(`Trunking VLANs Enabled: ${allowed === null ? 'ALL' : formatList(allowed)}`)
  ctx.print('Pruning VLANs Enabled: 2-1001')
  ctx.print('Capture Mode Disabled')
  ctx.print('Capture VLANs Allowed: ALL')
  ctx.print('')
  ctx.print('Protected: false')
  ctx.print('Unknown unicast blocked: disabled')
  ctx.print('Unknown multicast blocked: disabled')
  ctx.print('')
  ctx.print('Voice VLAN: none (Inactive)')
  ctx.print('Appliance trust: none')
}

/** Liste de VLAN compacte (1,10,20-30) ; « NONE » si vide. */
function formatList(ids: number[]): string {
  if (ids.length === 0) return 'NONE'
  const parts: string[] = []
  let start = ids[0] as number
  let prev = start
  for (const id of [...ids.slice(1), Number.NaN]) {
    if (id === prev + 1) {
      prev = id
      continue
    }
    parts.push(start === prev ? String(start) : `${start}-${prev}`)
    start = id
    prev = id
  }
  return parts.join(',')
}

// ---------------------------------------------------------------------------
// Table d'adresses MAC
// ---------------------------------------------------------------------------

/** Entrées statiques CPU d'un 2960 (exemple de la Command Reference 15.0(2)SE). */
const CPU_MACS = [
  '0000.0000.0001',
  '0000.0000.0002',
  '0000.0000.0003',
  '0000.0000.0009',
  '0000.0000.0012',
  '0180.c200.000b',
  '0180.c200.000c',
  '0180.c200.000d',
  '0180.c200.000e',
  '0180.c200.000f',
  '0180.c200.0010'
]

/** VLAN d'une trame reçue sur un port : étiquette 802.1Q, sinon VLAN d'accès ou natif. */
function frameVlan(port: NetInterface, tag: number | undefined): number {
  const sp = switchportOf(port)
  if (tag !== undefined) return tag
  return sp.mode === 'access' ? (sp.hoppedVlan ?? sp.accessVlan) : sp.nativeVlan
}

/**
 * Apprentissage des adresses MAC source des trames simulées par les switchs IOS : port d'arrivée et
 * VLAN de la trame (une entrée par couple adresse/VLAN, déplacée si l'adresse change de port).
 * Coût linéaire en nombre de trames.
 */
export function learnMacs(draft: Draft<LabState>, trace: PacketTrace): void {
  for (const event of trace.events) {
    if (event.outcome === 'dropped') continue
    const device = draft.devices[event.toDeviceId]
    if (!device || device.kind !== 'switch' || !isIos(device as IosDevice)) continue
    const link = draft.links[event.linkId]
    if (!link) continue
    const end = link.a.deviceId === device.id ? link.a : link.b
    const port = device.interfaces.find((i) => i.id === end.ifaceId)
    const eth = event.layers.find((l) => l.name === 'Ethernet II')
    const mac = eth?.fields.find(([k]) => k === 'MAC source')?.[1]
    if (!port || !physical(port as NetInterface) || !mac) continue
    const tag = event.layers.find((l) => l.name === '802.1Q')?.fields.find(([k]) => k === 'VLAN')?.[1]
    const vlan = frameVlan(port as NetInterface, tag === undefined ? undefined : Number(tag))
    const ios = draftIosState(device as Draft<IosDevice>)
    const entry = ios.macTable.find((e) => e.mac === mac && e.vlan === vlan)
    if (entry) entry.port = port.name
    else ios.macTable.push({ vlan, mac, port: port.name })
  }
}

function showMacTable(ctx: IosRunContext, dynamicOnly: boolean): void {
  const device = deviceOf(ctx)
  // Un port coupé ou débranché perd ses adresses
  const active = new Set(
    device.interfaces.filter((i) => ifaceStatus(ctx.state, device, i).status === 'up').map((i) => i.name)
  )
  const rows = iosState(device)
    .macTable.filter((e) => active.has(e.port))
    .map((e) => ({ ...e, mac: iosMac(e.mac) }))
    .sort((a, b) => a.vlan - b.vlan || a.mac.localeCompare(b.mac))
  const line = (vlan: string, mac: string, type: string, port: string) =>
    ctx.print(`${vlan.padStart(4)}    ${pad(mac, 18)}${pad(type, 12)}${port}`)
  ctx.print('          Mac Address Table')
  ctx.print('-------------------------------------------')
  ctx.print('')
  ctx.print('Vlan    Mac Address       Type        Ports')
  ctx.print('----    -----------       --------    -----')
  if (!dynamicOnly) for (const mac of CPU_MACS) line(' All', mac, 'STATIC', 'CPU')
  for (const r of rows) line(String(r.vlan), r.mac, 'DYNAMIC', r.port)
  ctx.print(`Total Mac Addresses for this criterion: ${rows.length + (dynamicOnly ? 0 : CPU_MACS.length)}`)
}

function clearMacTable(ctx: IosRunContext): void {
  update(ctx, (d) => {
    draftIosState(d).macTable = []
  })
}

// ---------------------------------------------------------------------------
// CDP
// ---------------------------------------------------------------------------

interface CdpNeighbor {
  device: IosDevice
  local: NetInterface
  remote: NetInterface
}

/** Voisins CDP : équipements IOS reliés par un câble actif, CDP actif des deux côtés. */
function cdpNeighbors(state: LabState, device: IosDevice): CdpNeighbor[] {
  const out: CdpNeighbor[] = []
  for (const local of device.interfaces.filter(physical)) {
    if (ifaceStatus(state, device, local).status !== 'up') continue
    const link = linkOnInterface(state, device.id, local.id)
    if (!link) continue
    const end = otherEnd(link, device.id, local.id)
    const peer = state.devices[end.deviceId]
    if (!isIos(peer) || !iosState(peer).cdpRun) continue
    const remote = peer.interfaces.find((i) => i.id === end.ifaceId)
    if (remote) out.push({ device: peer, local, remote })
  }
  return out
}

/** Interface abrégée de CDP : « Fas 0/1 », « Gig 0/0 ». */
function cdpIface(name: string): string {
  const m = /^([A-Za-z]+)(.*)$/.exec(ifaceLongName(name))
  return m ? `${(m[1] as string).slice(0, 3)} ${m[2]}` : name
}

/** Codes de capacité (R, S, I…) et libellés de show cdp neighbors detail. */
function capabilities(device: IosDevice): { codes: string; words: string } {
  if (device.kind === 'router') return { codes: 'R B S I', words: 'Router Source-Route-Bridge Switch IGMP' }
  if (IOS_MODEL_INFO[device.model].layer3) return { codes: 'R S I', words: 'Router Switch IGMP' }
  return { codes: 'S I', words: 'Switch IGMP' }
}

/** Plateforme annoncée (référence courte du modèle). */
function platform(device: IosDevice): string {
  const name = IOS_MODEL_INFO[device.model].name
  return name.replace(/^Cisco /, '').replace(/\/K9$/, '')
}

/** Durée de rétention restante : 180 s, annonces toutes les 60 s (dérivée de l'horloge du lab). */
const holdtime = (state: LabState): number => 180 - (Math.floor(state.clock / 1000) % 60)

function cdpEnabled(ctx: IosRunContext): boolean {
  if (iosState(deviceOf(ctx)).cdpRun) return true
  ctx.print('% CDP is not enabled')
  return false
}

function showCdpNeighbors(ctx: IosRunContext): void {
  if (!cdpEnabled(ctx)) return
  const device = deviceOf(ctx)
  ctx.print('Capability Codes: R - Router, T - Trans Bridge, B - Source Route Bridge')
  ctx.print('                  S - Switch, H - Host, I - IGMP, r - Repeater')
  ctx.print('')
  ctx.print('Device ID        Local Intrfce     Holdtme    Capability  Platform  Port ID')
  for (const n of cdpNeighbors(ctx.state, device)) {
    const rest = `${pad(cdpIface(n.local.name), 19)}${pad(String(holdtime(ctx.state)), 3)}${capabilities(
      n.device
    ).codes.padStart(11)}${' '.repeat(8)}${pad(platform(n.device).slice(0, 9), 10)}${cdpIface(n.remote.name)}`
    // Nom trop long : seul sur sa ligne, le reste aligné en dessous
    if (n.device.name.length > 16) {
      ctx.print(n.device.name)
      ctx.print(`${' '.repeat(17)}${rest}`)
    } else ctx.print(`${pad(n.device.name, 17)}${rest}`)
  }
}

/** Adresse annoncée : celle du port relié, sinon la première interface VLAN adressée. */
function cdpAddress(n: CdpNeighbor): string | null {
  return n.remote.address ?? n.device.interfaces.find((i) => i.svi && i.address)?.address ?? null
}

function showCdpDetail(ctx: IosRunContext): void {
  if (!cdpEnabled(ctx)) return
  const device = deviceOf(ctx)
  for (const n of cdpNeighbors(ctx.state, device)) {
    const info = IOS_MODEL_INFO[n.device.model]
    const address = cdpAddress(n)
    ctx.print('-------------------------')
    ctx.print(`Device ID: ${n.device.name}`)
    ctx.print('Entry address(es): ')
    if (address) ctx.print(`  IP address: ${address}`)
    ctx.print(`Platform: cisco ${info.name},  Capabilities: ${capabilities(n.device).words} `)
    ctx.print(
      `Interface: ${ifaceLongName(n.local.name)},  Port ID (outgoing port): ${ifaceLongName(n.remote.name)}`
    )
    ctx.print(`Holdtime : ${holdtime(ctx.state)} sec`)
    ctx.print('')
    ctx.print('Version :')
    for (const line of info.software.split('\n')) ctx.print(line)
    ctx.print('Technical Support: http://www.cisco.com/techsupport')
    ctx.print('Copyright (c) 1986-2021 by Cisco Systems, Inc.')
    ctx.print('')
    ctx.print('advertisement version: 2')
    if (n.device.kind === 'switch') {
      ctx.print("VTP Management Domain: ''")
      ctx.print(`Native VLAN: ${switchportOf(n.remote).nativeVlan}`)
    }
    ctx.print('Duplex: full')
    ctx.print('')
  }
}

function setCdpRun(ctx: IosRunContext, on: boolean): void {
  update(ctx, (d) => {
    draftIosState(d).cdpRun = on
  })
}

// ---------------------------------------------------------------------------
// Commandes
// ---------------------------------------------------------------------------

const commands: CliCommand[] = [
  {
    modes: ['config'],
    syntax: [
      kw('ip', 'Global IP configuration subcommands'),
      kw('default-gateway', 'Specify default gateway (if not routing IP)'),
      { arg: 'gw', type: IPV4, help: 'IP address of default gateway' }
    ],
    available: isSwitch,
    run: (ctx, args) => setGateway(ctx, args.gw ?? null),
    no: { min: 2, run: (ctx) => setGateway(ctx, null) }
  },
  {
    modes: ['user', 'exec'],
    syntax: [SHOW, INTERFACES, kw('status', 'Show interface line status')],
    available: isSwitch,
    run: showInterfacesStatus
  },
  {
    modes: ['user', 'exec'],
    syntax: [
      SHOW,
      INTERFACES,
      { arg: 'iface', type: iface(), help: 'Interface' },
      kw('switchport', 'Show interface switchport information')
    ],
    available: isSwitch,
    run: (ctx, args) => showSwitchport(ctx, args.iface ?? '')
  },
  {
    modes: ['user', 'exec'],
    syntax: [SHOW, kw('mac', 'MAC configuration'), kw('address-table', 'MAC forwarding table')],
    available: isSwitch,
    run: (ctx) => showMacTable(ctx, false)
  },
  {
    modes: ['user', 'exec'],
    syntax: [
      SHOW,
      kw('mac', 'MAC configuration'),
      kw('address-table', 'MAC forwarding table'),
      kw('dynamic', 'dynamic entry type')
    ],
    available: isSwitch,
    run: (ctx) => showMacTable(ctx, true)
  },
  {
    modes: ['exec'],
    syntax: [
      kw('clear', 'Reset functions'),
      kw('mac', 'MAC configuration'),
      kw('address-table', 'MAC forwarding table'),
      kw('dynamic', 'dynamic entry type')
    ],
    available: isSwitch,
    run: clearMacTable
  },
  {
    modes: ['user', 'exec'],
    syntax: [SHOW, kw('cdp', 'CDP information'), kw('neighbors', 'CDP neighbor entries')],
    run: showCdpNeighbors
  },
  {
    modes: ['user', 'exec'],
    syntax: [
      SHOW,
      kw('cdp', 'CDP information'),
      kw('neighbors', 'CDP neighbor entries'),
      kw('detail', 'Show detailed information')
    ],
    run: showCdpDetail
  },
  {
    modes: ['config'],
    syntax: [kw('cdp', 'Global CDP configuration subcommands'), kw('run', 'Enable CDP')],
    run: (ctx) => setCdpRun(ctx, true),
    no: { run: (ctx) => setCdpRun(ctx, false) }
  }
]

function config(device: IosDevice): ConfigBlock[] {
  const ios = iosState(device)
  const blocks: ConfigBlock[] = []
  if (!ios.cdpRun) blocks.push({ order: 44, lines: ['no cdp run'] })
  if (device.kind === 'switch' && ios.defaultGateway)
    blocks.push({ order: 105, lines: [`ip default-gateway ${ios.defaultGateway}`] })
  return blocks
}

export const switching = defineIosFeature({
  id: 'switching',
  commands,
  config,
  routes: gatewayRoutes
})
