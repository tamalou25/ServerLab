/**
 * Commandes du rôle Fichiers (NTFS, partages SMB, lecteurs réseau) : actions pures + libellés.
 */
import { setSmb1 } from './smbconfig'
import { def, on } from '../../commands/define'
import type { EngineResult } from '../../core/result'
import type { LabState } from '../../model/schema'
import type { PacketTrace } from '../../sim/trace'
import type { AccessToken } from './acl'
import {
  copyItem,
  createItem,
  createShare,
  removeItem,
  removeNtfs,
  removeShare,
  renameItem,
  setNtfsEntry,
  setNtfsInheritance,
  setShareAcl,
  writeFileContent
} from './actions'
import { findNode } from './paths'
import { mapDrive, unmapDrive, type DriveOperation } from './smb'

/** Lecteur réseau : un échec (erreur système 53, 67, 5…) ne modifie pas l'état. */
function drive(op: DriveOperation): EngineResult<{ trace: PacketTrace }> {
  if (!op.ok) return { ok: false, error: { code: `SystemError${op.code}`, message: op.message } }
  return { ok: true, state: op.state, value: { trace: op.trace } }
}

/** Partage d'un dossier, créé au besoin avec ses parents (assistant « Nouveau partage »). */
function shareFolder(
  state: LabState,
  serverId: string,
  input: Parameters<typeof createShare>[2],
  token: AccessToken
): EngineResult {
  const server = state.devices[serverId]
  const exists = server?.kind === 'server' && findNode(server.storage, input.path) !== undefined
  const created = exists ? null : createItem(state, serverId, input.path, 'folder', token, { parents: true })
  if (created && !created.ok) return created
  return createShare(created ? created.state : state, serverId, input, token)
}

export const filesCommands = {
  'files.setSmb1': def(
    setSmb1,
    (s, id, enabled) => `${enabled ? 'Activer' : 'Désactiver'} SMB 1.0${on(s, id)}`
  ),
  'files.createItem': def(
    createItem,
    (s, id, path, kind) => `Créer ${kind === 'folder' ? 'le dossier' : 'le fichier'} ${path}${on(s, id)}`
  ),
  'files.writeContent': def(
    writeFileContent,
    (s, id, path, _text, _token, options) =>
      `${options?.append ? 'Ajouter au fichier' : 'Écrire le fichier'} ${path}${on(s, id)}`
  ),
  'files.copyItem': def(
    copyItem,
    (s, id, source, destination) => `Copier ${source} vers ${destination}${on(s, id)}`
  ),
  'files.renameItem': def(renameItem, (s, id, path, newName) => `Renommer ${path} en ${newName}${on(s, id)}`),
  'files.removeItem': def(removeItem, (s, id, path) => `Supprimer ${path}${on(s, id)}`),
  'files.createShare': def(
    createShare,
    (s, id, input) => `Partager ${input.path} sous ${input.name}${on(s, id)}`
  ),
  'files.shareFolder': def(
    shareFolder,
    (s, id, input) => `Partager ${input.path} sous ${input.name}${on(s, id)}`
  ),
  'files.removeShare': def(removeShare, (s, id, name) => `Arrêter le partage ${name}${on(s, id)}`),
  'files.setShareAcl': def(
    setShareAcl,
    (s, id, name) => `Modifier les autorisations du partage ${name}${on(s, id)}`
  ),
  'files.setNtfsEntry': def(
    setNtfsEntry,
    (_s, _id, path, principal) => `Modifier les autorisations de ${principal} sur ${path}`
  ),
  'files.removeNtfs': def(
    removeNtfs,
    (_s, _id, path, account) => `Retirer ${account} des autorisations de ${path}`
  ),
  'files.setNtfsInheritance': def(
    setNtfsInheritance,
    (_s, _id, path) => `Modifier l’héritage des autorisations de ${path}`
  ),
  'files.mapDrive': def(
    (
      s: LabState,
      id: string,
      letter: string,
      path: string,
      token: AccessToken | null,
      options: { persistent?: boolean } = {}
    ) => drive(mapDrive(s, id, letter, path, token, options)),
    (s, id, letter, path) => `Connecter ${letter}: à ${path}${on(s, id)}`
  ),
  'files.unmapDrive': def(
    (s: LabState, id: string, letter: string, account: string) => drive(unmapDrive(s, id, letter, account)),
    (s, id, letter) => `Déconnecter ${letter}:${on(s, id)}`
  )
}
