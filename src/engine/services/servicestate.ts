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

/** L'état est-il celui d'une installation neuve (rien à stocker dans le .slab) ? */
export function isDefaultServiceState(s: ServiceState): boolean {
  return (
    s.status === DEFAULT_SERVICE_STATE.status &&
    s.startType === DEFAULT_SERVICE_STATE.startType &&
    s.failure === undefined &&
    s.recovery === undefined
  )
}

/**
 * Démarrage de l'ordinateur : les services en démarrage automatique démarrent, les autres
 * restent arrêtés (Learn, Set-Service -StartupType : « Manual - The service is started only
 * manually »). Un service en échec au démarrage (v2.8) reste arrêté quel que soit son type ; ses
 * options de récupération sont conservées. L'état par défaut (démarré, automatique) n'est pas stocké.
 * Renvoie les noms des services en démarrage automatique qui ont échoué (évènement 7000).
 */
export function bootServices(device: {
  host: { services: Record<string, ServiceState>; linux?: { loaded?: Record<string, string> } }
}): string[] {
  const failed: string[] = []
  // Linux : les services relisent leur configuration au démarrage (instantanés de linuxconfig.ts oubliés)
  if (device.host.linux?.loaded) delete device.host.linux.loaded
  for (const [name, s] of Object.entries(device.host.services)) {
    const fails = s.failure !== undefined
    if (fails && s.startType === 'Automatic') failed.push(name)
    const next: ServiceState = { ...s, status: !fails && s.startType === 'Automatic' ? 'Running' : 'Stopped' }
    if (isDefaultServiceState(next)) delete device.host.services[name]
    else device.host.services[name] = next
  }
  return failed
}
