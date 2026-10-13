/**
 * Configuration de base IOS : hostname, enable secret, bannière, ip domain-lookup, interfaces
 * (ip address, description, shutdown), commandes show, sauvegarde (copy / write / erase), reload,
 * ping et traceroute. Sorties reprises d'IOS 15.
 */
import { raise } from '../../core/result'
import type { LabState, NetInterface } from '../../model/schema'
import { formatIpv4, inNetwork, maskToPrefix, networkAddress, parseIpv4, prefixToMask } from '../../net/ipv4'
import { ping, tracert, type EchoOutcome } from '../../net/diagnostics'
import { deviceNameError } from '../../topology/actions'
import { IPV4, LINE, WORD, iface } from '../cli/args'
import type { ArgContext, CliCommand, IosRunContext, SyntaxToken } from '../cli/types'
import { applyStartup, configModified, draftIfaceEntry, draftIosState, iosState, snapshotOf } from '../config'
import { updateIos } from '../actions'
import { isIos, type IosDevice } from '../device'
import { defineIosFeature } from '../feature'
import { ifaceLongName, IOS_MODEL_INFO } from '../models'
import { showRunningConfig, showStartupConfig, type ConfigBlock } from '../running-config'
import { ifaceStatus, iosMac } from '../status'

const kw = (keyword: string, help: string): SyntaxToken => ({ keyword, help })

/** Équipement IOS de la session. */
export function deviceOf(ctx: { state: LabState; deviceId: string }): IosDevice {
  const device = ctx.state.devices[ctx.deviceId]
  if (!isIos(device)) throw new Error(`Équipement IOS introuvable (${ctx.deviceId}).`)
  return device
}

/** Interfaces en cours de configuration (config-if, config-subif). */
export function currentIfaces(ctx: { state: LabState; deviceId: string; session: { ifaces?: string[] } }) {
  const device = deviceOf(ctx)
  return (ctx.session.ifaces ?? [])
    .map((id) => device.interfaces.find((i) => i.id === id))
    .filter((i): i is NetInterface => i !== undefined)
}

/** Interfaces configurées de niveau 3 (ip address n'existe pas sur un port de switch). */
const layer3Iface = (ctx: ArgContext): boolean => currentIfaces(ctx).every((i) => i.l3)

/** Applique une modification de l'équipement IOS ; erreur métier affichée en cas d'échec. */
export function update(ctx: IosRunContext, recipe: Parameters<typeof updateIos>[2]): boolean {
  return ctx.apply(updateIos(ctx.state, ctx.deviceId, recipe))
}

// ---------------------------------------------------------------------------
// Messages d'état des interfaces
// ---------------------------------------------------------------------------

/** Messages %LINK / %LINEPROTO après shutdown / no shutdown. */
function linkMessages(ctx: IosRunContext, ifaces: NetInterface[], before: Map<string, string>): void {
  const device = deviceOf(ctx)
  for (const old of ifaces) {
    const now = device.interfaces.find((i) => i.id === old.id)
    if (!now) continue
    const status = ifaceStatus(ctx.state, device, now)
    if (before.get(now.id) === status.status) continue
    const name = ifaceLongName(now.name)
    if (status.status === 'administratively down') {
      ctx.print(`%LINK-5-CHANGED: Interface ${name}, changed state to administratively down`)
      if (before.get(now.id) === 'up')
        ctx.print(`%LINEPROTO-5-UPDOWN: Line protocol on Interface ${name}, changed state to down`)
    } else {
      ctx.print(`%LINK-3-UPDOWN: Interface ${name}, changed state to ${status.status}`)
      if (status.protocol === 'up')
        ctx.print(`%LINEPROTO-5-UPDOWN: Line protocol on Interface ${name}, changed state to up`)
    }
  }
}

function setShutdown(ctx: IosRunContext, shut: boolean): void {
  const ifaces = currentIfaces(ctx)
  const device = deviceOf(ctx)
  const before = new Map(ifaces.map((i) => [i.id, ifaceStatus(ctx.state, device, i).status]))
  const ids = new Set(ifaces.map((i) => i.id))
  const ok = update(ctx, (d) => {
    for (const i of d.interfaces.filter((x) => ids.has(x.id))) {
      i.enabled = !shut
      // shutdown / no shutdown rétablit un port en err-disabled
      const entry = d.ios?.interfaces[i.name]
      if (entry) {
        entry.errDisabled = false
        // Le même poste provoquera une nouvelle violation à la remise en service
        if (entry.portSecurity) entry.portSecurity.lastViolation = null
      }
    }
  })
  if (!ok) return
  linkMessages(ctx, ifaces, before)
}

