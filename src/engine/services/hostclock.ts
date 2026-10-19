/**
 * Horloge par ordinateur (v2.8, chantier A) : heure locale = horloge du lab + écart du poste
 * (`host.clockOffsetSeconds`). Aucun accès à l'horloge système : tout est déterministe.
 *
 * Sources Microsoft Learn :
 *  - Kerberos : « Maximum tolerance for computer clock synchronization » (valeur par défaut :
 *    5 minutes) — au-delà, le contrôleur de domaine refuse l'authentification :
 *    https://learn.microsoft.com/previous-versions/windows/it-pro/windows-10/security/threat-protection/security-policy-settings/maximum-tolerance-for-computer-clock-synchronization
 *  - W32Time : MaxAllowedPhaseOffset = 300 s pour les membres d'un domaine :
 *    https://learn.microsoft.com/windows-server/networking/windows-time-service/windows-time-service-tools-and-settings
 *  - ERROR_TIME_SKEW (1398) : « There is a time and/or date difference between the client and
 *    server. » : https://learn.microsoft.com/windows/win32/debug/system-error-codes--1300-1699-
 * Textes français et message de `w32tm /resync` service arrêté : docs/fidelite.md, « À vérifier (v2.8 — services) ».
 */
import type { Draft } from 'immer'
import { logEvent } from '../core/eventlog'
import { raise, transact, type EngineResult } from '../core/result'
import type { HostDevice, LabState } from '../model/schema'
import { serviceRunning } from './servicestate'

/** Tolérance Kerberos par défaut : 5 minutes (écart strictement supérieur refusé). */
export const KERBEROS_MAX_SKEW_SECONDS = 300

/** Message de l'erreur système 1398 (ERROR_TIME_SKEW), traduit de la définition de Learn. */
export const TIME_SKEW_MESSAGE =
  'Il existe une différence d’heure et/ou de date entre le client et le serveur.'

/** Message de `w32tm` quand le service Temps Windows n'est pas démarré (0x80070426). */
export const W32TIME_NOT_STARTED_MESSAGE = 'Le service n’a pas été démarré. (0x80070426)'

type AnyHost = HostDevice | Draft<HostDevice>

function hostOf(state: LabState | Draft<LabState>, id: string): AnyHost | null {
  const d = state.devices[id]
  return d && (d.kind === 'server' || d.kind === 'client') ? d : null
}

/** Écart de l'ordinateur avec l'horloge du lab, en secondes. */
export function clockOffset(state: LabState, deviceId: string): number {
  return hostOf(state, deviceId)?.host.clockOffsetSeconds ?? 0
}

/** Heure locale de l'ordinateur, sur l'échelle de `state.clock` (millisecondes depuis le début du lab). */
export function localClock(state: LabState, deviceId: string): number {
  return state.clock + clockOffset(state, deviceId) * 1000
}

/** Contrôleur de domaine allumé d'un ordinateur membre (celui de la session, sinon le premier). */
export function domainControllerOf(state: LabState, hostId: string): HostDevice | null {
  const host = hostOf(state, hostId)
  const domain = host?.host.domain ? state.domains[host.host.domain] : undefined
  if (!host || !domain) return null
  const controllers = domain.controllers
    .map((id) => hostOf(state, id))
    .filter((d): d is HostDevice => !!d && d.powered)
  const logon = host.host.session?.logonServer?.toLowerCase()
  return controllers.find((d) => d.name.toLowerCase() === logon) ?? controllers[0] ?? null
}

/**
 * Écart (secondes, valeur absolue) entre un ordinateur du domaine et son contrôleur de domaine ;
 * null pour un ordinateur hors domaine, pour un contrôleur ou sans contrôleur joignable.
 */
export function skewWithDomainController(state: LabState, hostId: string): number | null {
  const dc = domainControllerOf(state, hostId)
  if (!dc || dc.id === hostId) return null
  return Math.abs(clockOffset(state, hostId) - clockOffset(state, dc.id))
}

/** Vrai si l'écart avec le contrôleur de domaine dépasse la tolérance Kerberos (5 minutes). */
export function kerberosSkewExceeded(state: LabState, hostId: string): boolean {
  const skew = skewWithDomainController(state, hostId)
  return skew !== null && skew > KERBEROS_MAX_SKEW_SECONDS
}

/** Règle l'écart de l'ordinateur avec l'horloge du lab (Set-Date, net time /set). */
export function setHostClock(state: LabState, deviceId: string, offsetSeconds: number): EngineResult {
  return transact(state, (draft) => {
    const host = hostOf(draft, deviceId)
    if (!host) raise('NotSupported', 'Cet équipement n’a pas d’horloge réglable.')
    if (!Number.isFinite(offsetSeconds) || !Number.isInteger(offsetSeconds))
      raise('InvalidClock', 'L’heure indiquée n’est pas valide.')
    host.host.clockOffsetSeconds = offsetSeconds
    return undefined
  })
}

/** Source de la dernière resynchronisation : contrôleur de domaine, ou horloge locale. */
export interface ResyncResult {
  source: string | null
}

/**
 * `w32tm /resync` : exige le service Temps Windows (W32Time) démarré ; un ordinateur du domaine se
 * resynchronise sur son contrôleur de domaine (écart nul si le contrôleur est à l'heure).
 */
export function resyncClock(state: LabState, deviceId: string): EngineResult<ResyncResult> {
  return transact(state, (draft) => {
    const host = hostOf(draft, deviceId)
    if (!host) raise('NotSupported', 'Cet équipement n’a pas de service de temps.')
    if (!host.powered) raise('PoweredOff', `${host.name} est éteint.`)
    if (!serviceRunning(host, 'W32Time')) raise('ServiceNotStarted', W32TIME_NOT_STARTED_MESSAGE)
    const dc = domainControllerOf(draft as LabState, deviceId)
    const source = dc && dc.id !== deviceId ? dc : null
    host.host.clockOffsetSeconds = source ? clockOffset(draft as LabState, source.id) : 0
    if (source)
      logEvent(draft, deviceId, {
        level: 'information',
        source: 'Microsoft-Windows-Time-Service',
        eventId: 35,
        message: `Le service de temps synchronise maintenant l’horloge système avec la source de temps ${source.name}.`
      })
    return { source: source?.name ?? null }
  })
}
