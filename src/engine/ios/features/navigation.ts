/**
 * Navigation entre les modes IOS : enable, disable, configure terminal, interface, line, router,
 * exit, end. Textes d'aide repris d'IOS 15.
 */
import { WORD, iface, ifaceRange, number } from '../cli/args'
import type { CliCommand, IosMode, IosRunContext, SyntaxToken } from '../cli/types'
import { CONFIG_SUBMODES } from '../cli/types'
import { createSubinterface, createSvi, removeSubinterfaceByName } from '../actions'
import { defineIosFeature } from '../feature'
import { iosState } from '../config'
import { isIos } from '../device'
import { enterPortChannel, removePortChannel } from './etherchannel'
import { unsimulatedIosMessage } from '../../shell/unsimulated'

const kw = (keyword: string, help: string): SyntaxToken => ({ keyword, help })

const EXIT_HELP: Partial<Record<IosMode, string>> = {
  user: 'Exit from the EXEC',
  exec: 'Exit from the EXEC',
  config: 'Exit from configure mode',
  'config-if': 'Exit from interface configuration mode',
  'config-subif': 'Exit from subinterface configuration mode',
  'config-line': 'Exit from line configuration mode',
  'config-router': 'Exit from routing protocol configuration mode',
  'config-vlan': 'Apply changes, bump revision number, and exit mode',
  'dhcp-config': 'Exit from DHCP pool configuration mode',
  'config-std-nacl': 'Exit from access-list configuration mode',
  'config-ext-nacl': 'Exit from access-list configuration mode'
}

/** exit : remonte d'un niveau (sous-mode → configuration → privilégié → déconnexion). */
function exit(ctx: IosRunContext): void {
  const mode = ctx.session.mode
  if (mode === 'user' || mode === 'exec') ctx.logout()
  else if (mode === 'config') ctx.setMode('exec')
  else ctx.setMode('config')
}

/** Entrée en configuration d'interface (crée la sous-interface Gi0/0.10 si besoin). */
function enterInterface(ctx: IosRunContext, name: string): void {
  const device = ctx.state.devices[ctx.deviceId]
  if (!device) return
  if (name.startsWith('Po')) {
    enterPortChannel(ctx, name)
    return
  }
  let target = device.interfaces.find((i) => i.name === name)
  if (!target && name.includes('.')) {
    const parent = device.interfaces.find((i) => i.name === name.split('.')[0])
    if (!parent || !ctx.apply(createSubinterface(ctx.state, ctx.deviceId, parent.id, name))) return
    target = ctx.state.devices[ctx.deviceId]?.interfaces.find((i) => i.name === name)
  }
  if (!target && name.startsWith('Vl')) {
    // Interface VLAN (SVI) d'un switch
    if (!ctx.apply(createSvi(ctx.state, ctx.deviceId, Number(name.slice(2))))) return
    target = ctx.state.devices[ctx.deviceId]?.interfaces.find((i) => i.name === name)
  }
  if (!target) return
  ctx.setMode(target.subinterface ? 'config-subif' : 'config-if', { ifaces: [target.id] })
}

/**
 * interface range : mode config-if-range sur tous les ports de la plage ; chaque commande saisie
 * s'applique aussitôt à chacun (guide de configuration 2960, IOS 15.0(2)SE).
 */
function enterRange(ctx: IosRunContext, value: string): void {
  if (value.startsWith('unsimulated:')) {
    ctx.print(`% ${unsimulatedIosMessage(value.slice('unsimulated:'.length))}`)
    return
  }
  const names = value.slice('ok:'.length).split(',')
  const device = ctx.state.devices[ctx.deviceId]
  const ids = names
    .map((n) => device?.interfaces.find((i) => i.name === n)?.id)
    .filter((id) => id !== undefined)
  ctx.setMode('config-if-range', { ifaces: ids })
}

function enterConfig(ctx: IosRunContext): void {
  ctx.print('Enter configuration commands, one per line.  End with CNTL/Z.')
  ctx.setMode('config')
}

/** enable : mot de passe demandé si enable secret est configuré (3 essais). */
function enable(ctx: IosRunContext): void {
  const device = ctx.state.devices[ctx.deviceId]
  const secret = isIos(device) ? iosState(device).enableSecret : null
  if (ctx.session.mode === 'exec' || secret === null) {
    ctx.setMode('exec')
    return
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    if (ctx.ask('Password: ', true) === secret) {
      ctx.setMode('exec')
      return
    }
  }
  ctx.print('% Bad secrets')
  ctx.print('')
}

