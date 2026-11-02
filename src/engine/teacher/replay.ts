/**
 * Rejeu d'un rendu : le journal de l'élève est réexécuté depuis le lab de départ du sujet, avec
 * les mêmes fonctions que l'interface (dispatch, historique annuler/rétablir, tâches de fond en
 * mode Temps réel). L'état final et les critères en découlent : rien n'est lu dans le rendu.
 */
import type { AnyCommand } from '../commands/define'
import { dispatch, journalEntry } from '../commands/dispatch'
import { emptyHistory, recordEntry, redoStep, undoStep, type History } from '../commands/history'
import { evaluateCriteria } from '../labs/criteria'
import { buildLabState } from '../labs/lab'
import type { LabState } from '../model/schema'
import { runBackgroundTasks, type BackgroundMemo } from '../roles/background'
import type { Subject } from './subject'
import type { JournalStep, Submission } from './submission'

/** Résultat d'un pas rejoué (démonstration pas à pas, détail des erreurs). */
export type ReplayStepOutcome = 'applied' | 'unchanged' | 'refused' | 'undone' | 'redone' | 'ignored'

export interface ReplayResult {
  /** Rejeu complet (false : arrêté sur un pas impossible, voir `failure`). */
  ok: boolean
  failure: { step: number; message: string } | null
  state: LabState
  /** Issue de chaque pas rejoué (même longueur que le journal si `ok`). */
  outcomes: ReplayStepOutcome[]
  /** Commandes refusées par le moteur (`ok: false`). */
  refused: number
  /** Annulations effectivement appliquées. */
  undos: number
  criteria: { id: string; label: string; ok: boolean }[]
}

/** Contexte du rejeu : état courant, historique et mémo des tâches de fond (comme le store). */
export interface ReplayCursor {
  state: LabState
  history: History
  memo: BackgroundMemo
}

/** Tâches de fond après chaque pas (mode Temps réel de l'interface). */
function settle(cursor: ReplayCursor, state: LabState): ReplayCursor {
  const run = runBackgroundTasks(state, cursor.memo)
  return { ...cursor, state: run.state, memo: run.memo }
}

/** Point de départ du rejeu : état initial du lab du sujet (pannes comprises). */
export function startReplay(subject: Subject): ReplayCursor {
  const state = buildLabState(subject.lab)
  return settle({ state, history: emptyHistory(), memo: {} }, state)
}

/**
 * Rejoue un pas. Une commande refusée laisse l'état inchangé (erreur de l'élève). Une exception
 * (arguments impossibles à produire par l'interface) est un échec du rejeu.
 */
export function replayStep(
  cursor: ReplayCursor,
  step: JournalStep
): { ok: true; cursor: ReplayCursor; outcome: ReplayStepOutcome } | { ok: false; message: string } {
  try {
    if (step.kind === 'command') {
      const result = dispatch(cursor.state, step.command as AnyCommand & { label?: string })
      if (!result.ok) return { ok: true, cursor, outcome: 'refused' }
      if (!result.entry) return { ok: true, cursor: settle(cursor, result.state), outcome: 'unchanged' }
      return {
        ok: true,
        cursor: settle({ ...cursor, history: recordEntry(cursor.history, result.entry) }, result.state),
        outcome: 'applied'
      }
    }
    if (step.kind === 'transaction') {
      // Comme l'interface : commandes appliquées (tâches de fond comprises), une seule entrée
      const base = cursor.state
      let current = cursor
      for (const command of step.commands) {
        const result = dispatch(current.state, command as AnyCommand)
        if (result.ok && result.state !== current.state) current = settle(current, result.state)
      }
      const entry = journalEntry(base, current.state, { type: 'batch', args: [], label: step.label })
      if (!entry) return { ok: true, cursor: current, outcome: 'unchanged' }
      return {
        ok: true,
        cursor: { ...current, history: recordEntry(current.history, entry) },
        outcome: 'applied'
      }
    }
    const run =
      step.kind === 'undo' ? undoStep(cursor.state, cursor.history) : redoStep(cursor.state, cursor.history)
    // Rien à annuler, ou annulation devenue inapplicable : l'interface ne change rien non plus
    if (!run.ok) return { ok: true, cursor: { ...cursor, history: run.history }, outcome: 'ignored' }
    return {
      ok: true,
      cursor: settle({ ...cursor, history: run.history }, run.state),
      outcome: step.kind === 'undo' ? 'undone' : 'redone'
    }
  } catch {
    return { ok: false, message: 'commande impossible à rejouer (arguments incohérents).' }
  }
}

/** Rejoue tout le journal d'un rendu et évalue les critères du sujet sur l'état final. */
export function replaySubmission(subject: Subject, submission: Submission): ReplayResult {
  let cursor = startReplay(subject)
  const outcomes: ReplayStepOutcome[] = []
  let failure: ReplayResult['failure'] = null
  for (const [index, step] of submission.journal.entries()) {
    const next = replayStep(cursor, step)
    if (!next.ok) {
      failure = { step: index + 1, message: next.message }
      break
    }
    cursor = next.cursor
    outcomes.push(next.outcome)
  }
  const results = evaluateCriteria(cursor.state, subject.lab.criteria)
  return {
    ok: failure === null,
    failure,
    state: cursor.state,
    outcomes,
    refused: outcomes.filter((o) => o === 'refused').length,
    undos: outcomes.filter((o) => o === 'undone').length,
    criteria: subject.lab.criteria.map((c, i) => ({ id: c.id, label: c.label, ok: results[i]?.ok ?? false }))
  }
}
