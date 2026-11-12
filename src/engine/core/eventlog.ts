/**
 * Journal d'événements des serveurs et postes (Observateur d'événements simplifié).
 */
import type { Draft } from 'immer'
import type { EventLogEntry, LabState } from '../model/schema'
import { nextSeq } from '../model/factory'
import { raise, transact, type EngineResult } from './result'

/** Nombre maximal d'entrées conservées par équipement. */
export const EVENT_LOG_LIMIT = 500

/** Entrée d'état d'une unité systemd : démarrée, arrêtée ou en échec de démarrage. */
export function isUnitStateEntry(e: EventLogEntry): boolean {
  return e.source === 'systemd' && /^(Started|Stopped|Failed to start) /.test(e.message)
}

/**
 * Le nombre de démarrages, le PID, « active since » et l'état « failed » d'une unité Linux sont dérivés
 * du journal (`linuxsystem.ts`) : les entrées « Started » et la dernière entrée d'état de chaque unité
 * résistent à la rotation (audit v2.11.1, M-03) et à l'effacement du journal.
 */
export function unitStateAnchors(log: readonly EventLogEntry[]): boolean[] {
  // Un seul parcours depuis la fin (linéaire) : la première entrée d'état rencontrée pour une unité est sa dernière
  const anchors: boolean[] = new Array<boolean>(log.length).fill(false)
  const seen = new Set<string | undefined>()
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i]!
    if (!isUnitStateEntry(e)) continue
    if (e.message.startsWith('Started ') || !seen.has(e.account)) anchors[i] = true
    seen.add(e.account)
  }
  return anchors
}

/** Écart de temps simulé entre deux événements consécutifs (ms). */
const EVENT_TICK_MS = 1000

/** Filtre de l'Observateur d'événements et de Get-WinEvent (critères combinés par ET). */
export interface EventFilter {
  ids?: number[]
  levels?: EventLogEntry['level'][]
  sources?: string[]
  /** Horloge minimale / maximale (incluses). */
  since?: number | null
  until?: number | null
}

/** Événements qui satisfont le filtre (ordre conservé). */
export function filterEvents(entries: EventLogEntry[], filter: EventFilter): EventLogEntry[] {
  const sources = filter.sources?.map((s) => s.toLowerCase())
  return entries.filter(
    (e) =>
      (!filter.ids?.length || filter.ids.includes(e.eventId)) &&
      (!filter.levels?.length || filter.levels.includes(e.level)) &&
      (!sources?.length || sources.some((s) => e.source.toLowerCase().includes(s))) &&
      (filter.since === undefined || filter.since === null || e.time >= filter.since) &&
      (filter.until === undefined || filter.until === null || e.time <= filter.until)
  )
}

export type NewEvent = Omit<EventLogEntry, 'id' | 'time' | 'log'> & { log?: EventLogEntry['log'] }

/** Ajoute une entrée au journal d'un serveur ou poste (sans effet pour les autres équipements). */
export function logEvent(draft: Draft<LabState>, deviceId: string, event: NewEvent): void {
  const device = draft.devices[deviceId]
  if (!device || (device.kind !== 'server' && device.kind !== 'client')) return
  draft.clock += EVENT_TICK_MS
  device.host.eventLog.push({ log: 'Système', ...event, id: nextSeq(draft), time: draft.clock })
  // Rotation : on évince d'abord les plus anciennes entrées ordinaires, celles d'état d'unité ensuite
  const log = device.host.eventLog
  while (log.length > EVENT_LOG_LIMIT) {
    const i = unitStateAnchors(log).indexOf(false)
    log.splice(i < 0 ? 0 : i, 1)
  }
}

/**
 * Efface un journal (Observateur d'événements > Effacer le journal) et trace l'opération,
 * comme le système : événement 1102 dans le journal Sécurité, 104 dans le journal Système sinon.
 */
export function clearEventLog(state: LabState, deviceId: string, log: EventLogEntry['log']): EngineResult {
  return transact(state, (draft) => {
    const device = draft.devices[deviceId]
    if (!device || (device.kind !== 'server' && device.kind !== 'client'))
      raise('NotSupported', 'Cet équipement n’a pas de journal d’événements.')
    const user = device.host.session
      ? `${device.host.session.domain ?? device.name}\\${device.host.session.user}`
      : 'SYSTEM'
    // Sur Linux, l'état des unités (voir isUnitStateEntry) n'est pas un journal que l'on efface
    const anchors = unitStateAnchors(device.host.eventLog)
    device.host.eventLog = device.host.eventLog.filter(
      (e, i) => e.log !== log || (device.host.os === 'linux' && anchors[i])
    )
    if (log === 'Sécurité')
      logEvent(draft, deviceId, {
        level: 'information',
        source: 'Eventlog',
        eventId: 1102,
        log: 'Sécurité',
        message: `Le journal d’audit a été effacé. Sujet : ${user}.`
      })
    else
      logEvent(draft, deviceId, {
        level: 'information',
        source: 'Eventlog',
        eventId: 104,
        log: 'Système',
        message: `Le fichier journal ${log} a été effacé par ${user}.`
      })
    return undefined
  })
}
