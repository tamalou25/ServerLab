/**
 * Bind9 simulé (v2.9, #240) : lecture de named.conf (et de ses inclusions), contrôle de configuration
 * (`named-checkconf`), chargement et contrôle des fichiers de zone (`named-checkzone`), puis réponses
 * du serveur aux requêtes DNS (zones faisant autorité, redirecteurs, récursion, `allow-query`,
 * `allow-recursion`). Module de services sans dépendance à la console ni au réseau : la résolution
 * réelle (acheminement des paquets) est faite par roles/dns/resolver.ts qui appelle `bindReply`.
 *
 * Formats et messages : paquet Debian bind9 1:9.18 — named.conf(5), named-checkconf(1),
 * named-checkzone(1), sources lib/isccfg (parser, check) et lib/dns (master, zone). Tout ce qui n'est pas
 * relu sur une installation réelle est listé dans docs/fidelite.md, « À vérifier (v2.9 — Linux) »
 * (L-90 à L-99).
 */
import type { HostDevice } from '../model/schema'
import { effectiveIpv4 } from '../net/addressing'
import { inNetwork, isIpv4 } from '../net/ipv4'
import { OPTIONS_KNOWN, TOP_LEVEL_KNOWN, ZONE_OPTIONS_KNOWN } from './linuxbinddata'
import { findPackage, type LinuxRelease } from './linuxcatalog'
import { NAMED_CONF, runningConfigText, unbundle } from './linuxconfig'
import { linuxRelease } from './linuxpackages'

export { NAMED_CONF }

/** Version de BIND telle qu'affichée : « 9.18.49-1~deb12u2-Debian ». */
export function bindVersion(release: LinuxRelease): string {
  const full = findPackage('bind9')?.versions[release] ?? ''
  return `${full.replace(/^\d+:/, '')}-${release === 'debian12' ? 'Debian' : 'Ubuntu'}`
}
export const hostBindVersion = (host: HostDevice) => bindVersion(linuxRelease(host))

// ---------------------------------------------------------------------------------------------
// Lecture de named.conf
// ---------------------------------------------------------------------------------------------

interface Tok {
  kind: 'word' | 'str' | 'sym'
  v: string
  file: string
  line: number
}

export interface Stmt {
  key: string
  args: string[]
  block?: Stmt[]
  file: string
  line: number
}

class ConfError extends Error {
  constructor(
    message: string,
    /** Résultat affiché par named au chargement (« loading configuration: … »). */
    readonly result: 'failure' | 'unexpected token' | 'file not found'
  ) {
    super(message)
  }
}

