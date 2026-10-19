/**
 * Choix d'une cible VIABLE : parmi des candidats, la première (à partir d'un point de départ tiré de
 * la graine) dont l'injection produit réellement le symptôme. Évite de tirer une cible dont la panne
 * serait sans effet (p. ex. une GPO liée à deux endroits, un service que rien n'utilise).
 */
import { dispatch } from '../../commands/dispatch'
import type { LabState } from '../../model/schema'
import type { FaultDef, FaultTargetParams } from '../types'

/** État après injection des commandes de la panne (null si une commande est refusée). */
export function injected(state: LabState, fault: FaultDef, p: FaultTargetParams): LabState | null {
  let next = state
  for (const c of fault.inject(state, p)) {
    const r = dispatch(next, c)
    if (!r.ok) return null
    next = r.state
  }
  return next === state ? null : next
}

export function firstViable(
  state: LabState,
  rand: () => number,
  candidates: FaultTargetParams[],
  fault: FaultDef
): FaultTargetParams | null {
  const start = candidates.length > 0 ? Math.floor(rand() * candidates.length) : 0
  for (let k = 0; k < candidates.length; k++) {
    const p = candidates[(start + k) % candidates.length]!
    const broken = injected(state, fault, p)
    if (broken && fault.symptomVisible(broken, p)) return p
  }
  return null
}
