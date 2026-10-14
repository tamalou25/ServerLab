/**
 * Administration du système IOS : horloge (clock set, clock timezone, show clock), NTP, délai
 * d'inactivité des lignes (exec-timeout), terminal length, et commandes show d'information
 * (running-config d'une interface, description des interfaces, historique, utilisateurs,
 * protocoles, niveau de privilège, table des hôtes). Sorties reprises de la documentation Cisco
 * (sources en tête de chaque fonction et dans tests/engine/ios/system.test.ts).
 */
import { LAB_EPOCH_MS } from '../../core/clock'
import type { NetInterface } from '../../model/schema'
import { IPV4, WORD, iface, number } from '../cli/args'
import type { ArgType, CliCommand, IosRunContext, SyntaxToken } from '../cli/types'
import { draftIosState, iosState } from '../config'
import type { IosDevice } from '../device'
import { defineIosFeature } from '../feature'
import { ifaceLongName } from '../models'
import { interfaceSection, type ConfigBlock } from '../running-config'
import { ifaceStatus } from '../status'
import { unsimulatedIosMessage } from '../../shell/unsimulated'
import { deviceOf, update } from './base'
import { updateLine } from './security'

const kw = (keyword: string, help: string): SyntaxToken => ({ keyword, help })
const SHOW = kw('show', 'Show running system information')

const p2 = (n: number): string => String(n).padStart(2, '0')
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
]
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// ---------------------------------------------------------------------------
// Arguments propres
// ---------------------------------------------------------------------------

/** Heure hh:mm:ss de clock set. */
const TIME: ArgType = {
  label: 'hh:mm:ss',
  match: (tokens, index) => {
    const t = tokens[index]
    const m = t === undefined ? null : /^(\d{1,2}):(\d{1,2}):(\d{1,2})$/.exec(t)
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59 || Number(m[3]) > 59) return null
    return { consumed: 1, value: `${Number(m[1])}:${Number(m[2])}:${Number(m[3])}` }
  }
}

/** Mois en toutes lettres ou abrégé (january, jan). Valeur : 0 à 11. */
const MONTH: ArgType = {
  label: 'MONTH',
  match: (tokens, index) => {
    const t = tokens[index]?.toLowerCase()
    if (!t || t.length < 3) return null
    const found = MONTHS.findIndex((m) => m.toLowerCase().startsWith(t))
    return found < 0 ? null : { consumed: 1, value: String(found) }
  },
  complete: (partial) => MONTHS.filter((m) => m.toLowerCase().startsWith(partial.toLowerCase()))
}

/** Décalage horaire signé de clock timezone (<-23 - 23>). */
const HOURS_OFFSET: ArgType = {
  label: '<-23 - 23>',
  match: (tokens, index) => {
    const t = tokens[index]
    if (t === undefined || !/^-?\d+$/.test(t) || Math.abs(Number(t)) > 23) return null
    return { consumed: 1, value: String(Number(t)) }
  }
}

// ---------------------------------------------------------------------------
// Horloge
// ---------------------------------------------------------------------------

/** Heure affichée (UTC du lab + réglage clock set + fuseau), en millisecondes. */
function deviceTime(ctx: IosRunContext): { ms: number; zone: string; set: boolean } {
  const ios = iosState(deviceOf(ctx))
  const tz = ios.clockTimezone
  const shift = tz ? (tz.hours * 60 + Math.sign(tz.hours || 1) * tz.minutes) * 60000 : 0
  return {
    ms: LAB_EPOCH_MS + ctx.state.clock + (ios.clockOffset ?? 0) + shift,
    zone: tz?.zone ?? 'UTC',
    set: ios.clockOffset !== null
  }
}

/**
 * show clock [detail] : « *18:38:21.655 UTC Tue Jan 4 2011 », « * » tant que l'heure n'est pas
 * fiable (jamais réglée).
 * https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/bsm/configuration/15-mt/bsm-15-mt-book/bsm-time-calendar-set.html
 */