// ---------------------------------------------------------------------------
// ip address
// ---------------------------------------------------------------------------

const hexMask = (mask: string): string =>
  `0x${((parseIpv4(mask) ?? 0) >>> 0).toString(16).toUpperCase().padStart(8, '0')}`

function setIpAddress(ctx: IosRunContext, address: string, mask: string): void {
  const prefix = maskToPrefix(mask)
  if (prefix === null) {
    ctx.print(`Bad mask ${hexMask(mask)} for address ${address}`)
    return
  }
  const ip = parseIpv4(address) ?? 0
  const net = networkAddress(address, prefix)
  const broadcast = formatIpv4((ip | (~(parseIpv4(mask) ?? 0) >>> 0)) >>> 0)
  if (prefix < 31 && (address === net || address === broadcast)) {
    ctx.print(`Bad mask /${prefix} for address ${address}`)
    return
  }
  const device = deviceOf(ctx)
  for (const target of currentIfaces(ctx)) {
    if (target.subinterface && target.subinterface.vlan === null) {
      ctx.print('% Configuring IP routing on a LAN subinterface is only allowed if that')
      ctx.print('subinterface is already configured as part of an IEEE 802.10, IEEE 802.1Q,')
      ctx.print('or ISL vLAN.')
      ctx.print('')
      return
    }
    // Chevauchement avec une autre interface du même équipement
    const overlap = device.interfaces.find(
      (i) =>
        i.id !== target.id &&
        i.address &&
        i.prefixLength !== null &&
        (inNetwork(address, networkAddress(i.address, i.prefixLength), i.prefixLength) ||
          inNetwork(i.address, net, prefix))
    )
    if (overlap) {
      ctx.print(`% ${net} overlaps with ${ifaceLongName(overlap.name)}`)
      return
    }
    update(ctx, (d) => {
      const i = d.interfaces.find((x) => x.id === target.id)
      if (!i) raise('InterfaceNotFound', 'Interface introuvable.')
      i.addressing = 'static'
      i.address = address
      i.prefixLength = prefix
      i.gateway = null
    })
  }
}

function clearIpAddress(ctx: IosRunContext): void {
  const ids = new Set(currentIfaces(ctx).map((i) => i.id))
  update(ctx, (d) =>
    d.interfaces
      .filter((i) => ids.has(i.id))
      .forEach((i) => {
        i.address = null
        i.prefixLength = null
      })
  )
}

function setDescription(ctx: IosRunContext, text: string | null): void {
  const names = currentIfaces(ctx).map((i) => i.name)
  update(ctx, (d) => {
    const ios = draftIosState(d)
    for (const name of names) {
      const entry = draftIfaceEntry(ios, name)
      entry.description = text
    }
  })
}

// ---------------------------------------------------------------------------
// Bannière
// ---------------------------------------------------------------------------

/** banner motd #texte# (sur plusieurs lignes : saisie jusqu'au délimiteur). */
function setBanner(ctx: IosRunContext, raw: string): void {
  const delimiter = raw[0] ?? ''
  let text = raw.slice(1)
  let end = text.indexOf(delimiter)
  if (end < 0) {
    ctx.print(`Enter TEXT message.  End with the character '${delimiter}'.`)
    const lines = [text]
    while (end < 0) {
      const next = ctx.ask('')
      end = next.indexOf(delimiter)
      lines.push(end < 0 ? next : next.slice(0, end))
    }
    text = lines.filter((l, i) => i > 0 || l !== '').join('\n')
  } else {
    text = text.slice(0, end)
  }
  update(ctx, (d) => {
    draftIosState(d).bannerMotd = text
  })
}

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

const pad = (text: string, width: number): string => text.padEnd(width)

function showIpInterfaceBrief(ctx: IosRunContext): void {
  const device = deviceOf(ctx)
  ctx.print(
    `${pad('Interface', 23)}${pad('IP-Address', 16)}${pad('OK?', 4)}${pad('Method', 7)}${pad('Status', 22)}Protocol`
  )
  for (const i of device.interfaces) {
    const s = ifaceStatus(ctx.state, device, i)
    ctx.print(
      `${pad(ifaceLongName(i.name), 23)}${pad(i.address ?? 'unassigned', 16)}${pad('YES', 4)}${pad(
        i.address ? 'manual' : 'unset',
        7
      )}${pad(s.status, 22)}${s.protocol}`
    )
  }
}

