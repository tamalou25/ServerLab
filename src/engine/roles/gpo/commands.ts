/**
 * Commandes du rôle Stratégies de groupe : actions pures du moteur + libellés français.
 */
import { setGpRegistryValue } from './registry'
import { def } from '../../commands/define'
import { gpoName, linkTargetName } from '../../commands/labels'
import type { EngineResult } from '../../core/result'
import type { LabState } from '../../model/schema'
import {
  createGpo,
  deleteGpo,
  linkGpo,
  renameGpo,
  setGpoSecurityFilter,
  setGpoStatus,
  setInheritanceBlocked,
  unlinkGpo,
  updateGpoLink,
  updateGpoSettings
} from './objects'

/** Nouvelle GPO, liée aussitôt si une cible est donnée (null = racine du domaine). */
function createGpoAndLink(
  state: LabState,
  domainName: string,
  input: Parameters<typeof createGpo>[2],
  target?: string | null
): EngineResult<string> {
  const created = createGpo(state, domainName, input)
  if (!created.ok || target === undefined) return created
  const linked = linkGpo(created.state, domainName, created.value, target)
  return linked.ok ? { ok: true, state: linked.state, value: created.value } : linked
}

export const gpoCommands = {
  'gpo.create': def(createGpo, (_s, _d, input) => `Créer la GPO ${input.name}`),
  'gpo.createAndLink': def(createGpoAndLink, (s, d, input, target) =>
    target === undefined
      ? `Créer la GPO ${input.name}`
      : `Créer la GPO ${input.name} et la lier à ${linkTargetName(s, d, target)}`
  ),
  'gpo.delete': def(deleteGpo, (s, d, id) => `Supprimer la GPO ${gpoName(s, d, id)}`),
  'gpo.rename': def(renameGpo, (s, d, id, name) => `Renommer la GPO ${gpoName(s, d, id)} en ${name}`),
  'gpo.setStatus': def(setGpoStatus, (s, d, id) => `Modifier l’état de la GPO ${gpoName(s, d, id)}`),
  'gpo.link': def(
    linkGpo,
    (s, d, id, target) => `Lier ${gpoName(s, d, id)} à ${linkTargetName(s, d, target)}`
  ),
  'gpo.updateLink': def(
    updateGpoLink,
    (s, d, id, target) => `Modifier la liaison ${gpoName(s, d, id)} sur ${linkTargetName(s, d, target)}`
  ),
  'gpo.unlink': def(
    unlinkGpo,
    (s, d, id, target) => `Supprimer la liaison ${gpoName(s, d, id)} de ${linkTargetName(s, d, target)}`
  ),
  'gpo.setInheritanceBlocked': def(
    setInheritanceBlocked,
    (s, d, target, blocked) =>
      `${blocked ? 'Bloquer' : 'Rétablir'} l’héritage sur ${linkTargetName(s, d, target)}`
  ),
  'gpo.setSecurityFilter': def(
    setGpoSecurityFilter,
    (s, d, id, identity, apply) =>
      `${apply ? 'Ajouter' : 'Retirer'} ${identity} au filtrage de ${gpoName(s, d, id)}`
  ),
  'gpo.updateSettings': def(
    updateGpoSettings,
    (s, d, id) => `Modifier les paramètres de ${gpoName(s, d, id)}`
  ),
  'gpo.setRegistryValue': def(
    setGpRegistryValue,
    (s, d, id, input) => `Valeur de registre ${input.key} dans ${gpoName(s, d, id)}`
  )
}