function showClock(ctx: IosRunContext, detail: boolean): void {
  const { ms, zone, set } = deviceTime(ctx)
  const d = new Date(ms)
  const time = `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}.${String(
    d.getUTCMilliseconds()
  ).padStart(3, '0')}`
  ctx.print(
    `${set ? '' : '*'}${time} ${zone} ${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]?.slice(0, 3)} ${d.getUTCDate()} ${d.getUTCFullYear()}`
  )
  if (detail) ctx.print(set ? 'Time source is user configuration' : 'Time source is hardware calendar')
}

/** clock set hh:mm:ss jour mois année : écart enregistré avec l'horloge du lab (heure locale saisie). */
function clockSet(ctx: IosRunContext, time: string, day: number, month: number, year: number): void {
  const [h, m, s] = time.split(':').map(Number)
  const tz = iosState(deviceOf(ctx)).clockTimezone
  const shift = tz ? (tz.hours * 60 + Math.sign(tz.hours || 1) * tz.minutes) * 60000 : 0
  const target = Date.UTC(year, month, day, h ?? 0, m ?? 0, s ?? 0) - shift
  const offset = target - (LAB_EPOCH_MS + ctx.state.clock)
  update(ctx, (d) => {
    draftIosState(d).clockOffset = offset
  })
}

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

/**
 * show running-config interface X : section de l'interface seule.
 * https://www.cisco.com/c/en/us/td/docs/ios/fundamentals/command/reference/cf_book/cf_s1.html
 */
function showRunningInterface(ctx: IosRunContext, name: string): void {
  const device = deviceOf(ctx)
  const i = device.interfaces.find((x) => x.name === name)
  if (!i) {
    ctx.print(`% ${unsimulatedIosMessage(`show running-config interface ${ifaceLongName(name)}`)}`)
    return
  }
  const body = ['!', ...interfaceSection(device, i, ctx.state), 'end']
  const bytes = body.reduce((n, l) => n + l.length + 1, 0)
  for (const line of ['Building configuration...', '', `Current configuration : ${bytes} bytes`, ...body])
    ctx.print(line)
}

const SHORT_STATUS: Record<string, string> = {
  up: 'up',
  down: 'down',
  'administratively down': 'admin down'
}

/**
 * show interfaces description : colonnes Interface / Status / Protocol / Description.
 * https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/interface/command/ir-cr-book/ir-s4.html
 */
function showInterfacesDescription(ctx: IosRunContext): void {
  const device = deviceOf(ctx)
  ctx.print(`${'Interface'.padEnd(10)}${'Status'.padEnd(15)}${'Protocol'.padEnd(9)}Description`)
  for (const i of device.interfaces) {
    const s = ifaceStatus(ctx.state, device, i)
    const description = iosState(device).interfaces[i.name]?.description ?? ''
    ctx.print(
      `${i.name.padEnd(10)}${(SHORT_STATUS[s.status] ?? s.status).padEnd(15)}${s.protocol.padEnd(9)}${description}`
    )
  }
}

/**
 * show users : ligne console active (« * »), aucun utilisateur ni hôte.
 * https://www.cisco.com/c/en/us/td/docs/ios/fundamentals/command/reference/cf_book/cf_s5.html
 */
function showUsers(ctx: IosRunContext): void {
  ctx.print('    Line       User       Host(s)              Idle       Location')
  ctx.print(`*${'0'.padStart(3)} ${'con 0'.padEnd(10)}${''.padEnd(11)}${'idle'.padEnd(21)}00:00:00 `)
}

/**
 * show protocols : routage IP global puis état et adresse de chaque interface.
 * https://www.cisco.com/c/en/us/td/docs/ios/fundamentals/command/reference/cf_book/cf_s4.html
 */
function showProtocols(ctx: IosRunContext): void {
  const device = deviceOf(ctx)
  const routing = device.kind === 'router' || iosState(device).ipRouting
  ctx.print('Global values:')
  ctx.print(`  Internet Protocol routing is ${routing ? 'enabled' : 'disabled'}`)
  for (const i of device.interfaces) printProtocolIface(ctx, device, i)
}

function printProtocolIface(ctx: IosRunContext, device: IosDevice, i: NetInterface): void {
  const s = ifaceStatus(ctx.state, device, i)
  ctx.print(`${ifaceLongName(i.name)} is ${s.status}, line protocol is ${s.protocol}`)
  if (i.address && i.prefixLength !== null) ctx.print(`  Internet address is ${i.address}/${i.prefixLength}`)
}

