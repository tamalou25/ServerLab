/**
 * Services d'un contrôleur de domaine nécessaires pour répondre à un client (v2.8, chantier A) :
 *  - NTDS (Services de domaine Active Directory) : annuaire LDAP ;
 *  - Netlogon : localisation du contrôleur (réponse au « ping » LDAP du localisateur de DC) et
 *    canal sécurisé des membres du domaine.
 * Si l'un des deux est arrêté, le contrôleur ne répond plus : ouverture de session, `gpupdate`,
 * `nltest /dsgetdc` et jonction au domaine échouent. Tant qu'un autre contrôleur répond, le client
 * s'en sert (le localisateur essaie tous les enregistrements SRV).
 *
 * Sources Microsoft Learn :
 *  - ERROR_NO_LOGON_SERVERS (1311) « There are currently no logon servers available to service the
 *    logon request. » et ERROR_NO_SUCH_DOMAIN (1355) « The specified domain either does not exist or
 *    could not be contacted. » : https://learn.microsoft.com/windows/win32/debug/system-error-codes--1300-1699-
 *  - Événement 5719 de Netlogon (« This computer was not able to set up a secure session with a DC in
 *    domain [domain name] due to the following: … ») :
 *    https://learn.microsoft.com/troubleshoot/windows-server/windows-security/event-id-5719-when-netlogon-service-restarts
 *  - Événement 1129 de stratégie de groupe (pas de connectivité vers un contrôleur) :
 *    https://learn.microsoft.com/troubleshoot/windows-server/group-policy/netlogon-event-id-5719-or-group-policy-event-1129
 * Textes français : docs/fidelite.md, « À vérifier (v2.8 — services) » (A-20 à A-25).
 */
import type { Device } from '../../model/schema'
import { serviceRunning } from '../../services/servicestate'

/** Services qu'un contrôleur de domaine doit faire tourner pour répondre aux clients. */
export const DC_CLIENT_SERVICES = ['NTDS', 'Netlogon'] as const

/** Message de l'erreur système 1311 (ERROR_NO_LOGON_SERVERS), traduit de la définition de Learn. */
export const NO_LOGON_SERVERS_MESSAGE =
  'Il n’y a actuellement aucun serveur d’ouverture de session disponible pour traiter la demande d’ouverture de session.'

/** Premier des services NTDS / Netlogon arrêté sur l'ordinateur, null s'ils tournent tous deux. */
export function stoppedDcService(device: Device): (typeof DC_CLIENT_SERVICES)[number] | null {
  if (device.kind !== 'server' && device.kind !== 'client') return null
  return DC_CLIENT_SERVICES.find((name) => !serviceRunning(device, name)) ?? null
}

/** Le contrôleur est-il allumé avec NTDS et Netlogon démarrés (donc en mesure de répondre) ? */
export function dcAnswersClients(device: Device): boolean {
  return device.powered && stoppedDcService(device) === null
}
