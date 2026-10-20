/**
 * Réponses HTTP d'un serveur Apache simulé (v2.9, #238) : choix du site (VirtualHost par nom, adresse et
 * port), DocumentRoot, DirectoryIndex, `Require` / `Options`, redirections, pages d'erreur, en-têtes et
 * lignes de journal. Tout est calculé depuis la configuration en vigueur d'Apache (dernier démarrage ou
 * rechargement) et les fichiers du serveur : changer un site ou un module n'a d'effet qu'après
 * `systemctl reload apache2`, comme sur un vrai serveur.
 *
 * Sources : textes des pages d'erreur et du pied de page (modules/http/http_protocol.c, server/core.c),
 * messages d'erreur et niveaux de journalisation (server/request.c, modules/aaa/mod_authz_core.c,
 * modules/mappers/mod_autoindex.c), ETag (modules/http/http_etag.c) — httpd 2.4.68, sources.debian.org.
 * Limites assumées : docs/fidelite.md, lignes L-70 à L-79.
 */
import { LAB_EPOCH_MS } from '../core/clock'
import { transact, type EngineResult } from '../core/result'
import { parseIpv4, prefixToMaskInt } from '../net/ipv4'
import type { HostDevice, LabState } from '../model/schema'
import type { LinuxNode } from '../model/linuxnode'
import {
  expandVars,
  type ApacheConfig,
  type Authz,
  type Scope,
  type Section,
  type VirtualHost
} from './linuxapache'
import {
  apacheConfig,
  appendAccessLog,
  appendErrorLog,
  serverBanner,
  serverDescription
} from './linuxapachehost'
import { findUnit } from './linuxcatalog'
import { resolveLink } from './linuxconfig'
import { isInstalled } from './linuxpackages'
import { listensOf, unitPid, unitStatus } from './linuxsystem'

export interface WebRequest {
  scheme: 'http' | 'https'
  /** Nom demandé (en-tête Host, sans le port). */
  host: string
  /** Port de destination. */
  port: number
  /** Adresse IPv4 de destination (celle du serveur). */
  dstIp: string
  /** Chemin et paramètres demandés (« /index.html?a=1 »). */
  path: string
  method: 'GET' | 'HEAD'
  clientIp: string
  clientPort: number
  userAgent: string
}

export interface WebResponse {
  status: number
  statusText: string
  headers: [string, string][]
  /** Corps de la réponse (vide pour HEAD). */
  body: string
  /** Fichier servi (chemin sur le serveur) ou null. */
  file: string | null
  /** Site qui a répondu (ServerName), pour l'affichage. */
  site: string
  /** HTTPS : certificat présenté. */
  tls: { certificate: string; commonName: string } | null
  /** Limites de la simulation à signaler à l'élève (contenu non reproduit…). */
  notes: string[]
  /** Lignes à journaliser (access.log, error.log et journaux des sites). */
  logs: { access: { file: string; line: string }[]; errors: ErrorLine[]; client: string }
}

interface ErrorLine {
  file: string
  module: string
  level: string
  message: string
  errno?: string
}

/** Panne avant toute réponse HTTP : rien n'écoute, ou la connexion TLS échoue. */
export type WebFailure = { failure: 'refused' } | { failure: 'tls-version' }

export type FileView = Record<string, LinuxNode>

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  410: 'Gone'
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const p2 = (n: number) => String(n).padStart(2, '0')

/** Date HTTP (RFC 7231) : « Tue, 20 Oct 2026 08:00:03 GMT ». */
export function httpDate(ms: number): string {
  const d = new Date(ms)
  return `${DAYS[d.getUTCDay()]}, ${p2(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} GMT`
}

function byteLength(text: string): number {
  let n = 0
  for (const ch of text) {
    const c = ch.codePointAt(0) as number
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4
  }
  return n
}

/** Types MIME de /etc/mime.types (extrait des extensions courantes). */
const MIME: Record<string, string> = {
  html: 'text/html',
  htm: 'text/html',
  shtml: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  txt: 'text/plain',
  csv: 'text/csv',
  xml: 'application/xml',
  json: 'application/json',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  ico: 'image/vnd.microsoft.icon',
  zip: 'application/zip',
  php: 'application/x-httpd-php'
}

