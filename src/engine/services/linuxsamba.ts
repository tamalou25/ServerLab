/**
 * Samba simulé (v2.9, #239) : lecture de /etc/samba/smb.conf, base des utilisateurs Samba (passdb),
 * authentification SMB et sortie de `testparm`. Module de services sans dépendance à la console.
 *
 * Formats et messages : sources de Samba 4.17.12 (Debian bookworm) — lib/util/tini.c (lecture du
 * fichier), lib/param/loadparm.c et source3/utils/testparm.c (messages et dump). Les paramètres non
 * modélisés sont recopiés tels que saisis (docs/fidelite.md, « À vérifier (v2.9 — Linux) », L-80 à L-89).
 *
 * La base d'utilisateurs Samba (tdbsam) est simulée par un fichier texte
 * /var/lib/samba/private/passdb.tdb (`nom:uid:drapeaux:$sim$motdepasse`) : aucun hachage réel.
 */
import type { HostDevice } from '../model/schema'
import { findPackage, type LinuxRelease } from './linuxcatalog'
import { KNOWN_PARAMETERS } from './linuxsambaparams'
import { linuxRelease } from './linuxpackages'

export { SMB_CONF } from './linuxconfig'
export const PASSDB = '/var/lib/samba/private/passdb.tdb'
export const SAMBA_LOG_DIR = '/var/log/samba'
/** Marqueur de mot de passe de la base : AUCUN hachage réel. */
export const PASS_MARK = '$sim$'

/** Version de Samba telle qu'affichée : « 4.17.12-Debian », « 4.19.5-Ubuntu ». */
export function sambaVersion(release: LinuxRelease): string {
  const full = findPackage('samba')?.versions[release] ?? ''
  const upstream = full.replace(/^\d+:/, '').split(/[+~-]/)[0] ?? full
  return `${upstream}-${release === 'debian12' ? 'Debian' : 'Ubuntu'}`
}
export const hostSambaVersion = (host: HostDevice) => sambaVersion(linuxRelease(host))

// ---------------------------------------------------------------------------------------------
// Paramètres modélisés
// ---------------------------------------------------------------------------------------------

type PType = 'bool' | 'str' | 'int' | 'enum' | 'octal' | 'list'
interface Param {
  label: string
  scope: 'G' | 'S'
  type: PType
  /** Valeur par défaut, telle qu'affichée par testparm -v. */
  def: string
  /** Libellés des énumérations (saisie insensible à la casse). */
  values?: string[]
}

const P = (label: string, scope: 'G' | 'S', type: PType, def: string, values?: string[]): Param => ({
  label,
  scope,
  type,
  def,
  ...(values ? { values } : {})
})

