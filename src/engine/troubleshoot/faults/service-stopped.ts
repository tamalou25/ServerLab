/**
 * Panne `windows.service-stopped` : le service d'un rôle installé est arrêté (`service.stop`).
 * Le symptôme est l'effet réel sur le lab, lu par la sonde du service (DNS, DHCPServer,
 * LanmanServer, W3SVC, Netlogon : voir `service-probes.ts`), jamais une sortie nouvelle.
 * Réparation : `service.start` (puis renouvellement du bail pour le serveur DHCP).
 */
import { command } from '../../commands/catalog'
import { serviceFault, type ServiceFaultSpec } from './service-fault'

/** Définition réutilisable (les pannes composées la restreignent à un service). */
export const stoppedSpec: ServiceFaultSpec = {
  id: 'windows.service-stopped',
  title: 'Service arrêté',
  difficulty: 1,
  // -Force : les services dépendants qui tournent (Netlogon sur un contrôleur) s'arrêtent d'abord
  break: (_s, p) => [command('service.stop', String(p['device']), String(p['service']), true)],
  fix: (_s, p) => [command('service.start', String(p['device']), String(p['service']))],
  cause: () => 'Le service était arrêté : il ne répondait plus aux demandes des clients.'
}

export const serviceStopped = serviceFault(stoppedSpec)