function tokenize(text: string, file: string): Tok[] {
  const out: Tok[] = []
  let line = 1
  let i = 0
  const n = text.length
  while (i < n) {
    const c = text[i] as string
    if (c === '\n') {
      line++
      i++
    } else if (/\s/.test(c)) i++
    else if (c === '#' || (c === '/' && text[i + 1] === '/')) {
      while (i < n && text[i] !== '\n') i++
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      if (end < 0) throw new ConfError(`${file}:${line}: unexpected end of input`, 'unexpected token')
      line += (text.slice(i, end).match(/\n/g) ?? []).length
      i = end + 2
    } else if (c === '{' || c === '}' || c === ';') {
      out.push({ kind: 'sym', v: c, file, line })
      i++
    } else if (c === '"') {
      let j = i + 1
      let v = ''
      while (j < n && text[j] !== '"') {
        if (text[j] === '\n') throw new ConfError(`${file}:${line}: unbalanced quotes`, 'unexpected token')
        if (text[j] === '\\' && j + 1 < n) j++
        v += text[j]
        j++
      }
      if (j >= n) throw new ConfError(`${file}:${line}: unexpected end of input`, 'unexpected token')
      out.push({ kind: 'str', v, file, line })
      i = j + 1
    } else {
      let j = i
      while (j < n && !/[\s{};"]/.test(text[j] as string)) {
        if (text[j] === '/' && (text[j + 1] === '/' || text[j + 1] === '*')) break
        j++
      }
      out.push({ kind: 'word', v: text.slice(i, j), file, line })
      i = j
    }
  }
  return out
}

/** Options à un seul argument : une fois lu, seul « ; » est accepté (sinon « missing ';' before … »). */
const SINGLE_ARG = new Set([
  'directory',
  'type',
  'file',
  'recursion',
  'dnssec-validation',
  'auth-nxdomain',
  'notify',
  'forward',
  'version',
  'hostname',
  'pid-file',
  'allow-new-zones',
  'empty-zones-enable',
  'minimal-responses',
  'querylog'
])

export interface ParsedConf {
  stmts: Stmt[]
  /** Erreur de syntaxe (la lecture s'arrête à la première) ; null si le fichier est lisible. */
  error: ConfError | null
}

/** Lit un fichier de configuration et ses `include`. `read` renvoie null si le fichier n'existe pas. */
export function parseConf(read: (path: string) => string | null, path: string): ParsedConf {
  const seen: string[] = []
  const parseFile = (file: string, from: { file: string; line: number } | null): Stmt[] => {
    const text = read(file)
    if (text === null)
      throw new ConfError(
        from
          ? `${from.file}:${from.line}: open: ${file}: file not found`
          : `none:0: open: ${file}: file not found`,
        'file not found'
      )
    if (seen.length > 16) throw new ConfError(`${file}: include loop`, 'failure')
    seen.push(file)
    const toks = tokenize(text, file)
    let pos = 0
    const unexpected = (t: Tok | undefined, expected: string): never => {
      if (!t)
        throw new ConfError(
          `${file}:${toks[toks.length - 1]?.line ?? 1}: unexpected end of input`,
          'unexpected token'
        )
      throw new ConfError(`${t.file}:${t.line}: ${expected}`, 'unexpected token')
    }
    const parseStmts = (nested: boolean, scope: 'top' | 'options' | 'zone' | 'other'): Stmt[] => {
      const out: Stmt[] = []
      for (;;) {
        const t = toks[pos]
        if (!t) {
          if (nested) return unexpected(undefined, '')
          return out
        }
        if (t.v === '}' && t.kind === 'sym') {
          if (nested) return out
          return unexpected(t, `unexpected token near '}'`)
        }
        if (t.kind === 'sym' && t.v === ';') {
          pos++
          continue
        }
        if (t.kind === 'sym') return unexpected(t, `unexpected token near '${t.v}'`)
        pos++
        const stmt: Stmt = { key: t.v, args: [], file: t.file, line: t.line }
        if (scope === 'top' && !TOP_LEVEL_KNOWN.has(t.v))
          throw new ConfError(`${t.file}:${t.line}: unknown option '${t.v}'`, 'failure')
        if (scope === 'options' && !OPTIONS_KNOWN.has(t.v))
          throw new ConfError(`${t.file}:${t.line}: unknown option '${t.v}'`, 'failure')
        if (scope === 'zone' && !ZONE_OPTIONS_KNOWN.has(t.v))
          throw new ConfError(`${t.file}:${t.line}: unknown option '${t.v}'`, 'failure')
        for (;;) {
          const a = toks[pos]
          if (!a) return unexpected(undefined, '')
          if (a.kind === 'sym' && a.v === ';') {
            pos++
            break
          }
          if (a.kind === 'sym' && a.v === '}')
            throw new ConfError(`${a.file}:${a.line}: missing ';' before '}'`, 'unexpected token')
          if (a.kind === 'sym' && a.v === '{') {
            pos++
            const inner = t.v === 'options' ? 'options' : t.v === 'zone' ? 'zone' : 'other'
            stmt.block = parseStmts(true, scope === 'top' ? inner : 'other')
            const close = toks[pos]
            if (!close) return unexpected(undefined, '')
            pos++ // '}'
            const after = toks[pos]
            if (!after) return unexpected(undefined, '')
            if (after.kind === 'sym' && after.v === ';') {
              pos++
              break
            }
            throw new ConfError(
              `${after.file}:${after.line}: missing ';' before '${after.v}'`,
              'unexpected token'
            )
          }
          stmt.args.push(a.v)
          pos++
          if (SINGLE_ARG.has(stmt.key) && stmt.args.length === 1) {
            const next = toks[pos]
            if (!next) return unexpected(undefined, '')
            if (!(next.kind === 'sym' && next.v === ';'))
              throw new ConfError(
                `${next.file}:${next.line}: missing ';' before '${next.v}'`,
                'unexpected token'
              )
          }
        }
        if (stmt.key === 'include' && scope === 'top') {
          const target = stmt.args[0] ?? ''
          out.push(...parseFile(target, { file: stmt.file, line: stmt.line }))
        } else out.push(stmt)
      }
    }
    return parseStmts(false, 'top')
  }
  try {
    return { stmts: parseFile(path, null), error: null }
  } catch (e) {
    if (e instanceof ConfError) return { stmts: [], error: e }
    throw e
  }
}

// ---------------------------------------------------------------------------------------------
// Modèle de configuration
// ---------------------------------------------------------------------------------------------

export interface BindZone {
  /** Nom en minuscules, sans point final (« . » pour la racine). */
  name: string
  type: string
  file: string | null
  forwarders: string[]
  forwardOnly: boolean | null
  allowQuery: string[] | null
  src: { file: string; line: number }
}

export interface BindModel {
  directory: string
  forwarders: string[]
  forwardOnly: boolean
  recursion: boolean
  allowQuery: string[] | null
  allowRecursion: string[] | null
  /** Adresses d'écoute IPv4 (listen-on) ; null = toutes. */
  listenOn: string[] | null
  acls: Record<string, string[]>
  zones: BindZone[]
}

const listOf = (block: Stmt[] | undefined): string[] =>
  (block ?? []).map((s) => [s.key, ...s.args].join(' ').trim()).filter((s) => s !== '')

const yes = (v: string | undefined, dflt: boolean) =>
  v === undefined ? dflt : /^(yes|true|1)$/i.test(v) ? true : /^(no|false|0)$/i.test(v) ? false : dflt

const zoneKey = (name: string) => {
  const n = name.toLowerCase().replace(/\.$/, '')
  return n === '' ? '.' : n
}

export const ZONE_TYPES = [
  'primary',
  'master',
  'secondary',
  'slave',
  'mirror',
  'stub',
  'static-stub',
  'forward',
  'hint',
  'redirect',
  'in-view'
]

/** Modèle et erreurs de contrôle (named-checkconf) d'une configuration lue. */
export function buildModel(stmts: Stmt[]): { model: BindModel; errors: string[] } {
  const errors: string[] = []
  const model: BindModel = {
    directory: '/var/cache/bind',
    forwarders: [],
    forwardOnly: false,
    recursion: true,
    allowQuery: null,
    allowRecursion: null,
    listenOn: null,
    acls: {},
    zones: []
  }
  const firstArg = (s: Stmt, key: string) => s.block?.find((x) => x.key === key)?.args[0]
  for (const s of stmts) {
    if (s.key === 'options' && s.block) {
      for (const o of s.block) {
        if (o.key === 'directory' && o.args[0]) model.directory = o.args[0]
        else if (o.key === 'forwarders') model.forwarders = listOf(o.block)
        else if (o.key === 'forward') model.forwardOnly = o.args[0] === 'only'
        else if (o.key === 'recursion') model.recursion = yes(o.args[0], true)
        else if (o.key === 'allow-query') model.allowQuery = listOf(o.block)
        else if (o.key === 'allow-recursion') model.allowRecursion = listOf(o.block)
        else if (o.key === 'listen-on') model.listenOn = listOf(o.block)
      }
    } else if (s.key === 'acl' && s.args[0]) model.acls[s.args[0].toLowerCase()] = listOf(s.block)
    else if (s.key === 'zone') {
      const name = zoneKey(s.args[0] ?? '')
      const type = firstArg(s, 'type')
      const fileName = firstArg(s, 'file') ?? null
      if (type === undefined) {
        errors.push(`${s.file}:${s.line}: zone '${name}': type not present`)
        continue
      }
      if (!ZONE_TYPES.includes(type)) {
        errors.push(`${s.file}:${s.line}: unexpected token near '${type}'`)
        continue
      }
      const previous = model.zones.find((z) => z.name === name)
      if (previous) {
        errors.push(
          `${s.file}:${s.line}: zone '${name}': already exists previous definition: ${previous.src.file}:${previous.src.line}`
        )
        continue
      }
      if ((type === 'primary' || type === 'master') && fileName === null) {
        errors.push(`${s.file}:${s.line}: zone '${name}': missing 'file' entry`)
        continue
      }
      const fwd = s.block?.find((x) => x.key === 'forward')?.args[0]
      model.zones.push({
        name,
        type: type === 'master' ? 'primary' : type === 'slave' ? 'secondary' : type,
        file: fileName,
        forwarders: listOf(s.block?.find((x) => x.key === 'forwarders')?.block),
        forwardOnly: fwd === undefined ? null : fwd === 'only',
        allowQuery: s.block?.some((x) => x.key === 'allow-query')
          ? listOf(s.block?.find((x) => x.key === 'allow-query')?.block)
          : null,
        src: { file: s.file, line: s.line }
      })
    }
  }
  return { model, errors }
}

export interface ConfCheck {
  model: BindModel
  /** Lignes écrites sur l'erreur standard par named-checkconf. */
  messages: string[]
  ok: boolean
  /** Résultat affiché par named au démarrage (« loading configuration: … »). */
  result: string
}

/** named-checkconf : lecture, syntaxe puis contrôle sémantique. */
export function checkConf(read: (path: string) => string | null, path = NAMED_CONF): ConfCheck {
  const parsed = parseConf(read, path)
  if (parsed.error)
    return {
      model: buildModel([]).model,
      messages: [parsed.error.message],
      ok: false,
      result: parsed.error.result
    }
  const { model, errors } = buildModel(parsed.stmts)
  return { model, messages: errors, ok: errors.length === 0, result: 'failure' }
}

// ---------------------------------------------------------------------------------------------
// Fichiers de zone (lib/dns/master.c, lib/dns/zone.c)
// ---------------------------------------------------------------------------------------------

export interface ZoneRecord {
  /** Nom absolu en minuscules, sans point final. */
  name: string
  ttl: number
  type: string
  rdata: string[]
  line: number
}

export interface ZoneLoad {
  ok: boolean
  records: ZoneRecord[]
  serial: number | null
  /** Lignes de named-checkzone (erreurs, avertissements, puis « loaded serial » ou « not loaded »). */
  messages: string[]
}

const TTL_RE = /^(\d+)([smhdw]?)$/i
const TTL_UNITS: Record<string, number> = { '': 1, s: 1, m: 60, h: 3600, d: 86400, w: 604800 }
const ttlOf = (tok: string): number | null => {
  const m = TTL_RE.exec(tok)
  return m ? Number(m[1]) * (TTL_UNITS[(m[2] ?? '').toLowerCase()] as number) : null
}
const RR_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'PTR', 'SOA', 'SRV', 'TXT']
const IPV6_RE = /^[0-9a-f:.]+$/i

