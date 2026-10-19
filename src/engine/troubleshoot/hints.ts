/**
 * Indices du mode panne : la commande nommée `troubleshoot.useHint` incrémente le compteur d'indices
 * d'une panne active (annulable comme toute commande) ; le texte vient de `FaultDef.hints`.
 */
import { fail, transact, type EngineResult } from '../core/result'
import type { LabState } from '../model/schema'

/** Nombre d'indices par panne (symptôme, zone, piste). */
export const HINTS_PER_FAULT = 3

/** Utilise l'indice suivant de la panne `faultId` ; renvoie le nombre d'indices utilisés. */
export function useHint(state: LabState, faultId: string): EngineResult<number> {
  const fault = state.troubleshooting?.faults.find((f) => f.id === faultId)
  if (!fault) return fail('FaultNotFound', 'Aucun dépannage en cours pour cette panne.')
  if (fault.hintsUsed >= HINTS_PER_FAULT)
    return fail('NoMoreHints', 'Tous les indices ont déjà été utilisés.')
  return transact(state, (draft) => {
    const f = draft.troubleshooting?.faults.find((x) => x.id === faultId)
    if (!f) return 0
    f.hintsUsed += 1
    return f.hintsUsed
  })
}
