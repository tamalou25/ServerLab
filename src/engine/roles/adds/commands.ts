/**
 * Commandes du rôle AD DS (annuaire, jonction, sessions) : actions pures du moteur + libellés.
 */
import { def, on } from '../../commands/define'
import { deviceName, directoryObjectName } from '../../commands/labels'
import { fail, type EngineResult } from '../../core/result'
import type { LabState } from '../../model/schema'
import type { PacketTrace } from '../../sim/trace'
import { installForest } from './forest'
import { moveFsmoRoles } from './fsmo'
import { installDomainController } from './promote'
import { syncDomain } from './replication'
import {
  moveDcToSite,
  newSite,
  newSiteLink,
  newSubnet,
  removeAdSite,
  removeSiteLink,
  removeSubnet,
  renameSite,
  setSiteLink
} from './sites'
import {
  changePasswordAndLogon,
  joinDomain,
  leaveDomain,
  logoff,
  logon,
  type DirectoryOperation,
  type LogonOutcome
} from './join'
import {
  addComputer,
  addGroup,
  addGroupMembers,
  addOrganizationalUnit,
  addUser,
  moveObject,
  removeGroupMembers,
  enableRecycleBin,
  removeObject,
  resetPassword,
  restoreDeletedObject,
  setAccountActivity,
  setServicePrincipalNames,
  setAccountEnabled,
  setUserProperties,
  unlockAccount,
  setGroupProperties
} from './objects'

/** Résultat métier d'une opération d'annuaire (jonction, ouverture de session…). */
export interface DirectoryOutcome {
  /** L'opération a abouti (un échec est aussi journalisé : évènement 4625, trace réseau). */
  success: boolean
  message: string
  trace: PacketTrace
  mustChangePassword: boolean
}

/** Une opération d'annuaire modifie l'état même en cas d'échec (journal de sécurité, trace). */
function directory(op: DirectoryOperation | LogonOutcome): EngineResult<DirectoryOutcome> {
  return {
    ok: true,
    state: op.state,
    value: {
      success: op.ok,
      message: op.message,
      trace: op.trace,
      mustChangePassword: 'mustChangePassword' in op ? op.mustChangePassword === true : false
    }
  }
}

/** Fermeture de session (l'action renvoie directement l'état). */
function closeSession(state: LabState, deviceId: string): EngineResult {
  if (!state.devices[deviceId]) return fail('DeviceNotFound', 'Équipement introuvable.')
  return { ok: true, state: logoff(state, deviceId), value: undefined }
}

