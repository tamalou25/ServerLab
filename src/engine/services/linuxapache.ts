/**
 * Apache2 sur un serveur Linux simulé (v2.9, #238) : fichiers du paquet apache2 (Debian 12,
 * 2.4.68-1~deb12u1), lecture de la configuration (`apache2.conf` et ses `Include`), contrôle de
 * syntaxe (`apache2ctl configtest`), hôtes virtuels (`apache2ctl -S`) et liste des ports d'écoute.
 *
 * - Les messages d'erreur sont ceux des sources de httpd 2.4.68 relevées sur sources.debian.org
 *   (server/config.c, server/core.c, server/util.c, server/vhost.c, modules/ssl/ssl_engine_config.c) :
 *   voir docs/captures/bash/apache2ctl-*.txt et docs/fidelite.md (L-70 à L-79).
 * - Fonctions pures : le contenu des fichiers arrive par un `ConfigSource` (fichiers actuels du serveur
 *   ou instantané de la dernière relecture, voir `loaded` dans linuxconfig.ts).
 * - Les liens symboliques de sites-enabled, mods-enabled et conf-enabled sont des nœuds `link`
 *   (model/linuxnode.ts) : a2ensite & co les créent et les suppriment comme sur un vrai système.
 */
import type { LinuxNode } from '../model/linuxnode'
import {
  APACHE_ARITY,
  APACHE_CONF,
  APACHE_CONFS,
  APACHE_DIRECTIVES,
  APACHE_ENVVARS,
  APACHE_MODS,
  APACHE_PORTS,
  APACHE_SITE_DEFAULT,
  APACHE_SITE_SSL,
  DEBIAN_INDEX
} from './linuxapachedata'

export const APACHE_DIR = '/etc/apache2'
export const APACHE_LOGS = '/var/log/apache2'
export const ACCESS_LOG = `${APACHE_LOGS}/access.log`
export const ERROR_LOG = `${APACHE_LOGS}/error.log`
export const OTHER_VHOSTS_LOG = `${APACHE_LOGS}/other_vhosts_access.log`
export const SNAKEOIL_CERT = '/etc/ssl/certs/ssl-cert-snakeoil.pem'
export const SNAKEOIL_KEY = '/etc/ssl/private/ssl-cert-snakeoil.key'
export const DOC_ROOT = '/var/www/html'
export const INDEX_HTML = `${DOC_ROOT}/index.html`
/** Contenu de l'ancien index.html de ServerLab (v2.9, #236), remplacé par la page Debian à l'installation d'apache2. */
export const LEGACY_INDEX = '<html><body><h1>It works!</h1></body></html>\n'

/** Variables d'environnement de /etc/apache2/envvars (valeurs fixes du paquet Debian). */
const ENV: Record<string, string> = {
  APACHE_RUN_USER: 'www-data',
  APACHE_RUN_GROUP: 'www-data',
  APACHE_PID_FILE: '/var/run/apache2/apache2.pid',
  APACHE_RUN_DIR: '/var/run/apache2',
  APACHE_LOCK_DIR: '/var/lock/apache2',
  APACHE_LOG_DIR: APACHE_LOGS,
  LANG: 'C'
}

/** Textes qui tiennent lieu de certificat et de clé « snakeoil » (aucun matériel cryptographique réel). */
const SNAKEOIL_TEXT =
  '# Certificat auto-signé « snakeoil » simulé par ServerLab (aucun matériel cryptographique réel).\n'

/** Contenu fourni par le paquet apache2 (chemin → texte) tant que le fichier n'est pas modifié. */
export const APACHE_PROVIDED: Record<string, string> = (() => {
  const p: Record<string, string> = {
    [`${APACHE_DIR}/apache2.conf`]: APACHE_CONF,
    [`${APACHE_DIR}/ports.conf`]: APACHE_PORTS,
    [`${APACHE_DIR}/envvars`]: APACHE_ENVVARS,
    [`${APACHE_DIR}/sites-available/000-default.conf`]: APACHE_SITE_DEFAULT,
    [`${APACHE_DIR}/sites-available/default-ssl.conf`]: APACHE_SITE_SSL,
    [SNAKEOIL_CERT]: SNAKEOIL_TEXT,
    [SNAKEOIL_KEY]: SNAKEOIL_TEXT
  }
  for (const [name, text] of Object.entries(APACHE_CONFS))
    p[`${APACHE_DIR}/conf-available/${name}.conf`] = text
  for (const [name, m] of Object.entries(APACHE_MODS)) {
    p[`${APACHE_DIR}/mods-available/${name}.load`] = m.load
    if (m.conf !== undefined) p[`${APACHE_DIR}/mods-available/${name}.conf`] = m.conf
  }
  return p
})()

/** Page par défaut copiée dans /var/www/html par la postinst du paquet (debian/apache2.postinst). */
export const defaultIndexFor = (
  path: string,
  content: string | undefined,
  installed: boolean
): string | undefined =>
  installed && path === INDEX_HTML && (content === undefined || content === LEGACY_INDEX)
    ? DEBIAN_INDEX
    : content

