/**
 * Catalogue des pannes du mode panne. Ajouter une panne : voir `docs/depannage.md`.
 * Cohérence (ids uniques, 3 indices, difficulté) vérifiée par `tests/engine/troubleshoot/registry.test.ts`.
 */
import { wrongMask } from './faults/wrong-mask'
import { serviceStopped } from './faults/service-stopped'
import { WINDOWS_FAULTS } from './faults/windows'
import type { FaultDef } from './types'

export const FAULTS: readonly FaultDef[] = [serviceStopped, wrongMask, ...WINDOWS_FAULTS]

/** Panne du catalogue par identifiant (undefined : identifiant inconnu, p. ex. fichier d'une version future). */
export function getFault(id: string): FaultDef | undefined {
  return FAULTS.find((f) => f.id === id)
}
