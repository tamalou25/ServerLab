/**
 * RIP IOS : router rip, version, network, auto-summary, passive-interface, default-information
 * originate, show ip rip database. Convergence calculée par ios/rip.ts.
 * Sources : RIP Command Reference
 * https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/iproute_rip/command/irr-cr-book/irr-cr-rip.html
 */
import type { Draft } from 'immer'
import type { RipProcess } from '../../model/schema'
import { IPV4, number } from '../cli/args'
import type { ArgContext, CliCommand, IosRunContext, SyntaxToken } from '../cli/types'
import { draftIosState, iosState } from '../config'
import { isIos, type IosDevice } from '../device'
import { defineIosFeature } from '../feature'
import { ifaceLongName, IOS_MODEL_INFO } from '../models'
import { byAddress, classfulNetwork, classfulPrefix, ripDatabase, ripRoutes, ripSummarizes } from '../rip'
import type { ConfigBlock } from '../running-config'
import { deviceOf, update } from './base'

const kw = (keyword: string, help: string): SyntaxToken => ({ keyword, help })

/** Routeur, ou switch de niveau 3 (9200). */
const routes = (ctx: ArgContext): boolean => {
  const d = ctx.state.devices[ctx.deviceId]
  return d?.kind === 'router' || (d?.kind === 'switch' && isIos(d) && IOS_MODEL_INFO[d.model].layer3)
}

/** Mode config-router du processus RIP. */
export const inRip = (ctx: ArgContext): boolean => ctx.session.router?.protocol === 'rip'

/** Modifie le processus RIP (créé par router rip). */
export function updateRip(ctx: IosRunContext, change: (rip: Draft<RipProcess>) => void): void {
  update(ctx, (d) => {
    const ios = draftIosState(d)
    ios.rip ??= { version: null, networks: [], autoSummary: true, passive: [], defaultOriginate: false }
    change(ios.rip)
  })
}

/** Secondes écoulées depuis la dernière mise à jour périodique (toutes les 30 s). */
export const ripAge = (clock: number): string =>
  `00:00:${String(Math.floor(clock / 1000) % 30).padStart(2, '0')}`

/**
 * show ip rip database : réseaux résumés (auto-summary), connectés, appris (sauts, voisin, âge,
 * interface). Exemple de la Command Reference (« 10.0.0.0/8    auto-summary »,
 * « 10.11.11.0/24    directly connected, Ethernet2 », « [1] via 172.19.67.38, 00:00:25, Serial0 »).
 */
function showRipDatabase(ctx: IosRunContext): void {
  const device = deviceOf(ctx)
  const router = ripDatabase(ctx.state).get(device.id)
  if (!router) return
  const name = (id?: string) => ifaceLongName(device.interfaces.find((i) => i.id === id)?.name ?? '')
  const entries = [...router.entries.values()].filter((e) => !e.originated).sort(byAddress)
  const summaries = new Set<string>()
  for (const e of entries) {
    const major = classfulNetwork(e.network)
    const prefix = classfulPrefix(e.network)
    if (ripSummarizes(router.config) && e.prefixLength > prefix && !summaries.has(major)) {
      summaries.add(major)
      ctx.print(`${major}/${prefix}    auto-summary`)
    }
    if (e.metric === 0) {
      ctx.print(
        `${e.network}/${e.prefixLength}    directly connected, ${name(e.ifaceId ?? router.ifaces.find((i) => i.network === e.network)?.iface.id)}`
      )
      continue
    }
    ctx.print(`${e.network}/${e.prefixLength}`)
    ctx.print(`    [${e.metric}] via ${e.gateway}, ${ripAge(ctx.state.clock)}, ${name(e.ifaceId)}`)
  }
}