/** Entrées logiques d'un fichier de zone : parenthèses jointes, commentaires « ; » retirés. */
function zoneEntries(text: string): { tokens: string[]; blank: boolean; line: number }[] {
  const out: { tokens: string[]; blank: boolean; line: number }[] = []
  let depth = 0
  let cur: { tokens: string[]; blank: boolean; line: number } | null = null
  text.split('\n').forEach((raw, idx) => {
    const tokens: string[] = []
    let i = 0
    while (i < raw.length) {
      const c = raw[i] as string
      if (c === ';') break
      if (/\s/.test(c)) i++
      else if (c === '(') {
        depth++
        i++
      } else if (c === ')') {
        depth = Math.max(0, depth - 1)
        i++
      } else if (c === '"') {
        let j = i + 1
        while (j < raw.length && raw[j] !== '"') j += raw[j] === '\\' ? 2 : 1
        tokens.push(raw.slice(i, j + 1))
        i = j + 1
      } else {
        let j = i
        while (j < raw.length && !/[\s;()"]/.test(raw[j] as string)) j++
        tokens.push(raw.slice(i, j))
        i = j
      }
    }
    if (!cur) {
      if (tokens.length === 0) return
      cur = { tokens, blank: /^\s/.test(raw), line: idx + 1 }
    } else cur.tokens.push(...tokens)
    if (depth === 0) {
      out.push(cur)
      cur = null
    }
  })
  if (cur) out.push(cur)
  return out
}

/**
 * Charge un fichier de zone (`named-checkzone`). `shown` : chemin tel qu'il est affiché dans les messages.
 * `integrity` : contrôles d'intégrité NS/MX (activés par défaut par named-checkzone).
 */
export function loadZone(text: string | null, zone: string, shown: string, integrity = true): ZoneLoad {
  const tag = `zone ${zone === '.' ? '.' : zone}/IN`
  const fail = (messages: string[], reason: string): ZoneLoad => ({
    ok: false,
    records: [],
    serial: null,
    messages: [
      ...messages,
      `${tag}: loading from master file ${shown} failed: ${reason}`,
      `${tag}: not loaded due to errors.`
    ]
  })
  if (text === null) return fail([], 'file not found')
  const apex = zone === '.' ? '' : zone
  let origin = apex
  const absolute = (tok: string): string => {
    if (tok === '@') return origin
    if (tok.endsWith('.')) return tok.slice(0, -1).toLowerCase()
    return (origin === '' ? tok : `${tok}.${origin}`).toLowerCase()
  }
  let defaultTtl: number | null = null
  let lastTtl: number | null = null
  let owner: string | null = null
  const records: ZoneRecord[] = []
  const warnings: string[] = []
  for (const entry of zoneEntries(text)) {
    const toks = [...entry.tokens]
    const where = `${shown}:${entry.line}`
    if (toks[0]?.startsWith('$')) {
      const d = (toks[0] as string).toUpperCase()
      if (d === '$TTL') {
        const v = ttlOf(toks[1] ?? '')
        if (v === null)
          return fail(
            [`dns_master_load: ${where}: $TTL ${toks[1] ? 'bad ttl' : 'unexpected end of line'}`],
            'bad ttl'
          )
        defaultTtl = v
      } else if (d === '$ORIGIN') {
        const o = toks[1]
        if (!o) return fail([`dns_master_load: ${where}: unexpected end of line`], 'unexpected end of line')
        origin = o === '@' ? origin : (absolute(o) ?? origin)
      } else
        return fail([`dns_master_load: ${where}: unknown $ directive '${toks[0]}'`], 'unknown $ directive')
      continue
    }
    if (!entry.blank) {
      const name = absolute(toks.shift() as string)
      owner = name
    } else if (owner === null)
      return fail([`dns_master_load: ${where}: no current owner name`], 'no current owner name')
    // TTL et classe, dans n'importe quel ordre
    let ttl: number | null = null
    for (let k = 0; k < 2; k++) {
      const t = toks[0]
      if (t === undefined) break
      if (t.toUpperCase() === 'IN') toks.shift()
      else if (ttl === null && ttlOf(t) !== null && !RR_TYPES.includes(t.toUpperCase()))
        ttl = ttlOf(toks.shift() as string)
    }
    const typeTok = toks.shift()
    if (!typeTok) return fail([`dns_master_load: ${where}: unexpected end of line`], 'unexpected end of line')
    const type = typeTok.toUpperCase()
    if (!RR_TYPES.includes(type))
      return fail([`dns_master_load: ${where}: unknown RR type '${typeTok}'`], 'unknown class/type')
    const bad = (near: string | undefined, why: string): ZoneLoad =>
      fail([`dns_rdata_fromtext: ${where}: ${near === undefined ? '' : `near '${near}': `}${why}`], why)
    const need = (n: number, rest: string[]): ZoneLoad | null => {
      if (rest.length < n) return bad(undefined, 'unexpected end of line')
      if (rest.length > n && type !== 'TXT') return bad(rest[n], 'extra input text')
      return null
    }
    let rdata: string[] = toks
    const problem = (() => {
      switch (type) {
        case 'A':
          if (
            toks.length >= 1 &&
            !(isIpv4(toks[0] as string) && /^\d+\.\d+\.\d+\.\d+$/.test(toks[0] as string))
          )
            return bad(toks[0], 'bad dotted quad')
          return need(1, toks)
        case 'AAAA':
          if (toks.length >= 1 && !(IPV6_RE.test(toks[0] as string) && (toks[0] as string).includes(':')))
            return bad(toks[0], 'bad IPv6 address')
          return need(1, toks)
        case 'NS':
        case 'CNAME':
        case 'PTR': {
          const e = need(1, toks)
          if (e) return e
          rdata = [absolute(toks[0] as string) as string]
          return null
        }
        case 'MX': {
          if (toks.length >= 1 && !/^\d+$/.test(toks[0] as string))
            return bad(toks[0], 'unexpected end of input')
          const e = need(2, toks)
          if (e) return e
          rdata = [toks[0] as string, absolute(toks[1] as string) as string]
          return null
        }
        case 'SRV': {
          const e = need(4, toks)
          if (e) return e
          rdata = [
            toks[0] as string,
            toks[1] as string,
            toks[2] as string,
            absolute(toks[3] as string) as string
          ]
          return null
        }
        case 'SOA': {
          const e = need(7, toks)
          if (e) return e
          rdata = [
            absolute(toks[0] as string) as string,
            absolute(toks[1] as string) as string,
            ...toks.slice(2).map((t) => String(ttlOf(t) ?? t))
          ]
          return null
        }
        default:
          return toks.length === 0 ? bad(undefined, 'unexpected end of line') : null
      }
    })()
    if (problem) return problem
    if (ttl === null) {
      ttl = defaultTtl ?? lastTtl
      if (ttl === null) {
        warnings.push(`dns_master_load: ${where}: no TTL specified; using SOA MINTTL instead`)
        ttl = type === 'SOA' ? Number(rdata[6]) : 0
      }
    }
    lastTtl = ttl
    const name = owner as string
    if (!(name === apex || name.endsWith(apex === '' ? '' : `.${apex}`))) {
      warnings.push(`${tag}: ignoring out-of-zone data (${name === '' ? '.' : name})`)
      continue
    }
    if (type === 'SOA' && name !== apex) return fail([], 'not at top of zone')
    const other = records.find((r) => r.name === name && (r.type === 'CNAME') !== (type === 'CNAME'))
    if (other) return fail([`${where}: CNAME and other data`], 'CNAME and other data')
    records.push({ name, ttl, type, rdata, line: entry.line })
  }
  const soas = records.filter((r) => r.type === 'SOA')
  const nsCount = records.filter((r) => r.type === 'NS' && r.name === apex).length
  const errors: string[] = []
  if (soas.length !== 1) errors.push(`${tag}: has ${soas.length} SOA records`)
  if (nsCount === 0) errors.push(`${tag}: has no NS records`)
  if (errors.length === 0 && integrity) {
    const inZone = (n: string) => n === apex || n.endsWith(apex === '' ? '' : `.${apex}`)
    const addr = (n: string) => records.some((r) => r.name === n && (r.type === 'A' || r.type === 'AAAA'))
    const check = (kind: string, target: string) => {
      if (!inZone(target)) return
      if (records.some((r) => r.name === target && r.type === 'CNAME'))
        errors.push(`${tag}: ${kind} '${target}' is a CNAME (illegal)`)
      else if (!addr(target)) errors.push(`${tag}: ${kind} '${target}' has no address records (A or AAAA)`)
    }
    for (const r of records) {
      if (r.type === 'NS' && r.name === apex) check('NS', r.rdata[0] as string)
      else if (r.type === 'MX') check('MX', r.rdata[1] as string)
    }
  }
  if (errors.length > 0)
    return {
      ok: false,
      records: [],
      serial: null,
      messages: [...warnings, ...errors, `${tag}: not loaded due to errors.`]
    }
  const serial = Number(soas[0]?.rdata[2] ?? 0)
  return { ok: true, records, serial, messages: [...warnings, `${tag}: loaded serial ${serial}`] }
}

// ---------------------------------------------------------------------------------------------
// Serveur en fonctionnement
// ---------------------------------------------------------------------------------------------

export interface LoadedZone {
  zone: BindZone
  /** null : fichier de zone en erreur (le serveur répond SERVFAIL). */
  load: ZoneLoad | null
}

export interface BindServer {
  host: HostDevice
  check: ConfCheck
  zones: LoadedZone[]
}

const absoluteFile = (model: BindModel, file: string) =>
  file.startsWith('/') ? file : `${model.directory.replace(/\/$/, '')}/${file}`

/** Charge la configuration et les zones à partir d'un lecteur de fichiers. */
export function loadServer(host: HostDevice, read: (path: string) => string | null): BindServer {
  const check = checkConf(read)
  const zones: LoadedZone[] = []
  if (check.ok) {
    for (const zone of check.model.zones) {
      if (zone.type === 'primary' && zone.file !== null) {
        const path = absoluteFile(check.model, zone.file)
        const load = loadZone(read(path), zone.name, path)
        zones.push({ zone, load: load.ok ? load : null })
      } else zones.push({ zone, load: null })
    }
  }
  return { host, check, zones }
}

/** Configuration en vigueur : celle du dernier (re)démarrage ou rechargement de named. */
export function runningServer(host: HostDevice): BindServer {
  const bundle = unbundle(runningConfigText(host.host.linux, 'named'))
  return loadServer(host, (p) => bundle.get(p) ?? null)
}

// --- Listes de contrôle d'accès ---------------------------------------------------------------

function localAddresses(host: HostDevice): { ip: string; prefix: number }[] {
  const out: { ip: string; prefix: number }[] = []
  for (const i of host.interfaces) {
    const eff = effectiveIpv4(i)
    if (eff) out.push({ ip: eff.address, prefix: eff.prefixLength })
  }
  return out
}

function matches(list: string[], ip: string, host: HostDevice, model: BindModel, depth = 0): boolean {
  for (const raw of list) {
    const negated = raw.startsWith('!')
    const entry = (negated ? raw.slice(1) : raw).trim()
    let hit = false
    const lower = entry.toLowerCase()
    if (lower === 'any') hit = true
    else if (lower === 'none') hit = false
    else if (lower === 'localhost') hit = ip === '127.0.0.1' || localAddresses(host).some((a) => a.ip === ip)
    else if (lower === 'localnets')
      hit = ip === '127.0.0.1' || localAddresses(host).some((a) => inNetwork(ip, a.ip, a.prefix))
    else if (model.acls[lower] && depth < 8)
      hit = matches(model.acls[lower] as string[], ip, host, model, depth + 1)
    else if (entry.includes('/')) {
      const [net, bits] = entry.split('/')
      hit = !!net && isIpv4(net) && inNetwork(ip, net, Number(bits))
    } else if (isIpv4(entry)) hit = entry === ip
    if (hit) return !negated
  }
  return false
}

// --- Réponses ------------------------------------------------------------------------------------

export interface BindRecord {
  name: string
  type: string
  data: string
  ttl: number
}

export type BindReply =
  | { kind: 'answer'; records: BindRecord[]; authoritative: boolean; authority?: BindRecord[] }
  | { kind: 'nxdomain'; authority: BindRecord[] }
  | { kind: 'servfail' }
  | { kind: 'refused' }
  /** Interroger ces serveurs (redirecteurs) ; `only` : ne pas poursuivre par la racine. */
  | { kind: 'forward'; servers: string[]; only: boolean }
  /** Résolution récursive depuis la racine. */
  | { kind: 'recurse' }

const rdataText = (r: ZoneRecord): string => {
  switch (r.type) {
    case 'SOA':
      return `${r.rdata[0]}. ${r.rdata[1]}. ${r.rdata.slice(2).join(' ')}`
    default:
      return r.rdata.join(' ')
  }
}

const toRecord = (r: ZoneRecord, qname: string): BindRecord => ({
  name: qname,
  type: r.type,
  data: rdataText(r),
  ttl: r.ttl
})

/** Réponse de named à une requête (`clientIp` : adresse source de la requête, pour les listes d'accès). */
export function bindReply(
  server: BindServer,
  qname: string,
  qtype: string,
  clientIp: string,
  depth = 0
): BindReply {
  const { model } = server.check
  if (!server.check.ok) return { kind: 'servfail' }
  const name = qname.toLowerCase().replace(/\.$/, '')
  // Zone la plus spécifique
  const best = server.zones
    .filter(({ zone }) => zone.name === '.' || name === zone.name || name.endsWith(`.${zone.name}`))
    .sort((a, b) => b.zone.name.length - a.zone.name.length)[0]
  const allowed = (acl: string[] | null, dflt: string[]) => matches(acl ?? dflt, clientIp, server.host, model)
  if (best && best.zone.type === 'primary') {
    if (!allowed(best.zone.allowQuery ?? model.allowQuery, ['any'])) return { kind: 'refused' }
    if (!best.load) return { kind: 'servfail' }
    const records = best.load.records
    const here = records.filter((r) => r.name === name)
    // Réponse négative : le SOA de la zone figure dans la section AUTHORITY
    const soaRecord = records.find((r) => r.type === 'SOA')
    const soa = soaRecord ? [toRecord(soaRecord, best.zone.name === '.' ? '' : best.zone.name)] : []
    const wanted = here.filter((r) => r.type === qtype.toUpperCase())
    if (wanted.length > 0)
      return { kind: 'answer', records: wanted.map((r) => toRecord(r, name)), authoritative: true }
    const cname = here.find((r) => r.type === 'CNAME')
    if (cname && qtype.toUpperCase() !== 'CNAME') {
      const target = cname.rdata[0] as string
      const first = toRecord(cname, name)
      if (depth < 8) {
        const next = bindReply(server, target, qtype, clientIp, depth + 1)
        if (next.kind === 'answer') return { ...next, records: [first, ...next.records] }
        if (next.kind === 'nxdomain') return { kind: 'answer', records: [first], authoritative: true }
      }
      return { kind: 'answer', records: [first], authoritative: true }
    }
    // Nom existant avec d'autres types, ou nœud vide entre deux noms existants : réponse vide (NODATA)
    if (here.length > 0 || records.some((r) => r.name.endsWith(`.${name}`)))
      return { kind: 'answer', records: [], authoritative: true, authority: soa }
    return { kind: 'nxdomain', authority: soa }
  }
  if (best && best.zone.type === 'forward' && best.zone.forwarders.length > 0)
    return {
      kind: 'forward',
      servers: best.zone.forwarders,
      only: best.zone.forwardOnly ?? model.forwardOnly
    }
  if (best && best.zone.type !== 'hint') return { kind: 'servfail' }
  // Récursion : réservée aux clients autorisés (allow-recursion, par défaut localnets et localhost)
  if (!model.recursion || !allowed(model.allowRecursion, ['localnets', 'localhost']))
    return { kind: 'refused' }
  if (model.forwarders.length > 0)
    return { kind: 'forward', servers: model.forwarders, only: model.forwardOnly }
  return { kind: 'recurse' }
}

/** Nombre de zones « automatiques » (zones vides RFC 1918 et assimilées) comptées par `rndc status`. */
export const AUTOMATIC_ZONES = 97
