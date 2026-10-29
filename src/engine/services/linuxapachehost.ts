/**
 * Configuration d'Apache d'un ordinateur (v2.9, #238) : relit les fichiers de /etc/apache2 du
 * serveur (`live`) ou l'instantané gardé depuis le dernier (re)démarrage (`running`), comme
 * `host.linux.loaded` pour sshd (linuxconfig.ts). Un `a2ensite` ou une modification de fichier ne
 * change donc le site servi qu'après `systemctl reload apache2`.
 */
import type { Draft } from 'immer'
import { LAB_EPOCH_MS } from '../core/clock'
import { EVENT_LOG_LIMIT, logEvent, type NewEvent } from '../core/eventlog'
import { LINUX_USER } from '../model/factory'
import type { EventLogEntry, HostDevice, LabState } from '../model/schema'
import { ERROR_LOG, parseConfig, type ApacheConfig, type ServerContext } from './linuxapache'
import { findPackage } from './linuxcatalog'
import { apacheSource, bundleSource, hostsTextOf, resolveLink } from './linuxconfig'
import { installedPackages, linuxRelease } from './linuxpackages'
import { defaultLinuxFiles, withPackageFiles } from './linuxtree'

type AnyHost = HostDevice | Draft<HostDevice>

/** Nombre d'octets UTF-8 d'un texte. */
function bytes(text: string): number {
  let n = 0
  for (const ch of text) {
    const c = ch.codePointAt(0) as number
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4
  }
  return n
}

/** Contexte du serveur : nom de la machine, /etc/hosts, existence et taille des fichiers (liens suivis). */
export function serverContext(host: AnyHost): ServerContext {
  const linux = host.host.linux
  const files = withPackageFiles(
    (linux?.files ?? defaultLinuxFiles(host.host.session?.user ?? LINUX_USER)) as never,
    installedPackages(host)
  ) as Record<string, { type: 'file' | 'dir'; content?: string; link?: string }>
  return {
    hostname: host.name,
    hostsText: hostsTextOf(linux?.files, host.name),
    stat(path) {
      let p = path
      for (let i = 0; i < 8 && files[p]?.link !== undefined; i++) p = resolveLink(p, files[p]?.link as string)
      const node = files[p]
      if (!node) return null
      return { type: node.type, size: node.type === 'dir' ? 4096 : bytes(node.content ?? 'x') }
    }
  }
}

/** Configuration d'Apache : en vigueur (dernier démarrage) ou actuelle (fichiers). */
export function apacheConfig(host: AnyHost, mode: 'running' | 'live'): ApacheConfig {
  const linux = host.host.linux
  const snapshot = mode === 'running' ? linux?.loaded?.['apache2'] : undefined
  const source = snapshot !== undefined ? bundleSource(snapshot) : apacheSource(linux?.files)
  return parseConfig(source, serverContext(host))
}

// ---------------------------------------------------------------------------------------------
// Journaux : access.log et error.log sont des entrées du journal de l'ordinateur (comme auth.log)
// ---------------------------------------------------------------------------------------------

export const ACCESS_SOURCE = 'apache2.access'
export const ERROR_SOURCE = 'apache2.error'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const p2 = (n: number) => String(n).padStart(2, '0')

function localDate(host: AnyHost, clock: number): Date {
  return new Date(LAB_EPOCH_MS + clock + (host.host.clockOffsetSeconds ?? 0) * 1000)
}

/** Version amont d'apache2 pour la distribution du serveur (« 2.4.68 »). */
export function apacheVersion(host: AnyHost): string {
  const full = findPackage('apache2')?.versions[linuxRelease(host)] ?? ''
  return full.replace(/^\d+:/, '').split(/[-~+]/)[0] ?? full
}

/** Version du serveur annoncée (Server: Apache/2.4.68 (Debian)) selon ServerTokens. */
export function serverBanner(host: AnyHost, tokens: string): string {
  const version = apacheVersion(host)
  const [major = '2', minor = '4'] = version.split('.')
  const os = linuxRelease(host) === 'debian12' ? 'Debian' : 'Ubuntu'
  switch (tokens) {
    case 'prod':
    case 'productonly':
      return 'Apache'
    case 'major':
      return `Apache/${major}`
    case 'minor':
      return `Apache/${major}.${minor}`
    case 'min':
    case 'minimal':
      return `Apache/${version}`
    default:
      return `Apache/${version} (${os})`
  }
}

