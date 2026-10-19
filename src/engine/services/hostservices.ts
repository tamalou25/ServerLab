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
 * Dépendances (v2.8, #223) : table sourcée dans `servicedeps.ts`. Démarrer un service démarre
 * d'abord ses dépendances ; une dépendance désactivée fait échouer le démarrage (erreur 1068).
 * Arrêter un service dont des dépendants tournent échoue sans `force` (erreur 1051, Stop-Service
 * sans -Force) ; avec `force`, les dépendants sont arrêtés d'abord.
 * Le modèle ne connaît pas l'état « en pause » : docs/fidelite.md, « À vérifier (Lot 2) ».
 */
import type { Draft } from 'immer'
import { logEvent } from '../core/eventlog'
import { raise, transact, type EngineResult } from '../core/result'
import type { HostDevice, LabState, ServiceState } from '../model/schema'
import { hostServices, type HostService } from '../roles/registry'
import { dependentNames, requiredChain, requiredNames } from './servicedeps'
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

const namesOf = (state: LabState, deviceId: string) => computerServices(state, deviceId).map((s) => s.name)

const pick = (state: LabState, deviceId: string, names: string[]): ServiceInfo[] =>
  names.flatMap((n) => findComputerService(state, deviceId, n) ?? [])

/** Services requis directement par un service (Get-Service -RequiredServices, ServicesDependedOn). */
export function requiredServices(state: LabState, deviceId: string, name: string): ServiceInfo[] {
  return pick(state, deviceId, requiredNames(name, namesOf(state, deviceId)))
}

/** Services qui dépendent d'un service, directement ou non (Get-Service -DependentServices). */
export function dependentServices(state: LabState, deviceId: string, name: string): ServiceInfo[] {
  return pick(state, deviceId, dependentNames(name, namesOf(state, deviceId)))
}

/** Dépendants en cours d'exécution : ce sont eux qui empêchent l'arrêt sans -Force. */
export function runningDependents(state: LabState, deviceId: string, name: string): ServiceInfo[] {
  return dependentServices(state, deviceId, name).filter((s) => s.status === 'Running')
}

/** Première dépendance (directe ou non) désactivée : elle empêche le démarrage (erreur 1068). */
export function disabledDependency(state: LabState, deviceId: string, name: string): ServiceInfo | undefined {
  return pick(state, deviceId, requiredChain(name, namesOf(state, deviceId))).find(
    (s) => s.status !== 'Running' && s.startType === 'Disabled'
  )
}

/**
 * Démarre un service (sans effet s'il tourne déjà), après ses dépendances arrêtées. Un service
 * désactivé ne démarre pas ; une dépendance désactivée fait échouer le démarrage.
 */
export function startService(state: LabState, deviceId: string, name: string): EngineResult<ServiceInfo> {
  return transact(state, (draft) => {
    const s = requireService(state, deviceId, name)
    if (s.status === 'Running') return s
    if (s.startType === 'Disabled')
      raise(
        'ServiceDisabled',
        `Le service « ${serviceLabel(s)} » ne peut pas être démarré en raison de l’erreur suivante : impossible de démarrer le service ${s.name} sur l’ordinateur « . ». Son type de démarrage est Désactivé.`
      )
    if (disabledDependency(state, deviceId, name))
      raise(
        'ServiceDependencyFailed',
        `Le service « ${serviceLabel(s)} » ne peut pas être démarré en raison de l’erreur suivante : impossible de démarrer le service ${s.name} sur l’ordinateur « . ». Le service ou le groupe de dépendances n’a pas pu démarrer.`
      )
    const device = hostOf(draft, deviceId) as Draft<HostDevice>
    // Dépendances d'abord (les plus profondes en premier), puis le service lui-même
    const needed = pick(state, deviceId, requiredChain(name, namesOf(state, deviceId))).filter(
      (r) => r.status !== 'Running'
    )
    for (const c of [...needed, s]) {
      store(device, c.name, { status: 'Running', startType: c.startType })
      logState(draft, deviceId, c, true)
    }
    return { ...s, status: 'Running' as const }
  })
}

/**
 * Arrête un service (sans effet s'il est déjà arrêté). Des dépendants en cours d'exécution
 * l'interdisent sans `force` ; avec `force` ils sont arrêtés d'abord (Stop-Service -Force).
 */
export function stopService(
  state: LabState,
  deviceId: string,
  name: string,
  force = false
): EngineResult<ServiceInfo> {
  return transact(state, (draft) => {
    const s = requireService(state, deviceId, name)
    if (s.status === 'Stopped') return s
    if (!s.canStop) raise('ServiceCannotStop', `Le service « ${serviceLabel(s)} » ne peut pas être arrêté.`)
    const dependents = runningDependents(state, deviceId, name)
    // PowerShell (ServiceHasDependentServices) : « Cannot stop service '{1} ({0})' because it has
    // dependent services. It can only be stopped if the Force flag is set. »
    if (dependents.length > 0 && !force)
      raise(
        'ServiceHasDependents',
        `Impossible d’arrêter le service « ${serviceLabel(s)} » car il a des services dépendants. Il ne peut être arrêté que si l’indicateur Force est défini.`
      )
    const device = hostOf(draft, deviceId) as Draft<HostDevice>
    for (const d of [...dependents, s]) {
      store(device, d.name, { status: 'Stopped', startType: d.startType })
      logState(draft, deviceId, d, false)
    }
    return { ...s, status: 'Stopped' as const }
  })
}

/**
 * Redémarre un service : arrêt (s'il tourne) puis démarrage. Avec `force`, les dépendants en
 * cours d'exécution sont arrêtés d'abord, puis redémarrés après le service.
 */
export function restartService(
  state: LabState,
  deviceId: string,
  name: string,
  force = false
): EngineResult<ServiceInfo> {
  const dependents = runningDependents(state, deviceId, name)
  const stopped = stopService(state, deviceId, name, force)
  if (!stopped.ok) return stopped
  const started = startService(stopped.state, deviceId, name)
  if (!started.ok || !force) return started
  let current = started.state
  for (const d of dependents) {
    const r = startService(current, deviceId, d.name)
    if (!r.ok) return r
    current = r.state
  }
  return { ok: true, state: current, value: started.value }
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
