/**
 * Correction d'un rendu : rejeu, signalements, note selon le barème du sujet, puis saisie du
 * professeur (commentaire, points de l'oral). La note n'est jamais lue dans un fichier.
 *
 * Calcul de la note (barème du sujet) :
 * - composante critères = points des critères validés / points de tous les critères ;
 * - composante temps = 1 jusqu'à la moitié de la durée, puis décroît linéairement jusqu'à 0 à la
 *   fin de la durée ;
 * - composante erreurs = 1 − erreurs / maxErrors (bornée à 0). Erreur = commande refusée par le
 *   moteur, plus chaque annulation si `undoIsError` ;
 * - partie pratique = moyenne pondérée des trois composantes × points des critères, moins
 *   la pénalité de chaque indice consulté ;
 * - note = (partie pratique + points de l'oral) / (points des critères + points de l'oral) × outOf,
 *   bornée entre 0 et outOf, arrondie au centième.
 */
import { CORRECTION_FORMAT_VERSION, type Correction, type CorrectionFlag } from './correction'
import { replaySubmission, type ReplayResult } from './replay'
import { subjectFingerprint, type Subject } from './subject'
import { submissionFingerprint, type Submission } from './submission'

/** Tolérance sur la durée (enregistrement du rendu, horloges) : 2 minutes. */
export const DURATION_TOLERANCE_MS = 120_000

const round2 = (n: number) => Math.round(n * 100) / 100
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))

export interface GradeInput {
  subject: Subject
  /** Critères validés (identifiants). */
  passed: ReadonlySet<string>
  elapsedMs: number
  errors: number
  hintsTaken: number
  /** Points attribués aux questions d'oral (null : pas encore noté = 0). */
  oralPoints: readonly (number | null)[]
}

export interface Grade {
  components: Correction['components']
  hintPenalty: number
  value: number
  outOf: number
}

/** Note selon le barème (fonction pure, voir l'en-tête du fichier). */
export function computeGrade(input: GradeInput): Grade {
  const { scale, oral } = input.subject
  const criteriaMax = scale.criteria.reduce((sum, c) => sum + c.points, 0)
  const criteriaGot = scale.criteria.reduce(
    (sum, c) => sum + (input.passed.has(c.criterionId) ? c.points : 0),
    0
  )
  const durationMs = scale.minutes * 60_000
  const components = {
    criteria: criteriaMax === 0 ? 0 : criteriaGot / criteriaMax,
    time: clamp((durationMs - input.elapsedMs) / (durationMs / 2), 0, 1),
    errors: clamp(1 - input.errors / scale.maxErrors, 0, 1)
  }
  const { weights } = scale
  const totalWeight = weights.criteria + weights.time + weights.errors
  const weighted =
    totalWeight === 0
      ? 0
      : (weights.criteria * components.criteria +
          weights.time * components.time +
          weights.errors * components.errors) /
        totalWeight
  const hintPenalty = input.hintsTaken * scale.hintPenalty
  const oralMax = oral.reduce((sum, q) => sum + q.points, 0)
  const oralGot = oral.reduce((sum, q, i) => sum + clamp(input.oralPoints[i] ?? 0, 0, q.points), 0)
  const max = criteriaMax + oralMax
  const raw = max === 0 ? 0 : ((weighted * criteriaMax - hintPenalty + oralGot) / max) * scale.outOf
  return {
    components: {
      criteria: round2(components.criteria),
      time: round2(components.time),
      errors: round2(components.errors)
    },
    hintPenalty: round2(hintPenalty),
    value: round2(clamp(raw, 0, scale.outOf)),
    outOf: scale.outOf
  }
}

