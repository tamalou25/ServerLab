/**
 * Sécurité IOS : port-security des ports de switch (maximum, mac-address sticky, violation
 * shutdown / restrict / protect, err-disabled), accès SSH (ip domain-name, crypto key generate
 * rsa, username … secret, line vty, transport input, login local), lignes (password, login) et
 * service password-encryption (chiffrement type 7).
 */
import { produce, type Draft } from 'immer'
import type { IosState, LabState, NetInterface } from '../../model/schema'
import { switchportOf } from '../../net/switchport'
import { linkOnInterface, otherEnd } from '../../topology/queries'
import { WORD, iface as ifaceArg, number } from '../cli/args'
import type { ArgContext, ArgType, CliCommand, IosRunContext, SyntaxToken } from '../cli/types'
import { draftIfaceEntry, draftIosState, iosState } from '../config'
import { isIos, type IosDevice } from '../device'
import { defineIosFeature } from '../feature'
import { ifaceLongName } from '../models'
import type { ConfigBlock } from '../running-config'
import { iosMac } from '../status'
import { currentIfaces, deviceOf, secretHash, update } from './base'

const kw = (keyword: string, help: string): SyntaxToken => ({ keyword, help })

type PortSecurity = NonNullable<IosState['interfaces'][string]['portSecurity']>

const defaultPortSecurity = (): PortSecurity => ({
  enabled: false,
  maximum: 1,
  violation: 'shutdown',
  sticky: false,
  staticMacs: [],
  stickyMacs: [],
  dynamicMacs: [],
  violations: 0,
  lastViolation: null
})

/** Ports de switch (physiques). */
const switchPorts = (ctx: ArgContext): boolean =>
  ctx.state.devices[ctx.deviceId]?.kind === 'switch' && currentIfaces(ctx).every((i) => !i.svi && !i.l3)

// ---------------------------------------------------------------------------
// Chiffrement type 7 (service password-encryption)
// ---------------------------------------------------------------------------

const XLAT = 'dsfd;kfoA,.iyewrkldJKDHSUBsgvca69834ncxv9873254k;fg87'

/** Mot de passe chiffré type 7 (algorithme réversible d'IOS), sel déterministe. */
export function type7(password: string): string {
  let seed = 0
  for (const ch of password) seed = (seed * 31 + ch.charCodeAt(0)) % 16
  let out = String(seed).padStart(2, '0')
  for (let i = 0; i < password.length; i++)
    out += (password.charCodeAt(i) ^ XLAT.charCodeAt((seed + i) % XLAT.length))
      .toString(16)
      .toUpperCase()
      .padStart(2, '0')
  return out
}

// ---------------------------------------------------------------------------
// Port-security
// ---------------------------------------------------------------------------

/** Adresse MAC de l'équipement branché directement sur le port (null : rien de branché d'actif). */
function peerMac(state: LabState, device: IosDevice, port: NetInterface): string | null {
  const link = linkOnInterface(state, device.id, port.id)
  if (!link || !device.powered) return null
  const end = otherEnd(link, device.id, port.id)
  const peer = state.devices[end.deviceId]
  const peerIface = peer?.interfaces.find((i) => i.id === end.ifaceId)
  return peer?.powered && peerIface?.enabled ? iosMac(peerIface.mac) : null
}

const secureMacs = (ps: PortSecurity): string[] => [...ps.staticMacs, ...ps.stickyMacs, ...ps.dynamicMacs]