// ---------------------------------------------------------------------------------------------
// Pages d'erreur (modules/http/http_protocol.c)
// ---------------------------------------------------------------------------------------------

const DOCTYPE = '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd">\n'

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function canned(status: number, location: string, plainHttp: boolean): string {
  switch (status) {
    case 301:
    case 302:
      return `<p>The document has moved <a href="${escapeHtml(location)}">here</a>.</p>\n`
    case 303:
      return `<p>The answer to your request is located <a href="${escapeHtml(location)}">here</a>.</p>\n`
    case 401:
      return "<p>This server could not verify that you\nare authorized to access the document\nrequested.  Either you supplied the wrong\ncredentials (e.g., bad password), or your\nbrowser doesn't understand how to supply\nthe credentials required.</p>\n"
    case 400:
      return plainHttp
        ? "<p>Your browser sent a request that this server could not understand.<br />\nReason: You're speaking plain HTTP to an SSL-enabled server port.<br />\n Instead use the HTTPS scheme to access this URL, please.<br />\n</p>\n"
        : '<p>Your browser sent a request that this server could not understand.<br />\n</p>\n'
    case 403:
      return "<p>You don't have permission to access this resource.</p>\n"
    case 404:
      return '<p>The requested URL was not found on this server.</p>\n'
    default:
      return ''
  }
}

// ---------------------------------------------------------------------------------------------
// Choix du site
// ---------------------------------------------------------------------------------------------

const globToRegExp = (pattern: string): RegExp =>
  new RegExp(
    `^${pattern
      .replace(/[.+^${}()|\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')}$`,
    'i'
  )

/** Le serveur écoute-t-il ce port sur cette adresse (configuration en vigueur, service actif) ? */
export function apacheListening(host: HostDevice, port: number, dstIp: string): boolean {
  const unit = findUnit('apache2')
  if (!unit || !isInstalled(host, unit.pkg) || !host.powered || !unitStatus(host, unit).active) return false
  return listensOf(host, unit).some(
    (l) => l.port === port && (l.address === undefined || l.address === '0.0.0.0' || l.address === dstIp)
  )
}

interface Chosen {
  vhost: VirtualHost | null
  scope: Scope
  index: number
  name: string
  ssl: boolean
}

function chooseSite(cfg: ApacheConfig, req: WebRequest): Chosen {
  const matching = cfg.vhosts
    .map((v, index) => ({ v, index }))
    .filter(({ v }) =>
      v.addrs.some((a) => (a.port === 0 || a.port === req.port) && (a.host === null || a.host === req.dstIp))
    )
  // Une adresse précise l'emporte sur le joker (find_ipaddr avant default_list)
  const exact = matching.filter(({ v }) =>
    v.addrs.some((a) => a.host === req.dstIp && (a.port === 0 || a.port === req.port))
  )
  const pool = exact.length > 0 ? exact : matching
  if (pool.length === 0) {
    return {
      vhost: null,
      scope: cfg.main,
      index: -1,
      name: cfg.serverHostname,
      ssl: cfg.main.sslEngine && req.port === 443
    }
  }
  const wanted = req.host.toLowerCase()
  const byName = pool.find(
    ({ v }) =>
      (v.serverName ?? '').toLowerCase() === wanted ||
      v.serverAliases.some((alias) => globToRegExp(alias).test(wanted))
  )
  const pick = byName ?? (pool[0] as { v: VirtualHost; index: number })
  return {
    vhost: pick.v,
    scope: pick.v,
    index: pick.index,
    name: pick.v.serverName ?? cfg.serverHostname,
    ssl: pick.v.sslEngine
  }
}

// ---------------------------------------------------------------------------------------------
// Droits d'accès : Require, Options, DirectoryIndex
// ---------------------------------------------------------------------------------------------

type Verdict = 'granted' | 'denied' | 'auth'

function ipInList(ip: string, items: string[]): boolean {
  const n = parseIpv4(ip)
  if (n === null) return false
  return items.some((item) => {
    const [base = '', len] = item.split('/')
    if (len !== undefined) {
      const b = parseIpv4(base)
      return (
        b !== null && (n & prefixToMaskInt(Number(len))) >>> 0 === (b & prefixToMaskInt(Number(len))) >>> 0
      )
    }
    // Adresse partielle (« 192.168.2 ») ou complète
    return ip === base || ip.startsWith(`${base}.`)
  })
}

