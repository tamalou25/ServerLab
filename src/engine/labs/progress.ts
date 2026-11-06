/**
 * Progression de l'élève (v2.14) : tentatives enregistrées (résultats, aide utilisée, compétences
 * travaillées) et règles qui en déduisent l'état de chaque étape d'un parcours, l'état de chaque
 * compétence et la prochaine étape recommandée.
 *
 * Règles (testées dans `tests/engine/labs/progress.test.ts`) :
 * - **Exercice terminé** : au moins une tentative réussie (tous les critères validés) sur le lab de
 *   l'étape, dans le mode exigé par l'étape (examen pour une révision différée).
 * - **Compétence travaillée** : au moins une réussite d'une étape qui la travaille.
 * - **Compétence démontrée** (maîtrise durable) : au moins une réussite **autonome** (aucun indice, pas
 *   d'abandon) ET une seconde réussite soit dans une **autre étape** qui travaille la compétence
 *   (transfert), soit sur la **même étape au moins un jour plus tard** (révision différée). Une seule
 *   réussite guidée ne suffit jamais.
 * - **Prochaine étape recommandée** : la première étape non terminée dont les prérequis sont terminés
 *   (jamais un verrou : tout lab reste ouvrable) ; parcours terminé : une révision différée due.
 * - **Révision due** : étape terminée il y a plus de `REVISION_AFTER_DAYS` jours dont une compétence
 *   n'est pas encore démontrée.
 *
 * Pur et déterministe : l'horloge (`now`) et les horodatages sont fournis par l'appelant.
 */
import { z } from 'zod'
import { COMPETENCES, type CompetenceId, type Pathway, type PathwayStep } from './pathway'

export const PROGRESS_FORMAT_VERSION = 1

/** Nombre maximal de tentatives conservées (les plus anciennes sont oubliées au-delà). */
export const MAX_ATTEMPTS = 2000

export const ProgressAttemptModeSchema = z.enum(['lab', 'exam', 'troubleshoot'])
export type ProgressAttemptMode = z.infer<typeof ProgressAttemptModeSchema>

/** Une tentative terminée : vérification à 100 %, fin d'examen ou bilan de dépannage. */
export const ProgressAttemptSchema = z.object({
  id: z.string().min(1).max(120),
  labId: z.string().min(1).max(120),
  mode: ProgressAttemptModeSchema,
  /** Horodatages ISO 8601 fournis par l'interface. */
  startedAt: z.string().max(40).optional(),
  finishedAt: z.string().min(1).max(40),
  passed: z.number().int().min(0),
  total: z.number().int().min(0),
  /** Tous les critères validés (dépannage : issue « résolu »). */
  success: z.boolean(),
  /** Indices demandés (critères et mode panne). */
  hintsUsed: z.number().int().min(0).default(0),
  hintsAvailable: z.number().int().min(0).default(0),
  gaveUp: z.boolean().default(false),
  /** Résultat sur 100 du bilan de dépannage, s'il y a lieu. */
  score: z.number().min(0).max(100).optional(),
  /** Compétences travaillées (identifiants du catalogue ; les inconnus sont conservés tels quels). */
  competences: z.array(z.string().max(60)).max(20).default([]),
  pathwayId: z.string().max(120).optional(),
  stepId: z.string().max(120).optional(),
  /** Graine d'une variante de dépannage. */
  seed: z.number().int().optional()
})

export type ProgressAttempt = z.infer<typeof ProgressAttemptSchema>

export const ProgressFileSchema = z.object({
  formatVersion: z.literal(PROGRESS_FORMAT_VERSION),
  attempts: z.array(z.unknown())
})

/**
 * Tentatives lues d'un fichier de progression : les entrées invalides sont écartées une à une, un
 * fichier d'un autre format ou corrompu donne une liste vide (jamais d'exception), au plus
 * `MAX_ATTEMPTS` entrées (les plus récentes).
 */
export function parseProgress(raw: unknown): ProgressAttempt[] {
  const file = ProgressFileSchema.safeParse(raw)
  if (!file.success) return []
  const attempts = file.data.attempts.flatMap((entry) => {
    const parsed = ProgressAttemptSchema.safeParse(entry)
    return parsed.success ? [parsed.data] : []
  })
  return attempts.slice(-MAX_ATTEMPTS)
}

/** Ajoute une tentative (remplace une tentative de même identifiant) en respectant la limite. */
export function addAttempt(attempts: ProgressAttempt[], attempt: ProgressAttempt): ProgressAttempt[] {
  return [...attempts.filter((a) => a.id !== attempt.id), attempt].slice(-MAX_ATTEMPTS)
}

