/**
 * Passation d'un sujet : questions d'oral à afficher, indices, construction du rendu. Le temps
 * réel est fourni par l'interface (le moteur ne lit pas l'horloge système).
 */
import { evaluateCriteria } from '../labs/criteria'
import type { LabState } from '../model/schema'
import { subjectFingerprint, type OralQuestion, type Subject } from './subject'
import { SUBMISSION_FORMAT_VERSION, type JournalStep, type Submission } from './submission'

/** Données d'une passation en cours (tout ce qui finira dans le rendu). */
export interface Attempt {
  subject: Subject
  fingerprint: string
  studentName: string
  mode: Submission['mode']
  startedAt: number
  journal: JournalStep[]
  hints: Submission['hints']
  answers: Submission['answers']
}

export function startAttempt(
  subject: Subject,
  studentName: string,
  mode: Submission['mode'],
  now: number
): Attempt {
  return {
    subject,
    fingerprint: subjectFingerprint(subject),
    studentName: studentName.trim().slice(0, 100),
    mode,
    startedAt: now,
    journal: [],
    hints: [],
    answers: []
  }
}

/** Temps restant (ms, 0 si écoulé). */
export function attemptRemainingMs(attempt: Attempt, now: number): number {
  return Math.max(0, attempt.startedAt + attempt.subject.scale.minutes * 60_000 - now)
}

/**
 * Questions d'oral dont le déclencheur est atteint (minute écoulée ou critère validé sur l'état
 * courant), hors questions déjà affichées.
 */
export function dueQuestions(
  attempt: Attempt,
  state: LabState,
  now: number,
  shown: ReadonlySet<string>
): OralQuestion[] {
  const pending = attempt.subject.oral.filter((q) => !shown.has(q.id))
  if (pending.length === 0) return []
  const elapsedMin = (now - attempt.startedAt) / 60_000
  const results = evaluateCriteria(state, attempt.subject.lab.criteria)
  const passed = new Set(results.filter((r) => r.ok).map((r) => r.id))
  return pending.filter((q) =>
    q.trigger.kind === 'minute' ? elapsedMin >= q.trigger.minute : passed.has(q.trigger.criterionId)
  )
}

export interface NextHint {
  criterionId: string
  index: number
  text: string
}

/**
 * Prochain indice : premier critère non validé dont il reste un indice à révéler (les critères
 * eux-mêmes restent masqués). null : plus aucun indice disponible.
 */
export function nextHint(attempt: Attempt, state: LabState): NextHint | null {
  const results = evaluateCriteria(state, attempt.subject.lab.criteria)
  for (const [i, c] of attempt.subject.lab.criteria.entries()) {
    if (results[i]?.ok) continue
    const texts = [c.hint, ...c.hints].filter((h) => h.trim() !== '')
    const index = attempt.hints.filter((h) => h.criterionId === c.id).length
    if (index < texts.length) return { criterionId: c.id, index, text: texts[index]! }
  }
  return null
}

/** Texte d'un indice déjà pris. */
export function hintText(subject: Subject, criterionId: string, index: number): string {
  const c = subject.lab.criteria.find((x) => x.id === criterionId)
  return c ? ([c.hint, ...c.hints][index] ?? '') : ''
}

/** Rendu de fin de passation (rien n'est noté ici : la correction rejoue le journal). */
export function finishAttempt(
  attempt: Attempt,
  options: { now: number; ending: Submission['ending']; appVersion: string }
): Submission {
  const deadline = attempt.startedAt + attempt.subject.scale.minutes * 60_000
  return {
    app: 'ServerLab',
    kind: 'rendu',
    formatVersion: SUBMISSION_FORMAT_VERSION,
    appVersion: options.appVersion,
    subject: { fingerprint: attempt.fingerprint, title: attempt.subject.meta.title },
    student: { name: attempt.studentName || 'Élève', studentId: null, classId: null },
    mode: attempt.mode,
    startedAt: attempt.startedAt,
    endedAt: options.ending === 'timeout' ? Math.min(options.now, deadline) : options.now,
    ending: options.ending,
    journal: attempt.journal,
    hints: attempt.hints,
    answers: attempt.answers
  }
}