function hardwareName(device: IosDevice, iface: NetInterface): { hw: string; bw: number } {
  const giga = iface.name.startsWith('Gi')
  if (device.kind === 'router')
    return giga ? { hw: 'CN Gigabit Ethernet', bw: 1000000 } : { hw: 'Gt96k FE', bw: 100000 }
  return giga ? { hw: 'Gigabit Ethernet', bw: 1000000 } : { hw: 'Fast Ethernet', bw: 100000 }
}

function showInterface(ctx: IosRunContext, device: IosDevice, i: NetInterface): void {
  const s = ifaceStatus(ctx.state, device, i)
  const { hw, bw } = hardwareName(device, i)
  const mac = iosMac(i.mac)
  ctx.print(
    `${ifaceLongName(i.name)} is ${s.status}, line protocol is ${s.protocol}${s.errDisabled ? ' (err-disabled)' : ''}`
  )
  ctx.print(`  Hardware is ${hw}, address is ${mac} (bia ${mac})`)
  const description = iosState(device).interfaces[i.name]?.description
  if (description) ctx.print(`  Description: ${description}`)
  if (i.address && i.prefixLength !== null) ctx.print(`  Internet address is ${i.address}/${i.prefixLength}`)
  ctx.print(`  MTU 1500 bytes, BW ${bw} Kbit/sec, DLY ${bw >= 1000000 ? 10 : 100} usec,`)
  ctx.print('     reliability 255/255, txload 1/255, rxload 1/255')
  ctx.print(
    i.subinterface
      ? `  Encapsulation 802.1Q Virtual LAN, Vlan ID  ${i.subinterface.vlan ?? 1}.`
      : '  Encapsulation ARPA, loopback not set'
  )
}

function showVersion(ctx: IosRunContext): void {
  const device = deviceOf(ctx)
  const info = IOS_MODEL_INFO[device.model]
  const count = (prefix: string) =>
    device.interfaces.filter((i) => !i.subinterface && i.name.startsWith(prefix)).length
  const minutes = Math.floor(ctx.state.clock / 60000)
  for (const line of info.software.split('\n')) ctx.print(line)
  ctx.print('Technical Support: http://www.cisco.com/techsupport')
  ctx.print('Copyright (c) 1986-2021 by Cisco Systems, Inc.')
  ctx.print('')
  ctx.print(`${device.name} uptime is ${minutes} minute${minutes === 1 ? '' : 's'}`)
  ctx.print('System returned to ROM by power-on')
  ctx.print(`System image file is "${info.image}"`)
  ctx.print('')
  ctx.print(info.hardware)
  if (count('Fa')) ctx.print(`${count('Fa')} FastEthernet interfaces`)
  if (count('Gi')) ctx.print(`${count('Gi')} Gigabit Ethernet interfaces`)
  ctx.print('')
  ctx.print(`Configuration register is ${device.kind === 'router' ? '0x2102' : '0xF'}`)
}

// ---------------------------------------------------------------------------
// Sauvegarde et redémarrage
// ---------------------------------------------------------------------------

function save(ctx: IosRunContext): void {
  ctx.print('Building configuration...')
  if (update(ctx, (d) => (draftIosState(d).startup = snapshotOf(d as IosDevice)))) ctx.print('[OK]')
}

const confirmed = (answer: string): boolean => answer.trim() === '' || /^y(es)?$/i.test(answer.trim())

function reload(ctx: IosRunContext): void {
  if (configModified(deviceOf(ctx))) {
    for (;;) {
      const answer = ctx.ask('System configuration has been modified. Save? [yes/no]: ').trim().toLowerCase()
      if (answer === 'yes' || answer === 'y') {
        save(ctx)
        break
      }
      if (answer === 'no' || answer === 'n') break
      ctx.print("% Please answer 'yes' or 'no'.")
    }
  }
  if (!confirmed(ctx.ask('Proceed with reload? [confirm]'))) return
  if (
    !update(ctx, (d, draft) =>
      applyStartup(d, () => {
        draft.seq += 1
        return draft.seq
      })
    )
  )
    return
  ctx.print('')
  ctx.setMode('user')
  const motd = iosState(deviceOf(ctx)).bannerMotd
  ctx.print('Press RETURN to get started!')
  if (motd) for (const line of motd.split('\n')) ctx.print(line)
}

