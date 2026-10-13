/**
 * Listes d'accès IOS : standard et étendues, numérotées (access-list 1-99 / 100-199) et nommées
 * (ip access-list standard | extended), application aux interfaces (ip access-group in / out),
 * show access-lists avec compteurs. Le filtrage s'applique par le crochet de transit `filter` ;
 * chaque correspondance est comptée (effet durable de la trace).
 */
import type { IosAcl, IosAclEntry, NetInterface } from '../../model/schema'
import type {
  ArgType,
  ArgValue,
  CliCommand,
  CommandArgs,
  IosRunContext,
  IosMode,
  SyntaxToken
} from '../cli/types'
import { IPV4, WORD, number } from '../cli/args'
import { aclMatch, formatSpec } from '../acl'
import { draftIfaceEntry, draftIosState, iosState } from '../config'
import { isIos, type IosDevice } from '../device'
import { defineIosFeature } from '../feature'
import { ifaceLongName } from '../models'
import type { ConfigBlock } from '../running-config'
import { currentIfaces, update } from './base'

const kw = (keyword: string, help: string): SyntaxToken => ({ keyword, help })

/** Ports nommés (affichage et saisie) comme sur IOS. */
const PORT_NAMES: Record<string, number> = {
  'ftp-data': 20,
  ftp: 21,
  telnet: 23,
  smtp: 25,
  domain: 53,
  www: 80,
  pop3: 110
}
const portName = (port: number): string =>
  Object.entries(PORT_NAMES).find(([, p]) => p === port)?.[0] ?? String(port)

/** Port TCP / UDP : numéro ou nom (www, telnet…). */
const PORT: ArgType = {
  label: '<0-65535>',
  match: (tokens, index) => {
    const t = tokens[index]
    if (t === undefined) return null
    if (/^\d+$/.test(t) && Number(t) <= 65535) return { consumed: 1, value: t }
    const named = PORT_NAMES[t.toLowerCase()]
    return named !== undefined ? { consumed: 1, value: String(named) } : null
  },
  complete: (partial) => Object.keys(PORT_NAMES).filter((n) => n.startsWith(partial.toLowerCase()))
}

// ---------------------------------------------------------------------------
// Syntaxe des entrées
// ---------------------------------------------------------------------------

/** Désignation d'adresse : any, host A, ou A masque-générique. */
function addressForms(
  prefix: 'src' | 'dst'
): { syntax: SyntaxToken[]; read: (a: CommandArgs) => [string, string] }[] {
  const who = prefix === 'src' ? 'source' : 'destination'
  return [
    { syntax: [kw('any', `Any ${who} host`)], read: () => ['0.0.0.0', '255.255.255.255'] },
    {
      syntax: [
        kw('host', `A single ${who} host`),
        { arg: `${prefix}Host`, type: IPV4, help: `${who[0]?.toUpperCase()}${who.slice(1)} address` }
      ],
      read: (a) => [a[`${prefix}Host`] ?? '', '0.0.0.0']
    },
    {
      syntax: [
        { arg: prefix, type: IPV4, help: `${who[0]?.toUpperCase()}${who.slice(1)} address` },
        { arg: `${prefix}Wild`, type: IPV4, help: `${who[0]?.toUpperCase()}${who.slice(1)} wildcard bits` }
      ],
      read: (a) => [a[prefix] ?? '', a[`${prefix}Wild`] ?? '']
    }
  ]
}

type EntryDraft = Omit<IosAclEntry, 'seq'>

interface EntryForm {
  syntax: SyntaxToken[]
  build: (args: CommandArgs) => EntryDraft
}

const ANY: [string, string] = ['0.0.0.0', '255.255.255.255']

/**
 * Mot-clé final de journalisation : `log` (standard et étendue), `log-input` (étendue seulement).
 * Syntaxe : Security Configuration Guide: Access Control Lists, IOS 15M&T, « Creating an IP Access
 * List and Applying It to an Interface » (`deny … [log]`, `deny protocol … [log | log-input]`).
 */
const LOG_OPTIONS = {
  log: kw('log', 'Log matches against this entry'),
  'log-input': kw('log-input', 'Log matches against this entry, including input interface')
} as const

/** Formes d'une entrée après l'action (permit / deny), avec ou sans journalisation finale. */
function entryForms(type: 'standard' | 'extended'): EntryForm[] {
  const logs = type === 'standard' ? (['log'] as const) : (['log', 'log-input'] as const)
  return baseEntryForms(type).flatMap((form) => [
    form,
    ...logs.map((log): EntryForm => ({
      syntax: [...form.syntax, LOG_OPTIONS[log]],
      build: (a) => ({ ...form.build(a), log })
    }))
  ])
}