/**
 * show hosts : domaine, mode de résolution, serveurs de noms, légende et en-tête du cache (vide :
 * aucune entrée ip host simulée).
 * https://www.cisco.com/c/en/us/td/docs/ios/fundamentals/command/reference/cf_book/cf_s2.html
 */
function showHosts(ctx: IosRunContext): void {
  const ios = iosState(deviceOf(ctx))
  ctx.print(`Default domain is ${ios.domainName ?? 'not set'}`)
  ctx.print(`Name/address lookup uses ${ios.domainLookup ? 'domain service' : 'static mappings'}`)
  ctx.print('Name servers are 255.255.255.255')
  ctx.print('')
  ctx.print('Codes: UN - unknown, EX - expired, OK - OK, ?? - revalidate')
  ctx.print('       temp - temporary, perm - permanent')
  ctx.print('       NA - Not Applicable None - Not defined')
  ctx.print('')
  ctx.print('Host                      Port  Flags      Age Type   Address(es)')
}

// ---------------------------------------------------------------------------
// Commandes
// ---------------------------------------------------------------------------

const unsimulated =
  (name: string) =>
  (ctx: IosRunContext): void =>
    ctx.print(`% ${unsimulatedIosMessage(name)}`)

const CLOCK = kw('clock', 'Manage the system clock')