// ---------------------------------------------------------------------------
// ping et traceroute
// ---------------------------------------------------------------------------

/** Nom d'hôte au lieu d'une adresse : résolution DNS non simulée. */
function unknownHost(ctx: IosRunContext, name: string): void {
  if (iosState(deviceOf(ctx)).domainLookup)
    ctx.print(`Translating "${name}"...domain server (255.255.255.255)`)
  ctx.print('% Unrecognized host or address, or protocol not running.')
  ctx.print('')
}

const PING_CHAR: Record<EchoOutcome['kind'], string> = {
  reply: '!',
  timeout: '.',
  unreachable: 'U',
  'ttl-expired': '.',
  'transmit-failed': '.'
}

function runPing(ctx: IosRunContext, target: string): void {
  if (parseIpv4(target) === null) {
    unknownHost(ctx, target)
    return
  }
  const result = ping(ctx.state, ctx.deviceId, target, { count: 5, size: 100 })
  if (!result.ok) {
    ctx.print(`% ${result.error.message}`)
    return
  }
  ctx.addTrace(result.value.trace)
  const outcomes = result.value.outcomes
  const times = outcomes.flatMap((o) => (o.kind === 'reply' ? [Math.max(1, o.time)] : []))
  ctx.print('Type escape sequence to abort.')
  ctx.print(`Sending 5, 100-byte ICMP Echos to ${target}, timeout is 2 seconds:`)
  // Échec ARP local (« injoignable » émis par l'équipement lui-même) : délai dépassé, comme IOS
  const own = new Set(deviceOf(ctx).interfaces.map((i) => i.address))
  ctx.print(
    outcomes.map((o) => (o.kind === 'unreachable' && own.has(o.from) ? '.' : PING_CHAR[o.kind])).join('')
  )
  const rate = Math.round((times.length / outcomes.length) * 100)
  ctx.print(
    times.length > 0
      ? `Success rate is ${rate} percent (${times.length}/${outcomes.length}), round-trip min/avg/max = ${Math.min(
          ...times
        )}/${Math.round(times.reduce((a, b) => a + b, 0) / times.length)}/${Math.max(...times)} ms`
      : `Success rate is 0 percent (0/${outcomes.length})`
  )
}

function runTraceroute(ctx: IosRunContext, target: string): void {
  if (parseIpv4(target) === null) {
    unknownHost(ctx, target)
    return
  }
  const result = tracert(ctx.state, ctx.deviceId, target)
  if (!result.ok) {
    ctx.print(`% ${result.error.message}`)
    return
  }
  ctx.addTrace(result.value.trace)
  ctx.print('Type escape sequence to abort.')
  ctx.print(`Tracing the route to ${target}`)
  ctx.print('VRF info: (vrf in name/id, vrf out name/id)')
  result.value.hops.forEach((hop, index) => {
    const n = String(index + 1).padStart(3)
    if (hop.kind === 'reply' || hop.kind === 'ttl-expired') {
      const ms = `${hop.kind === 'reply' ? hop.time : 0} msec`
      ctx.print(`${n} ${hop.from} ${ms} ${ms} ${ms}`)
    } else if (hop.kind === 'unreachable') {
      ctx.print(`${n} ${hop.from} !H  !H  !H`)
    } else {
      ctx.print(`${n}  *  *  *`)
    }
  })
  // Aucun saut : on affiche les sauts muets jusqu'à la limite existante de 4 (fidélité I13)
  if (result.value.hops.length === 0)
    for (let i = 1; i <= 4; i++) ctx.print(`${String(i).padStart(3)}  *  *  *`)
}

// ---------------------------------------------------------------------------
// Commandes
// ---------------------------------------------------------------------------

const IF_MODES = ['config-if', 'config-subif'] as const

const SHOW = kw('show', 'Show running system information')
const SHOW_IP = kw('ip', 'IP information')