const PARAMS: Param[] = [
  P('workgroup', 'G', 'str', 'WORKGROUP'),
  P('netbios name', 'G', 'str', ''),
  P('server string', 'G', 'str', ''),
  P('server role', 'G', 'enum', 'auto', [
    'auto',
    'standalone server',
    'member server',
    'classic primary domain controller',
    'classic backup domain controller',
    'active directory domain controller'
  ]),
  P('security', 'G', 'enum', 'USER', ['AUTO', 'USER', 'DOMAIN', 'ADS']),
  P('map to guest', 'G', 'enum', 'Never', ['Never', 'Bad User', 'Bad Password', 'Bad Uid']),
  P('guest account', 'G', 'str', 'nobody'),
  P('log file', 'G', 'str', ''),
  P('max log size', 'G', 'int', '5000'),
  P('logging', 'G', 'str', ''),
  P('panic action', 'G', 'str', ''),
  P('obey pam restrictions', 'G', 'bool', 'No'),
  P('unix password sync', 'G', 'bool', 'No'),
  P('passwd program', 'G', 'str', ''),
  P('passwd chat', 'G', 'str', '*new*password* %n\\n *new*password* %n\\n *changed*'),
  P('pam password change', 'G', 'bool', 'No'),
  P('usershare allow guests', 'G', 'bool', 'No'),
  P('encrypt passwords', 'G', 'bool', 'Yes'),
  P('bind interfaces only', 'G', 'bool', 'No'),
  P('interfaces', 'G', 'list', ''),
  P('server min protocol', 'G', 'enum', 'SMB2_02', [
    'LANMAN1',
    'LANMAN2',
    'NT1',
    'SMB2_02',
    'SMB2_10',
    'SMB3_00',
    'SMB3_02',
    'SMB3_11'
  ]),
  P('server max protocol', 'G', 'enum', 'SMB3_11', [
    'LANMAN1',
    'LANMAN2',
    'NT1',
    'SMB2_02',
    'SMB2_10',
    'SMB3_00',
    'SMB3_02',
    'SMB3_11'
  ]),
  P('restrict anonymous', 'G', 'int', '0'),
  P('local master', 'G', 'bool', 'Yes'),
  P('os level', 'G', 'int', '20'),
  P('wins support', 'G', 'bool', 'No'),
  P('dns proxy', 'G', 'bool', 'Yes'),
  P('load printers', 'G', 'bool', 'Yes'),
  P('disable spoolss', 'G', 'bool', 'No'),
  P('unix extensions', 'G', 'bool', 'Yes'),
  P('wide links', 'G', 'bool', 'No'),
  P('deadtime', 'G', 'int', '10080'),
  P('socket options', 'G', 'str', 'TCP_NODELAY'),
  P('log level', 'G', 'str', '0'),
  P('usershare path', 'G', 'str', ''),
  P('comment', 'S', 'str', ''),
  P('path', 'S', 'str', ''),
  P('browseable', 'S', 'bool', 'Yes'),
  P('read only', 'S', 'bool', 'Yes'),
  P('guest ok', 'S', 'bool', 'No'),
  P('guest only', 'S', 'bool', 'No'),
  P('valid users', 'S', 'list', ''),
  P('invalid users', 'S', 'list', ''),
  P('read list', 'S', 'list', ''),
  P('write list', 'S', 'list', ''),
  P('admin users', 'S', 'list', ''),
  P('hosts allow', 'S', 'list', ''),
  P('hosts deny', 'S', 'list', ''),
  P('create mask', 'S', 'octal', '0744'),
  P('directory mask', 'S', 'octal', '0755'),
  P('force create mode', 'S', 'octal', '00'),
  P('force directory mode', 'S', 'octal', '00'),
  P('force user', 'S', 'str', ''),
  P('force group', 'S', 'str', ''),
  P('hide dot files', 'S', 'bool', 'Yes'),
  P('printable', 'S', 'bool', 'No'),
  P('available', 'S', 'bool', 'Yes'),
  P('inherit permissions', 'S', 'bool', 'No'),
  P('vfs objects', 'S', 'list', ''),
  P('follow symlinks', 'S', 'bool', 'Yes')
]

/** Nom normalisé d'un paramètre : sans blanc ni casse (strwicmp ignore les espaces). */
export const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '')

const BY_KEY = new Map(PARAMS.map((p) => [norm(p.label), p]))

/** Synonymes : nom → [paramètre, valeur inversée]. */
const SYNONYMS: Record<string, [string, boolean]> = {
  writable: ['readonly', true],
  writeable: ['readonly', true],
  writeok: ['readonly', true],
  public: ['guestok', false],
  browsable: ['browseable', false],
  allowhosts: ['hostsallow', false],
  denyhosts: ['hostsdeny', false],
  onlyguest: ['guestonly', false]
}

const TRUE_RE = /^(yes|true|1|on)$/i
const FALSE_RE = /^(no|false|0|off)$/i

// ---------------------------------------------------------------------------------------------
// Lecture du fichier (lib/util/tini.c) et chargement (lib/param/loadparm.c)
// ---------------------------------------------------------------------------------------------

export interface SmbSection {
  /** Nom tel que saisi (casse conservée). */
  name: string
  /** Paramètres modélisés (clé normalisée → valeur brute), le dernier gagne. */
  set: Map<string, string>
  /** Paramètres valides mais non modélisés (libellé saisi → valeur), dans l'ordre. */
  extra: Map<string, string>
  /** Paramètres « a : b » (idmap config…). */
  parametric: Map<string, string>
}

export interface SmbConf {
  global: SmbSection
  shares: SmbSection[]
}

export interface LoadResult {
  ok: boolean
  conf: SmbConf
  /** Messages écrits sur l'erreur standard pendant le chargement. */
  stderr: string[]
}

const newSection = (name: string): SmbSection => ({
  name,
  set: new Map(),
  extra: new Map(),
  parametric: new Map()
})

