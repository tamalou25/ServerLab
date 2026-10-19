/**
 * Libellés d'affichage des services (snap-in Services, Gestionnaire de serveur).
 * Présentation uniquement : l'état vient des accesseurs du moteur (`computerServices`).
 */
import type { ServiceInfo, ServiceStartType } from '@engine/index'

/** Libellés du type de démarrage (colonne « Type de démarrage » de services.msc). */
export const START_TYPE_LABELS: Record<ServiceStartType, string> = {
  Automatic: 'Automatique',
  Manual: 'Manuel',
  Disabled: 'Désactivé'
}

/** Libellé de l'état d'un service. */
export function statusLabel(s: Pick<ServiceInfo, 'status'>): string {
  return s.status === 'Running' ? 'En cours d’exécution' : 'Arrêté'
}

/** Service à signaler : arrêté alors que son démarrage est automatique. */
export function isAlert(s: Pick<ServiceInfo, 'status' | 'startType'>): boolean {
  return s.status !== 'Running' && s.startType === 'Automatic'
}

/** Compte d'ouverture de session des services du système (valeurs usuelles de Windows Server). */
const LOGON_ACCOUNTS: Record<string, string> = {
  dhcp: 'Service local',
  dnscache: 'Service réseau',
  eventlog: 'Service local',
  mpssvc: 'Service local',
  lanmanworkstation: 'Service réseau',
  w32time: 'Service local'
}

export function logonAccount(name: string): string {
  return LOGON_ACCOUNTS[name.toLowerCase()] ?? 'Système local'
}