/** Description complète du serveur (ap_get_server_description) : « Apache/2.4.68 (Debian) ». */
export const serverDescription = (host: AnyHost) => serverBanner(host, 'os')

/**
 * Remplace les repères de date d'une ligne de journal d'Apache à l'affichage :
 * `{t}` → 20/Oct/2026:08:00:03 +0000 (access.log), `{e}` → Tue Oct 20 08:00:03.123456 2026 (error.log).
 */
export function renderApacheLine(host: AnyHost, e: EventLogEntry): string {
  const d = localDate(host, e.time)
  const access = `${p2(d.getUTCDate())}/${MONTHS[d.getUTCMonth()]}/${d.getUTCFullYear()}:${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} +0000`
  const usec = String((Math.abs(e.id) * 7919) % 1_000_000).padStart(6, '0')
  const error = `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}.${usec} ${d.getUTCFullYear()}`
  return e.message.replace('{t}', access).replace('{e}', error)
}

/** Ajoute une entrée sans faire avancer l'horloge du lab (lignes de démarrage : elles datent du démarrage lui-même). */
export function pushUntimed(draft: Draft<LabState>, deviceId: string, event: NewEvent): void {
  const dev = draft.devices[deviceId]
  if (!dev || (dev.kind !== 'server' && dev.kind !== 'client')) return
  // Identifiant négatif propre à ces lignes : le compteur d'identifiants du lab (state.seq) n'est pas consommé
  const id = -1 - dev.host.eventLog.filter((e) => e.id < 0).length
  dev.host.eventLog.push({ log: 'Système', ...event, id, time: draft.clock })
  if (dev.host.eventLog.length > EVENT_LOG_LIMIT)
    dev.host.eventLog.splice(0, dev.host.eventLog.length - EVENT_LOG_LIMIT)
}

/** Ajoute une ligne à error.log (ou au journal d'erreurs d'un site) : « [date] [module:niveau] [pid P:tid T] message ». */
export function appendErrorLog(
  draft: Draft<LabState>,
  deviceId: string,
  line: {
    module: string
    level: string
    pid: number
    message: string
    client?: string
    /** Erreur système rapportée avant le client : « (13)Permission denied ». */
    errno?: string
    file?: string
  }
): void {
  const tid = 139_800_000_000_000 + line.pid * 1024
  const errno = line.errno ? `${line.errno}: ` : ''
  pushUntimed(draft, deviceId, {
    level: line.level === 'error' ? 'error' : 'information',
    source: ERROR_SOURCE,
    eventId: line.pid,
    account: line.file ?? ERROR_LOG,
    message: `[{e}] [${line.module}:${line.level}] [pid ${line.pid}:tid ${tid}] ${errno}${line.client ? `[client ${line.client}] ` : ''}${line.message}`
  })
}

/** Ajoute une ligne à un journal d'accès (déjà mise en forme, `{t}` pour la date). */
export function appendAccessLog(
  draft: Draft<LabState>,
  deviceId: string,
  file: string,
  message: string
): void {
  logEvent(draft, deviceId, {
    level: 'information',
    source: ACCESS_SOURCE,
    eventId: 0,
    account: file,
    message
  })
}

/** Crée les fichiers de journaux cités par la configuration (vides) : entrées sans texte. */
export function touchLogFiles(draft: Draft<LabState>, deviceId: string, files: string[]): void {
  const dev = draft.devices[deviceId]
  if (!dev || (dev.kind !== 'server' && dev.kind !== 'client')) return
  for (const f of files)
    if (!dev.host.eventLog.some((e) => e.account === f && e.source.startsWith('apache2.')))
      pushUntimed(draft, deviceId, {
        level: 'information',
        source: ERROR_SOURCE,
        eventId: 0,
        account: f,
        message: ''
      })
}
