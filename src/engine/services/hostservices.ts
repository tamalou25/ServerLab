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
 * Échec au démarrage (v2.8, #224) : un service marqué en échec (`failure`) refuse de démarrer
 * (erreur 1066 ou 1053, codes d'erreur système de Learn) jusqu'à la réparation de sa configuration
 * (`clearServiceFailure`) ; le refus est journalisé (évènement 7000) par `recordStartFailure`.
 * Options de récupération (`sc failure`) : `setServiceRecovery`.
 * Le modèle ne connaît pas l'état « en pause » : docs/fidelite.md, « À vérifier (Lot 2) ».
 */
import type { Draft } from 'immer'
import { logEvent } from '../core/eventlog'
import { raise, transact, type EngineResult } from '../core/result'
import type {
  HostDevice,
  LabState,
  ServiceFailure,
  ServiceRecovery,
  ServiceRecoveryActionType,
  ServiceState
} from '../model/schema'
import { hostServices, type HostService } from '../roles/registry'
import { dependentNames, requiredChain, requiredNames } from './servicedeps'
import { isDefaultServiceState, serviceState } from './servicestate'

export type ServiceStartType = ServiceState['startType']

/** Service avec son état courant. */
export interface ServiceInfo extends HostService {
  status: ServiceState['status']
  startType: ServiceStartType
  /** Échec au démarrage (v2.8) : le service refuse de démarrer tant qu'il n'est pas réparé. */
  failure?: ServiceFailure | undefined
  /** Options de récupération (`sc failure`, v2.8). */
  recovery?: ServiceRecovery | undefined
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

/** Partie stockée d'un service (état, type de démarrage, échec, récupération) ; `patch` la modifie. */
function stateOf(s: ServiceInfo, patch: Partial<ServiceState> = {}): ServiceState {
  const next: ServiceState = { status: s.status, startType: s.startType, ...patch }
  if (!('failure' in patch) && s.failure) next.failure = s.failure
  if (!('recovery' in patch) && s.recovery) next.recovery = s.recovery
  if (next.failure === undefined) delete next.failure
  if (next.recovery === undefined) delete next.recovery
  return next
}

/** Écrit l'état ; l'état par défaut (démarré, automatique, sans panne) n'est pas stocké. */
function store(device: Draft<HostDevice>, name: string, next: ServiceState): void {
  if (isDefaultServiceState(next)) delete device.host.services[name]
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

/**
 * Première dépendance (directe ou non) désactivée ou en échec au démarrage : elle empêche le
 * démarrage (erreur 1068).
 */
export function disabledDependency(state: LabState, deviceId: string, name: string): ServiceInfo | undefined {
  return pick(state, deviceId, requiredChain(name, namesOf(state, deviceId))).find(
    (s) => s.status !== 'Running' && (s.startType === 'Disabled' || s.failure !== undefined)
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
    const failure = startFailureOf(s)
    if (failure)
      raise(
        'ServiceStartFailed',
        `Le service « ${serviceLabel(s)} » ne peut pas être démarré en raison de l’erreur suivante : impossible de démarrer le service ${s.name} sur l’ordinateur « . ». ${failure.text}`
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
      store(device, c.name, stateOf(c, { status: 'Running' }))
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
      store(device, d.name, stateOf(d, { status: 'Stopped' }))
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
    store(device, s.name, stateOf(s, { startType }))
    return { ...s, startType }
  })
}

// ---------------------------------------------------------------------------------------------
// Échec au démarrage et récupération (v2.8, #224)

/**
 * Erreur Win32 renvoyée par le démarrage d'un service en échec (Learn, « System Error Codes
 * (1000-1299) ») : 1066 ERROR_SERVICE_SPECIFIC_ERROR « The service has returned a service-specific
 * error code. » (configuration invalide), 1053 ERROR_SERVICE_REQUEST_TIMEOUT « The service did not
 * respond to the start or control request in a timely fashion. » (délai dépassé). Textes français
 * traduits de ces définitions, à vérifier : docs/fidelite.md.
 */
export const START_FAILURE_ERRORS: Record<ServiceFailure['reason'], { number: number; text: string }> = {
  invalidConfig: {
    number: 1066,
    text: 'Le service a renvoyé un code d’erreur spécifique au service.'
  },
  timeout: {
    number: 1053,
    text: 'Le service n’a pas répondu assez rapidement à la demande de démarrage ou de contrôle.'
  }
}

/** Erreur de démarrage du service s'il est en échec (numéro Win32 et texte), sinon `undefined`. */
export function startFailureOf(
  s: Pick<ServiceInfo, 'failure'>
): { number: number; text: string } | undefined {
  return s.failure ? START_FAILURE_ERRORS[s.failure.reason] : undefined
}

/**
 * Évènement 7000 du Gestionnaire de contrôle des services. Learn (Netlogon, « Troubleshoot Netlogon
 * service startup failures ») : « The Netlogon service failed to start due to the following error: »
 * suivi du texte de l'erreur. Libellé français à vérifier (docs/fidelite.md).
 */
export function startFailureEvent(display: string, text: string) {
  return {
    level: 'error' as const,
    source: 'Service Control Manager',
    eventId: 7000,
    message: `Le service ${display} n’a pas pu démarrer en raison de l’erreur suivante : \n${text}`
  }
}

/**
 * Journalise le refus de démarrer d'un service en échec (évènement 7000). `startService` renvoie
 * une erreur sans modifier l'état : les consoles appellent cette fonction pour garder la trace.
 * Sans effet si le service n'est pas en échec.
 */
export function recordStartFailure(state: LabState, deviceId: string, name: string): LabState {
  const s = findComputerService(state, deviceId, name)
  const failure = s && startFailureOf(s)
  if (!s || !failure) return state
  const r = transact(state, (draft) => logEvent(draft, deviceId, startFailureEvent(s.display, failure.text)))
  return r.ok ? r.state : state
}

/** Texte de l'action corrective de l'évènement 7031 (« Restart the service. » : Microsoft Q&A). */
const CORRECTIVE_ACTION_TEXT: Record<ServiceRecoveryActionType, string> = {
  restart: 'Redémarrer le service.',
  reboot: 'Redémarrer l’ordinateur.',
  run: 'Exécuter la commande de récupération.'
}

/**
 * Journalise l'arrêt inattendu d'un service : 7031 avec l'action corrective s'il y en a une pour
 * ce premier échec, 7034 sinon (Learn, « Error 1053, Error 1067, or Event ID 7034 » : « The … service
 * terminated unexpectedly. It has done this X time(s). »). Une action « restart » échoue ensuite
 * car le service est en échec (7000). Le compteur d'échecs n'est pas conservé : toujours 1 fois.
 */
function logUnexpectedStop(draft: Draft<LabState>, deviceId: string, s: ServiceInfo): void {
  const action = s.recovery?.actions[0]
  const base = `Le service ${s.display} s’est arrêté de manière inattendue. Ce comportement s’est produit 1 fois.`
  if (!action) {
    logEvent(draft, deviceId, {
      level: 'error',
      source: 'Service Control Manager',
      eventId: 7034,
      message: base
    })
    return
  }
  logEvent(draft, deviceId, {
    level: 'error',
    source: 'Service Control Manager',
    eventId: 7031,
    message: `${base} L’action corrective suivante sera exécutée dans ${action.delayMs} millisecondes : ${CORRECTIVE_ACTION_TEXT[action.type]}`
  })
  const failure = startFailureOf(s)
  if (action.type === 'restart' && failure)
    logEvent(draft, deviceId, startFailureEvent(s.display, failure.text))
}

/**
 * Met un service en échec au démarrage (panne de configuration). S'il tournait, il s'arrête de
 * façon inattendue (ses dépendants en cours d'exécution s'arrêtent d'abord) : évènement 7034 ou
 * 7031. Il refuse ensuite de démarrer jusqu'à `clearServiceFailure`.
 */
export function setServiceFailure(
  state: LabState,
  deviceId: string,
  name: string,
  reason: ServiceFailure['reason']
): EngineResult<ServiceInfo> {
  return transact(state, (draft) => {
    const s = requireService(state, deviceId, name)
    const device = hostOf(draft, deviceId) as Draft<HostDevice>
    const failing: ServiceInfo = { ...s, failure: { reason } }
    if (s.status === 'Running') {
      for (const d of runningDependents(state, deviceId, name)) {
        store(device, d.name, stateOf(d, { status: 'Stopped' }))
        logState(draft, deviceId, d, false)
      }
      store(device, s.name, stateOf(s, { status: 'Stopped', failure: { reason } }))
      logUnexpectedStop(draft, deviceId, failing)
    } else store(device, s.name, stateOf(s, { failure: { reason } }))
    return { ...failing, status: 'Stopped' as const }
  })
}

/** Répare la configuration du service : il peut de nouveau démarrer (il n'est pas démarré pour autant). */
export function clearServiceFailure(
  state: LabState,
  deviceId: string,
  name: string
): EngineResult<ServiceInfo> {
  return transact(state, (draft) => {
    const s = requireService(state, deviceId, name)
    const device = hostOf(draft, deviceId) as Draft<HostDevice>
    store(device, s.name, stateOf(s, { failure: undefined }))
    return { ...s, failure: undefined }
  })
}

/** Modification des options de récupération (`sc failure`) : seuls les champs fournis changent. */
export type ServiceRecoveryPatch = Partial<ServiceRecovery>

/** Options de récupération d'un service (valeurs par défaut si jamais configurées). */
export function serviceRecovery(s: Pick<ServiceInfo, 'recovery'>): ServiceRecovery {
  return s.recovery ?? { resetSeconds: 0, rebootMessage: '', command: '', actions: [] }
}

/** Configure les options de récupération (`sc failure reset= reboot= command= actions=`). */
export function setServiceRecovery(
  state: LabState,
  deviceId: string,
  name: string,
  patch: ServiceRecoveryPatch
): EngineResult<ServiceInfo> {
  return transact(state, (draft) => {
    const s = requireService(state, deviceId, name)
    const device = hostOf(draft, deviceId) as Draft<HostDevice>
    const recovery: ServiceRecovery = { ...serviceRecovery(s), ...patch }
    store(device, s.name, stateOf(s, { recovery }))
    return { ...s, recovery }
  })
}