/** Lignes logiques du fichier : blancs répétés réduits, continuation par « \ » (tini.c, get_line). */
function logicalLines(text: string): string[] {
  const out: string[] = []
  let buf = ''
  for (const raw of text.split('\n')) {
    const line = buf === '' ? raw.replace(/^\s+/, '') : raw
    if (buf === '' && (line === '' || line.startsWith('#') || line.startsWith(';'))) continue
    const collapsed = line.replace(/[ \t\r]+/g, (m) => m[0] as string)
    if (collapsed.endsWith('\\')) {
      buf += collapsed.slice(0, -1)
      continue
    }
    out.push(buf + collapsed)
    buf = ''
  }
  if (buf !== '') out.push(buf)
  return out
}

/** Charge un smb.conf : paramètres inconnus ignorés avec les messages de loadparm.c. */
export function loadSmbConf(text: string): LoadResult {
  const conf: SmbConf = { global: newSection('global'), shares: [] }
  const stderr: string[] = []
  let current = conf.global
  let isGlobal = true
  for (const line of logicalLines(text)) {
    if (line.startsWith('[')) {
      const end = line.indexOf(']')
      if (end < 0) return { ok: false, conf, stderr }
      const name = line.slice(1, end).trim()
      if (norm(name) === 'global') {
        current = conf.global
        isGlobal = true
      } else {
        const existing = conf.shares.find((s) => s.name.toLowerCase() === name.toLowerCase())
        current = existing ?? newSection(name)
        if (!existing) conf.shares.push(current)
        isGlobal = false
      }
      continue
    }
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const label = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    if (label === '') return { ok: false, conf, stderr }
    if (label.includes(':')) {
      current.parametric.set(label, value)
      continue
    }
    let key = norm(label)
    let val = value
    const syn = SYNONYMS[key]
    if (syn) {
      key = syn[0]
      if (syn[1]) val = TRUE_RE.test(value) ? 'no' : FALSE_RE.test(value) ? 'yes' : value
    }
    const param = BY_KEY.get(key)
    if (param) {
      if (!isGlobal && param.scope === 'G') {
        stderr.push(`Global parameter ${param.label} found in service section!`)
        continue
      }
      current.set.set(key, val)
      continue
    }
    if (KNOWN_PARAMETERS.has(key)) {
      current.extra.set(label, value)
      continue
    }
    stderr.push(`Unknown parameter encountered: "${label}"`, `Ignoring unknown parameter "${label}"`)
  }
  return { ok: true, conf, stderr }
}

// ---------------------------------------------------------------------------------------------
// Valeurs
// ---------------------------------------------------------------------------------------------

/** Liste Samba : mots séparés par des blancs ou des virgules, guillemets permis. */
export function splitList(raw: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|[^\s,]+/g
  for (let m = re.exec(raw); m; m = re.exec(raw)) out.push((m[1] ?? m[0]) as string)
  return out
}

/** Valeur affichée par testparm : booléens Yes/No, énumérations en libellé, listes séparées par « , ». */
function format(p: Param, raw: string): string {
  switch (p.type) {
    case 'bool':
      return TRUE_RE.test(raw) ? 'Yes' : 'No'
    case 'enum': {
      const hit = p.values?.find((v) => v.toLowerCase() === raw.toLowerCase())
      if (hit) return hit
      if (p.label === 'server role') {
        const short = raw.toLowerCase()
        if (short === 'standalone') return 'standalone server'
        if (short === 'member') return 'member server'
        if (short === 'domain controller' || short === 'dc' || short === 'ad dc')
          return 'active directory domain controller'
      }
      return raw
    }
    case 'octal': {
      const n = parseInt(raw, 8)
      return Number.isNaN(n) ? raw : `0${n.toString(8)}`
    }
    case 'int':
      return String(Number.parseInt(raw, 10) || 0)
    case 'list':
      return splitList(raw).join(', ')
    default:
      return raw
  }
}

/** Valeur brute effective d'un paramètre d'un partage : partage, puis [global] (valeur par défaut des partages), puis défaut. */
function rawOf(conf: SmbConf, section: SmbSection | null, p: Param): string {
  const key = norm(p.label)
  if (section && section !== conf.global && p.scope === 'S') {
    const own = section.set.get(key)
    if (own !== undefined) return own
  }
  return conf.global.set.get(key) ?? p.def
}