/** Signalements : incohérences entre le rendu, le sujet et le rejeu. */
export function detectFlags(
  subject: Subject,
  submission: Submission,
  replay: ReplayResult
): CorrectionFlag[] {
  const flags: CorrectionFlag[] = []
  if (submission.subject.fingerprint !== subjectFingerprint(subject))
    flags.push({
      code: 'subject-mismatch',
      message: 'Le rendu ne correspond pas à ce sujet (empreinte différente) : sujet modifié ou autre sujet.'
    })
  if (replay.failure)
    flags.push({
      code: 'replay-failed',
      message: `Rejeu interrompu au pas ${replay.failure.step} : ${replay.failure.message}`
    })
  const { startedAt, endedAt } = submission
  const times = [
    ...submission.journal.map((s) => s.at),
    ...submission.hints.map((h) => h.at),
    ...submission.answers.map((a) => a.at)
  ]
  const ordered = submission.journal.every((s, i, all) => i === 0 || all[i - 1]!.at <= s.at)
  if (endedAt < startedAt || !ordered || times.some((t) => t < startedAt || t > endedAt))
    flags.push({
      code: 'timestamps-incoherent',
      message: 'Horodatages incohérents : actions hors de la période de passation ou dans le désordre.'
    })
  const known = new Set(subject.lab.criteria.map((c) => c.id))
  const questions = new Set(subject.oral.map((q) => q.id))
  if (
    submission.hints.some((h) => !known.has(h.criterionId)) ||
    submission.answers.some((a) => !questions.has(a.questionId))
  )
    flags.push({
      code: 'timestamps-incoherent',
      message: 'Indices ou réponses rattachés à des critères ou questions absents du sujet.'
    })
  const elapsed = endedAt - startedAt
  const durationMs = subject.scale.minutes * 60_000
  if (
    elapsed > durationMs + DURATION_TOLERANCE_MS ||
    (submission.ending === 'timeout' && elapsed < durationMs - DURATION_TOLERANCE_MS)
  )
    flags.push({
      code: 'duration-out-of-bounds',
      message: `Durée de passation hors bornes (${Math.round(elapsed / 60_000)} min pour ${subject.scale.minutes} min prévues).`
    })
  // Un même code n'est signalé qu'une fois (premier message conservé)
  return flags.filter((f, i) => flags.findIndex((g) => g.code === f.code) === i)
}

export interface CorrectOptions {
  appVersion: string
  /** Date ISO de la correction (fournie par l'interface). */
  correctedAt: string
  comment?: string
  /** Points de l'oral, dans l'ordre des questions du sujet (null : non noté). */
  oralPoints?: readonly (number | null)[]
}

/** Corrige un rendu : rejeu, signalements et note. */
export function correctSubmission(
  subject: Subject,
  submission: Submission,
  options: CorrectOptions
): Correction {
  const replay = replaySubmission(subject, submission)
  const passed = new Set(replay.criteria.filter((c) => c.ok).map((c) => c.id))
  const errors = replay.refused + (subject.scale.undoIsError ? replay.undos : 0)
  const elapsedMs = Math.max(
    0,
    Math.min(submission.endedAt - submission.startedAt, subject.scale.minutes * 60_000)
  )
  const oralPoints = subject.oral.map((_, i) => options.oralPoints?.[i] ?? null)
  const grade = computeGrade({
    subject,
    passed,
    elapsedMs,
    errors,
    hintsTaken: submission.hints.length,
    oralPoints
  })
  const points = new Map(subject.scale.criteria.map((c) => [c.criterionId, c.points]))
  return {
    app: 'ServerLab',
    kind: 'correction',
    formatVersion: CORRECTION_FORMAT_VERSION,
    appVersion: options.appVersion,
    subject: { fingerprint: subjectFingerprint(subject), title: subject.meta.title },
    submission: { fingerprint: submissionFingerprint(submission) },
    student: submission.student,
    correctedAt: options.correctedAt,
    criteria: replay.criteria.map((c) => ({
      id: c.id,
      label: c.label,
      ok: c.ok,
      points: c.ok ? (points.get(c.id) ?? 0) : 0,
      max: points.get(c.id) ?? 0
    })),
    elapsedMs,
    errors: { refused: replay.refused, undos: replay.undos, total: errors },
    hintsTaken: submission.hints.length,
    penalties: { hints: grade.hintPenalty },
    components: grade.components,
    oral: subject.oral.map((q, i) => ({
      questionId: q.id,
      answer: submission.answers.find((a) => a.questionId === q.id)?.text ?? '',
      points: oralPoints[i] === null ? null : clamp(oralPoints[i]!, 0, q.points),
      max: q.points
    })),
    grade: { value: grade.value, outOf: grade.outOf },
    comment: options.comment ?? '',
    flags: detectFlags(subject, submission, replay)
  }
}
