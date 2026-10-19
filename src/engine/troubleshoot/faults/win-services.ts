/**
 * Pannes de service Windows (chantier D, #230) construites sur les sondes de `service-probes.ts` :
 * - `win.service-disabled` : service désactivé (type de démarrage Disabled) et arrêté ;
 * - `win.service-failed` : service en échec au démarrage (`service.setFailure`, erreur 1066 ou 1053) ;
 * - `win.dependency-stopped` : un service dont le service dépend est arrêté (table
 *   `servicedeps.ts`) : le dépendant tombe avec lui et ne reviendra pas tout seul.
 */
import { command } from '../../commands/catalog'
import type { LabState } from '../../model/schema'
import { requiredNames } from '../../services/servicedeps'
import { computerServices } from '../../services/hostservices'
import type { FaultTargetParams } from '../types'
import { serviceFault, startable, type ServiceFaultSpec } from './service-fault'
import { nameOf, running } from './service-probes'

const dev = (p: FaultTargetParams) => String(p['device'])
const svc = (p: FaultTargetParams) => String(p['service'])

export const serviceDisabled = serviceFault({
  id: 'win.service-disabled',
  title: 'Service désactivé',
  difficulty: 2,
  break: (_s, p) => [
    command('service.stop', dev(p), svc(p), true),
    command('service.setStartType', dev(p), svc(p), 'Disabled')
  ],
  // Un service désactivé ne démarre pas : il faut d'abord rétablir son type de démarrage
  fix: (_s, p) => [
    command('service.setStartType', dev(p), svc(p), 'Automatic'),
    command('service.start', dev(p), svc(p))
  ],
  serviceOk: (state, p) => startable(state, p),
  trackHint: (state, p) =>
    `Le service est bien là mais ne se relance pas : regardez son type de démarrage sur ${nameOf(state, p['device'])}.`,
  cause: () => 'Le service avait un type de démarrage Désactivé : il ne démarrait plus, même à la main.'
})

/** Définition réutilisable (les pannes composées la restreignent à un service). */
export const failedSpec: ServiceFaultSpec = {
  id: 'win.service-failed',
  title: 'Service en échec au démarrage',
  difficulty: 2,
  expand: (_s, p) => [
    { ...p, reason: 'invalidConfig' },
    { ...p, reason: 'timeout' }
  ],
  break: (_s, p) => [
    command(
      'service.setFailure',
      dev(p),
      svc(p),
      String(p['reason']) === 'timeout' ? 'timeout' : 'invalidConfig'
    )
  ],
  // Réparer la configuration, puis démarrer
  fix: (_s, p) => [command('service.clearFailure', dev(p), svc(p)), command('service.start', dev(p), svc(p))],
  serviceOk: (state, p) => startable(state, p),
  trackHint: (state, p) =>
    `Le service s’est arrêté tout seul et refuse de redémarrer : lisez le message d’erreur et le journal Système de ${nameOf(state, p['device'])}.`,
  cause: (_s, p) =>
    String(p['reason']) === 'timeout'
      ? 'Le service ne répondait plus au démarrage (délai dépassé, erreur 1053) : il restait arrêté.'
      : 'La configuration du service était invalide (erreur 1066) : il s’arrêtait et refusait de redémarrer.'
}

export const serviceFailed = serviceFault(failedSpec)

/** Dépendances (sourcées, `servicedeps.ts`) d'un service présent sur l'ordinateur. */
function dependenciesOf(state: LabState, device: string, service: string): string[] {
  const present = computerServices(state, device).map((s) => s.name)
  return requiredNames(service, present)
}

/** Définition réutilisable (les pannes composées la restreignent à un service). */
export const dependencySpec: ServiceFaultSpec = {
  id: 'win.dependency-stopped',
  title: 'Service dont dépend un autre service arrêté',
  difficulty: 3,
  // Le symptôme est celui du service dépendant (W3SVC, Netlogon) ; la cause est sa dépendance
  expand: (state, p) => dependenciesOf(state, dev(p), svc(p)).map((dependency) => ({ ...p, dependency })),
  // Arrêt forcé de la dépendance : ses dépendants en cours d'exécution s'arrêtent d'abord
  break: (_s, p) => [command('service.stop', dev(p), String(p['dependency']), true)],
  // Démarrer le dépendant relance sa dépendance d'abord (Start-Service)
  fix: (_s, p) => [command('service.start', dev(p), svc(p))],
  serviceOk: (state, p) => running(state, p, String(p['dependency'])),
  trackHint: (state, p) =>
    `Le service du symptôme dépend d’un autre service : listez ses dépendances (Get-Service -RequiredServices) sur ${nameOf(state, p['device'])}.`,
  cause: (_s, p) =>
    `Le service ${String(p['dependency'])}, dont dépend ${svc(p)}, avait été arrêté : ${svc(p)} s’était arrêté avec lui et ne redémarrait pas seul.`
}

export const dependencyStopped = serviceFault(dependencySpec)