export interface ConfContext {
  /** Nom de la machine (netbios name par défaut). */
  hostname: string
  /** Version de Samba (valeur par défaut de `server string`). */
  version: string
}

/** Valeur effective formatée d'un paramètre modélisé. */
export function paramValue(
  conf: SmbConf,
  ctx: ConfContext,
  section: SmbSection | null,
  label: string
): string {
  const p = BY_KEY.get(norm(label))
  if (!p) return ''
  const raw = rawOf(conf, section, p)
  if (raw === '' && p.label === 'netbios name') return ctx.hostname.toUpperCase()
  if (raw === '' && p.label === 'server string') return `Samba ${ctx.version}`
  return format(p, raw)
}

export const boolValue = (conf: SmbConf, ctx: ConfContext, section: SmbSection | null, label: string) =>
  paramValue(conf, ctx, section, label) === 'Yes'

export const listValue = (conf: SmbConf, section: SmbSection | null, label: string): string[] => {
  const p = BY_KEY.get(norm(label))
  return p ? splitList(rawOf(conf, section, p)) : []
}

/** Rôle du serveur : `server role` (ou déduit de `security`), libellé ROLE_… de testparm. */
export function serverRole(conf: SmbConf, ctx: ConfContext): string {
  const role = paramValue(conf, ctx, null, 'server role')
  if (role === 'member server') return 'ROLE_DOMAIN_MEMBER'
  if (role === 'classic primary domain controller') return 'ROLE_DOMAIN_PDC'
  if (role === 'classic backup domain controller') return 'ROLE_DOMAIN_BDC'
  if (role === 'active directory domain controller') return 'ROLE_ACTIVE_DIRECTORY_DC'
  const sec = paramValue(conf, ctx, null, 'security')
  if (role === 'auto' && (sec === 'DOMAIN' || sec === 'ADS')) return 'ROLE_DOMAIN_MEMBER'
  return 'ROLE_STANDALONE'
}

// ---------------------------------------------------------------------------------------------
// testparm
// ---------------------------------------------------------------------------------------------

const labelSort = (a: string, b: string) => (norm(a) < norm(b) ? -1 : norm(a) > norm(b) ? 1 : 0)

/** Paramètres de la section [global] à afficher (modélisés puis non modélisés), pour une portée. */
function dumpScope(conf: SmbConf, ctx: ConfContext, scope: 'G' | 'S'): string[] {
  const lines: [string, string][] = []
  for (const p of PARAMS) {
    if (p.scope !== scope || !conf.global.set.has(norm(p.label))) continue
    const value = paramValue(conf, ctx, conf.global, p.label)
    const dflt =
      p.label === 'netbios name'
        ? ctx.hostname.toUpperCase()
        : p.label === 'server string'
          ? `Samba ${ctx.version}`
          : format(p, p.def)
    if (value !== dflt) lines.push([p.label, `\t${p.label} = ${value}`])
  }
  return lines.sort((a, b) => labelSort(a[0], b[0])).map((l) => l[1])
}

/** `testparm -s` : « # Global parameters » puis un bloc par partage (seules les valeurs non défaut). */
export function dumpConf(conf: SmbConf, ctx: ConfContext): { lines: string[]; unmodeled: string[] } {
  const unmodeled = [...conf.global.extra.keys(), ...conf.shares.flatMap((s) => [...s.extra.keys()])]
  const out = ['# Global parameters', '[global]', ...dumpScope(conf, ctx, 'G')]
  for (const [k, v] of [...conf.global.parametric].sort((a, b) => labelSort(a[0], b[0])))
    out.push(`\t${k} = ${v}`)
  if (!conf.global.parametric.has('idmap config * : backend')) out.push('\tidmap config * : backend = tdb')
  out.push(...dumpScope(conf, ctx, 'S'))
  for (const [k, v] of [...conf.global.extra].sort((a, b) => labelSort(a[0], b[0]))) out.push(`\t${k} = ${v}`)
  for (const s of conf.shares) {
    out.push('', `[${s.name}]`)
    const lines: [string, string][] = []
    for (const p of PARAMS) {
      if (p.scope !== 'S') continue
      const effective = paramValue(conf, ctx, s, p.label)
      const base = paramValue(conf, ctx, conf.global, p.label)
      if (effective !== base) lines.push([p.label, `\t${p.label} = ${effective}`])
    }
    for (const [k, v] of s.extra) lines.push([k, `\t${k} = ${v}`])
    for (const [k, v] of s.parametric) lines.push([k, `\t${k} = ${v}`])
    out.push(...lines.sort((a, b) => labelSort(a[0], b[0])).map((l) => l[1]))
  }
  return { lines: out, unmodeled }
}

