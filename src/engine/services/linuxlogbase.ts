/**
 * Base des journaux d'un serveur Linux (v2.9, #237) : une ligne de journal est une entrée du journal
 * d'évènements de l'ordinateur (`host.eventLog`), comme les lignes de systemd (`linuxsystem.ts`).
 * Les fichiers /var/log/auth.log, /var/log/syslog et /var/log/fail2ban.log sont CALCULÉS depuis ce
 * journal à chaque lecture (`linuxlog.ts`) : aucune ligne n'est stockée deux fois.
 *
 * Correspondance avec `EventLogEntry` :
 * - `source`   : programme (`sshd`, `sudo`, `fail2ban.actions`, étiquette de `logger`…) ;
 * - `eventId`  : PID du programme (0 : sans PID) ;
 * - `message`  : texte du message, sans date ni nom de machine ;
 * - `account`  : `from:<machine>` pour un message reçu d'une autre machine par rsyslog.
 */
import type { Draft } from 'immer'
import { logEvent } from '../core/eventlog'
import { LAB_EPOCH_MS } from '../core/clock'
import type { EventLogEntry, HostDevice, LabState } from '../model/schema'

type AnyHost = HostDevice | Draft<HostDevice>

/** Message à journaliser (une ligne de journal). */
export interface LogLine {
  source: string
  pid: number
  message: string
  level?: EventLogEntry['level']
}

/** Programmes dont les messages relèvent de l'installation `auth`/`authpriv` (auth.log, jamais syslog). */
const AUTH_SOURCES = ['sshd', 'sudo', 'su', 'passwd', 'useradd', 'usermod', 'groupadd']

export const isAuthSource = (source: string) => AUTH_SOURCES.includes(source)
export const isFail2banSource = (source: string) => source.startsWith('fail2ban')

/** Installations syslog d'un programme (celles qu'un sélecteur rsyslog peut nommer). */
export function facilitiesOf(source: string): string[] {
  if (isAuthSource(source)) return ['auth', 'authpriv']
  return source === 'systemd' ? ['daemon'] : ['user']
}

/** Préfixe de machine d'origine d'un message reçu par rsyslog. */
export const ORIGIN_PREFIX = 'from:'

/** Ajoute une ligne au journal local ; `origin` : machine d'envoi (message reçu par le réseau). */
export function appendLine(draft: Draft<LabState>, deviceId: string, line: LogLine, origin?: string): void {
  logEvent(draft, deviceId, {
    level: line.level ?? 'information',
    log: isAuthSource(line.source) ? 'Sécurité' : 'Système',
    source: line.source,
    eventId: line.pid,
    message: line.message,
    ...(origin !== undefined ? { account: `${ORIGIN_PREFIX}${origin}` } : {})
  })
}

const p2 = (n: number) => String(n).padStart(2, '0')
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function localDate(host: AnyHost, clock: number): Date {
  return new Date(LAB_EPOCH_MS + clock + (host.host.clockOffsetSeconds ?? 0) * 1000)
}

/** Horodatage de rsyslog : ISO à la microseconde (Debian 12), format traditionnel « Oct 20 08:00:03 » (Ubuntu). */
export function syslogStamp(host: AnyHost, clock: number, traditional: boolean): string {
  const d = localDate(host, clock)
  if (traditional)
    return `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, ' ')} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}T${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}.${String(d.getUTCMilliseconds()).padStart(3, '0')}000+00:00`
}

/** Date d'un message de fail2ban : « 2026-10-20 08:00:03 » (sans fraction) ou « …,123 » (fichier journal). */
export function f2bStamp(host: AnyHost, clock: number, millis: boolean): string {
  const d = localDate(host, clock)
  const base = `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`
  return millis ? `${base},${String(d.getUTCMilliseconds()).padStart(3, '0')}` : base
}
