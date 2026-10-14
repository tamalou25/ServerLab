/**
 * Services système d'un ordinateur : liste (dérivée des rôles installés), démarrage, arrêt,
 * type de démarrage (v2.7, Lot 2a). Partagé par Get-Service / Start-Service / Stop-Service /
 * Restart-Service / Set-Service, `net start` / `net stop` et `sc query|start|stop|config`.
 *
 * Comportement sourcé Microsoft Learn :
 * - Set-Service (-StartupType) : « Disabled - The service is disabled and cannot be started by a
 *   user or application » ; Automatic : démarré par le système au démarrage ; Manual : démarré
 *   seulement à la demande (https://learn.microsoft.com/powershell/module/microsoft.powershell.management/set-service?view=powershell-5.1).
 * - Start-Service, exemple 4 « Start a disabled service » : le démarrage d'un service désactivé
 *   échoue (« Cannot start service TlntSvr on computer '.' »).
 * - net stop : « dhcp client — You cannot stop or pause the DHCP Client service » ; « Stopping the
 *   Server service prevents users from gaining access to the computer's shared resources ».
 *
 * Le modèle ne connaît pas les dépendances entre services (pas de -Force exigé) ni l'état
 * « en pause » : docs/fidelite.md, « À vérifier (Lot 2) ».
 */
import type { Draft } from 'immer'
import { logEvent } from '../core/eventlog'
import { raise, transact, type EngineResult } from '../core/result'
import type { HostDevice, LabState, ServiceState } from '../model/schema'
import { hostServices, type HostService } from '../roles/registry'
import { DEFAULT_SERVICE_STATE, serviceState } from './servicestate'

export type ServiceStartType = ServiceState['startType']

/** Service avec son état courant. */
export interface ServiceInfo extends HostService {
  status: ServiceState['status']
  startType: ServiceStartType
  /** Le service accepte-t-il l'arrêt ? (Learn, net stop : le Client DHCP ne peut pas être arrêté.) */
  canStop: boolean
}

/** Services qui refusent l'arrêt (Learn, net stop). */
const UNSTOPPABLE = new Set(['dhcp'])

function hostOf(state: LabState | Draft<LabState>, deviceId: string): HostDevice | Draft<HostDevice> {
  const d = state.devices[deviceId]
  if (!d || (d.kind !== 'server' && d.kind !== 'client'))
    raise('NotSupported', 'Cet équipement n’exécute pas de services système.')
  return d
}

function isController(state: LabState | Draft<LabState>, deviceId: string): boolean {
  return Object.values(state.domains).some((d) => d.controllers.includes(deviceId))
}

/** Services de l'ordinateur avec leur état (triés par nom affiché). */
export function computerServices(state: LabState, deviceId: string): ServiceInfo[] {
  const d = state.devices[deviceId]
  if (!d || (d.kind !== 'server' && d.kind !== 'client')) return []
  return hostServices(d.host.features, isController(state, deviceId)).map((s) => ({
    ...s,
    ...serviceState(d, s.name),
    canStop: !UNSTOPPABLE.has(s.name.toLowerCase())
  }))
}

/** Service désigné par son nom court ou son nom affiché (insensible à la casse). */
export function findComputerService(
  state: LabState,
  deviceId: string,
  name: string
): ServiceInfo | undefined {
  const lower = name.trim().toLowerCase()
  return computerServices(state, deviceId).find(
    (s) => s.name.toLowerCase() === lower || s.display.toLowerCase() === lower
  )
}

/** Libellé « Nom affiché (nom) » des messages de Start-Service (Learn, exemple 4). */
export function serviceLabel(s: HostService): string {
  return `${s.display} (${s.name})`
}

function requireService(state: LabState, deviceId: string, name: string): ServiceInfo {
  hostOf(state, deviceId)
  const s = findComputerService(state, deviceId, name)
  if (!s) raise('ServiceNotFound', `Le service « ${name} » n’existe pas sur cet ordinateur.`)
  return s
}

/** Écrit l'état ; l'état par défaut (démarré, automatique) n'est pas stocké. */
function store(device: Draft<HostDevice>, name: string, next: ServiceState): void {
  if (next.status === DEFAULT_SERVICE_STATE.status && next.startType === DEFAULT_SERVICE_STATE.startType)
    delete device.host.services[name]
  else device.host.services[name] = next
}

/** Évènement 7036 du Gestionnaire de contrôle des services (changement d'état). */
function logState(draft: Draft<LabState>, deviceId: string, s: HostService, running: boolean): void {
  logEvent(draft, deviceId, {
    level: 'information',
    source: 'Service Control Manager',
    eventId: 7036,
    message: `Le service ${s.display} est entré dans l’état : ${running ? 'en cours d’exécution' : 'arrêté'}.`
  })
}

/** Démarre un service (sans effet s'il tourne déjà). Un service désactivé ne démarre pas. */
export function startService(state: LabState, deviceId: string, name: string): EngineResult<ServiceInfo> {
  return transact(state, (draft) => {
    const s = requireService(state, deviceId, name)
    if (s.status === 'Running') return s
    if (s.startType === 'Disabled')
      raise(
        'ServiceDisabled',
        `Le service « ${serviceLabel(s)} » ne peut pas être démarré en raison de l’erreur suivante : impossible de démarrer le service ${s.name} sur l’ordinateur « . ». Son type de démarrage est Désactivé.`
      )
    const device = hostOf(draft, deviceId) as Draft<HostDevice>
    store(device, s.name, { status: 'Running', startType: s.startType })
    logState(draft, deviceId, s, true)
    return { ...s, status: 'Running' as const }
  })
}

/** Arrête un service (sans effet s'il est déjà arrêté). */
export function stopService(state: LabState, deviceId: string, name: string): EngineResult<ServiceInfo> {
  return transact(state, (draft) => {
    const s = requireService(state, deviceId, name)
    if (s.status === 'Stopped') return s
    if (!s.canStop) raise('ServiceCannotStop', `Le service « ${serviceLabel(s)} » ne peut pas être arrêté.`)
    const device = hostOf(draft, deviceId) as Draft<HostDevice>
    store(device, s.name, { status: 'Stopped', startType: s.startType })
    logState(draft, deviceId, s, false)
    return { ...s, status: 'Stopped' as const }
  })
}

/** Redémarre un service : arrêt (s'il tourne) puis démarrage. */
export function restartService(state: LabState, deviceId: string, name: string): EngineResult<ServiceInfo> {
  const stopped = stopService(state, deviceId, name)
  if (!stopped.ok) return stopped
  return startService(stopped.state, deviceId, name)
}

/** Change le type de démarrage (Set-Service -StartupType, sc config start=). */
export function setServiceStartType(
  state: LabState,
  deviceId: string,
  name: string,
  startType: ServiceStartType
): EngineResult<ServiceInfo> {
  return transact(state, (draft) => {
    const s = requireService(state, deviceId, name)
    const device = hostOf(draft, deviceId) as Draft<HostDevice>
    store(device, s.name, { status: s.status, startType })
    return { ...s, startType }
  })
}
