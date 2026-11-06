/**
 * Progression du parcours côté interface : chargement, enregistrement d'une tentative terminée (lab
 * réussi à la vérification, fin d'examen, bilan de dépannage) et ouverture d'une étape (lab, variante
 * par graine, examen). Le main valide et écrit progress.json ; le moteur calcule les états.
 */
import {
  buildLabState,
  parseProgress,
  PATHWAY_PME,
  pathwayOverview,
  startExam,
  stepsForLab,
  type ProgressAttempt,
  type ProgressAttemptMode,
  type LabDefinition,
  type PathwayStep,
  type TroubleshootSummary
} from '@engine/index'
import { labById } from './labCatalog'
import { openLab } from './labs'
import { confirmDiscard, resetDocumentUi } from './document'
import { useExamStore } from '../store/exam'
import { useLabStore } from '../store/lab'
import { useLabsStore } from '../store/labs'
import { useProgressStore } from '../store/progress'
import { useUiStore } from '../store/ui'

/** Charge la progression (une fois) ; renvoie la liste courante. */
export async function loadProgress(): Promise<ProgressAttempt[]> {
  const cached = useProgressStore.getState().attempts
  if (cached) return cached
  let attempts: ProgressAttempt[]
  try {
    attempts = parseProgress({ formatVersion: 1, attempts: await window.serverlab.listProgress() })
  } catch {
    attempts = []
  }
  useProgressStore.getState().set(attempts)
  return attempts
}

export interface AttemptInput {
  lab: LabDefinition
  mode: ProgressAttemptMode
  passed: number
  total: number
  success: boolean
  hintsUsed?: number
  hintsAvailable?: number
  gaveUp?: boolean
  score?: number
  startedAt?: number
  seed?: number
}

let counter = 0

/** Enregistre une tentative terminée ; les compétences et l'étape viennent du parcours qui réutilise ce lab. */
export async function recordAttempt(input: AttemptInput): Promise<void> {
  const now = Date.now()
  const step = stepsForLab(input.lab.id).find(({ step: s }) =>
    s.mode === 'exam' ? input.mode === 'exam' : true
  )
  const attempt: ProgressAttempt = {
    id: `${input.lab.id}-${now}-${++counter}`,
    labId: input.lab.id,
    mode: input.mode,
    ...(input.startedAt !== undefined ? { startedAt: new Date(input.startedAt).toISOString() } : {}),
    finishedAt: new Date(now).toISOString(),
    passed: input.passed,
    total: input.total,
    success: input.success,
    hintsUsed: input.hintsUsed ?? 0,
    hintsAvailable: input.hintsAvailable ?? 0,
    gaveUp: input.gaveUp ?? false,
    ...(input.score !== undefined ? { score: Math.round(input.score) } : {}),
    competences: step ? [...step.step.competences] : [],
    ...(step ? { pathwayId: step.pathway.id, stepId: step.step.id } : {}),
    ...(input.seed !== undefined ? { seed: input.seed } : {})
  }
  // Un lab de dépannage fourni peut être enregistré par « Vérifier » (mode lab) et par son bilan (mode
  // dépannage) : dans les dix minutes, les deux ne font qu'une tentative, le bilan l'emportant
  const existing = useProgressStore.getState().attempts ?? []
  const twin = existing.find(
    (a) =>
      a.labId === attempt.labId &&
      a.mode !== attempt.mode &&
      a.mode !== 'exam' &&
      attempt.mode !== 'exam' &&
      Math.abs(Date.parse(a.finishedAt) - now) < 10 * 60_000
  )
  if (twin && attempt.mode === 'lab') return
  if (twin) attempt.id = twin.id
  try {
    const list = await window.serverlab.recordAttempt(attempt)
    useProgressStore.getState().set(parseProgress({ formatVersion: 1, attempts: list }))
  } catch {
    // Progression non enregistrée : sans conséquence pour la session en cours
  }
}

/** Nombre d'indices supplémentaires révélés sur les critères du lab (le premier indice d'un critère en échec est toujours montré). */
export function labHintsUsed(): number {
  return Object.values(useLabsStore.getState().hintLevels).reduce((n, level) => n + level, 0)
}

/** Bilan de dépannage → tentative (résolu = réussite). */
export function attemptFromSummary(
  lab: LabDefinition,
  summary: TroubleshootSummary,
  startedAt: number,
  seed?: number
): AttemptInput {
  return {
    lab,
    mode: 'troubleshoot',
    passed: summary.objectives.filter((o) => o.ok).length,
    total: summary.objectives.length,
    success: summary.outcome === 'resolu',
    hintsUsed: summary.hintsUsed,
    hintsAvailable: summary.autonomy.hintsAvailable,
    gaveUp: summary.gaveUp,
    score: summary.score,
    startedAt,
    ...(seed !== undefined ? { seed } : {})
  }
}

/** Lab d'une étape, avec la graine d'une variante s'il s'agit d'un lab de dépannage. */
export function stepLab(step: PathwayStep, seed?: number): LabDefinition | undefined {
  const lab = labById(step.labId)
  if (!lab) return undefined
  if (seed === undefined || !lab.troubleshooting) return lab
  return { ...lab, id: lab.id, troubleshooting: { ...lab.troubleshooting, seed } }
}

/** Ouvre l'étape : lab ordinaire, variante (graine) ou directement en mode examen (révision différée). */
export async function openStep(step: PathwayStep, seed?: number): Promise<void> {
  const lab = stepLab(step, seed)
  if (!lab) {
    useUiStore
      .getState()
      .showModal({ title: 'Étape indisponible', message: `Le lab ${step.labId} n’est pas fourni.` })
    return
  }
  if (step.mode !== 'exam') {
    await openLab(lab)
    return
  }
  if (!(await confirmDiscard())) return
  let start
  try {
    start = buildLabState(lab)
  } catch (e) {
    useUiStore.getState().showModal({
      title: 'Ouverture du lab impossible',
      message: e instanceof Error ? e.message : String(e)
    })
    return
  }
  const minutes = Math.max(1, Math.round(Number(/\d+/.exec(lab.duration)?.[0] ?? 30)))
  resetDocumentUi()
  useLabStore.getState().load(start, { path: null, name: `${lab.id}.slab` })
  useLabsStore.getState().setActive(lab)
  useLabsStore.getState().setPickerOpen(false)
  useUiStore.getState().openMission()
  useExamStore.getState().set({
    session: startExam(lab, Date.now(), minutes),
    lab,
    revision: useLabStore.getState().revision,
    result: null
  })
}

/** Prochaine étape recommandée du parcours PME (null : parcours terminé). */
export function recommendedStep(attempts: ProgressAttempt[]): PathwayStep | null {
  return pathwayOverview(PATHWAY_PME, attempts, Date.now()).recommended
}
