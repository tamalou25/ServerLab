/**
 * Client HTTP simulé (navigateur, Invoke-WebRequest) : résolution DNS (alias CNAME compris),
 * connexion TCP routée et tracée, choix du site par la liaison (IP, port, en-tête d'hôte),
 * contrôle du certificat en HTTPS, puis document par défaut ou fichier demandé.
 */
import type { Certificate, HostDevice, LabState, ServerDevice } from '../../model/schema'
import { effectiveIpv4 } from '../../net/addressing'
import { webRespond } from '../../services/linuxhttp'
import { contentOfHost, hostFiles } from '../../shell/bash/linuxfs'
import { sourceAddressFor } from '../../sim/forward'
import { certificateCovers, certificateTrusted } from '../../services/certificates'
import { concatTraces, type PacketTrace } from '../../sim/trace'
import { isRevoked } from '../adcs/actions'
import { serverExchange } from '../adds/locator'
import { firstAddress, resolveName } from '../dns/resolver'
import { findNode } from '../files/paths'
import type { IisBinding, IisSite } from './schema'
import { DEFAULT_DOCUMENTS, iisServerOf } from './state'
import { serviceRunning } from '../../services/servicestate'

export interface ParsedUrl {
  protocol: 'http' | 'https'
  host: string
  port: number
  /** Chemin demandé, sans la barre initiale (« » = racine). */
  path: string
}