export const serializeProgress = (attempts: ProgressAttempt[]): string =>
  JSON.stringify({ formatVersion: PROGRESS_FORMAT_VERSION, attempts }, null, 2)

// ---------------------------------------------------------------------------------------------
// Règles
// ---------------------------------------------------------------------------------------------

/** Jours après lesquels une étape terminée mérite une révision si ses compétences ne sont pas démontrées. */
export const REVISION_AFTER_DAYS = 7

const DAY_MS = 86_400_000

const time = (iso: string): number => {
  const t = Date.parse(iso)
  return Number.isNaN(t) ? 0 : t
}

/** Tentatives qui comptent pour une étape : son lab, dans le mode exigé (examen pour une révision). */
export function attemptsOfStep(step: PathwayStep, attempts: readonly ProgressAttempt[]): ProgressAttempt[] {
  return attempts.filter((a) => a.labId === step.labId && (step.mode === 'exam' ? a.mode === 'exam' : true))
}

/** Réussite autonome : tous les critères validés, aucun indice, pas d'abandon. */
export const isAutonomous = (a: ProgressAttempt): boolean => a.success && a.hintsUsed === 0 && !a.gaveUp

export type StepState =
  /** Terminée au moins une fois (succès). */
  | 'termine'
  /** Prochaine étape conseillée. */
  | 'recommande'
  /** Ouvrable, mais des prérequis ne sont pas terminés ou la date de révision n'est pas atteinte. */
  | 'disponible'
  /** Terminée il y a longtemps : révision conseillée. */
  | 'a-revoir'

export interface StepStatus {
  step: PathwayStep
  state: StepState
  attempts: number
  successes: number
  /** Dernière réussite (ISO), s'il y en a une. */
  lastSuccessAt: string | null
  /** Prérequis non terminés (recommandation seulement). */
  missingPrerequisites: string[]
  /** Révision différée : date à partir de laquelle elle est conseillée (ISO), ou null. */
  availableFrom: string | null
}

export type CompetenceState = 'non-travaillee' | 'travaillee' | 'demontree'

export interface CompetenceStatus {
  id: CompetenceId
  label: string
  state: CompetenceState
  successes: number
  autonomousSuccesses: number
  /** Étapes distinctes réussies qui travaillent la compétence. */
  stepsSucceeded: string[]
  /** Ce qui manque pour la démontrer (vide si démontrée). */
  missing: string | null
}

export interface PathwayOverview {
  pathway: Pathway
  steps: StepStatus[]
  competences: CompetenceStatus[]
  /** Prochaine étape recommandée (null : parcours terminé et aucune révision due). */
  recommended: PathwayStep | null
  /** Étapes terminées / total. */
  completed: number
  total: number
}

function completedStep(step: PathwayStep, attempts: readonly ProgressAttempt[]): boolean {
  return attemptsOfStep(step, attempts).some((a) => a.success)
}

function lastSuccess(step: PathwayStep, attempts: readonly ProgressAttempt[]): string | null {
  const times = attemptsOfStep(step, attempts)
    .filter((a) => a.success)
    .map((a) => a.finishedAt)
    .sort((x, y) => time(x) - time(y))
  return times[times.length - 1] ?? null
}

/** Compétences travaillées par une tentative : celles de l'étape du lab, sinon celles enregistrées. */
function competencesOf(pathway: Pathway, a: ProgressAttempt): { id: CompetenceId; stepId: string }[] {
  const steps = pathway.steps.filter(
    (s) => s.labId === a.labId && (s.mode === 'exam' ? a.mode === 'exam' : true)
  )
  if (steps.length === 0)
    return a.competences
      .filter((c): c is CompetenceId => c in COMPETENCES)
      .map((id) => ({ id, stepId: a.stepId ?? a.labId }))
  return steps.flatMap((s) => s.competences.map((id) => ({ id, stepId: s.id })))
}