// ---------------------------------------------------------------------------------------------
// Modules, sites et configurations activés par défaut
// ---------------------------------------------------------------------------------------------

/** Modules activés à l'installation (debian/apache2.postinst : enable_default_mpm, enable_default_modules). */
const DEFAULT_MODULES = [
  'mpm_event',
  'authz_host',
  'auth_basic',
  'access_compat',
  'authn_file',
  'authz_user',
  'alias',
  'dir',
  'autoindex',
  'env',
  'mime',
  'negotiation',
  'setenvif',
  'filter',
  'deflate',
  'status',
  'reqtimeout'
]
/** Configurations activées à l'installation (enable_default_conf). */
const DEFAULT_CONFS = [
  'charset',
  'localized-error-pages',
  'other-vhosts-access-log',
  'security',
  'serve-cgi-bin'
]

/** Dépendances d'un module (`# Depends:` ou `# Conflicts:` en tête de son fichier .load). */
export function moduleHeader(name: string, kind: 'Depends' | 'Conflicts' = 'Depends'): string[] {
  const load = APACHE_MODS[name]?.load ?? ''
  for (const line of load.split('\n')) {
    const m = new RegExp(`^# ${kind}:\\s+(.*?)\\s*$`).exec(line)
    if (m) return (m[1] as string).split(/\s+/)
    if (!/^\s*(#.*)?$/.test(line)) break
  }
  return []
}

/** Modules à activer pour `names`, dépendances d'abord (a2enmod active les dépendances avant le module). */
export function withDependencies(names: string[]): string[] {
  const out: string[] = []
  const add = (n: string) => {
    if (out.includes(n)) return
    for (const d of moduleHeader(n)) add(d)
    out.push(n)
  }
  names.forEach(add)
  return out
}

const dirNode = (mode = 0o755, owner = 'root', group = 'root'): LinuxNode => ({
  type: 'dir',
  mode,
  owner,
  group,
  mtime: 0
})
const fileNode = (mode = 0o644, owner = 'root', group = 'root'): LinuxNode => ({
  type: 'file',
  mode,
  owner,
  group,
  mtime: 0
})
export const linkNode = (target: string): LinuxNode => ({
  type: 'file',
  mode: 0o777,
  owner: 'root',
  group: 'root',
  link: target,
  mtime: 0
})

/** Dossiers, fichiers et liens qu'apporte le paquet apache2 (système neuf). */
export function apacheNodes(): [string, LinuxNode][] {
  const nodes: [string, LinuxNode][] = [
    [APACHE_DIR, dirNode()],
    [`${APACHE_DIR}/conf-available`, dirNode()],
    [`${APACHE_DIR}/conf-enabled`, dirNode()],
    [`${APACHE_DIR}/mods-available`, dirNode()],
    [`${APACHE_DIR}/mods-enabled`, dirNode()],
    [`${APACHE_DIR}/sites-available`, dirNode()],
    [`${APACHE_DIR}/sites-enabled`, dirNode()],
    [APACHE_LOGS, dirNode(0o750, 'root', 'adm')],
    ['/etc/ssl', dirNode()],
    ['/etc/ssl/certs', dirNode()],
    ['/etc/ssl/private', dirNode(0o710, 'root', 'root')]
  ]
  for (const path of Object.keys(APACHE_PROVIDED))
    nodes.push([path, fileNode(path === SNAKEOIL_KEY ? 0o640 : 0o644)])
  for (const path of [ACCESS_LOG, ERROR_LOG, OTHER_VHOSTS_LOG])
    nodes.push([path, fileNode(0o640, 'root', 'adm')])
  const link = (kind: string, name: string, ext: string) =>
    nodes.push([
      `${APACHE_DIR}/${kind}-enabled/${name}.${ext}`,
      linkNode(`../${kind}-available/${name}.${ext}`)
    ])
  for (const m of withDependencies(DEFAULT_MODULES)) {
    link('mods', m, 'load')
    if (APACHE_MODS[m]?.conf !== undefined) link('mods', m, 'conf')
  }
  for (const c of DEFAULT_CONFS) link('conf', c, 'conf')
  link('sites', '000-default', 'conf')
  return nodes
}

/** Complète une arborescence des nœuds d'apache2 tant que /etc/apache2 n'y figure pas (sinon : déjà matérialisés). */
export function withApacheNodes<T extends { type: 'file' | 'dir' }>(
  files: Record<string, T>,
  extra: (node: LinuxNode) => T = (n) => n as unknown as T
): Record<string, T> {
  if (APACHE_DIR in files) return files
  const missing = apacheNodes().filter(([p]) => !(p in files))
  return { ...files, ...Object.fromEntries(missing.map(([p, n]) => [p, extra(n)])) }
}

// ---------------------------------------------------------------------------------------------
// Lecture de la configuration
// ---------------------------------------------------------------------------------------------

/** Accès aux fichiers de configuration : lecture (liens suivis) et liste des fichiers d'un dossier. */
export interface ConfigSource {
  /** Texte du fichier, null s'il n'existe pas. */
  read(path: string): string | null
  /** Fichiers `dir/*suffix` (chemins complets, triés). */
  glob(dir: string, suffix: string): string[]
}

/** Contexte du serveur nécessaire au contrôle de la configuration. */
export interface ServerContext {
  /** Nom de la machine (apr_gethostname). */
  hostname: string
  /** Contenu de /etc/hosts. */
  hostsText: string
  /** Type du chemin (liens suivis) ; null s'il n'existe pas ; `size` : taille du fichier. */
  stat(path: string): { type: 'file' | 'dir'; size: number } | null
}

interface RawNode {
  /** Nom de la directive, tel que tapé (`<VirtualHost` pour une section). */
  name: string
  args: string
  file: string
  line: number
  children?: RawNode[]
}

export interface BuildResult {
  nodes: RawNode[]
  /** Fichiers lus, dans l'ordre (chemin tel qu'inclus → contenu). */
  files: Record<string, string>
  /** Modules chargés (LoadModule), dans l'ordre. */
  loads: { module: string; file: string; line: number; path: string }[]
  /** Erreur de lecture (ap_read_config) : message complet sans le préfixe « apache2: ». */
  error?: string
}

const SERVER_ROOT = APACHE_DIR

const absolute = (path: string) => (path.startsWith('/') ? path : `${SERVER_ROOT}/${path}`)

/** Lignes logiques d'un fichier : continuation par « \ », commentaires et lignes vides ignorés. */
function logicalLines(text: string): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = []
  const raw = text.split('\n')
  if (raw.at(-1) === '') raw.pop()
  let acc = ''
  raw.forEach((l, i) => {
    const line = l.replace(/\r$/, '')
    const joined = acc + line
    if (/\\\s*$/.test(joined) && joined.trim().endsWith('\\')) {
      acc = joined.replace(/\\\s*$/, '')
      return
    }
    acc = ''
    const t = joined.trim()
    if (t !== '' && !t.startsWith('#')) out.push({ text: t, line: i + 1 })
  })
  return out
}

/** Premier mot d'une chaîne de configuration (guillemets acceptés) et reste. */
export function nextWord(text: string): [string, string] {
  const s = text.replace(/^\s+/, '')
  if (s === '') return ['', '']
  const q = s[0]
  if (q === '"' || q === "'") {
    let out = ''
    let i = 1
    for (; i < s.length && s[i] !== q; i++) {
      if (s[i] === '\\' && i + 1 < s.length && (s[i + 1] === q || s[i + 1] === '\\')) i++
      out += s[i]
    }
    return [out, s.slice(i + 1).replace(/^\s+/, '')]
  }
  const m = /^(\S+)\s*(.*)$/s.exec(s)
  return [m?.[1] ?? '', m?.[2] ?? '']
}

export const splitArgs = (args: string): string[] => {
  const out: string[] = []
  let rest = args
  for (;;) {
    const [w, r] = nextWord(rest)
    if (w === '' && r === '') break
    out.push(w)
    rest = r
  }
  return out
}

/** Remplace `${VAR}` par la valeur de l'environnement d'Apache (envvars) ou d'un `Define`. */
export function expandVars(text: string, defines: Record<string, string> = {}): string {
  return text.replace(/\$\{(\w+)\}/g, (all, n: string) => defines[n] ?? ENV[n] ?? all)
}

/** Lit la configuration depuis `apache2.conf` : arbre de directives, fichiers lus et modules chargés. */
export function buildConfig(src: ConfigSource): BuildResult {
  const result: BuildResult = { nodes: [], files: {}, loads: [] }
  const root = `${APACHE_DIR}/apache2.conf`

  /** Lit un fichier ; renvoie son arbre ou une erreur (déjà préfixée « Syntax error on line … »). */
  const readFile = (path: string, depth: number): { nodes: RawNode[] } | { error: string } => {
    const text = src.read(path)
    if (text === null)
      return { error: `Could not open configuration file ${path}: No such file or directory` }
    result.files[path] = text
    const top: RawNode[] = []
    const stack: RawNode[] = []
    const current = () => (stack.length > 0 ? ((stack.at(-1) as RawNode).children as RawNode[]) : top)
    const wrap = (n: { file: string; line: number }, msg: string) =>
      `Syntax error on line ${n.line} of ${n.file}: ${msg}`
    for (const l of logicalLines(text)) {
      let [name, args] = nextWord(l.text)
      const node: RawNode = { name, args, file: path, line: l.line }
      if (name.startsWith('</')) {
        if (stack.length === 0)
          return { error: wrap(node, `${name} without matching <${name.slice(2)} section`) }
        if (!name.endsWith('>')) return { error: wrap(node, `${name}> directive missing closing '>'`) }
        const open = stack.at(-1) as RawNode
        if (name.slice(2, -1).toLowerCase() !== open.name.slice(1).toLowerCase())
          return { error: wrap(node, `Expected </${open.name.slice(1)}> but saw ${name}`) }
        stack.pop()
        continue
      }
      if (name.startsWith('<')) {
        // « <VirtualHost *:80> » : le « > » final fait partie des arguments
        let full = l.text
        if (!full.endsWith('>')) return { error: wrap(node, `${name}> directive missing closing '>'`) }
        full = full.slice(0, -1)
        ;[name, args] = nextWord(full)
        node.name = name
        node.args = args.trim()
        node.children = []
        current().push(node)
        stack.push(node)
        continue
      }
      const lname = name.toLowerCase()
      if (lname === 'include' || lname === 'includeoptional') {
        const [target] = nextWord(args)
        const abs = absolute(expandVars(target))
        const optional = lname === 'includeoptional'
        const slash = abs.lastIndexOf('/')
        const dir = abs.slice(0, slash)
        const base = abs.slice(slash + 1)
        let matches: string[]
        if (/[*?[]/.test(base)) {
          const suffix = base.replace(/^\*/, '')
          matches = src.glob(dir, suffix)
          if (matches.length === 0 && !optional)
            return { error: wrap(node, `No matches for the wildcard '${base}' in '${dir}', failing`) }
        } else if (src.read(abs) === null) {
          if (optional) continue
          return { error: wrap(node, `Could not open configuration file ${abs}: No such file or directory`) }
        } else matches = [abs]
        if (depth > 30) return { error: wrap(node, 'Recursion limit of nested Include reached') }
        for (const f of matches) {
          const r = readFile(f, depth + 1)
          if ('error' in r) return { error: wrap(node, r.error) }
          current().push(...r.nodes)
        }
        continue
      }
      if (lname === 'loadmodule') {
        const [mod, rest] = nextWord(args)
        const [path] = nextWord(rest)
        if (mod !== '' && path !== '') result.loads.push({ module: mod, file: path, line: l.line, path })
      }
      current().push(node)
    }
    if (stack.length > 0) {
      const lines = stack
        .slice()
        .reverse()
        .map((n) => `${n.file}:${n.line}: ${n.name}> was not closed.`)
      const outer = stack[0] as RawNode
      return { error: wrap(outer, lines.join('\n')) }
    }
    return { nodes: top }
  }

  const r = readFile(root, 0)
  if ('error' in r) result.error = r.error.startsWith('Could not open') ? r.error : r.error
  else result.nodes = r.nodes
  return result
}

/** Identifiant (Debian) du module chargé par `LoadModule x_module …`, null s'il est inconnu. */
export const moduleOfLoad = (identifier: string): string | null => {
  const m = /^(.+)_module$/.exec(identifier)
  const name = m?.[1] ?? ''
  return name in APACHE_MODS ? name : null
}

/** Nom `mod_x.c` d'un module compilé dans le binaire Debian (apache2 -l). */
const STATIC_C = new Set([
  'core.c',
  'mod_so.c',
  'mod_watchdog.c',
  'http_core.c',
  'mod_log_config.c',
  'mod_logio.c',
  'mod_version.c',
  'mod_unixd.c'
])

// ---------------------------------------------------------------------------------------------
// Modèle de la configuration
// ---------------------------------------------------------------------------------------------

export type Authz =
  | { t: 'all' | 'any' | 'none'; items: Authz[] }
  | { t: 'req'; provider: string; args: string[]; negate: boolean }

export interface LogSpec {
  target: string
  format: string
}

export interface Scope {
  serverName?: string
  serverAliases: string[]
  documentRoot?: string
  errorLog?: string
  customLogs: LogSpec[]
  directoryIndex?: string[]
  aliases: { from: string; to: string; script: boolean }[]
  redirects: { status: number; from: string; to: string }[]
  sslEngine: boolean
  sslCert?: string
  sslKey?: string
  /** Niveau de journalisation d'erreurs (LogLevel), premier mot : warn, info, debug… */
  logLevel?: string
}

export interface Section {
  kind: 'Directory' | 'DirectoryMatch' | 'Location' | 'LocationMatch' | 'Files' | 'FilesMatch'
  pattern: string
  /** Serveur virtuel (index dans `vhosts`) ; -1 : serveur principal. */
  vhost: number
  options: string[] | null
  directoryIndex?: string[]
  authz: Authz | null
  order: number
}

export interface VirtualHost extends Scope {
  /** Adresses de la section (« * », « 192.168.2.10 », « _default_ ») et port (0 : tous). */
  addrs: { host: string | null; port: number }[]
  file: string
  line: number
}

export interface ApacheConfig {
  /** Erreur de lecture de la configuration (avant tout contrôle de syntaxe), avec préfixe « apache2: ». */
  readError?: string
  /** Erreur de syntaxe (AH00526) : deux lignes. */
  syntaxError?: string
  /** Avertissements affichés avant « Syntax OK ». */
  warnings: string[]
  modules: string[]
  listens: { host: string | null; port: number; proto: string }[]
  main: Scope
  vhosts: VirtualHost[]
  sections: Section[]
  logFormats: Record<string, string>
  serverTokens: string
  serverSignature: 'on' | 'off' | 'email'
  /** Types MIME compressés par mod_deflate (AddOutputFilterByType DEFLATE …). */
  deflateTypes: string[]
  /** Nom du serveur principal (ServerName global ou nom déduit de la machine). */
  serverHostname: string
  mainFile: string
}

const emptyScope = (): Scope => ({
  serverAliases: [],
  customLogs: [],
  aliases: [],
  redirects: [],
  sslEngine: false
})

const MPMS = ['mpm_event', 'mpm_worker', 'mpm_prefork']

/** Valeur de `ServerName` : « nom », « nom:port », « http://nom:port ». */
const serverNameOf = (value: string): string => {
  const noScheme = value.replace(/^[a-z]+:\/\//i, '')
  return noScheme.replace(/:\d+$/, '').replace(/\/.*$/, '')
}

/** Adresse d'un `Listen` / `<VirtualHost>` : « 80 », « *:80 », « 192.168.2.10:8080 », « _default_:443 ». */
export function parseAddr(text: string): { host: string | null; port: number } | null {
  if (/^\d+$/.test(text)) return { host: null, port: Number(text) }
  const m = /^(\[[^\]]*\]|[^:]+)(?::(\d+|\*))?$/.exec(text)
  if (!m) return null
  const host = m[1] === '*' || m[1] === '_default_' ? null : (m[1] as string)
  return { host, port: m[2] === undefined || m[2] === '*' ? 0 : Number(m[2]) }
}

/** Sélection de l'arbre d'après les `IfModule` / `IfDefine` puis contrôle de chaque directive. */
export function parseConfig(src: ConfigSource, ctx: ServerContext): ApacheConfig {
  const built = buildConfig(src)
  const cfg: ApacheConfig = {
    warnings: [],
    modules: [],
    listens: [],
    main: emptyScope(),
    vhosts: [],
    sections: [],
    logFormats: {},
    serverTokens: 'OS',
    serverSignature: 'on',
    deflateTypes: [],
    serverHostname: '',
    mainFile: `${APACHE_DIR}/apache2.conf`
  }
  if (built.error !== undefined) {
    cfg.readError = `apache2: ${built.error}`
    return cfg
  }
  // LoadModule est exécuté à la lecture : tous les modules sont connus avant le parcours de l'arbre
  for (const l of built.loads) {
    const name = moduleOfLoad(l.module)
    if (name !== null) {
      cfg.modules.push(name)
    }
  }
  const mpmCount = cfg.modules.filter((m) => MPMS.includes(m)).length
  if (mpmCount !== 1) {
    cfg.readError = `AH00534: apache2: Configuration error: ${mpmCount === 0 ? 'No MPM loaded.' : 'More than one MPM loaded.'}`
    return cfg
  }

  const defines: Record<string, string> = {}
  let order = 0
  const fail = (n: RawNode, message: string): never => {
    throw Object.assign(new Error(message), { node: n })
  }
  const moduleAvailable = (id: string) =>
    id === 'core' || cfg.modules.includes(id) || (id.startsWith('mpm_') && cfg.modules.includes(id))
  const ifModuleTrue = (arg: string): boolean => {
    const neg = arg.startsWith('!')
    const a = neg ? arg.slice(1) : arg
    let present: boolean
    if (a.endsWith('.c'))
      present = STATIC_C.has(a) || cfg.modules.includes(a.replace(/^mod_/, '').replace(/\.c$/, ''))
    else if (a.endsWith('_module')) present = cfg.modules.includes(a.slice(0, -7)) || a === 'core_module'
    else present = false
    return neg ? !present : present
  }

  type Context = { scope: Scope; vhost: number; section: Section | null; authz: Authz[] }
  const walk = (nodes: RawNode[], c: Context): void => {
    for (const n of nodes) {
      const lname = n.name.toLowerCase()
      const args = expandVars(n.args, defines)
      if (n.children) {
        const sec = lname.slice(1)
        if (sec === 'ifmodule') {
          if (args === '') fail(n, "<IfModule > directive missing closing '>'")
          if (ifModuleTrue(splitArgs(args)[0] ?? '')) walk(n.children, c)
        } else if (sec === 'ifdefine') {
          const a = splitArgs(args)[0] ?? ''
          const neg = a.startsWith('!')
          if (a.replace(/^!/, '') in defines !== neg) walk(n.children, c)
        } else if (sec === 'virtualhost') {
          if (c.vhost >= 0 || c.section) fail(n, '<VirtualHost> directive not allowed here')
          if (args === '') fail(n, '<VirtualHost> directive requires additional arguments')
          const addrs = splitArgs(args).map((a) => parseAddr(a))
          if (addrs.some((a) => a === null)) fail(n, 'Invalid address or port')
          const v: VirtualHost = {
            ...emptyScope(),
            addrs: addrs as { host: string | null; port: number }[],
            file: n.file,
            line: n.line
          }
          cfg.vhosts.push(v)
          walk(n.children, { scope: v, vhost: cfg.vhosts.length - 1, section: null, authz: [] })
        } else if (
          ['directory', 'directorymatch', 'location', 'locationmatch', 'files', 'filesmatch'].includes(sec)
        ) {
          const kind = (sec[0] as string).toUpperCase() + sec.slice(1).replace('match', 'Match')
          const pattern = splitArgs(args).slice(-1)[0] ?? ''
          if (pattern === '') fail(n, `${n.name}> directive requires additional arguments`)
          const s: Section = {
            kind: kind as Section['kind'],
            pattern,
            vhost: c.vhost,
            options: null,
            authz: null,
            order: order++
          }
          cfg.sections.push(s)
          walk(n.children, { ...c, section: s, authz: [] })
          if (c.authz.length === 0 && s.authz === null) s.authz = null
        } else if (['requireall', 'requireany', 'requirenone'].includes(sec)) {
          const group: Authz = { t: sec.slice(7) as 'all' | 'any' | 'none', items: [] }
          const parent = c.authz.at(-1)
          if (parent && 't' in parent && parent.t !== 'req') parent.items.push(group)
          else if (c.section) {
            const top = (c.section.authz ??= { t: 'any', items: [] })
            if (top.t !== 'req') top.items.push(group)
          }
          walk(n.children, { ...c, authz: [...c.authz, group] })
        } else {
          // Sections non modélisées (Limit, If, Proxy…) : leur contenu est contrôlé, pas appliqué
          walk(n.children, { ...c, section: null })
        }
        continue
      }
      directive(n, lname, args, c)
    }
  }

  const directive = (n: RawNode, lname: string, args: string, c: Context): void => {
    const owner = APACHE_DIRECTIVES[lname]
    if (lname === 'listen') {
      const a = splitArgs(args)
      if (a.length < 1 || a.length > 2) fail(n, 'Listen requires 1 or 2 arguments.')
      const addr = parseAddr(a[0] as string)
      if (addr === null) fail(n, 'Invalid address or port')
      if ((addr as { port: number }).port === 0) fail(n, 'Port must be specified')
      const ad = addr as { host: string | null; port: number }
      cfg.listens.push({
        host: ad.host,
        port: ad.port,
        proto: a[1]?.toLowerCase() ?? (ad.port === 443 ? 'https' : 'http')
      })
      return
    }
    if (owner === undefined || !moduleAvailable(owner))
      fail(
        n,
        `Invalid command '${n.name}', perhaps misspelled or defined by a module not included in the server configuration`
      )
    const arity = APACHE_ARITY[lname]
    if (arity) checkArity(n, arity, args)
    const a = splitArgs(args)
    const scope = c.scope
    switch (lname) {
      case 'define':
        defines[a[0] ?? ''] = a[1] ?? ''
        return
      case 'servername':
        scope.serverName = serverNameOf(a[0] as string)
        return
      case 'serveralias':
        scope.serverAliases.push(...a)
        return
      case 'documentroot': {
        const path = absolute(a[0] as string).replace(/\/+$/, '') || '/'
        const st = ctx.stat(path)
        if (st?.type !== 'dir') {
          if (c.vhost < 0) fail(n, `DocumentRoot '${path}' is not a directory, or is not readable`)
          cfg.warnings.push(`AH00112: Warning: DocumentRoot [${path}] does not exist`)
        }
        scope.documentRoot = path
        return
      }
      case 'errorlog':
        scope.errorLog = a[0]
        return
      case 'logformat':
        if (a.length === 2) cfg.logFormats[a[1] as string] = a[0] as string
        else if (a[0] !== undefined) cfg.logFormats['@default'] = a[0]
        return
      case 'customlog':
        scope.customLogs.push({ target: a[0] as string, format: a[1] ?? '' })
        return
      case 'directoryindex':
        if (c.section) c.section.directoryIndex = a
        else scope.directoryIndex = a
        return
      case 'alias':
      case 'scriptalias':
        if (a.length === 2)
          scope.aliases.push({ from: a[0] as string, to: a[1] as string, script: lname === 'scriptalias' })
        return
      case 'redirect':
      case 'redirectpermanent':
      case 'redirecttemp': {
        let status = lname === 'redirectpermanent' ? 301 : 302
        let rest = a
        if (lname === 'redirect' && a.length === 3) {
          const word = (a[0] as string).toLowerCase()
          status = { permanent: 301, temp: 302, seeother: 303, gone: 410 }[word] ?? Number(word)
          rest = a.slice(1)
        }
        if (rest.length === 2)
          scope.redirects.push({ status, from: rest[0] as string, to: rest[1] as string })
        return
      }
      case 'loglevel':
        scope.logLevel = (a[0] ?? '').toLowerCase()
        return
      case 'servertokens':
        cfg.serverTokens = (a[0] as string).toLowerCase()
        return
      case 'serversignature':
        if (!['on', 'off', 'email'].includes((a[0] as string).toLowerCase()))
          fail(n, 'ServerSignature: use one of: off | on | email')
        cfg.serverSignature = (a[0] as string).toLowerCase() as 'on' | 'off' | 'email'
        return
      case 'sslengine':
        scope.sslEngine = (a[0] as string).toLowerCase() === 'on'
        return
      case 'sslcertificatefile':
      case 'sslcertificatekeyfile': {
        const path = absolute(a[0] as string)
        const st = ctx.stat(path)
        if (st?.type !== 'file' || st.size === 0)
          fail(n, `${n.name}: file '${path}' does not exist or is empty`)
        if (lname === 'sslcertificatefile') scope.sslCert = path
        else scope.sslKey = path
        return
      }
      case 'options': {
        if (c.section) c.section.options = [...(c.section.options ?? []), ...a]
        return
      }
      case 'require': {
        const negate = (a[0] ?? '').toLowerCase() === 'not'
        const parts = negate ? a.slice(1) : a
        const leaf: Authz = {
          t: 'req',
          provider: (parts[0] ?? '').toLowerCase(),
          args: parts.slice(1),
          negate
        }
        const parent = c.authz.at(-1)
        if (parent && parent.t !== 'req') parent.items.push(leaf)
        else if (c.section) {
          const top = (c.section.authz ??= { t: 'any', items: [] })
          if (top.t !== 'req') top.items.push(leaf)
        }
        return
      }
      case 'addoutputfilterbytype':
        if ((a[0] ?? '').toUpperCase() === 'DEFLATE') cfg.deflateTypes.push(...a.slice(1))
        return
      default:
    }
  }

  /** Nombre d'arguments d'une directive, avec les messages de server/config.c (invoke_cmd). */
  const checkArity = (n: RawNode, [kind, help]: [string, string], args: string): void => {
    const a = splitArgs(args)
    const tail = help ? `, ${help}` : ''
    const bad = (what: string) => fail(n, `${n.name} ${what}${tail}`)
    switch (kind) {
      case 'NO_ARGS':
        if (a.length > 0) fail(n, `${n.name} takes no arguments`)
        break
      case 'TAKE1':
        if (a.length !== 1) bad('takes one argument')
        break
      case 'TAKE2':
        if (a.length !== 2) bad('takes two arguments')
        break
      case 'TAKE12':
        if (a.length < 1 || a.length > 2) bad('takes 1-2 arguments')
        break
      case 'TAKE3':
        if (a.length !== 3) bad('takes three arguments')
        break
      case 'TAKE23':
        if (a.length < 2 || a.length > 3) bad('takes two or three arguments')
        break
      case 'TAKE123':
        if (a.length < 1 || a.length > 3) bad('takes one, two or three arguments')
        break
      case 'TAKE13':
        if (a.length !== 1 && a.length !== 3) bad('takes one or three arguments')
        break
      case 'ITERATE':
        if (a.length < 1) bad('requires at least one argument')
        break
      case 'ITERATE2':
        if (a.length < 2) bad('requires at least two arguments')
        break
      case 'FLAG':
        if (a.length < 1 || !['on', 'off'].includes((a[0] as string).toLowerCase()))
          fail(n, `${n.name} must be On or Off`)
        break
      default:
    }
  }

  try {
    walk(built.nodes, { scope: cfg.main, vhost: -1, section: null, authz: [] })
  } catch (e) {
    const node = (e as { node?: RawNode }).node
    if (node)
      cfg.syntaxError = `AH00526: Syntax error on line ${node.line} of ${node.file}:\n${(e as Error).message}`
    else throw e
  }
  // Nom du serveur : ServerName global, sinon déduit de la machine (ap_get_local_host)
  if (cfg.main.serverName !== undefined) cfg.serverHostname = cfg.main.serverName
  else {
    const guess = localHostName(ctx)
    cfg.serverHostname = guess.name
    cfg.warnings.push(...guess.warnings)
  }
  return cfg
}

/** `ap_get_local_host` : nom du serveur principal quand aucun ServerName global n'est donné. */
export function localHostName(ctx: ServerContext): { name: string; warnings: string[] } {
  const mapped = ctx.hostsText
    .split('\n')
    .map((l) => l.replace(/#.*/, '').trim().split(/\s+/))
    .find((f) => f.length >= 2 && f.slice(1).some((h) => h.toLowerCase() === ctx.hostname.toLowerCase()))
  const warnings: string[] = []
  let name: string
  if (!mapped) {
    warnings.push(`AH00557: apache2: apr_sockaddr_info_get() failed for ${ctx.hostname}`)
    name = '127.0.0.1'
  } else if ((mapped[1] as string).includes('.')) {
    return { name: mapped[1] as string, warnings: [] }
  } else name = mapped[0] as string
  warnings.push(
    `AH00558: apache2: Could not reliably determine the server's fully qualified domain name, using ${name}. Set the 'ServerName' directive globally to suppress this message`
  )
  return { name, warnings }
}

/** Texte de `apache2ctl configtest` : [sortie standard, erreurs, code de sortie]. */
export function configTest(cfg: ApacheConfig): { stderr: string[]; ok: boolean } {
  if (cfg.readError !== undefined) return { stderr: [cfg.readError], ok: false }
  if (cfg.syntaxError !== undefined) return { stderr: [...cfg.syntaxError.split('\n')], ok: false }
  return { stderr: [...cfg.warnings, 'Syntax OK'], ok: true }
}

/** Ports et adresses d'écoute (Listen) ; sans Listen, Apache refuse de démarrer. */
export interface ListenAddr {
  host: string | null
  port: number
}

// ---------------------------------------------------------------------------------------------
// apache2ctl -S
// ---------------------------------------------------------------------------------------------

/** Hachage des adresses IPv4 de server/vhost.c (hash_inaddr), clé lue en little-endian. */
function ipBucket(ip: string): number {
  const [a = 0, b = 0, c = 0, d = 0] = ip.split('.').map(Number)
  let key = (((d << 24) | (c << 16) | (b << 8) | a) >>> 0) as number
  key = (key ^ (key >>> 16)) >>> 0
  return ((key >>> 8) ^ key) % 256
}

const pad = (text: string, n: number) => text.padEnd(n)

/** Contenu de `apache2ctl -S` (serveurs virtuels puis paramètres d'exécution). */
export function dumpVhosts(cfg: ApacheConfig, ctx: ServerContext): string[] {
  interface Chain {
    key: string
    host: string | null
    port: number
    vhosts: VirtualHost[]
  }
  const wildcard: Chain[] = []
  const buckets: Chain[][] = Array.from({ length: 256 }, () => [])
  // Les hôtes virtuels sont traités dans l'ordre inverse du fichier (server/vhost.c)
  const reverse = [...cfg.vhosts].reverse()
  for (const v of reverse)
    for (const addr of v.addrs) {
      const find = (list: Chain[]) => list.find((c) => c.host === addr.host && c.port === addr.port)
      let chain: Chain | undefined
      if (addr.host === null) {
        chain = find(wildcard)
        if (!chain) {
          chain = { key: '', host: null, port: addr.port, vhosts: [] }
          wildcard.unshift(chain)
        }
      } else {
        const bucket = buckets[ipBucket(addr.host)] as Chain[]
        chain = find(bucket)
        if (!chain) {
          chain = { key: '', host: addr.host, port: addr.port, vhosts: [] }
          bucket.unshift(chain)
        }
      }
      chain.vhosts.unshift(v)
    }
  const name = (v: VirtualHost) =>
    v.serverName ?? (v.addrs.some((a) => a.host === null) ? cfg.serverHostname : (v.addrs[0]?.host ?? ''))
  const lines = ['VirtualHost configuration:']
  const dump = (c: Chain) => {
    const label = c.host === null ? `*:${c.port || '*'}` : `${c.host}:${c.port || '*'}`
    const first = c.vhosts[0] as VirtualHost
    if (c.vhosts.length === 1) {
      lines.push(`${pad(label, 22)} ${name(first)} (${first.file}:${first.line})`)
      return
    }
    lines.push(`${pad(label, 22)} is a NameVirtualHost`)
    lines.push(`${' '.repeat(8)} default server ${name(first)} (${first.file}:${first.line})`)
    for (const v of c.vhosts) {
      lines.push(`${' '.repeat(8)} port ${c.port || '*'} namevhost ${name(v)} (${v.file}:${v.line})`)
      for (const alias of v.serverAliases.filter((x) => !/[*?]/.test(x)))
        lines.push(`${' '.repeat(16)} alias ${alias}`)
      for (const alias of v.serverAliases.filter((x) => /[*?]/.test(x)))
        lines.push(`${' '.repeat(16)} wild alias ${alias}`)
    }
  }
  buckets.forEach((b) => b.forEach(dump))
  wildcard.forEach(dump)
  const root = cfg.main.documentRoot ?? `${SERVER_ROOT}/htdocs`
  const log = cfg.main.errorLog ?? 'logs/error_log'
  lines.push(
    `ServerRoot: "${SERVER_ROOT}"`,
    `Main DocumentRoot: "${root}"`,
    `Main ErrorLog: "${absolute(expandVars(log))}"`,
    `Mutex default: dir="${ENV.APACHE_RUN_DIR}/" mechanism=default `,
    'Mutex mpm-accept: using_defaults',
    'Mutex watchdog-callback: using_defaults',
    `PidFile: "${ENV.APACHE_PID_FILE}"`,
    'Define: DUMP_VHOSTS',
    'Define: DUMP_RUN_CFG',
    'User: name="www-data" id=33',
    'Group: name="www-data" id=33'
  )
  void ctx
  return lines
}

/** Fichiers de journaux cités par la configuration (ErrorLog, CustomLog), chemins absolus. */
export function configuredLogs(cfg: ApacheConfig): string[] {
  const out = new Set<string>()
  const scopes: Scope[] = [cfg.main, ...cfg.vhosts]
  for (const s of scopes) {
    if (s.errorLog && !s.errorLog.startsWith('|') && !s.errorLog.startsWith('syslog'))
      out.add(absolute(expandVars(s.errorLog)))
    for (const l of s.customLogs) if (!l.target.startsWith('|')) out.add(absolute(expandVars(l.target)))
  }
  return [...out]
}

/** Adresses d'écoute (Listen) et protocole, pour ss. */
export const listenSpecs = (cfg: ApacheConfig): { host: string | null; port: number }[] =>
  cfg.listens.map((l) => ({ host: l.host, port: l.port }))