/** Formes d'une entrée sans journalisation. */
function baseEntryForms(type: 'standard' | 'extended'): EntryForm[] {
  if (type === 'standard') {
    const standard = (syntax: SyntaxToken[], read: (a: CommandArgs) => [string, string]): EntryForm => ({
      syntax,
      build: (a) => {
        const [s, w] = read(a)
        return {
          action: 'permit',
          protocol: 'ip',
          src: s,
          srcWildcard: w,
          dst: ANY[0],
          dstWildcard: ANY[1],
          dstPort: null,
          log: null
        }
      }
    })
    return [
      ...addressForms('src').map((src) => standard(src.syntax, src.read)),
      // Adresse seule : machine unique (masque générique 0.0.0.0 implicite)
      standard([{ arg: 'src', type: IPV4, help: 'Address to match' }], (a) => [a.src ?? '', '0.0.0.0'])
    ]
  }
  const forms: EntryForm[] = []
  const protocols = [
    ['ip', 'Any Internet Protocol'],
    ['icmp', 'Internet Control Message Protocol'],
    ['tcp', 'Transmission Control Protocol'],
    ['udp', 'User Datagram Protocol']
  ] as const
  for (const [protocol, help] of protocols)
    for (const src of addressForms('src'))
      for (const dst of addressForms('dst'))
        for (const withPort of protocol === 'tcp' || protocol === 'udp' ? [false, true] : [false])
          forms.push({
            syntax: [
              kw(protocol, help),
              ...src.syntax,
              ...dst.syntax,
              ...(withPort
                ? [
                    kw('eq', 'Match only packets on a given port number'),
                    { arg: 'port', type: PORT, help: 'Port number' }
                  ]
                : [])
            ],
            build: (a) => {
              const [s, sw] = src.read(a)
              const [d, dw] = dst.read(a)
              return {
                action: 'permit',
                protocol,
                src: s,
                srcWildcard: sw,
                dst: d,
                dstWildcard: dw,
                dstPort: withPort ? Number(a.port) : null,
                log: null
              }
            }
          })
  return forms
}

// ---------------------------------------------------------------------------
// Modifications
// ---------------------------------------------------------------------------

function addEntry(
  ctx: IosRunContext,
  name: string,
  type: 'standard' | 'extended',
  entry: EntryDraft,
  seq?: number
): void {
  update(ctx, (d) => {
    const ios = draftIosState(d)
    let acl = ios.acls.find((a) => a.name === name)
    if (!acl) {
      acl = { name, type, entries: [] }
      ios.acls.push(acl)
    }
    const next = seq ?? (acl.entries[acl.entries.length - 1]?.seq ?? 0) + 10
    acl.entries = acl.entries.filter((e) => e.seq !== next)
    acl.entries.push({ ...entry, seq: next })
    acl.entries.sort((a, b) => a.seq - b.seq)
  })
}

function removeEntry(ctx: IosRunContext, name: string, match: (e: IosAclEntry) => boolean): void {
  update(ctx, (d) => {
    const acl = draftIosState(d).acls.find((a) => a.name === name)
    if (acl) acl.entries = acl.entries.filter((e) => !match(e))
  })
}

const sameEntry = (a: EntryDraft, b: IosAclEntry): boolean =>
  a.action === b.action &&
  a.protocol === b.protocol &&
  a.src === b.src &&
  a.srcWildcard === b.srcWildcard &&
  a.dst === b.dst &&
  a.dstWildcard === b.dstWildcard &&
  a.dstPort === b.dstPort

/** Liste nommée courante (mode config-std-nacl / config-ext-nacl). */
const currentAcl = (ctx: IosRunContext): string => ctx.session.acl ?? ''

function setAccessGroup(ctx: IosRunContext, direction: 'in' | 'out', acl: string | null): void {
  const names = currentIfaces(ctx).map((i) => i.name)
  update(ctx, (d) => {
    const ios = draftIosState(d)
    for (const name of names) {
      const entry = draftIfaceEntry(ios, name)
      if (direction === 'in') entry.aclIn = acl
      else entry.aclOut = acl
    }
  })
}

// ---------------------------------------------------------------------------
// Affichage
// ---------------------------------------------------------------------------

