/**
 * Lecture de l'état démarré / arrêté d'un service système (v2.7, Lot 2a).
 *
 * Module sans dépendance (ni registre des rôles, ni topologie) : les rôles l'importent pour
 * vérifier que leur service tourne (résolveur DNS, serveur DHCP, serveur SMB) sans créer de cycle.
 * Les actions (démarrer, arrêter, type de démarrage) sont dans `hostservices.ts`.
 */
import type { ServiceState } from '../model/schema'

/** Partie d'un ordinateur utile à la lecture (fonctionne aussi sur un brouillon immer). */
interface WithServices {
  host: { services?: Readonly<Record<string, ServiceState>> }
}

/** État par défaut : démarré, démarrage automatique (installation neuve). */
export const DEFAULT_SERVICE_STATE: ServiceState = { status: 'Running', startType: 'Automatic' }

/** État d'un service par son nom court (insensible à la casse). */
export function serviceState(device: WithServices, name: string): ServiceState {
  const table = device.host.services ?? {}
  const direct = table[name]
  if (direct) return direct
  const lower = name.toLowerCase()
  const key = Object.keys(table).find((k) => k.toLowerCase() === lower)
  return key ? (table[key] ?? DEFAULT_SERVICE_STATE) : DEFAULT_SERVICE_STATE
}

/**
 * Le service tourne-t-il ? (L'ordinateur allumé et le rôle installé sont vérifiés par l'appelant.)
 * Arrêter « DNS » coupe le serveur DNS, « DHCPServer » la distribution de baux, « LanmanServer »
 * l'accès aux partages.
 */
export function serviceRunning(device: WithServices, name: string): boolean {
  return serviceState(device, name).status === 'Running'
}

/**
 * Démarrage de l'ordinateur : les services en démarrage automatique démarrent, les autres
 * restent arrêtés (Learn, Set-Service -StartupType : « Manual - The service is started only
 * manually »). L'état par défaut (démarré, automatique) n'est pas stocké.
 */
export function bootServices(device: { host: { services: Record<string, ServiceState> } }): void {
  for (const [name, s] of Object.entries(device.host.services)) {
    if (s.startType === 'Automatic') delete device.host.services[name]
    else device.host.services[name] = { status: 'Stopped', startType: s.startType }
  }
}