const commands: CliCommand[] = [
  // --- show ---
  {
    modes: ['exec'],
    syntax: [
      SHOW,
      kw('running-config', 'Current operating configuration'),
      kw('interface', 'Show interface configuration'),
      {
        arg: 'iface',
        type: iface({ subinterfaces: true, vlans: true, portChannels: true }),
        help: 'Interface'
      }
    ],
    run: (ctx, args) => showRunningInterface(ctx, args.iface ?? '')
  },
  {
    modes: ['user', 'exec'],
    syntax: [
      SHOW,
      kw('interfaces', 'Interface status and configuration'),
      kw('description', 'Show interface description')
    ],
    run: showInterfacesDescription
  },
  {
    modes: ['user', 'exec'],
    syntax: [SHOW, kw('clock', 'Display the system clock')],
    run: (ctx) => showClock(ctx, false)
  },
  {
    modes: ['user', 'exec'],
    syntax: [SHOW, kw('clock', 'Display the system clock'), kw('detail', 'Display detailed information')],
    run: (ctx) => showClock(ctx, true)
  },
  {
    modes: ['user', 'exec'],
    syntax: [SHOW, kw('history', 'Display the session command history')],
    run: (ctx) => (ctx.session.history ?? []).forEach((l) => ctx.print(`  ${l}`))
  },
  {
    modes: ['user', 'exec'],
    syntax: [SHOW, kw('users', 'Display information about terminal lines')],
    run: showUsers
  },
  {
    modes: ['user', 'exec'],
    syntax: [SHOW, kw('protocols', 'Active network routing protocols')],
    run: showProtocols
  },
  {
    modes: ['user', 'exec'],
    syntax: [SHOW, kw('privilege', 'Show current privilege level')],
    run: (ctx) => ctx.print(`Current privilege level is ${ctx.session.mode === 'exec' ? 15 : 1}`)
  },
  {
    modes: ['exec'],
    syntax: [SHOW, kw('hosts', 'IP domain-name, lookup style, nameservers, and host table')],
    run: showHosts
  },
  // Contenu de la mémoire flash et tableau des lignes : non simulés (tailles et compteurs réels inconnus)
  {
    modes: ['user', 'exec'],
    syntax: [SHOW, kw('flash:', 'display information about flash: file system')],
    run: unsimulated('show flash:')
  },
  {
    modes: ['user', 'exec'],
    syntax: [SHOW, kw('line', 'TTY line information')],
    run: unsimulated('show line')
  },

  // --- terminal et horloge (exec) ---
  {
    modes: ['user', 'exec'],
    syntax: [
      kw('terminal', 'Set terminal line parameters'),
      kw('length', 'Set number of lines on a screen'),
      { arg: 'lines', type: number(0, 512), help: 'Number of lines on screen (0 for no pausing)' }
    ],
    run: (ctx, args) => {
      ctx.session = { ...ctx.session, length: Number(args.lines) }
    }
  },
  ...[false, true].map((monthFirst): CliCommand => {
    const day = { arg: 'day', type: number(1, 31), help: 'Day of the month' }
    const month = { arg: 'month', type: MONTH, help: 'Month of the year' }
    return {
      modes: ['exec'],
      syntax: [
        CLOCK,
        kw('set', 'Set the time and date'),
        { arg: 'time', type: TIME, help: 'Current Time' },
        ...(monthFirst ? [month, day] : [day, month]),
        { arg: 'year', type: number(1993, 2035), help: 'Year' }
      ],
      run: (ctx, args) =>
        clockSet(ctx, args.time ?? '0:0:0', Number(args.day), Number(args.month), Number(args.year))
    }
  }),

  // --- configuration globale ---
  ...[false, true].map((withMinutes): CliCommand => ({
    modes: ['config'],
    syntax: [
      kw('clock', 'Configure time-of-day clock'),
      kw('timezone', 'Configure time zone'),
      { arg: 'zone', type: WORD, help: 'name of time zone' },
      { arg: 'hours', type: HOURS_OFFSET, help: 'Hours offset from UTC' },
      ...(withMinutes ? [{ arg: 'minutes', type: number(0, 59), help: 'Minutes offset from UTC' }] : [])
    ],
    run: (ctx, args) =>
      update(ctx, (d) => {
        draftIosState(d).clockTimezone = {
          zone: args.zone ?? 'UTC',
          hours: Number(args.hours),
          minutes: args.minutes === undefined ? 0 : Number(args.minutes)
        }
      }),
    no: {
      min: 2,
      run: (ctx) =>
        update(ctx, (d) => {
          draftIosState(d).clockTimezone = null
        })
    }
  })),
  {
    modes: ['config'],
    syntax: [
      kw('ntp', 'Configure NTP'),
      kw('server', 'Configure NTP server'),
      { arg: 'address', type: IPV4, help: 'IP address of peer' }
    ],
    run: (ctx, args) =>
      update(ctx, (d) => {
        const ios = draftIosState(d)
        const address = args.address ?? ''
        if (!ios.ntpServers.includes(address)) ios.ntpServers.push(address)
      }),
    no: {
      run: (ctx, args) =>
        update(ctx, (d) => {
          const ios = draftIosState(d)
          ios.ntpServers = ios.ntpServers.filter((a) => a !== args.address)
        })
    }
  },

  // --- lignes ---
  ...[false, true].map((withSeconds): CliCommand => ({
    modes: ['config-line'],
    syntax: [
      kw('exec-timeout', 'Set the EXEC timeout'),
      { arg: 'minutes', type: number(0, 35791), help: 'Timeout in minutes' },
      ...(withSeconds ? [{ arg: 'seconds', type: number(0, 2147483), help: 'Timeout in seconds' }] : [])
    ],
    run: (ctx, args) => {
      const minutes = Number(args.minutes)
      const seconds = args.seconds === undefined ? 0 : Number(args.seconds)
      // 10 0 : valeur d'usine, absente de la running-config
      updateLine(ctx, (l) => {
        l.execTimeout = minutes === 10 && seconds === 0 ? null : { minutes, seconds }
      })
    },
    no: { min: 1, run: (ctx) => updateLine(ctx, (l) => (l.execTimeout = null)) }
  }))
]

function config(device: IosDevice): ConfigBlock[] {
  const ios = iosState(device)
  const tz = ios.clockTimezone
  return [
    // Forme de l'exemple Cisco (« clock timezone PST -8 ») ; minutes seulement si non nulles
    {
      order: 25,
      lines: tz ? [`clock timezone ${tz.zone} ${tz.hours}${tz.minutes ? ` ${tz.minutes}` : ''}`] : []
    },
    { order: 170, lines: ios.ntpServers.map((a) => `ntp server ${a}`) }
  ]
}

export const system = defineIosFeature({ id: 'system', commands, config })
