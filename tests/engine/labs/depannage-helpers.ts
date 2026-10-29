/**
 * Aides des tests des labs de dépannage (43 à 45) : chargement par `buildLabState` (lab déjà cassé) et
 * réparation OFFICIELLE d'une panne (`FaultDef.repair` rejoué par `dispatch`, comme le fait le bilan).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildLabState,
  type AnyCommand,
  checkLab,
  dispatch,
  getFault,
  parseLabText,
  type LabDefinition,
  type LabState
} from '@engine/index'

/** Lit labs/<fichier>.json comme l'application et construit son état de départ (cassé). */
export function loadTroubleshootingLab(file: string): { lab: LabDefinition; start: LabState } {
  const parsed = parseLabText(readFileSync(join(__dirname, '../../../labs', file), 'utf8'))
  if (!parsed.ok) throw new Error(parsed.message)
  return { lab: parsed.lab, start: buildLabState(parsed.lab) }
}

/** Rejoue des commandes nommées (erreur si l'une est refusée). */
export function play(state: LabState, commands: AnyCommand[]): LabState {
  let next = state
  for (const c of commands) {
    const r = dispatch(next, c)
    if (!r.ok) throw new Error(`${c.type} : ${r.error.message}`)
    next = r.state
  }
  return next
}

/** Réparation officielle de la panne active d'identifiant `faultId` (ou de toutes si omis). */
export function repairOfficial(state: LabState, faultId?: string): LabState {
  let next = state
  for (const f of state.troubleshooting?.faults ?? []) {
    if (faultId !== undefined && f.id !== faultId) continue
    const def = getFault(f.id)
    if (!def) throw new Error(`Panne inconnue : ${f.id}`)
    next = play(next, def.repair(next, f.params))
  }
  return next
}

/** Identifiants des critères non validés. */
export const failing = (state: LabState, lab: LabDefinition): string[] =>
  checkLab(state, lab)
    .results.filter((r) => !r.ok)
    .map((r) => r.id)