/** Lignes « show ip protocols » du processus RIP. */
export function ripProtocolLines(ctx: IosRunContext, device: IosDevice): string[] {
  const router = ripDatabase(ctx.state).get(device.id)
  const config = iosState(device).rip
  if (!config) return []
  const v = config.version
  const due = 30 - (Math.floor(ctx.state.clock / 1000) % 30)
  const lines = [
    'Routing Protocol is "rip"',
    '  Outgoing update filter list for all interfaces is not set',
    '  Incoming update filter list for all interfaces is not set',
    `  Sending updates every 30 seconds, next due in ${due} seconds`,
    '  Invalid after 180 seconds, hold down 180, flushed after 240',
    '  Redistributing: rip',
    `  Default version control: send version ${v ?? 1}, receive ${v === null ? 'any version' : `version ${v}`}`,
    `  Automatic network summarization is ${ripSummarizes(config) ? 'in effect' : 'not in effect'}`,
    '  Maximum path: 4',
    '  Routing for Networks:',
    ...config.networks.map((n) => `    ${n}`)
  ]
  if (config.passive.length) {
    lines.push('  Passive Interface(s):')
    for (const p of config.passive) lines.push(`    ${ifaceLongName(p)}`)
  }
  lines.push('  Routing Information Sources:', '    Gateway         Distance      Last Update')
  for (const gw of [...(router?.sources.keys() ?? [])].sort())
    lines.push(`    ${gw.padEnd(15)}${'120'.padStart(9)}      ${ripAge(ctx.state.clock)}`)
  lines.push('  Distance: (default is 120)')
  return lines
}

const commands: CliCommand[] = [
  {
    modes: ['config'],
    syntax: [kw('router', 'Enable a routing process'), kw('rip', 'Routing Information Protocol (RIP)')],
    available: routes,
    run: (ctx) => {
      updateRip(ctx, () => undefined)
      ctx.setMode('config-router', { router: { protocol: 'rip', process: 0 } })
    },
    no: {
      run: (ctx) =>
        update(ctx, (d) => {
          draftIosState(d).rip = null
        })
    }
  },
  {
    modes: ['config-router'],
    syntax: [
      kw('version', 'Set routing protocol version'),
      { arg: 'version', type: number(1, 2), help: 'version' }
    ],
    available: inRip,
    run: (ctx, args) => updateRip(ctx, (rip) => (rip.version = Number(args.version) === 2 ? 2 : 1)),
    no: { min: 1, run: (ctx) => updateRip(ctx, (rip) => (rip.version = null)) }
  },
  {
    // network 10.1.1.0 : enregistré comme réseau de classe (10.0.0.0)
    modes: ['config-router'],
    syntax: [
      kw('network', 'Enable routing on an IP network'),
      { arg: 'network', type: IPV4, help: 'Network number' }
    ],
    available: inRip,
    run: (ctx, args) =>
      updateRip(ctx, (rip) => {
        const net = classfulNetwork(args.network ?? '0.0.0.0')
        if (!rip.networks.includes(net)) rip.networks.push(net)
      }),
    no: {
      run: (ctx, args) =>
        updateRip(ctx, (rip) => {
          const net = classfulNetwork(args.network ?? '0.0.0.0')
          rip.networks = rip.networks.filter((n) => n !== net)
        })
    }
  },
  {
    modes: ['config-router'],
    syntax: [kw('auto-summary', 'Enable automatic network number summarization')],
    available: inRip,
    run: (ctx) => updateRip(ctx, (rip) => (rip.autoSummary = true)),
    no: { run: (ctx) => updateRip(ctx, (rip) => (rip.autoSummary = false)) }
  },
  {
    modes: ['user', 'exec'],
    syntax: [
      kw('show', 'Show running system information'),
      kw('ip', 'IP information'),
      kw('rip', 'IP RIP show commands'),
      kw('database', 'IP RIP database')
    ],
    available: routes,
    run: showRipDatabase
  }
]

function config(device: IosDevice): ConfigBlock[] {
  const rip = iosState(device).rip
  if (!rip) return []
  const lines = ['router rip']
  if (rip.version !== null) lines.push(` version ${rip.version}`)
  for (const p of rip.passive) lines.push(` passive-interface ${ifaceLongName(p)}`)
  for (const n of rip.networks) lines.push(` network ${n}`)
  if (rip.defaultOriginate) lines.push(' default-information originate')
  if (!rip.autoSummary) lines.push(' no auto-summary')
  return [{ order: 111, lines }]
}

export const rip = defineIosFeature({ id: 'rip', commands, config, routes: ripRoutes })