/** Apprentissage des adresses et violations, recalculés après chaque modification du lab. */
function settle(state: LabState): LabState {
  return produce(state, (draft) => {
    for (const device of Object.values(draft.devices)) {
      if (device.kind !== 'switch' || !isIos(device as IosDevice) || !device.ios) continue
      for (const port of device.interfaces) {
        const entry = device.ios.interfaces[port.name]
        const ps = entry?.portSecurity
        if (!entry || !ps?.enabled || entry.errDisabled || !port.enabled) continue
        if (switchportOf(port as NetInterface).mode !== 'access') continue
        const mac = peerMac(state, device as IosDevice, port as NetInterface)
        if (!mac) {
          // Lien tombé : les adresses apprises dynamiquement sont oubliées
          if (ps.dynamicMacs.length) ps.dynamicMacs = []
          continue
        }
        const secure = secureMacs(ps as PortSecurity)
        if (secure.includes(mac)) continue
        if (secure.length < ps.maximum) {
          if (ps.sticky) ps.stickyMacs.push(mac)
          else ps.dynamicMacs.push(mac)
          continue
        }
        if (ps.lastViolation === mac) continue
        ps.violations += 1
        ps.lastViolation = mac
        if (ps.violation === 'shutdown') {
          entry.errDisabled = true
          port.enabled = false
        }
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
    const ps = now?.portSecurity
    if (!ps || ps.violations === (was?.portSecurity?.violations ?? 0)) continue
    const long = ifaceLongName(port.name)
    if (now.errDisabled && !was?.errDisabled)
      out.push(
        `%PM-4-ERR_DISABLE: psecure-violation error detected on ${port.name}, putting ${port.name} in err-disable state`
      )
    if (ps.violation !== 'protect')
      out.push(
        `%PORT_SECURITY-2-PSECURE_VIOLATION: Security violation occurred, caused by MAC address ${ps.lastViolation} on port ${long}.`
      )
    if (now.errDisabled && !was?.errDisabled)
      out.push(
        `%LINEPROTO-5-UPDOWN: Line protocol on Interface ${long}, changed state to down`,
        `%LINK-3-UPDOWN: Interface ${long}, changed state to down`
      )
  }
  return out
}

/** Modifie la port-security des ports en cours de configuration (ports d'accès seulement). */
function setPortSecurity(ctx: IosRunContext, change: (ps: Draft<PortSecurity>) => void): void {
  const ports = currentIfaces(ctx)
  const trunk = ports.find((p) => switchportOf(p).mode !== 'access')
  if (trunk) {
    ctx.print(`Command rejected: ${trunk.name} is a trunk port.`)
    return
  }
  update(ctx, (d) => {
    const ios = draftIosState(d)
    for (const p of ports) {
      const entry = draftIfaceEntry(ios, p.name)
      entry.portSecurity ??= defaultPortSecurity()
      change(entry.portSecurity)
    }
  })
}

const MAC: ArgType = {
  label: 'H.H.H',
  match: (tokens, index) => {
    const t = tokens[index]
    return t && /^[0-9a-f]{1,4}\.[0-9a-f]{1,4}\.[0-9a-f]{1,4}$/i.test(t)
      ? {
          consumed: 1,
          value: t
            .split('.')
            .map((g) => g.padStart(4, '0').toLowerCase())
            .join('.')
        }
      : null
  }
}

function showPortSecurityInterface(ctx: IosRunContext, name: string): void {
  const device = deviceOf(ctx)
  const port = device.interfaces.find((i) => i.name === name)
  const entry = iosState(device).interfaces[name]
  const ps = entry?.portSecurity ?? defaultPortSecurity()
  if (!port) return
  const status = !ps.enabled
    ? 'Secure-down'
    : entry?.errDisabled
      ? 'Secure-shutdown'
      : port.enabled && peerMac(ctx.state, device, port)
        ? 'Secure-up'
        : 'Secure-down'
  const last = ps.lastViolation ?? peerMac(ctx.state, device, port)
  const row = (label: string, value: string | number) => ctx.print(`${label.padEnd(27)}: ${value}`)
  row('Port Security', ps.enabled ? 'Enabled' : 'Disabled')
  row('Port Status', status)
  row('Violation Mode', ps.violation[0]?.toUpperCase() + ps.violation.slice(1))
  row('Aging Time', '0 mins')
  row('Aging Type', 'Absolute')
  row('SecureStatic Address Aging', 'Disabled')
  row('Maximum MAC Addresses', ps.maximum)
  row('Total MAC Addresses', secureMacs(ps).length)
  row('Configured MAC Addresses', ps.staticMacs.length)
  row('Sticky MAC Addresses', ps.stickyMacs.length)
  row('Last Source Address:Vlan', last ? `${last}:${switchportOf(port).accessVlan}` : '0000.0000.0000:0')
  row('Security Violation Count', ps.violations)
}

function showPortSecurity(ctx: IosRunContext): void {
  const device = deviceOf(ctx)
  ctx.print('Secure Port  MaxSecureAddr  CurrentAddr  SecurityViolation  Security Action')
  ctx.print('                (Count)       (Count)          (Count)')
  ctx.print('---------------------------------------------------------------------------')
  for (const port of device.interfaces) {
    const ps = iosState(device).interfaces[port.name]?.portSecurity
    if (!ps?.enabled) continue
    const action = ps.violation[0]?.toUpperCase() + ps.violation.slice(1)
    ctx.print(
      `${port.name.padStart(11)}${String(ps.maximum).padStart(15)}${String(secureMacs(ps).length).padStart(13)}${String(ps.violations).padStart(19)}${action.padStart(17)}`
    )
  }
  ctx.print('---------------------------------------------------------------------------')
}

// ---------------------------------------------------------------------------
// SSH, comptes et lignes
// ---------------------------------------------------------------------------

function generateKeys(ctx: IosRunContext, bits?: number): void {
  const device = deviceOf(ctx)
  const ios = iosState(device)
  if (/^(Router|Switch)$/.test(device.name)) {
    ctx.print('% Please define a hostname other than Router.')
    return
  }
  if (!ios.domainName) {
    ctx.print('% Please define a domain-name first.')
    return
  }
  ctx.print(`The name for the keys will be: ${device.name}.${ios.domainName}`)
  let size = bits
  if (size === undefined) {
    ctx.print('Choose the size of the key modulus in the range of 360 to 4096 for your')
    ctx.print('  General Purpose Keys. Choosing a key modulus greater than 512 may take')
    ctx.print('  a few minutes.')
    ctx.print('')
    const answer = ctx.ask('How many bits in the modulus [512]: ').trim()
    size = answer === '' ? 512 : Number(answer)
    if (!Number.isInteger(size) || size < 360 || size > 4096) {
      ctx.print('% A decimal number between 360 and 4096.')
      return
    }
  }
  ctx.print(`% Generating ${size} bit RSA keys, keys will be non-exportable...`)
  ctx.print('[OK] (elapsed time was 1 seconds)')
  const fresh = ios.rsaBits === null
  update(ctx, (d) => {
    draftIosState(d).rsaBits = size ?? 512
  })
  if (fresh) ctx.print('%SSH-5-ENABLED: SSH 1.99 has been enabled')
}

/** Ligne en cours de configuration (créée à la première modification). */
function updateLine(ctx: IosRunContext, change: (line: Draft<IosState['lines'][number]>) => void): void {
  const ref = ctx.session.line
  if (!ref) return
  update(ctx, (d) => {
    const lines = draftIosState(d).lines
    let line = lines.find((l) => l.type === ref.type && l.first === ref.first && l.last === ref.last)
    if (!line) {
      line = {
        type: ref.type,
        first: ref.first,
        last: ref.last,
        password: null,
        login: 'none',
        loggingSync: false,
        transport: null
      }
      lines.push(line)
      lines.sort((a, b) => (a.type === b.type ? a.first - b.first : a.type === 'console' ? -1 : 1))
    }
    change(line)
  })
}

function showIpSsh(ctx: IosRunContext): void {
  const ios = iosState(deviceOf(ctx))
  const version = ios.sshVersion === 2 ? '2.0' : '1.99'
  if (ios.rsaBits === null) {
    ctx.print(`SSH Disabled - version ${version}`)
    ctx.print('%Please create RSA keys to enable SSH (and of atleast 768 bits for SSH v2).')
  } else ctx.print(`SSH Enabled - version ${version}`)
  ctx.print('Authentication methods:publickey,keyboard-interactive,password')
  ctx.print('Authentication timeout: 120 secs; Authentication retries: 3')
}

// ---------------------------------------------------------------------------
// Commandes
// ---------------------------------------------------------------------------

const PS = [
  kw('switchport', 'Set switching mode characteristics'),
  kw('port-security', 'Security related command')
]
const PASSWORD_ARG = {
  arg: 'password',
  type: { label: 'LINE', match: WORD.match },
  help: 'The UNENCRYPTED (cleartext) line password'
}

const commands: CliCommand[] = [
  // --- port-security ---
  {
    modes: ['config-if'],
    syntax: PS,
    available: switchPorts,
    run: (ctx) => setPortSecurity(ctx, (ps) => (ps.enabled = true)),
    no: { run: (ctx) => setPortSecurity(ctx, (ps) => (ps.enabled = false)) }
  },
  {
    modes: ['config-if'],
    syntax: [
      ...PS,
      kw('maximum', 'Max secure addresses'),
      { arg: 'max', type: number(1, 132), help: 'Maximum addresses' }
    ],
    available: switchPorts,
    run: (ctx, args) => setPortSecurity(ctx, (ps) => (ps.maximum = Number(args.max))),
    no: { min: 3, run: (ctx) => setPortSecurity(ctx, (ps) => (ps.maximum = 1)) }
  },
  ...(['shutdown', 'restrict', 'protect'] as const).map((mode): CliCommand => ({
    modes: ['config-if'],
    syntax: [
      ...PS,
      kw('violation', 'Security violation mode'),
      kw(
        mode,
        mode === 'shutdown'
          ? 'Security violation shutdown mode'
          : mode === 'restrict'
            ? 'Security violation restrict mode'
            : 'Security violation protect mode'
      )
    ],
    available: switchPorts,
    run: (ctx) => setPortSecurity(ctx, (ps) => (ps.violation = mode)),
    no: { min: 3, run: (ctx) => setPortSecurity(ctx, (ps) => (ps.violation = 'shutdown')) }
  })),
  {
    modes: ['config-if'],
    syntax: [
      ...PS,
      kw('mac-address', 'Secure mac address'),
      kw('sticky', 'Configure dynamic secure addresses as sticky')
    ],
    available: switchPorts,
    run: (ctx) =>
      setPortSecurity(ctx, (ps) => {
        ps.sticky = true
        // Les adresses déjà apprises deviennent collantes
        ps.stickyMacs.push(...ps.dynamicMacs)
        ps.dynamicMacs = []
      }),
    no: {
      run: (ctx) =>
        setPortSecurity(ctx, (ps) => {
          ps.sticky = false
          ps.stickyMacs = []
        })
    }
  },
  {
    modes: ['config-if'],
    syntax: [
      ...PS,
      kw('mac-address', 'Secure mac address'),
      { arg: 'mac', type: MAC, help: '48 bit mac address' }
    ],
    available: switchPorts,
    run: (ctx, args) =>
      setPortSecurity(
        ctx,
        (ps) => void (ps.staticMacs.includes(args.mac ?? '') || ps.staticMacs.push(args.mac ?? ''))
      ),
    no: {
      run: (ctx, args) =>
        setPortSecurity(ctx, (ps) => (ps.staticMacs = ps.staticMacs.filter((m) => m !== args.mac)))
    }
  },
  {
    modes: ['user', 'exec'],
    syntax: [
      kw('show', 'Show running system information'),
      kw('port-security', 'Show secure port information')
    ],
    available: (ctx) => ctx.state.devices[ctx.deviceId]?.kind === 'switch',
    run: showPortSecurity
  },
  {
    modes: ['user', 'exec'],
    syntax: [
      kw('show', 'Show running system information'),
      kw('port-security', 'Show secure port information'),
      kw('interface', 'Show secure interface'),
      { arg: 'iface', type: ifaceArg(), help: 'Interface' }
    ],
    available: (ctx) => ctx.state.devices[ctx.deviceId]?.kind === 'switch',
    run: (ctx, args) => showPortSecurityInterface(ctx, args.iface ?? '')
  },

  // --- SSH et comptes ---
  ...[
    [kw('domain-name', 'Define the default domain name')],
    [kw('domain', 'IP DNS Resolver'), kw('name', 'Define the default domain name')]
  ].map((tail): CliCommand => ({
    modes: ['config'],
    syntax: [
      kw('ip', 'Global IP configuration subcommands'),
      ...tail,
      { arg: 'domain', type: WORD, help: 'Default domain name' }
    ],
    run: (ctx, args) =>
      update(ctx, (d) => {
        draftIosState(d).domainName = args.domain ?? null
      }),
    no: {
      min: tail.length + 1,
      run: (ctx) =>
        update(ctx, (d) => {
          draftIosState(d).domainName = null
        })
    }
  })),
  ...[false, true].map((withModulus): CliCommand => ({
    modes: ['config'],
    syntax: [
      kw('crypto', 'Encryption module'),
      kw('key', 'Long term key operations'),
      kw('generate', 'Generate new keys'),
      kw('rsa', 'Generate RSA keys'),
      ...(withModulus
        ? [
            kw('modulus', 'Provide number of modulus bits on the command line'),
            { arg: 'bits', type: number(360, 4096), help: 'size of the key modulus [360-4096]' }
          ]
        : [])
    ],
    run: (ctx, args) => generateKeys(ctx, withModulus ? Number(args.bits) : undefined)
  })),
  {
    modes: ['config'],
    syntax: [
      kw('ip', 'Global IP configuration subcommands'),
      kw('ssh', 'Configure ssh options'),
      kw('version', 'Specify protocol version to be supported'),
      { arg: 'version', type: number(1, 2), help: 'Protocol version' }
    ],
    run: (ctx, args) =>
      update(ctx, (d) => {
        draftIosState(d).sshVersion = Number(args.version)
      }),
    no: {
      min: 3,
      run: (ctx) =>
        update(ctx, (d) => {
          draftIosState(d).sshVersion = null
        })
    }
  },
  ...[false, true].map((withPrivilege): CliCommand => ({
    modes: ['config'],
    syntax: [
      kw('username', 'Establish User Name Authentication'),
      { arg: 'name', type: WORD, help: 'User name' },
      ...(withPrivilege
        ? [
            kw('privilege', 'Set user privilege level'),
            { arg: 'level', type: number(0, 15), help: 'User privilege level' }
          ]
        : []),
      kw('secret', 'Specify the secret for the user'),
      { arg: 'secret', type: WORD, help: 'The UNENCRYPTED (cleartext) user secret' }
    ],
    run: (ctx, args) =>
      update(ctx, (d) => {
        const ios = draftIosState(d)
        const name = args.name ?? ''
        ios.users = ios.users.filter((u) => u.name !== name)
        ios.users.push({ name, privilege: withPrivilege ? Number(args.level) : 1, secret: args.secret ?? '' })
      }),
    ...(withPrivilege
      ? {}
      : {
          no: {
            min: 2,
            run: (ctx: IosRunContext, args: Readonly<Record<string, string>>) =>
              update(ctx, (d) => {
                const ios = draftIosState(d)
                ios.users = ios.users.filter((u) => u.name !== args.name)
              })
          }
        })
  })),
  {
    modes: ['config'],
    syntax: [
      kw('service', 'Modify use of network based services'),
      kw('password-encryption', 'Encrypt system passwords')
    ],
    run: (ctx) =>
      update(ctx, (d) => {
        draftIosState(d).passwordEncryption = true
      }),
    no: {
      run: (ctx) =>
        update(ctx, (d) => {
          draftIosState(d).passwordEncryption = false
        })
    }
  },
  {
    modes: ['user', 'exec'],
    syntax: [
      kw('show', 'Show running system information'),
      kw('ip', 'IP information'),
      kw('ssh', 'Information on SSH')
    ],
    run: showIpSsh
  },

  // --- lignes ---
  {
    modes: ['config-line'],
    syntax: [kw('password', 'Set a password'), PASSWORD_ARG],
    run: (ctx, args) => updateLine(ctx, (l) => (l.password = args.password ?? null)),
    no: { min: 1, run: (ctx) => updateLine(ctx, (l) => (l.password = null)) }
  },
  {
    // Console et vty ; « no logging synchronous » rétablit la valeur d'usine
    modes: ['config-line'],
    syntax: [
      kw('logging', 'Modify message logging facilities'),
      kw('synchronous', 'Synchronized message output')
    ],
    run: (ctx) => updateLine(ctx, (l) => (l.loggingSync = true)),
    no: { run: (ctx) => updateLine(ctx, (l) => (l.loggingSync = false)) }
  },
  {
    modes: ['config-line'],
    syntax: [kw('login', 'Enable password checking')],
    run: (ctx) => updateLine(ctx, (l) => (l.login = 'line')),
    no: { run: (ctx) => updateLine(ctx, (l) => (l.login = 'none')) }
  },
  {
    modes: ['config-line'],
    syntax: [kw('login', 'Enable password checking'), kw('local', 'Local password checking')],
    run: (ctx) => updateLine(ctx, (l) => (l.login = 'local')),
    no: { run: (ctx) => updateLine(ctx, (l) => (l.login = 'none')) }
  },
  ...(
    [
      [['ssh'], 'TCP/IP SSH protocol'],
      [['telnet'], 'TCP/IP Telnet protocol'],
      [['ssh', 'telnet'], 'TCP/IP SSH protocol'],
      [['all'], 'All protocols'],
      [['none'], 'No protocols']
    ] as const
  ).map(([words, help]): CliCommand => ({
    modes: ['config-line'],
    syntax: [
      kw('transport', 'Define transport protocols for line'),
      kw('input', 'Define which protocols to use when connecting to the terminal server'),
      ...words.map((w, i) => kw(w, i === 0 ? help : 'TCP/IP Telnet protocol'))
    ],
    available: (ctx) => ctx.session.line?.type === 'vty',
    run: (ctx) =>
      updateLine(ctx, (l) => {
        l.transport =
          words[0] === 'all'
            ? ['ssh', 'telnet']
            : words[0] === 'none'
              ? []
              : [...(words as readonly ('ssh' | 'telnet')[])]
      })
  }))
]

/** Lignes d'usine et configurées, dans l'ordre de la running-config. */
function lineBlocks(device: IosDevice): string[] {
  const ios = iosState(device)
  const encrypt = ios.passwordEncryption
  const defaults: { type: 'console' | 'aux' | 'vty'; first: number; last: number }[] = [
    { type: 'console', first: 0, last: 0 },
    ...(device.kind === 'router' ? [{ type: 'aux' as const, first: 0, last: 0 }] : []),
    { type: 'vty', first: 0, last: 4 },
    ...(device.kind === 'switch' ? [{ type: 'vty' as const, first: 5, last: 15 }] : [])
  ]
  const configured = ios.lines.filter(
    (l) => !defaults.some((d) => d.type === l.type && d.first === l.first && d.last === l.last)
  )
  const all = [...defaults, ...configured.map((l) => ({ type: l.type, first: l.first, last: l.last }))]
  const out: string[] = []
  for (const ref of all) {
    const line = ios.lines.find((l) => l.type === ref.type && l.first === ref.first && l.last === ref.last)
    out.push(
      ref.type === 'console'
        ? 'line con 0'
        : ref.type === 'aux'
          ? 'line aux 0'
          : `line vty ${ref.first} ${ref.last}`
    )
    if (line?.password)
      out.push(encrypt ? ` password 7 ${type7(line.password)}` : ` password ${line.password}`)
    // Ordre relatif à password / login à vérifier (exemples Cisco sans mot de passe)
    if (line?.loggingSync) out.push(' logging synchronous')
    const login = line ? line.login : ref.type === 'vty' ? 'line' : 'none'
    if (login === 'line') out.push(' login')
    if (login === 'local') out.push(' login local')
    if (line?.transport)
      out.push(
        ` transport input ${line.transport.length === 0 ? 'none' : line.transport.length === 2 ? 'all' : line.transport[0]}`
      )
  }
  return out
}

function config(device: IosDevice): ConfigBlock[] {
  const ios = iosState(device)
  const blocks: ConfigBlock[] = []
  if (ios.users.length)
    blocks.push({
      order: 30,
      lines: ios.users.map(
        (u) =>
          `username ${u.name}${u.privilege !== 1 ? ` privilege ${u.privilege}` : ''} secret 5 ${secretHash(u.secret)}`
      )
    })
  if (ios.domainName) blocks.push({ order: 41, lines: [`ip domain name ${ios.domainName}`] })
  if (ios.sshVersion !== null) blocks.push({ order: 130, lines: [`ip ssh version ${ios.sshVersion}`] })
  blocks.push({ order: 160, lines: lineBlocks(device) })
  return blocks
}

function interfaceConfig(device: IosDevice, i: NetInterface): ConfigBlock[] {
  const ps = iosState(device).interfaces[i.name]?.portSecurity
  if (!ps) return []
  const lines: string[] = []
  if (ps.maximum !== 1) lines.push(`switchport port-security maximum ${ps.maximum}`)
  if (ps.enabled) lines.push('switchport port-security')
  if (ps.violation !== 'shutdown') lines.push(`switchport port-security violation ${ps.violation}`)
  if (ps.sticky) lines.push('switchport port-security mac-address sticky')
  for (const mac of ps.stickyMacs) lines.push(`switchport port-security mac-address sticky ${mac}`)
  for (const mac of ps.staticMacs) lines.push(`switchport port-security mac-address ${mac}`)
  return lines.length ? [{ order: 25, lines }] : []
}

export const security = defineIosFeature({
  id: 'security',
  commands,
  config,
  interfaceConfig,
  settle,
  settleMessages: messages,
  // restrict / protect : les trames d'une adresse non sécurisée sont rejetées sur le port plein
  admits(_state, device, port, mac) {
    const ps = iosState(device).interfaces[port.name]?.portSecurity
    if (!ps?.enabled || switchportOf(port).mode !== 'access') return true
    const secure = secureMacs(ps)
    return secure.includes(iosMac(mac)) || secure.length < ps.maximum
  }
})