/** Contrôles de testparm (do_global_checks) : avertissements écrits sur l'erreur standard. */
export function globalChecks(conf: SmbConf, ctx: ConfContext): string[] {
  const out = ['']
  const workgroup = paramValue(conf, ctx, null, 'workgroup')
  const netbios = paramValue(conf, ctx, null, 'netbios name')
  if (workgroup.toLowerCase() === netbios.toLowerCase())
    out.push("WARNING: 'workgroup' and 'netbios name' must differ.", '')
  if (netbios.length > 15) out.push("WARNING: The 'netbios name' is too long (max. 15 chars).", '')
  return out
}

/** Valeur d'un seul paramètre (`--parameter-name`), null s'il est inconnu ou non modélisé. */
export function singleParameter(
  conf: SmbConf,
  ctx: ConfContext,
  section: SmbSection | null,
  name: string
): string | null {
  const p = BY_KEY.get(norm(name))
  if (!p || (section !== null && p.scope === 'G' && section !== conf.global)) return null
  return paramValue(conf, ctx, section, p.label)
}

export function findShare(conf: SmbConf, name: string): SmbSection | undefined {
  return conf.shares.find((s) => s.name.toLowerCase() === name.toLowerCase())
}

// ---------------------------------------------------------------------------------------------
// Base des utilisateurs Samba (passdb)
// ---------------------------------------------------------------------------------------------

export interface SamUser {
  name: string
  uid: number
  /** U = compte normal, D = désactivé, N = sans mot de passe. */
  flags: string
  password: string
}

export function readPassdb(text: string | undefined): SamUser[] {
  return (text ?? '')
    .split('\n')
    .filter((l) => l !== '')
    .flatMap((l) => {
      const f = l.split(':')
      if (f.length < 4) return []
      const password = (f.slice(3).join(':') ?? '').replace(PASS_MARK, '')
      return [{ name: f[0] as string, uid: Number(f[1]), flags: f[2] as string, password }]
    })
}

export const formatPassdb = (users: SamUser[]): string =>
  users.map((u) => `${u.name}:${u.uid}:${u.flags}:${PASS_MARK}${u.password}`).join('\n') +
  (users.length ? '\n' : '')

// ---------------------------------------------------------------------------------------------
// Authentification SMB
// ---------------------------------------------------------------------------------------------

export type SmbAuth =
  | { kind: 'user'; user: SamUser }
  | { kind: 'guest' }
  | { kind: 'failed'; status: 'NT_STATUS_LOGON_FAILURE' | 'NT_STATUS_ACCOUNT_DISABLED' }

/**
 * Authentification d'un client SMB. `unixUsers` : comptes de /etc/passwd (un compte Samba sans compte
 * Unix ne peut pas ouvrir de session). Nom vide : session anonyme (guest).
 */
export function authenticateSmb(
  conf: SmbConf,
  ctx: ConfContext,
  users: SamUser[],
  unixUsers: string[],
  name: string | null,
  password: string | null
): SmbAuth {
  if (!name) return { kind: 'guest' }
  const mapToGuest = paramValue(conf, ctx, null, 'map to guest')
  const user = users.find((u) => u.name.toLowerCase() === name.toLowerCase())
  if (!user || !unixUsers.includes(user.name))
    return mapToGuest === 'Bad User'
      ? { kind: 'guest' }
      : { kind: 'failed', status: 'NT_STATUS_LOGON_FAILURE' }
  if (user.flags.includes('D')) return { kind: 'failed', status: 'NT_STATUS_ACCOUNT_DISABLED' }
  if (!user.flags.includes('N') && user.password !== (password ?? ''))
    return mapToGuest === 'Bad Password'
      ? { kind: 'guest' }
      : { kind: 'failed', status: 'NT_STATUS_LOGON_FAILURE' }
  return { kind: 'user', user }
}