const commands: CliCommand[] = [
  // --- configuration globale ---
  {
    modes: ['config'],
    syntax: [
      kw('hostname', "Set system's network name"),
      { arg: 'name', type: WORD, help: "This system's network name" }
    ],
    run: (ctx, args) => {
      const name = args.name ?? ''
      if (deviceNameError('router', name)) {
        ctx.print('% Hostname contains one or more illegal characters.')
        return
      }
      update(ctx, (d, draft) => {
        const taken = Object.values(draft.devices).some(
          (x) => x.id !== d.id && x.name.toUpperCase() === name.toUpperCase()
        )
        if (taken) raise('DuplicateName', `Un équipement nommé « ${name} » existe déjà dans la topologie.`)
        d.name = name
      })
    }
  },
  {
    modes: ['config'],
    syntax: [
      kw('enable', 'Modify enable password parameters'),
      kw('secret', 'Assign the privileged level secret (MAX of 25 characters)'),
      { arg: 'secret', type: WORD, help: "The UNENCRYPTED (cleartext) 'enable' secret" }
    ],
    run: (ctx, args) =>
      update(ctx, (d) => {
        draftIosState(d).enableSecret = args.secret ?? ''
      }),
    no: {
      min: 2,
      run: (ctx) =>
        update(ctx, (d) => {
          draftIosState(d).enableSecret = null
        })
    }
  },
  {
    modes: ['config'],
    syntax: [
      kw('banner', 'Define a login banner'),
      kw('motd', 'Set Message of the Day banner'),
      { arg: 'text', type: LINE, help: "c  banner-text c, where 'c' is a delimiting character" }
    ],
    run: (ctx, args) => setBanner(ctx, args.text ?? ''),
    no: {
      min: 2,
      run: (ctx) =>
        update(ctx, (d) => {
          draftIosState(d).bannerMotd = null
        })
    }
  },
  ...[
    [kw('domain-lookup', 'Enable IP Domain Name System hostname translation')],
    [kw('domain', 'IP DNS Resolver'), kw('lookup', 'Enable IP Domain Name System hostname translation')]
  ].map((tail): CliCommand => ({
    modes: ['config'],
    syntax: [kw('ip', 'Global IP configuration subcommands'), ...tail],
    run: (ctx) =>
      update(ctx, (d) => {
        draftIosState(d).domainLookup = true
      }),
    no: {
      run: (ctx) =>
        update(ctx, (d) => {
          draftIosState(d).domainLookup = false
        })
    }
  })),

  // --- interface ---
  {
    modes: IF_MODES,
    syntax: [
      kw('ip', 'Interface Internet Protocol config commands'),
      kw('address', 'Set the IP address of an interface'),
      { arg: 'address', type: IPV4, help: 'IP address' },
      { arg: 'mask', type: IPV4, help: 'IP subnet mask' }
    ],
    available: layer3Iface,
    run: (ctx, args) => setIpAddress(ctx, args.address ?? '', args.mask ?? ''),
    no: { min: 2, run: clearIpAddress }
  },
  {
    modes: IF_MODES,
    syntax: [
      kw('description', 'Interface specific description'),
      { arg: 'text', type: LINE, help: 'Up to 240 characters describing this interface' }
    ],
    run: (ctx, args) => setDescription(ctx, args.text ?? ''),
    no: { min: 1, run: (ctx) => setDescription(ctx, null) }
  },
  {
    modes: IF_MODES,
    syntax: [kw('shutdown', 'Shutdown the selected interface')],
    run: (ctx) => setShutdown(ctx, true),
    no: { run: (ctx) => setShutdown(ctx, false) }
  },

  // --- show ---
  {
    modes: ['exec'],
    syntax: [SHOW, kw('running-config', 'Current operating configuration')],
    run: (ctx) => showRunningConfig(deviceOf(ctx), ctx.state).forEach((l) => ctx.print(l))
  },
  {
    modes: ['exec'],
    syntax: [SHOW, kw('startup-config', 'Contents of startup configuration')],
    run: (ctx) => showStartupConfig(deviceOf(ctx), ctx.state).forEach((l) => ctx.print(l))
  },
  {
    modes: ['user', 'exec'],
    syntax: [
      SHOW,
      SHOW_IP,
      kw('interface', 'IP interface status and configuration'),
      kw('brief', 'Brief summary of IP status and configuration')
    ],
    run: showIpInterfaceBrief
  },
  {
    modes: ['user', 'exec'],
    syntax: [SHOW, kw('interfaces', 'Interface status and configuration')],
    run: (ctx) => {
      const device = deviceOf(ctx)
      device.interfaces.forEach((i) => showInterface(ctx, device, i))
    }
  },
  {
    modes: ['user', 'exec'],
    syntax: [
      SHOW,
      kw('interfaces', 'Interface status and configuration'),
      { arg: 'iface', type: iface({ subinterfaces: true }), help: 'Interface' }
    ],
    run: (ctx, args) => {
      const device = deviceOf(ctx)
      const i = device.interfaces.find((x) => x.name === args.iface)
      if (i) showInterface(ctx, device, i)
      else ctx.print("% Invalid input detected at '^' marker.")
    }
  },
  {
    modes: ['user', 'exec'],
    syntax: [SHOW, kw('version', 'System hardware and software status')],
    run: showVersion
  },

  // --- sauvegarde et redémarrage ---
  {
    modes: ['exec'],
    syntax: [
      kw('copy', 'Copy from one file to another'),
      kw('running-config', 'Copy from current system configuration'),
      kw('startup-config', 'Copy to startup configuration')
    ],
    run: (ctx) => {
      const answer = ctx.ask('Destination filename [startup-config]? ').trim()
      if (answer !== '' && answer !== 'startup-config') return
      save(ctx)
    }
  },
  {
    modes: ['exec'],
    syntax: [kw('write', 'Write running configuration to memory, network, or terminal')],
    run: save
  },
  {
    modes: ['exec'],
    syntax: [
      kw('write', 'Write running configuration to memory, network, or terminal'),
      kw('memory', 'Write to NV memory')
    ],
    run: save
  },
  {
    modes: ['exec'],
    syntax: [
      kw('erase', 'Erase a filesystem'),
      kw('startup-config', 'Erase contents of configuration memory')
    ],
    run: (ctx) => {
      const answer = ctx.ask(
        'Erasing the nvram filesystem will remove all configuration files! Continue? [confirm]'
      )
      if (!confirmed(answer)) return
      if (!update(ctx, (d) => (draftIosState(d).startup = null))) return
      ctx.print('[OK]')
      ctx.print('Erase of nvram: complete')
    }
  },
  {
    modes: ['exec'],
    syntax: [kw('reload', 'Halt and perform a cold restart')],
    run: reload,
    doAllowed: false
  },
  {
    modes: ['user', 'exec'],
    syntax: [
      kw('ping', 'Send echo messages'),
      { arg: 'target', type: WORD, help: 'Ping destination address or hostname' }
    ],
    run: (ctx, args) => runPing(ctx, args.target ?? '')
  },
  {
    modes: ['user', 'exec'],
    syntax: [
      kw('traceroute', 'Trace route to destination'),
      { arg: 'target', type: WORD, help: 'Trace route to destination address or hostname' }
    ],
    run: (ctx, args) => runTraceroute(ctx, args.target ?? '')
  }
]

