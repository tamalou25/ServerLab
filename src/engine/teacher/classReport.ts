/**
 * Bilan de classe : export CSV (séparateur `;`, UTF-8 avec BOM pour Excel) et statistiques.
 */
import type { Correction } from './correction'
import type { Submission } from './submission'

/** Marque d'ordre des octets : Excel lit alors le fichier en UTF-8. */
export const CSV_BOM = '﻿'

/**
 * Cellule CSV : guillemets doublés, et neutralisation des formules (une valeur commençant par
 * `=`, `+`, `-`, `@`, tabulation ou retour chariot serait exécutée par le tableur).
 */
export function csvCell(value: string | number): string {
  let text = typeof value === 'number' ? String(value).replace('.', ',') : value
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[";\r\n]/.test(text) || text !== text.trim() ? `"${text.replace(/"/g, '""')}"` : text
}

const minutes = (ms: number) => Math.round(ms / 600) / 100

/** CSV de la classe : une ligne par élève, une colonne par critère (OK / KO). */
export function classCsv(corrections: readonly Correction[]): string {
  const criteria = corrections[0]?.criteria ?? []
  const header = [
    'Nom',
    'Note',
    'Sur',
    'Critères validés',
    'Temps (min)',
    'Erreurs',
    'Indices',
    'Pénalités',
    'Oral',
    ...criteria.map((c) => c.label),
    'Signalements',
    'Commentaire'
  ]
  const rows = corrections.map((c) => [
    c.student.name,
    c.grade.value,
    c.grade.outOf,
    `${c.criteria.filter((x) => x.ok).length}/${c.criteria.length}`,
    minutes(c.elapsedMs),
    c.errors.total,
    c.hintsTaken,
    c.penalties.hints,
    c.oral.reduce((sum, q) => sum + (q.points ?? 0), 0),
    ...criteria.map((k) => (c.criteria.find((x) => x.id === k.id)?.ok ? 'OK' : 'KO')),
    c.flags.map((f) => f.message).join(' | '),
    c.comment
  ])
  return CSV_BOM + [header, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n'
}

export interface ClassStats {
  count: number
  /** Moyenne des notes (null : aucune copie). */
  mean: number | null
  /** Temps moyen (ms). */
  meanElapsedMs: number | null
  /** Critère le plus raté (null : aucun échec). */
  mostFailed: { id: string; label: string; failures: number } | null
  flagged: number
}

export function classStats(corrections: readonly Correction[]): ClassStats {
  const count = corrections.length
  const avg = (values: number[]) =>
    count === 0 ? null : Math.round((values.reduce((a, b) => a + b, 0) / count) * 100) / 100
  const failures = new Map<string, { id: string; label: string; failures: number }>()
  for (const c of corrections)
    for (const k of c.criteria) {
      const entry = failures.get(k.id) ?? { id: k.id, label: k.label, failures: 0 }
      if (!k.ok) entry.failures++
      failures.set(k.id, entry)
    }
  const worst = [...failures.values()].reduce<ClassStats['mostFailed']>(
    (best, e) => (e.failures > 0 && (!best || e.failures > best.failures) ? e : best),
    null
  )
  return {
    count,
    mean: avg(corrections.map((c) => (c.grade.value / c.grade.outOf) * 20)),
    meanElapsedMs: avg(corrections.map((c) => c.elapsedMs)),
    mostFailed: worst,
    flagged: corrections.filter((c) => c.flags.length > 0).length
  }
}

/**
 * États d'une copie dérivés de la correction (jamais inventés) : signalée (drapeaux), rejeu
 * interrompu (drapeau `replay-failed`), oral à renseigner (une question sans points), et le nombre de
 * critères validés sur le total. « Tous validés » décrit le résultat de cette épreuve, pas une maîtrise
 * générale de la compétence.
 */
export interface CopyStatus {
  flagged: boolean
  replayFailed: boolean
  oralPending: boolean
  passed: number
  total: number
  /** 'complete' : tous les critères validés ; 'none' : aucun ; 'partial' : entre les deux. */
  criteria: 'complete' | 'partial' | 'none'
}

export function copyStatus(correction: Correction): CopyStatus {
  const passed = correction.criteria.filter((c) => c.ok).length
  const total = correction.criteria.length
  return {
    flagged: correction.flags.length > 0,
    replayFailed: correction.flags.some((f) => f.code === 'replay-failed'),
    oralPending: correction.oral.some((q) => q.points === null),
    passed,
    total,
    criteria: total > 0 && passed === total ? 'complete' : passed === 0 ? 'none' : 'partial'
  }
}

/** Entrée de la chronologie d'une copie (journal réel de l'élève, temps relatif au départ). */
export interface CopyTimelineEntry {
  /** Millisecondes depuis le début de l'épreuve (borné à 0). */
  offsetMs: number
  kind: 'command' | 'undo' | 'redo' | 'transaction' | 'hint' | 'answer'
  label: string
}

/**
 * Chronologie d'un rendu : commandes (libellé enregistré ou type), annulations, rétablissements,
 * transactions (glisser), indices pris et réponses à l'oral, triés par horodatage. Aucune
 * interprétation : chaque entrée est un pas réellement journalisé.
 */
export function journalTimeline(submission: Submission): CopyTimelineEntry[] {
  const at = (ts: number) => Math.max(0, ts - submission.startedAt)
  const entries: CopyTimelineEntry[] = []
  for (const step of submission.journal) {
    if (step.kind === 'command')
      entries.push({ offsetMs: at(step.at), kind: 'command', label: step.command.label ?? step.command.type })
    else if (step.kind === 'transaction')
      entries.push({ offsetMs: at(step.at), kind: 'transaction', label: step.label })
    else
      entries.push({
        offsetMs: at(step.at),
        kind: step.kind,
        label: step.kind === 'undo' ? 'Annuler' : 'Rétablir'
      })
  }
  for (const hint of submission.hints)
    entries.push({ offsetMs: at(hint.at), kind: 'hint', label: `Indice ${hint.index + 1}` })
  for (const answer of submission.answers)
    entries.push({ offsetMs: at(answer.at), kind: 'answer', label: 'Réponse à l’oral' })
  return entries.sort((a, b) => a.offsetMs - b.offsetMs)
}