function evalAuthz(node: Authz, req: WebRequest, local: string[]): Verdict {
  if (node.t === 'req') {
    let v: Verdict
    switch (node.provider) {
      case 'all':
        v = (node.args[0] ?? '').toLowerCase() === 'granted' ? 'granted' : 'denied'
        break
      case 'ip':
        v = ipInList(req.clientIp, node.args) ? 'granted' : 'denied'
        break
      case 'local':
        v = req.clientIp.startsWith('127.') || local.includes(req.clientIp) ? 'granted' : 'denied'
        break
      case 'method':
        v = node.args.map((a) => a.toUpperCase()).includes(req.method) ? 'granted' : 'denied'
        break
      case 'valid-user':
      case 'user':
      case 'group':
        // Sans identifiants : le serveur répond 401 (l'authentification n'est pas simulée)
        v = 'auth'
        break
      default:
        v = 'denied'
    }
    if (node.negate) return v === 'granted' ? 'denied' : v === 'denied' ? 'granted' : 'denied'
    return v
  }
  const results = node.items.map((i) => evalAuthz(i, req, local))
  if (node.t === 'any') {
    if (results.includes('granted')) return 'granted'
    return results.includes('auth') ? 'auth' : 'denied'
  }
  if (node.t === 'all') {
    if (results.length === 0) return 'granted'
    if (results.every((r) => r === 'granted')) return 'granted'
    return results.includes('denied') ? 'denied' : 'auth'
  }
  // RequireNone : accordé seulement si aucun sous-élément ne l'est
  return results.some((r) => r === 'granted') ? 'denied' : 'granted'
}

function appliesToPath(s: Section, filePath: string, urlPath: string): boolean {
  const norm = (p: string) => p.replace(/\/+$/, '') || '/'
  switch (s.kind) {
    case 'Directory': {
      const p = norm(expandVars(s.pattern))
      if (/[*?]/.test(p)) return globToRegExp(p).test(norm(filePath)) || globToRegExp(`${p}/*`).test(filePath)
      return p === '/' || filePath === p || filePath.startsWith(`${p}/`)
    }
    case 'DirectoryMatch':
      return safeRegex(s.pattern, filePath)
    case 'Location': {
      const p = norm(s.pattern)
      return p === '/' || urlPath === p || urlPath.startsWith(`${p}/`)
    }
    case 'LocationMatch':
      return safeRegex(s.pattern, urlPath)
    case 'Files': {
      const base = filePath.slice(filePath.lastIndexOf('/') + 1)
      return globToRegExp(s.pattern).test(base)
    }
    case 'FilesMatch':
      return safeRegex(s.pattern, filePath.slice(filePath.lastIndexOf('/') + 1))
  }
}

function safeRegex(pattern: string, text: string): boolean {
  try {
    return new RegExp(pattern.replace(/^~\s*/, '')).test(text)
  } catch {
    return false
  }
}

/** Sections applicables, de la plus générale à la plus précise (Directory, puis Files, puis Location). */
function sectionsFor(cfg: ApacheConfig, vhost: number, filePath: string, urlPath: string): Section[] {
  const rank = (s: Section) => (s.kind.startsWith('Directory') ? 0 : s.kind.startsWith('Files') ? 1 : 2)
  return cfg.sections
    .filter((s) => (s.vhost === -1 || s.vhost === vhost) && appliesToPath(s, filePath, urlPath))
    .sort((a, b) => {
      if (rank(a) !== rank(b)) return rank(a) - rank(b)
      if (rank(a) === 0) {
        const depth = (s: Section) =>
          s.kind === 'Directory' ? s.pattern.split('/').filter(Boolean).length : 99
        if (depth(a) !== depth(b)) return depth(a) - depth(b)
      }
      // À égalité, le serveur principal avant l'hôte virtuel, puis l'ordre du fichier
      if (a.vhost !== b.vhost) return a.vhost - b.vhost
      return a.order - b.order
    })
}

