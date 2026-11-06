/**
 * Espaces de travail : disponibilité de chaque espace d'après l'état des stores (lab ouvert, épreuve,
 * mode enseignant, tutoriel) et espace effectivement affiché (repli sur l'Atelier).
 */
import { useAttemptStore } from '../store/attempt'
import { useExamStore } from '../store/exam'
import { useLabsStore } from '../store/labs'
import { useTeacherStore } from '../store/teacher'
import { useTroubleshootStore } from '../store/troubleshoot'
import { useTutorialStore } from '../store/tutorial'
import { useUiStore, type Workspace } from '../store/ui'

export interface WorkspaceAvailability {
  mission: boolean
  teacher: boolean
}

/** Vrai si un lab, un résultat d'examen, un dépannage ou une épreuve est ouvert. */
export function missionAvailable(): boolean {
  const labs = useLabsStore.getState()
  const tshoot = useTroubleshootStore.getState()
  const attempt = useAttemptStore.getState()
  return !!(
    labs.active ||
    useExamStore.getState().result ||
    tshoot.session ||
    tshoot.summary ||
    attempt.pending ||
    attempt.attempt ||
    attempt.submission
  )
}

/** Vrai si le mode enseignant est activé et qu'aucune épreuve ni tutoriel n'est en cours. */
export function teacherAvailable(): boolean {
  return (
    useTeacherStore.getState().enabled &&
    useAttemptStore.getState().attempt === null &&
    useTutorialStore.getState().phase !== 'running'
  )
}

/** Espace effectivement affiché pour un espace demandé. */
export function effectiveWorkspace(requested: Workspace, available: WorkspaceAvailability): Workspace {
  if (requested === 'mission' && !available.mission) return 'atelier'
  if (requested === 'teacher' && !available.teacher) return 'atelier'
  return requested
}

/** Disponibilité et espace affiché, réévalués à chaque changement des stores concernés. */
export function useWorkspace(): {
  workspace: Workspace
  requested: Workspace
  available: WorkspaceAvailability
} {
  const requested = useUiStore((s) => s.workspace)
  const active = useLabsStore((s) => s.active)
  const examResult = useExamStore((s) => s.result)
  const tshootSession = useTroubleshootStore((s) => s.session)
  const tshootSummary = useTroubleshootStore((s) => s.summary)
  const pending = useAttemptStore((s) => s.pending)
  const attempt = useAttemptStore((s) => s.attempt)
  const submission = useAttemptStore((s) => s.submission)
  const teacher = useTeacherStore((s) => s.enabled)
  const tutorial = useTutorialStore((s) => s.phase)
  const available: WorkspaceAvailability = {
    mission: !!(active || examResult || tshootSession || tshootSummary || pending || attempt || submission),
    teacher: teacher && attempt === null && tutorial !== 'running'
  }
  return { workspace: effectiveWorkspace(requested, available), requested, available }
}

/** Demande d'un espace (rail, menu, raccourci) : refusée sans effet si l'espace n'est pas disponible. */
export function requestWorkspace(workspace: Workspace): boolean {
  const available = { mission: missionAvailable(), teacher: teacherAvailable() }
  if (effectiveWorkspace(workspace, available) !== workspace) return false
  useUiStore.getState().setWorkspace(workspace)
  return true
}