/** Entrée telle que dans la running-config (standard : « host » omis). */
function entryText(acl: IosAcl, e: IosAclEntry, forShow: boolean): string {
  // Mot-clé de journalisation en fin d'entrée (« 70 permit ip host 10.3.3.3 any log »)
  const log = e.log ? ` ${e.log}` : ''
  if (acl.type === 'standard') {
    const src =
      e.srcWildcard === '255.255.255.255'
        ? 'any'
        : e.srcWildcard === '0.0.0.0'
          ? e.src
          : forShow
            ? `${e.src}, wildcard bits ${e.srcWildcard}`
            : `${e.src} ${e.srcWildcard}`
    return `${e.action} ${src}${log}`
  }
  const port = e.dstPort !== null ? ` eq ${portName(e.dstPort)}` : ''
  return `${e.action} ${e.protocol} ${formatSpec(e.src, e.srcWildcard)} ${formatSpec(e.dst, e.dstWildcard)}${port}${log}`
}

function showAccessLists(ctx: IosRunContext, only?: string): void {
  const device = ctx.state.devices[ctx.deviceId]
  if (!isIos(device)) return
  const ios = iosState(device)
  for (const acl of ios.acls.filter((a) => only === undefined || a.name === only)) {
    ctx.print(`${acl.type === 'standard' ? 'Standard' : 'Extended'} IP access list ${acl.name}`)
    for (const e of acl.entries) {
      const n = ios.aclCounters[`${acl.name}|${e.seq}`] ?? 0
      ctx.print(`    ${e.seq} ${entryText(acl, e, true)}${n > 0 ? ` (${n} match${n > 1 ? 'es' : ''})` : ''}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Commandes
// ---------------------------------------------------------------------------

const ACTIONS = [
  ['permit', 'Specify packets to forward'],
  ['deny', 'Specify packets to reject']
] as const

function numberedCommands(type: 'standard' | 'extended'): CliCommand[] {
  const range = type === 'standard' ? number(1, 99) : number(100, 199)
  const help = type === 'standard' ? 'IP standard access list' : 'IP extended access list'
  return ACTIONS.flatMap(([action, actionHelp]) =>
    entryForms(type).map((form): CliCommand => ({
      modes: ['config'],
      syntax: [
        kw('access-list', 'Add an access list entry'),
        { arg: 'acl', type: range, help },
        kw(action, actionHelp),
        ...form.syntax
      ],
      run: (ctx, args) => addEntry(ctx, args.acl ?? '', type, { ...form.build(args), action })
    }))
  )
}

function namedEntryCommands(type: 'standard' | 'extended'): CliCommand[] {
  const mode: IosMode = type === 'standard' ? 'config-std-nacl' : 'config-ext-nacl'
  return ACTIONS.flatMap(([action, actionHelp]) =>
    entryForms(type).flatMap((form): CliCommand[] =>
      [false, true].map((withSeq) => ({
        modes: [mode],
        syntax: [
          ...(withSeq ? [{ arg: 'seq', type: number(1, 2147483647), help: 'Sequence Number' }] : []),
          kw(action, actionHelp),
          ...form.syntax
        ],
        run: (ctx, args) =>
          addEntry(
            ctx,
            currentAcl(ctx),
            type,
            { ...form.build(args), action },
            args.seq !== undefined ? Number(args.seq) : undefined
          ),
        ...(withSeq
          ? {}
          : {
              no: {
                run: (ctx: IosRunContext, args: Readonly<Record<string, ArgValue>>) => {
                  const wanted = { ...form.build(args), action }
                  removeEntry(ctx, currentAcl(ctx), (e) => sameEntry(wanted, e))
                }
              }
            })
      }))
    )
  )
}

const commands: CliCommand[] = [
  ...numberedCommands('standard'),
  ...numberedCommands('extended'),
  {
    modes: ['config'],
    syntax: [
      kw('access-list', 'Add an access list entry'),
      { arg: 'acl', type: number(1, 199), help: 'Access list number' }
    ],
    no: {
      run: (ctx, args) =>
        update(ctx, (d) => {
          const ios = draftIosState(d)
          ios.acls = ios.acls.filter((a) => a.name !== args.acl)
        })
    }
  },
  ...(['standard', 'extended'] as const).map((type): CliCommand => ({
    modes: ['config'],
    syntax: [
      kw('ip', 'Global IP configuration subcommands'),
      kw('access-list', 'Named access-list'),
      kw(type, type === 'standard' ? 'Standard Access List' : 'Extended Access List'),
      { arg: 'name', type: WORD, help: 'Access-list name' }
    ],
    run: (ctx, args) => {
      const name = args.name ?? ''
      const ok = update(ctx, (d) => {
        const ios = draftIosState(d)
        if (!ios.acls.some((a) => a.name === name)) ios.acls.push({ name, type, entries: [] })
      })
      if (ok) ctx.setMode(type === 'standard' ? 'config-std-nacl' : 'config-ext-nacl', { acl: name })
    },
    no: {
      run: (ctx, args) =>
        update(ctx, (d) => {
          const ios = draftIosState(d)
          ios.acls = ios.acls.filter((a) => a.name !== args.name)
        })
    }
  })),
  ...namedEntryCommands('standard'),
  ...namedEntryCommands('extended'),
  ...(['config-std-nacl', 'config-ext-nacl'] as const).map((mode): CliCommand => ({
    modes: [mode],
    syntax: [{ arg: 'seq', type: number(1, 2147483647), help: 'Sequence Number' }],
    no: { run: (ctx, args) => removeEntry(ctx, currentAcl(ctx), (e) => e.seq === Number(args.seq)) }
  })),
  ...(['in', 'out'] as const).map((direction): CliCommand => ({
    modes: ['config-if', 'config-subif'],
    syntax: [
      kw('ip', 'Interface Internet Protocol config commands'),
      kw('access-group', 'Specify access control for packets'),
      { arg: 'acl', type: WORD, help: 'Access-list name or number' },
      kw(direction, direction === 'in' ? 'inbound packets' : 'outbound packets')
    ],
    available: (ctx) => currentIfaces(ctx).every((i) => i.l3),
    run: (ctx, args) => setAccessGroup(ctx, direction, args.acl ?? null),
    no: { run: (ctx) => setAccessGroup(ctx, direction, null) }
  })),
  {
    modes: ['user', 'exec'],
    syntax: [kw('show', 'Show running system information'), kw('access-lists', 'List access lists')],
    run: (ctx) => showAccessLists(ctx)
  },
  {
    modes: ['user', 'exec'],
    syntax: [
      kw('show', 'Show running system information'),
      kw('access-lists', 'List access lists'),
      { arg: 'acl', type: WORD, help: 'ACL name or number' }
    ],
    run: (ctx, args) => showAccessLists(ctx, args.acl)
  }
]

function config(device: IosDevice): ConfigBlock[] {
  const acls = iosState(device).acls
  const lines: string[] = []
  for (const acl of acls.filter((a) => /^\d+$/.test(a.name)))
    for (const e of acl.entries) lines.push(`access-list ${acl.name} ${entryText(acl, e, false)}`)
  for (const acl of acls.filter((a) => !/^\d+$/.test(a.name))) {
    lines.push(`ip access-list ${acl.type} ${acl.name}`)
    for (const e of acl.entries) lines.push(` ${entryText(acl, e, false)}`)
  }
  return lines.length ? [{ order: 125, lines }] : []
}

function interfaceConfig(device: IosDevice, i: NetInterface): ConfigBlock[] {
  const entry = iosState(device).interfaces[i.name]
  const lines: string[] = []
  if (entry?.aclIn) lines.push(`ip access-group ${entry.aclIn} in`)
  if (entry?.aclOut) lines.push(`ip access-group ${entry.aclOut} out`)
  return lines.length ? [{ order: 42, lines }] : []
}

export const acl = defineIosFeature({
  id: 'acl',
  commands,
  config,
  interfaceConfig,
  transit: {
    filter(ctx, device, ingressIfaceId, egressIfaceId, packet) {
      if (!isIos(device)) return null
      const ios = iosState(device)
      const iface = device.interfaces.find((i) => i.id === (ingressIfaceId ?? egressIfaceId))
      const name = iface
        ? ingressIfaceId
          ? ios.interfaces[iface.name]?.aclIn
          : ios.interfaces[iface.name]?.aclOut
        : null
      const list = name ? ios.acls.find((a) => a.name === name) : undefined
      // Liste inexistante : tout passe, comme sur IOS
      if (!iface || !list) return null
      const entry = aclMatch(list, packet)
      if (entry)
        ctx.effects.push({ kind: 'acl', deviceId: device.id, data: { acl: list.name, seq: entry.seq } })
      if (entry?.action === 'permit') return null
      const where = `${ingressIfaceId ? 'à l’entrée' : 'à la sortie'} de ${ifaceLongName(iface.name)}`
      return entry
        ? `${device.name} refuse le paquet ${where} : liste d’accès ${list.name}, entrée ${entry.seq} « ${entryText(list, entry, false)} ».`
        : `${device.name} refuse le paquet ${where} : liste d’accès ${list.name}, refus implicite final (deny any).`
    }
  },
  onEffect(device, effect) {
    if (effect.kind !== 'acl') return
    const counters = draftIosState(device).aclCounters
    const key = `${effect.data.acl}|${effect.data.seq}`
    counters[key] = (counters[key] ?? 0) + 1
  }
})