/** Haché affiché pour enable secret (format type 5, valeur simulée). */
export function secretHash(secret: string): string {
  const alphabet = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
  let h = 2166136261
  let out = ''
  for (let i = 0; out.length < 26; i++) {
    h = Math.imul(h ^ (secret.charCodeAt(i % Math.max(1, secret.length)) + i), 16777619) >>> 0
    out += alphabet[h % 64]
  }
  return `$1$${out.slice(0, 4)}$${out.slice(4, 26)}`
}

function config(device: IosDevice): ConfigBlock[] {
  const ios = iosState(device)
  return [
    {
      order: 5,
      lines: [
        'service timestamps debug datetime msec',
        'service timestamps log datetime msec',
        ios.passwordEncryption ? 'service password-encryption' : 'no service password-encryption'
      ]
    },
    { order: 10, lines: [`hostname ${device.name}`] },
    {
      order: 20,
      lines: ios.enableSecret !== null ? [`enable secret 5 ${secretHash(ios.enableSecret)}`] : []
    },
    { order: 40, lines: ios.domainLookup ? [] : ['no ip domain lookup'] },
    {
      order: 150,
      lines: ios.bannerMotd !== null ? [`banner motd ^C${ios.bannerMotd}^C`] : []
    }
  ]
}

function interfaceConfig(device: IosDevice, i: NetInterface): ConfigBlock[] {
  const description = iosState(device).interfaces[i.name]?.description
  const blocks: ConfigBlock[] = []
  if (description) blocks.push({ order: 10, lines: [`description ${description}`] })
  if (i.l3)
    blocks.push({
      order: 30,
      lines: [
        i.address && i.prefixLength !== null
          ? `ip address ${i.address} ${prefixToMask(i.prefixLength)}`
          : 'no ip address'
      ]
    })
  if (!i.enabled && !iosState(device).interfaces[i.name]?.errDisabled)
    blocks.push({ order: 90, lines: ['shutdown'] })
  if (device.kind === 'router' && !i.subinterface)
    blocks.push({ order: 95, lines: ['duplex auto', 'speed auto'] })
  return blocks
}

export const base = defineIosFeature({ id: 'base', commands, config, interfaceConfig })
