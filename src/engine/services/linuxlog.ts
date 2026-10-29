/**
 * Journaux d'un serveur Linux (v2.9, #237) : écriture des messages (sshd, sudo, logger, fail2ban),
 * envoi distant de rsyslog et lecture de /var/log/auth.log, /var/log/syslog, /var/log/fail2ban.log.
 *
 * - Les fichiers sont CALCULÉS depuis le journal de l'ordinateur (`linuxlogbase.ts`) : toute action
 *   simulée qui écrit un message l'alimente, sans second stockage.
 * - Envoi distant : une règle `*.* @@hôte:514` (TCP) ou `@hôte:514` (UDP) de la configuration en
 *   vigueur de rsyslog (`linuxconfig.ts`) copie le message sur la machine de destination si elle est
 *   joignable et si son rsyslog écoute sur ce protocole et ce port (`module(load="imtcp")`…). Le
 *   message arrive avec le nom de la machine d'origine, comme sur un vrai collecteur.
 * - Sélecteurs de rsyslog : seule l'installation (`auth`, `authpriv`, `*`…) est prise en compte, pas la priorité.
 */
import { raise, transact, type EngineResult } from '../core/result'
import { ping } from '../net/diagnostics'
import { effectiveIpv4 } from '../net/addressing'
import { isIpv4 } from '../net/ipv4'
import { isLinuxHost } from '../model/host'
import type { EventLogEntry, HostDevice, LabState } from '../model/schema'
import { firstAddress, resolveName } from '../roles/dns/resolver'
import { APACHE_LOGS } from './linuxapache'
import { renderApacheLine } from './linuxapachehost'
import { findUnit } from './linuxcatalog'
import { observeSshFailure } from './linuxfail2ban'
import { parseRsyslog, runningConfigText } from './linuxconfig'
import {
  ORIGIN_PREFIX,
  appendLine,
  f2bStamp,
  facilitiesOf,
  isAuthSource,
  isFail2banSource,
  syslogStamp,
  type LogLine
} from './linuxlogbase'
import { isInstalled, linuxRelease, unitStatus } from './linuxsystem'

export type { LogLine }

export const AUTH_LOG = '/var/log/auth.log'
export const SYSLOG = '/var/log/syslog'
export const FAIL2BAN_LOG = '/var/log/fail2ban.log'

/** Contenu d'un fichier de journal, calculé depuis le journal de l'ordinateur ; null si le chemin n'en est pas un. */
export function renderLogFile(host: HostDevice, path: string): string | null {
  if (path.startsWith(`${APACHE_LOGS}/`)) {
    // access.log, error.log et journaux des sites d'Apache (v2.9, #238) : une entrée = une ligne
    const lines = host.host.eventLog
      .filter((e) => e.source.startsWith('apache2.') && e.account === path && e.message !== '')
      .map((e) => renderApacheLine(host, e))
    return lines.length === 0 ? '' : `${lines.join('\n')}\n`
  }
  if (path !== AUTH_LOG && path !== SYSLOG && path !== FAIL2BAN_LOG) return null
  const traditional = linuxRelease(host) !== 'debian12'
  const wanted = (e: EventLogEntry) =>
    path === FAIL2BAN_LOG
      ? isFail2banSource(e.source)
      : path === AUTH_LOG
        ? isAuthSource(e.source)
        : !isAuthSource(e.source) && !isFail2banSource(e.source) && !e.source.startsWith('apache2.')
  const lines = host.host.eventLog.filter(wanted).map((e) => {
    if (path === FAIL2BAN_LOG) {
      const level = e.source === 'fail2ban.actions' && /\] (Un)?[Bb]an /.test(e.message) ? 'NOTICE' : 'INFO'
      return `${f2bStamp(host, e.time, true)} ${e.source.padEnd(24)}[${e.eventId}]: ${level.padEnd(7)} ${e.message}`
    }
    const origin = e.account?.startsWith(ORIGIN_PREFIX) ? e.account.slice(ORIGIN_PREFIX.length) : host.name
    const tag = e.source === 'systemd' ? 'systemd[1]' : e.eventId > 0 ? `${e.source}[${e.eventId}]` : e.source
    return `${syslogStamp(host, e.time, traditional)} ${origin} ${tag}: ${e.message}`
  })
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`
}

/** Machine de destination joignable dont rsyslog reçoit les messages de ce protocole et de ce port. */
function receiverOf(state: LabState, senderId: string, target: string, proto: 'tcp' | 'udp', port: number) {
  let ip = target
  if (!isIpv4(target)) {
    const found = firstAddress(resolveName(state, senderId, target))
    if (!found) return undefined
    ip = found
  }
  const dest = Object.values(state.devices).find(
    (d): d is HostDevice =>
      d.id !== senderId &&
      isLinuxHost(d) &&
      d.powered &&
      d.interfaces.some((i) => effectiveIpv4(i)?.address === ip)
  )
  const unit = findUnit('rsyslog')
  if (!dest || !unit || !isInstalled(dest, unit.pkg) || !unitStatus(dest, unit).active) return undefined
  const inputs = parseRsyslog(runningConfigText(dest.host.linux, 'rsyslog')).inputs
  if (!inputs.some((i) => i.proto === proto && i.port === port)) return undefined
  const reply = ping(state, senderId, ip, { count: 1, size: 56 })
  return reply.ok && reply.value.outcomes.some((o) => o.kind === 'reply') ? dest : undefined
}

/** Machines qui recevront ce message par l'envoi distant de rsyslog de l'expéditeur. */
function receiversOf(state: LabState, senderId: string, source: string): HostDevice[] {
  const sender = state.devices[senderId]
  const unit = findUnit('rsyslog')
  if (!sender || !isLinuxHost(sender) || !unit) return []
  if (!isInstalled(sender, unit.pkg) || !unitStatus(sender, unit).active) return []
  const facilities = facilitiesOf(source)
  const found = new Map<string, HostDevice>()
  for (const f of parseRsyslog(runningConfigText(sender.host.linux, 'rsyslog')).forwards) {
    if (!f.facilities.includes('*') && !f.facilities.some((x) => facilities.includes(x))) continue
    const dest = receiverOf(state, senderId, f.target, f.proto, f.port)
    if (dest) found.set(dest.id, dest)
  }
  return [...found.values()]
}

export interface WriteOptions {
  /** Échecs d'authentification SSH venant de cette adresse (un par ligne `Found`) : fail2ban les compte. */
  sshFailures?: { from: string; count: number }
}

/**
 * Journalise des messages sur l'ordinateur, les envoie aux collecteurs configurés dans rsyslog
 * et laisse fail2ban réagir aux échecs SSH.
 */
export function writeLogs(
  state: LabState,
  deviceId: string,
  lines: LogLine[],
  options: WriteOptions = {}
): EngineResult<void> {
  const sender = state.devices[deviceId]
  const senderName = sender?.name ?? ''
  // Destinataires déterminés sur l'état d'avant : l'écriture d'un journal ne change pas le réseau
  const plan = lines.map((line) => receiversOf(state, deviceId, line.source).map((d) => d.id))
  return transact(state, (draft) => {
    if (!sender || !isLinuxHost(sender)) raise('NotSupported', 'Cet équipement n’exécute pas Linux.')
    lines.forEach((line, i) => {
      appendLine(draft, deviceId, line)
      for (const id of plan[i] ?? []) appendLine(draft, id, line, senderName)
    })
    for (let i = 0; i < (options.sshFailures?.count ?? 0); i++)
      observeSshFailure(draft, deviceId, options.sshFailures?.from ?? '')
  })
}