export const addsCommands = {
  'adds.installForest': def(
    installForest,
    (s, id, f) => `Promouvoir ${deviceName(s, id)} (forêt ${f.domainName})`
  ),
  'adds.addOrganizationalUnit': def(
    addOrganizationalUnit,
    (_s, _d, ou) => `Créer l’unité d’organisation ${ou.name}`
  ),
  'adds.addUser': def(addUser, (_s, _d, u) => `Créer l’utilisateur ${u.name}`),
  'adds.addGroup': def(addGroup, (_s, _d, g) => `Créer le groupe ${g.name}`),
  'adds.setGroupProperties': def(setGroupProperties, (_s, _d, group) => `Modifier le groupe ${group}`),
  'adds.addComputer': def(addComputer, (_s, _d, c) => `Créer le compte d’ordinateur ${c.name}`),
  'adds.addGroupMembers': def(addGroupMembers, (_s, _d, group) => `Ajouter des membres au groupe ${group}`),
  'adds.removeGroupMembers': def(
    removeGroupMembers,
    (_s, _d, group) => `Retirer des membres du groupe ${group}`
  ),
  'adds.moveObject': def(moveObject, (s, d, id) => `Déplacer ${directoryObjectName(s, d, id)}`),
  'adds.removeObject': def(removeObject, (s, d, id) => `Supprimer ${directoryObjectName(s, d, id)}`),
  'adds.enableRecycleBin': def(enableRecycleBin, (_s, d) => `Activer la Corbeille Active Directory (${d})`),
  'adds.restoreDeleted': def(
    restoreDeletedObject,
    (s, d, id) =>
      `Restaurer ${s.domains[d]?.deletedObjects.find((o) => o.obj.id === id)?.obj.name ?? 'un objet'} depuis la Corbeille`
  ),
  'adds.setAccountActivity': def(
    setAccountActivity,
    (_s, _d, identity) => `Historique du compte ${identity}`
  ),
  'adds.setServicePrincipalNames': def(
    setServicePrincipalNames,
    (_s, _d, identity) => `Définir les SPN de ${identity}`
  ),
  'adds.unlockAccount': def(unlockAccount, (_s, _d, identity) => `Déverrouiller le compte ${identity}`),
  'adds.setUserProperties': def(
    setUserProperties,
    (_s, _d, identity) => `Modifier les propriétés de ${identity}`
  ),
  'adds.setAccountEnabled': def(
    setAccountEnabled,
    (_s, _d, identity, enabled) => `${enabled ? 'Activer' : 'Désactiver'} le compte ${identity}`
  ),
  'adds.resetPassword': def(
    resetPassword,
    (_s, _d, identity) => `Réinitialiser le mot de passe de ${identity}`
  ),
  'adds.joinDomain': def(
    (s: LabState, id: string, input: Parameters<typeof joinDomain>[2]) => directory(joinDomain(s, id, input)),
    (s, id, input) => `Joindre ${deviceName(s, id)} au domaine ${input.domain}`
  ),
  'adds.leaveDomain': def(
    (s: LabState, id: string) => directory(leaveDomain(s, id)),
    (s, id) => `Retirer ${deviceName(s, id)} du domaine`
  ),
  'adds.logon': def(
    (s: LabState, id: string, input: Parameters<typeof logon>[2]) => directory(logon(s, id, input)),
    (s, id, input) => `Ouvrir une session ${input.user}${on(s, id)}`
  ),
  'adds.changePasswordAndLogon': def(
    (s: LabState, id: string, input: Parameters<typeof changePasswordAndLogon>[2]) =>
      directory(changePasswordAndLogon(s, id, input)),
    (s, id, input) => `Changer le mot de passe de ${input.user}${on(s, id)}`
  ),
  'adds.logoff': def(closeSession, (s, id) => `Fermer la session${on(s, id)}`),
  'adds.installDomainController': def(
    (s: LabState, id: string, input: Parameters<typeof installDomainController>[2]) =>
      directory(installDomainController(s, id, input)),
    (s, id, input) => `Promouvoir ${deviceName(s, id)} (contrôleur supplémentaire de ${input.domainName})`
  ),
  'adds.newSite': def(newSite, (_s, _d, input) => `Créer le site ${input.name}`),
  'adds.renameSite': def(renameSite, (_s, _d, name, next) => `Renommer le site ${name} en ${next}`),
  'adds.removeSite': def(removeAdSite, (_s, _d, name) => `Supprimer le site ${name}`),
  'adds.newSubnet': def(newSubnet, (_s, _d, input) => `Créer le sous-réseau ${input.prefix} (${input.site})`),
  'adds.removeSubnet': def(removeSubnet, (_s, _d, prefix) => `Supprimer le sous-réseau ${prefix}`),
  'adds.newSiteLink': def(newSiteLink, (_s, _d, input) => `Créer le lien de sites ${input.name}`),
  'adds.setSiteLink': def(setSiteLink, (_s, _d, name) => `Modifier le lien de sites ${name}`),
  'adds.removeSiteLink': def(removeSiteLink, (_s, _d, name) => `Supprimer le lien de sites ${name}`),
  'adds.moveDcToSite': def(
    moveDcToSite,
    (s, _d, id, site) => `Déplacer ${deviceName(s, id)} dans le site ${site}`
  ),
  'adds.moveFsmoRoles': def(
    moveFsmoRoles,
    (s, _d, id, roles) => `Transférer ${roles.join(', ')} vers ${deviceName(s, id)}`
  ),
  'adds.syncReplication': def(syncDomain, (_s, d) => `Répliquer maintenant (${d})`)
}