function effectiveOptions(sections: Section[]): Set<string> {
  let set = new Set<string>(['followsymlinks'])
  for (const s of sections) {
    if (!s.options) continue
    const tokens = s.options.map((o) => o.toLowerCase())
    if (tokens.some((t) => t.startsWith('+') || t.startsWith('-'))) {
      set = new Set(set)
      for (const t of tokens) {
        if (t.startsWith('+')) set.add(t.slice(1))
        else if (t.startsWith('-')) set.delete(t.slice(1))
      }
    } else {
      set = new Set(
        tokens.flatMap((t) =>
          t === 'all' ? ['indexes', 'followsymlinks', 'execcgi', 'includes'] : t === 'none' ? [] : [t]
        )
      )
    }
  }
  return set
}

// ---------------------------------------------------------------------------------------------
// Système de fichiers vu par www-data
// ---------------------------------------------------------------------------------------------

function wwwDataGroups(files: FileView, read: (p: string) => string): Set<string> {
  const groups = new Set<string>()
  for (const line of read('/etc/group').split('\n')) {
    const f = line.split(':')
    if (f[0] === 'www-data' || (f[3] ?? '').split(',').includes('www-data')) groups.add(f[0] as string)
  }
  void files
  return groups
}

function allowed(node: LinuxNode, groups: Set<string>, want: 4 | 1): boolean {
  const shift = node.owner === 'www-data' ? 6 : groups.has(node.group) ? 3 : 0
  return ((node.mode >> shift) & want) !== 0
}

function follow(files: FileView, path: string): { path: string; node: LinuxNode | undefined } {
  let p = path
  for (let i = 0; i < 8 && files[p]?.link !== undefined; i++) p = resolveLink(p, files[p]?.link as string)
  return { path: p, node: files[p] }
}

const parentOf = (path: string) => path.replace(/\/[^/]*$/, '') || '/'

/** Tous les dossiers parents sont-ils traversables par www-data (droit x) ? */
function traversable(files: FileView, groups: Set<string>, path: string): boolean {
  let dir = parentOf(path)
  for (;;) {
    const n = follow(files, dir).node
    if (n && !allowed(n, groups, 1)) return false
    if (dir === '/') return true
    dir = parentOf(dir)
  }
}

// ---------------------------------------------------------------------------------------------
// Journal d'accès
// ---------------------------------------------------------------------------------------------

function formatAccess(
  format: string,
  v: {
    req: WebRequest
    status: number
    bytes: number
    headerBytes: number
    serverName: string
    request: string
  }
): string {
  const [path = '/', query] = v.req.path.split('?')
  return format.replace(
    /%(?:\{([^}]*)\}([a-zA-Z])|>?([a-zA-Z%]))/g,
    (all, arg: string | undefined, c1: string | undefined, c2: string | undefined) => {
      const c = c1 ?? c2
      if (c1 !== undefined && arg !== undefined) {
        if (c === 'i') {
          const name = arg.toLowerCase()
          if (name === 'user-agent') return v.req.userAgent
          if (name === 'host') return v.req.host
          return '-'
        }
        return '-'
      }
      switch (c) {
        case 'h':
        case 'a':
          return v.req.clientIp
        case 'l':
        case 'u':
          return '-'
        case 't':
          return '[{t}]'
        case 'r':
          return v.request
        case 's':
          return String(v.status)
        case 'O':
          return String(v.bytes + v.headerBytes)
        case 'b':
          return v.bytes === 0 ? '-' : String(v.bytes)
        case 'B':
          return String(v.bytes)
        case 'v':
        case 'V':
          return v.serverName
        case 'p':
          return String(v.req.port)
        case 'U':
          return path
        case 'q':
          return query === undefined ? '' : `?${query}`
        case 'm':
          return v.req.method
        case 'H':
          return 'HTTP/1.1'
        case 'T':
        case 'D':
          return '0'
        case '%':
          return '%'
        default:
          return all
      }
    }
  )
}

// ---------------------------------------------------------------------------------------------
// Traitement d'une requête
// ---------------------------------------------------------------------------------------------

/** Chemin absolu d'un fichier de journal cité dans la configuration. */
const logPath = (target: string) => {
  const t = expandVars(target)
  return t.startsWith('/') ? t : `/etc/apache2/${t}`
}

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}