export function parseHttpUrl(text: string): ParsedUrl | null {
  const raw = text.trim()
  const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`
  const m = /^(https?):\/\/([^/:?#\s]+)(?::(\d+))?(\/[^?#\s]*)?(?:[?#].*)?$/i.exec(withScheme)
  if (!m) return null
  const protocol = (m[1] as string).toLowerCase() as 'http' | 'https'
  const port = m[3] ? Number(m[3]) : protocol === 'https' ? 443 : 80
  if (port < 1 || port > 65535) return null
  return {
    protocol,
    host: (m[2] as string).toLowerCase(),
    port,
    path: decodeURIComponent((m[4] ?? '/').slice(1))
  }
}

/** Erreur côté client (aucune réponse HTTP). */
export type HttpFailure =
  'InvalidUrl' | 'NameNotResolved' | 'ConnectFailed' | 'TrustFailure' | 'SecureChannel'

export type HttpResult =
  | { kind: 'failure'; code: HttpFailure; message: string; url: string; trace: PacketTrace | null }
  | {
      kind: 'response'
      url: string
      status: number
      /** Sous-code IIS (404.0, 403.14…). */
      subStatus: number
      statusText: string
      server: ServerDevice
      site: IisSite | null
      /** Fichier servi (chemin local sur le serveur). */
      file: string | null
      /** Texte de la page (page d'erreur ou description du document). */
      body: string
      /** HTTPS : certificat présenté et avertissement du navigateur (null : connexion approuvée). */
      certificate: Certificate | null
      certificateWarning: string | null
      trace: PacketTrace | null
    }

export const CONNECT_FAILED = 'Impossible de se connecter au serveur distant'
export const TRUST_FAILURE =
  'La connexion sous-jacente a été fermée : Impossible d’établir une relation de confiance pour le canal sécurisé SSL/TLS.'
export const SECURE_CHANNEL = 'La demande a été abandonnée : Impossible de créer un canal sécurisé SSL/TLS.'

const ERROR_PAGES: Record<string, { text: string; body: string }> = {
  '400.0': {
    text: 'Bad Request',
    body: 'Bad Request - Invalid Hostname. HTTP Error 400. The request hostname is invalid.'
  },
  '403.14': {
    text: 'Forbidden',
    body: 'Erreur HTTP 403.14 - Forbidden. Le serveur Web est configuré pour ne pas répertorier le contenu de ce répertoire.'
  },
  '404.0': {
    text: 'Not Found',
    body: 'Erreur HTTP 404.0 - Not Found. La ressource que vous recherchez a été supprimée, son nom a été changé ou elle est temporairement indisponible.'
  }
}

function hostOf(state: LabState, id: string): HostDevice | null {
  const d = state.devices[id]
  return d && (d.kind === 'server' || d.kind === 'client') ? d : null
}

function serverAt(state: LabState, ip: string): ServerDevice | null {
  return (
    Object.values(state.devices).find(
      (d): d is ServerDevice =>
        d.kind === 'server' && d.powered && d.interfaces.some((i) => effectiveIpv4(i)?.address === ip)
    ) ?? null
  )
}

/** Site qui répond (comme http.sys : en-tête d'hôte exact, puis IP exacte, puis génériques). */
function matchSite(
  sites: IisSite[],
  url: ParsedUrl,
  dstIp: string
): { listening: boolean; site: IisSite | null; binding: IisBinding | null } {
  const candidates = sites
    .filter((s) => s.state === 'Started')
    .flatMap((site) =>
      site.bindings
        .filter((b) => b.protocol === url.protocol && b.port === url.port && (b.ip === '*' || b.ip === dstIp))
        .map((binding) => ({ site, binding }))
    )
  if (candidates.length === 0) return { listening: false, site: null, binding: null }
  const score = (b: IisBinding) =>
    (b.host === url.host ? 2 : b.host === '' ? 0 : -10) + (b.ip === dstIp ? 1 : 0)
  const best = candidates
    .filter((c) => c.binding.host === '' || c.binding.host === url.host)
    .sort((a, b) => score(b.binding) - score(a.binding))[0]
  return best ? { listening: true, ...best } : { listening: true, site: null, binding: null }
}

/** Réponse du site pour le chemin demandé (document par défaut, fichier, 403.14, 404). */
function serve(server: ServerDevice, site: IisSite, path: string): { code: string; file: string | null } {
  const root = site.physicalPath.replace(/\\+$/, '')
  const local = path ? `${root}\\${path.replace(/\//g, '\\').replace(/\\+$/, '')}` : root
  const node = findNode(server.storage, local)
  if (node === undefined) return { code: '404.0', file: null }
  if (node && node.kind === 'file') return { code: '200', file: local }
  const doc = DEFAULT_DOCUMENTS.find((d) => {
    const found = findNode(server.storage, `${local}\\${d}`)
    return found && found.kind === 'file'
  })
  if (!doc) return { code: '403.14', file: null }
  const found = findNode(server.storage, `${local}\\${doc}`)
  return { code: '200', file: `${local}\\${found?.name ?? doc}` }
}

/** Texte lisible d'une page HTML (balises retirées), pour l'affichage du navigateur simulé. */
function pageText(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Requête GET vers un serveur Linux : Apache2 (services/linuxhttp.ts). Les accès du navigateur ne sont pas journalisés. */
function linuxGet(
  state: LabState,
  client: HostDevice,
  server: ServerDevice,
  url: ParsedUrl,
  ip: string,
  local: boolean,
  resolution: PacketTrace | null,
  display: string,
  failure: (code: HttpFailure, message: string, trace?: PacketTrace | null) => HttpResult
): HttpResult {
  const files = hostFiles(server)
  const web = webRespond(
    server,
    files,
    (p) => (files[p] ? contentOfHost(server, p, files[p], files) : ''),
    {
      scheme: url.protocol,
      host: url.host,
      port: url.port,
      dstIp: ip,
      path: `/${url.path}`,
      method: 'GET',
      clientIp: local ? ip : (sourceAddressFor(state, client, ip) ?? '127.0.0.1'),
      clientPort: 49152 + ((state.seq * 37) % 16000),
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edg/130.0'
    },
    state.clock
  )
  const refused = 'failure' in web
  let trace = resolution
  if (!local) {
    const exchange = serverExchange(state, client.id, ip, {
      protocol: 'HTTP',
      port: url.port,
      request: url.protocol === 'https' ? `TLS ClientHello (${url.host})` : `GET /${url.path} HTTP/1.1`,
      reply: refused
        ? 'TCP RST'
        : url.protocol === 'https'
          ? 'TLS ServerHello, Certificate'
          : `HTTP/1.1 ${web.status} ${web.statusText}`,
      fields: [['Hôte', url.host]]
    })
    trace = trace ? concatTraces(`HTTP ${url.host}`, [trace, exchange.trace]) : exchange.trace
    if (!exchange.ok) return failure('ConnectFailed', CONNECT_FAILED, trace)
  }
  if (refused) {
    return web.failure === 'refused'
      ? failure('ConnectFailed', CONNECT_FAILED, trace)
      : failure('SecureChannel', SECURE_CHANNEL, trace)
  }
  return {
    kind: 'response',
    url: display,
    status: web.status,
    subStatus: 0,
    statusText: web.statusText,
    server,
    site: null,
    file: web.file,
    body: pageText(web.body) || `Réponse de ${web.site}.`,
    certificate: null,
    // Le certificat « snakeoil » d'Apache est auto-signé : aucun poste ne l'approuve
    certificateWarning: web.tls
      ? 'Le certificat de sécurité présenté par ce site n’a pas été émis par une autorité de certification approuvée.'
      : null,
    trace
  }
}

/** Requête GET depuis un ordinateur. */
export function httpGet(state: LabState, clientId: string, urlText: string): HttpResult {
  const client = hostOf(state, clientId)
  const url = parseHttpUrl(urlText)
  const display = url
    ? `${url.protocol}://${url.host}${url.port === (url.protocol === 'https' ? 443 : 80) ? '' : `:${url.port}`}/${url.path}`
    : urlText
  const failure = (code: HttpFailure, message: string, trace: PacketTrace | null = null): HttpResult => ({
    kind: 'failure',
    code,
    message,
    url: display,
    trace
  })
  if (!client || !url)
    return failure('InvalidUrl', `URI non valide : le format de l’URI ne peut pas être déterminé.`)

  // Résolution du nom (adresse littérale, ordinateur local ou DNS)
  let ip: string | null
  let trace: PacketTrace | null = null
  const local = url.host === 'localhost' || url.host === '127.0.0.1' || url.host === client.name.toLowerCase()
  if (local) ip = client.interfaces.map((i) => effectiveIpv4(i)?.address).find((a) => !!a) ?? '127.0.0.1'
  else if (/^\d{1,3}(\.\d{1,3}){3}$/.test(url.host)) ip = url.host
  else {
    const resolution = resolveName(state, client.id, url.host)
    trace = resolution.trace
    ip = firstAddress(resolution)
    if (!ip) return failure('NameNotResolved', `Le nom distant n’a pas pu être résolu: '${url.host}'`, trace)
  }

  const server = local ? (client.kind === 'server' ? client : null) : serverAt(state, ip)
  // Serveur Linux : Apache2 répond d'après sa configuration en vigueur (v2.9, #238)
  if (server && server.host.os === 'linux')
    return linuxGet(state, client, server, url, ip, local, trace, display, failure)
  // Service de publication World Wide Web (W3SVC) arrêté : aucun site n'écoute
  const iis =
    server?.host.features.includes('Web-Server') && serviceRunning(server, 'W3SVC')
      ? iisServerOf(server)
      : null
  const match = iis ? matchSite(iis.sites, url, ip) : { listening: false, site: null, binding: null }

  // Connexion TCP (et requête HTTP si un site écoute sur ce port)
  const requestLine = `GET /${url.path} HTTP/1.1`
  let response: { code: string; file: string | null } | null = null
  if (server && match.listening)
    response = match.site ? serve(server, match.site, url.path) : { code: '400.0', file: null }
  const status = response ? Number(response.code.split('.')[0]) : 0
  if (!local) {
    const exchange = serverExchange(state, client.id, ip, {
      protocol: 'HTTP',
      port: url.port,
      request: url.protocol === 'https' ? `TLS ClientHello (${url.host})` : requestLine,
      reply: response
        ? url.protocol === 'https'
          ? 'TLS ServerHello, Certificate'
          : `HTTP/1.1 ${status} ${status === 200 ? 'OK' : (ERROR_PAGES[response.code]?.text ?? '')}`
        : 'TCP RST',
      fields: [['Hôte', url.host]]
    })
    trace = trace ? concatTraces(`HTTP ${url.host}`, [trace, exchange.trace]) : exchange.trace
    if (!exchange.ok) return failure('ConnectFailed', CONNECT_FAILED, trace)
  }
  if (!server || !response || !match.listening) return failure('ConnectFailed', CONNECT_FAILED, trace)

  // HTTPS : certificat de la liaison, nom couvert et chaîne approuvée par le client
  let certificate: Certificate | null = null
  let certificateWarning: string | null = null
  if (url.protocol === 'https' && match.binding) {
    const thumb = match.binding.certificate
    certificate = server.host.certificates.find((c) => c.store === 'My' && c.thumbprint === thumb) ?? null
    if (!certificate) return failure('SecureChannel', SECURE_CHANNEL, trace)
    if (isRevoked(state, certificate))
      certificateWarning =
        'Le certificat de sécurité de ce site a été révoqué par son autorité de certification.'
    else if (!certificateCovers(certificate, url.host))
      certificateWarning = `Le certificat de sécurité présenté par ce site a été émis pour un autre nom (${certificate.dnsNames.join(', ')}).`
    else if (!certificateTrusted(client, certificate))
      certificateWarning =
        'Le certificat de sécurité présenté par ce site n’a pas été émis par une autorité de certification approuvée.'
  }
  const page = ERROR_PAGES[response.code]
  const [major, minor] = response.code.split('.')
  return {
    kind: 'response',
    url: display,
    status: Number(major),
    subStatus: Number(minor ?? 0),
    statusText: status === 200 ? 'OK' : (page?.text ?? ''),
    server,
    site: match.site,
    file: response.file,
    body:
      page?.body ??
      `Document ${response.file?.split('\\').pop() ?? ''} servi par le site « ${match.site?.name} ».`,
    certificate,
    certificateWarning,
    trace
  }
}