const CONFIG_MODES: readonly IosMode[] = ['config', ...CONFIG_SUBMODES]

const commands: CliCommand[] = [
  {
    modes: ['user', 'exec'],
    syntax: [kw('enable', 'Turn on privileged commands')],
    run: enable,
    doAllowed: false
  },
  {
    modes: ['exec'],
    syntax: [kw('disable', 'Turn off privileged commands')],
    run: (ctx) => ctx.setMode('user'),
    doAllowed: false
  },
  {
    modes: ['exec'],
    syntax: [kw('configure', 'Enter configuration mode'), kw('terminal', 'Configure from the terminal')],
    run: enterConfig,
    doAllowed: false
  },
  {
    // configure seul : IOS demande la source de la configuration (terminal par défaut)
    modes: ['exec'],
    syntax: [kw('configure', 'Enter configuration mode')],
    run: (ctx) => {
      const answer = ctx
        .ask('Configuring from terminal, memory, or network [terminal]? ')
        .trim()
        .toLowerCase()
      if (answer === '' || 'terminal'.startsWith(answer)) enterConfig(ctx)
    },
    doAllowed: false
  },
  ...(Object.entries(EXIT_HELP) as [IosMode, string][]).map(([mode, help]): CliCommand => ({
    modes: [mode],
    syntax: [kw('exit', help)],
    run: exit,
    doAllowed: false
  })),
  {
    modes: CONFIG_MODES,
    syntax: [kw('end', 'Exit from configure mode')],
    run: (ctx) => ctx.setMode('exec'),
    doAllowed: false
  },
  {
    modes: ['config'],
    syntax: [
      kw('interface', 'Select an interface to configure'),
      {
        arg: 'iface',
        type: iface({ subinterfaces: true, vlans: true, portChannels: true }),
        help: 'Interface'
      }
    ],
    run: (ctx, args) => enterInterface(ctx, args.iface ?? ''),
    // no interface Gi0/0.10 : supprime la sous-interface
    no: {
      run: (ctx, args) => {
        const name = args.iface ?? ''
        if (name.startsWith('Po')) {
          removePortChannel(ctx, name)
          return
        }
        if (name.startsWith('Vl')) {
          ctx.apply(removeSubinterfaceByName(ctx.state, ctx.deviceId, name))
          return
        }
        if (!name.includes('.')) {
          ctx.print('% Removal of physical interfaces is not permitted')
          return
        }
        ctx.apply(removeSubinterfaceByName(ctx.state, ctx.deviceId, name))
      }
    }
  },
  {
    modes: ['config'],
    syntax: [
      kw('interface', 'Select an interface to configure'),
      kw('range', 'interface range command'),
      { arg: 'range', type: ifaceRange(), help: 'Interface' }
    ],
    run: (ctx, args) => enterRange(ctx, args.range ?? '')
  },
  {
    // Macros (define interface-range) : non simulées
    modes: ['config'],
    syntax: [
      kw('interface', 'Select an interface to configure'),
      kw('range', 'interface range command'),
      kw('macro', 'macro keyword'),
      { arg: 'name', type: WORD, help: 'WORD' }
    ],
    run: (ctx) => ctx.print(`% ${unsimulatedIosMessage('interface range macro')}`)
  },
  {
    modes: ['config'],
    syntax: [
      kw('line', 'Configure a terminal line'),
      kw('console', 'Primary terminal line'),
      { arg: 'first', type: number(0, 0), help: 'First Line number' }
    ],
    run: (ctx) => ctx.setMode('config-line', { line: { type: 'console', first: 0, last: 0 } })
  },
  ...[false, true].map((range): CliCommand => ({
    modes: ['config'],
    syntax: [
      kw('line', 'Configure a terminal line'),
      kw('vty', 'Virtual terminal'),
      { arg: 'first', type: number(0, 15), help: 'First Line number' },
      ...(range ? [{ arg: 'last', type: number(1, 15), help: 'Last Line number' }] : [])
    ],
    run: (ctx, args) => {
      const first = Number(args.first)
      const last = args.last === undefined ? first : Number(args.last)
      if (last < first) {
        ctx.print('%Bad line range')
        return
      }
      ctx.setMode('config-line', { line: { type: 'vty', first, last } })
    }
  }))
]

export const navigation = defineIosFeature({ id: 'navigation', commands })