/** État d'une compétence d'après les réussites enregistrées. */
export function competenceStatus(
  pathway: Pathway,
  id: CompetenceId,
  attempts: readonly ProgressAttempt[]
): CompetenceStatus {
  const relevant = attempts
    .filter((a) => a.success)
    .flatMap((a) =>
      competencesOf(pathway, a)
        .filter((c) => c.id === id)
        .map((c) => ({ a, stepId: c.stepId }))
    )
    .sort((x, y) => time(x.a.finishedAt) - time(y.a.finishedAt))
  const steps = [...new Set(relevant.map((r) => r.stepId))]
  const autonomous = relevant.filter((r) => isAutonomous(r.a))
  const label = COMPETENCES[id].label
  const base = {
    id,
    label,
    successes: relevant.length,
    autonomousSuccesses: autonomous.length,
    stepsSucceeded: steps
  }
  if (relevant.length === 0) return { ...base, state: 'non-travaillee', missing: 'aucune réussite' }
  const transfer = steps.length >= 2
  // Révision différée : une autre réussite sur la même étape au moins un jour après une réussite autonome
  const deferred = autonomous.some((r) =>
    relevant.some(
      (o) =>
        o.a.id !== r.a.id &&
        o.stepId === r.stepId &&
        Math.abs(time(o.a.finishedAt) - time(r.a.finishedAt)) >= DAY_MS
    )
  )
  if (autonomous.length >= 1 && (transfer || deferred)) return { ...base, state: 'demontree', missing: null }
  const missing =
    autonomous.length === 0
      ? 'une réussite sans indice (exercice autonome, incident inconnu ou examen)'
      : 'une seconde réussite dans une autre étape, ou sur la même étape au moins un jour plus tard'
  return { ...base, state: 'travaillee', missing }
}

/** Vue d'ensemble d'un parcours à la date `now` (ms). */
export function pathwayOverview(
  pathway: Pathway,
  attempts: readonly ProgressAttempt[],
  now: number
): PathwayOverview {
  const byId = new Map(pathway.steps.map((s) => [s.id, s]))
  const competences = ([...new Set(pathway.steps.flatMap((s) => s.competences))] as CompetenceId[]).map(
    (id) => competenceStatus(pathway, id, attempts)
  )
  const demonstrated = new Set(competences.filter((c) => c.state === 'demontree').map((c) => c.id))

  const statuses: StepStatus[] = pathway.steps.map((step) => {
    const own = attemptsOfStep(step, attempts)
    const done = own.some((a) => a.success)
    const last = lastSuccess(step, attempts)
    const missing = step.prerequisites.filter((p) => {
      const pre = byId.get(p)
      return pre ? !completedStep(pre, attempts) : false
    })
    let availableFrom: string | null = null
    if (step.deferDaysAfter) {
      const origin = byId.get(step.deferDaysAfter.step)
      const originSuccess = origin ? lastSuccess(origin, attempts) : null
      if (originSuccess)
        availableFrom = new Date(time(originSuccess) + step.deferDaysAfter.days * DAY_MS).toISOString()
    }
    const revisionDue =
      done &&
      last !== null &&
      now - time(last) > REVISION_AFTER_DAYS * DAY_MS &&
      step.competences.some((c) => !demonstrated.has(c))
    return {
      step,
      state: revisionDue ? 'a-revoir' : done ? 'termine' : 'disponible',
      attempts: own.length,
      successes: own.filter((a) => a.success).length,
      lastSuccessAt: last,
      missingPrerequisites: missing,
      availableFrom
    }
  })

  // Prochaine étape : première non terminée aux prérequis terminés et à la date de révision atteinte
  const next = statuses.find(
    (s) =>
      s.state === 'disponible' &&
      s.missingPrerequisites.length === 0 &&
      (s.availableFrom === null || time(s.availableFrom) <= now) &&
      // Révision différée sans réussite d'origine : pas encore recommandée
      (!s.step.deferDaysAfter || s.availableFrom !== null)
  )
  const revision = statuses.find((s) => s.state === 'a-revoir')
  const recommended = next ?? revision ?? null
  if (recommended && next) {
    const idx = statuses.findIndex((s) => s.step.id === recommended.step.id)
    statuses[idx] = { ...statuses[idx]!, state: 'recommande' }
  }
  return {
    pathway,
    steps: statuses,
    competences,
    recommended: recommended?.step ?? null,
    completed: statuses.filter((s) => s.state === 'termine' || s.state === 'a-revoir').length,
    total: statuses.length
  }
}

/** Niveau d'aide utilisé lors d'une tentative, pour l'affichage. */
export function helpUsedLabel(a: ProgressAttempt): string {
  if (a.mode === 'exam') return 'examen (sans indice)'
  if (a.gaveUp) return 'abandon (correction révélée)'
  if (a.hintsUsed === 0) return 'sans indice'
  return `${a.hintsUsed} indice${a.hintsUsed > 1 ? 's' : ''}`
}