/** Normalise un chemin d'URL (., ..) en chemin absolu sous la racine. */
function normalizeUrl(path: string): string {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}${path.endsWith('/') && parts.length > 0 ? '/' : ''}`
}

const LOG_LEVELS = ['emerg', 'alert', 'crit', 'error', 'warn', 'notice', 'info', 'debug', 'trace1']
const logsInfo = (level: string | undefined) =>
  LOG_LEVELS.indexOf((level ?? 'warn').split(':').pop() ?? 'warn') >= LOG_LEVELS.indexOf('info') ||
  (level ?? '').startsWith('trace')

/**
 * Réponse du serveur Apache `host` à `req`. `files` : arborescence du serveur (nœuds du paquet compris),
 * `read` : contenu d'un fichier. Renvoie une panne si personne n'écoute ou si la connexion TLS échoue.
 */
export function webRespond(
  host: HostDevice,
  files: FileView,
  read: (path: string) => string,
  req: WebRequest,
  clock: number
): WebResponse | WebFailure {
  if (!apacheListening(host, req.port, req.dstIp)) return { failure: 'refused' }
  const cfg = apacheConfig(host, 'running')
  const site = chooseSite(cfg, req)
  if (req.scheme === 'https' && !site.ssl) return { failure: 'tls-version' }

  const banner = serverBanner(host, cfg.serverTokens)
  const now = LAB_EPOCH_MS + clock + (host.host.clockOffsetSeconds ?? 0) * 1000
  const urlHost = req.host
  const portSuffix = req.port === (req.scheme === 'https' ? 443 : 80) ? '' : `:${req.port}`
  const notes: string[] = []
  const scope = site.scope
  const errorFile = logPath(scope.errorLog ?? cfg.main.errorLog ?? '/var/log/apache2/error.log')
  const verbose = logsInfo(scope.logLevel ?? cfg.main.logLevel)
  const errors: ErrorLine[] = []
  const client = `${req.clientIp}:${req.clientPort}`
  const sign = (): string => {
    if (cfg.serverSignature === 'off') return ''
    const mail = cfg.serverSignature === 'email'
    const name = escapeHtml(urlHost)
    return mail
      ? `<hr>\n<address>${serverDescription(host)} Server at <a href="mailto:webmaster@localhost">${name}</a> Port ${req.port}</address>\n`
      : `<hr>\n<address>${serverDescription(host)} Server at ${name} Port ${req.port}</address>\n`
  }

  const errorPage = (
    status: number,
    extra: [string, string][] = [],
    location = '',
    plain = false
  ): WebResponse => {
    const title = `${status} ${STATUS_TEXT[status] ?? ''}`
    const body = `${DOCTYPE}<html><head>\n<title>${title}</title>\n</head><body>\n<h1>${title.slice(4)}</h1>\n${canned(status, location, plain)}${sign()}</body></html>\n`
    return respond(status, [...extra, ['Content-Type', 'text/html; charset=iso-8859-1']], body, null)
  }

  /** Assemble la réponse (en-têtes dans l'ordre d'Apache) et prépare les lignes de journal. */
  const respond = (
    status: number,
    extra: [string, string][],
    body: string,
    file: string | null,
    vary = false
  ): WebResponse => {
    const length = byteLength(body)
    const ct = extra.find(([k]) => k === 'Content-Type')
    const others = extra.filter(([k]) => k !== 'Content-Type')
    const headers: [string, string][] = [
      ['Date', httpDate(now)],
      ['Server', banner],
      ...others,
      ['Content-Length', String(length)],
      ...(vary ? ([['Vary', 'Accept-Encoding']] as [string, string][]) : []),
      ...(ct ? [ct] : [])
    ]
    const headerBytes =
      byteLength(`HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? ''}\r\n`) +
      headers.reduce((n, [k, v]) => n + byteLength(`${k}: ${v}\r\n`), 0) +
      2
    const formats = (scope.customLogs.length > 0 ? scope.customLogs : cfg.main.customLogs).filter(
      (l) => !l.target.startsWith('|')
    )
    const access = formats.map((l) => ({
      file: logPath(l.target),
      line: formatAccess(cfg.logFormats[l.format] ?? l.format, {
        req,
        status,
        bytes: req.method === 'HEAD' ? 0 : length,
        headerBytes,
        serverName: site.name,
        request: `${req.method} ${req.path} HTTP/1.1`
      })
    }))
    return {
      status,
      statusText: STATUS_TEXT[status] ?? '',
      headers,
      body: req.method === 'HEAD' ? '' : body,
      file,
      site: site.name,
      tls: req.scheme === 'https' ? { certificate: scope.sslCert ?? '', commonName: host.name } : null,
      notes,
      logs: { access, errors, client }
    }
  }
  const fail = (line: Omit<ErrorLine, 'file'>) => errors.push({ file: errorFile, ...line })

  // HTTP en clair sur un port TLS : 400 (mod_ssl)
  if (req.scheme === 'http' && site.ssl) return errorPage(400, [], '', true)

  // Redirections et alias (mod_alias) : ceux du site, puis ceux du serveur principal
  const urlPath = normalizeUrl(decodePath(req.path.split('?')[0] ?? '/'))
  const redirects = [...scope.redirects, ...(site.vhost ? cfg.main.redirects : [])]
  for (const r of redirects) {
    const from = r.from.replace(/\/$/, '')
    if (urlPath === from || urlPath.startsWith(`${from}/`) || (from === '' && urlPath === '/')) {
      const location =
        r.to.replace(/\/$/, '') +
        urlPath.slice(from.length) +
        (req.path.includes('?') ? `?${req.path.split('?')[1]}` : '')
      return errorPage(r.status, [['Location', location]], location)
    }
  }
  const aliases = [...scope.aliases, ...(site.vhost ? cfg.main.aliases : [])]
  const alias = aliases.find(
    (a) =>
      urlPath === a.from.replace(/\/$/, '') ||
      urlPath.startsWith(a.from.endsWith('/') ? a.from : `${a.from}/`)
  )
  const docRoot =
    (scope.documentRoot ?? cfg.main.documentRoot ?? '/etc/apache2/htdocs').replace(/\/+$/, '') || '/'
  let filePath = alias
    ? `${alias.to.replace(/\/$/, '')}${urlPath.slice(alias.from.replace(/\/$/, '').length)}`
    : `${docRoot}${urlPath === '/' ? '' : urlPath}` || '/'
  if (filePath === '') filePath = '/'
  const trailing = urlPath.endsWith('/') || urlPath === '/'
  const bare = filePath.replace(/\/+$/, '') || '/'

  // Autorisations (Require) et options du dossier demandé
  const sections = sectionsFor(cfg, site.index, bare, urlPath)
  const authzSection = [...sections].reverse().find((s) => s.authz !== null)
  const localIps = host.interfaces.map((i) => i.address).filter((a): a is string => !!a)
  if (authzSection?.authz) {
    const verdict = evalAuthz(authzSection.authz, req, localIps)
    if (verdict === 'auth') return errorPage(401, [['WWW-Authenticate', 'Basic realm="Restricted Content"']])
    if (verdict === 'denied') {
      errors.push({
        file: errorFile,
        module: 'authz_core',
        level: 'error',
        message: `AH01630: client denied by server configuration: ${bare}${trailing && bare !== '/' ? '/' : ''}`
      })
      return errorPage(403)
    }
  }

  // Le système de fichiers, vu par www-data
  const groups = wwwDataGroups(files, read)
  const resolved = follow(files, bare)
  if (!traversable(files, groups, bare)) {
    errors.push({
      file: errorFile,
      module: 'core',
      level: 'error',
      errno: '(13)Permission denied',
      message: `AH00035: access to ${urlPath} denied (filesystem path '${bare}') because search permissions are missing on a component of the path`
    })
    return errorPage(403)
  }
  if (!resolved.node) {
    if (verbose) fail({ module: 'core', level: 'info', message: `AH00128: File does not exist: ${bare}` })
    return errorPage(404)
  }
  const options = effectiveOptions(sections)
  const indexNames =
    [...sections].reverse().find((s) => s.directoryIndex)?.directoryIndex ??
    scope.directoryIndex ??
    cfg.main.directoryIndex ??
    []

  let target = resolved
  let served = bare
  if (resolved.node.type === 'dir') {
    if (!trailing) {
      const location = `${req.scheme}://${urlHost}${portSuffix}${urlPath}/${req.path.includes('?') ? `?${req.path.split('?')[1]}` : ''}`
      return errorPage(301, [['Location', location]], location)
    }
    const candidates = indexNames.map((name) => `${bare === '/' ? '' : bare}/${name}`)
    // Le sous-requête du DirectoryIndex traverse le dossier lui-même : il faut y avoir le droit x
    const blocked = candidates[0]
    if (blocked !== undefined && !traversable(files, groups, blocked)) {
      errors.push({
        file: errorFile,
        module: 'core',
        level: 'error',
        errno: '(13)Permission denied',
        message: `AH00035: access to ${urlPath} denied (filesystem path '${blocked}') because search permissions are missing on a component of the path`
      })
      return errorPage(403)
    }
    const candidate = candidates.map((p) => ({ p, ...follow(files, p) })).find((c) => c.node?.type === 'file')
    if (!candidate) {
      if (!options.has('indexes')) {
        fail({
          module: 'autoindex',
          level: 'error',
          message: `AH01276: Cannot serve directory ${bare}/: No matching DirectoryIndex (${indexNames.join(',') || 'none'}) found, and server-generated directory index forbidden by Options directive`
        })
        return errorPage(403)
      }
      notes.push(
        'La page d’index automatique (mod_autoindex) n’est pas reproduite par ServerLab : seuls l’état et les en-têtes le sont.'
      )
      const names = Object.keys(files)
        .filter((p) => parentOf(p) === bare && p !== bare)
        .map((p) => p.slice(p.lastIndexOf('/') + 1))
        .sort()
      return respond(
        200,
        [['Content-Type', 'text/html;charset=UTF-8']],
        `Index of ${urlPath}\n${names.join('\n')}\n`,
        bare
      )
    }
    target = { path: candidate.path, node: candidate.node }
    served = candidate.p
  }

  const node = target.node as LinuxNode
  if (!allowed(node, groups, 4)) {
    errors.push({
      file: errorFile,
      module: 'core',
      level: 'error',
      errno: '(13)Permission denied',
      message: `AH00132: file permissions deny server access: ${served}`
    })
    return errorPage(403)
  }
  const body = read(target.path)
  const ext = served.includes('.') ? served.slice(served.lastIndexOf('.') + 1).toLowerCase() : ''
  const type = MIME[ext]
  if (ext === 'php') notes.push('PHP n’est pas exécuté par ServerLab : le fichier est servi tel quel.')
  const mtime = LAB_EPOCH_MS + node.mtime
  const size = byteLength(body)
  const deflated = type !== undefined && cfg.deflateTypes.some((t) => t.toLowerCase() === type)
  return respond(
    200,
    [
      ['Last-Modified', httpDate(mtime)],
      ['ETag', `"${size.toString(16)}-${(mtime * 1000).toString(16)}"`],
      ['Accept-Ranges', 'bytes'],
      ...(type ? ([['Content-Type', type]] as [string, string][]) : [])
    ],
    body,
    served,
    deflated
  )
}

// ---------------------------------------------------------------------------------------------
// Journalisation de la requête (access.log, error.log)
// ---------------------------------------------------------------------------------------------

/** Écrit les lignes de journal d'une réponse sur le serveur (access.log, error.log et journaux des sites). */
export function recordRequest(state: LabState, serverId: string, response: WebResponse): EngineResult<void> {
  return transact(state, (draft) => {
    const dev = draft.devices[serverId]
    if (!dev || (dev.kind !== 'server' && dev.kind !== 'client')) return
    const unit = findUnit('apache2')
    const pid = unit ? unitPid(dev as unknown as HostDevice, unit) : 0
    for (const e of response.logs.errors)
      appendErrorLog(draft, serverId, {
        module: e.module,
        level: e.level,
        pid,
        message: e.message,
        client: response.logs.client,
        ...(e.errno ? { errno: e.errno } : {}),
        file: e.file
      })
    for (const a of response.logs.access) appendAccessLog(draft, serverId, a.file, a.line)
  })
}
