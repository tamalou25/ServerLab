/**
 * Labs pédagogiques : ouverture (état de départ construit par le moteur), vérification des
 * critères, reprise depuis le départ.
 */
import { buildLabState, checkLab, type LabDefinition } from '@engine/index'
import { useExamStore } from '../store/exam'
import { useLabStore } from '../store/lab'
import { useLabsStore } from '../store/labs'
import { useUiStore } from '../store/ui'
import { confirmDiscard, resetDocumentUi } from './document'
import { t, tp } from './i18n'
import { labHintsUsed, recordAttempt } from './progress'
import { beginTroubleshootSession } from './troubleshoot'

/** Ouvre un lab : nouvel état de départ (document sans fichier) et onglet Lab affiché. */
export async function openLab(lab: LabDefinition): Promise<boolean> {
  if (!(await confirmDiscard())) return false
  let start
  try {
    start = buildLabState(lab)
  } catch (e) {
    useUiStore.getState().showModal({
      title: t('labs.openFailed'),
      message: e instanceof Error ? e.message : String(e)
    })
    return false
  }
  // Résultat d'un examen précédent effacé ; un examen en cours est noté comme abandonné au
  // chargement du nouveau lab (son résultat reste affiché)
  useExamStore.getState().set({ result: null })
  resetDocumentUi()
  useLabStore.getState().load(start, { path: null, name: `${lab.id}.slab` })
  useLabsStore.getState().setActive(lab)
  useLabsStore.getState().setPickerOpen(false)
  useUiStore.getState().setRightTab('lab')
  // Lab de dépannage fourni : session de dépannage (indices, « J'ai réparé », bilan) en plus de l'énoncé
  if (lab.troubleshooting)
    beginTroubleshootSession(lab.id, lab.troubleshooting.seed, { exam: false, generated: false })
  return true
}

/** Vérifie les critères du lab en cours sur l'état actuel. */
export function verifyLab(): void {
  const lab = useLabsStore.getState().active
  if (!lab) return
  const progress = checkLab(useLabStore.getState().lab, lab)
  useLabsStore.getState().setProgress(progress)
  if (progress.passed === progress.total) {
    useUiStore.getState().notify('success', tp('labs.passed', progress.total))
    // Tentative réussie enregistrée dans la progression (fusionnée avec le bilan d'un dépannage)
    void recordAttempt({
      lab,
      mode: 'lab',
      passed: progress.passed,
      total: progress.total,
      success: true,
      hintsUsed: labHintsUsed(),
      hintsAvailable: lab.criteria.reduce((n, c) => n + c.hints.length, 0)
    })
  }
}

/** Recommence le lab : l'état de départ est reconstruit (les modifications sont perdues). */
export function restartLab(): void {
  const lab = useLabsStore.getState().active
  if (!lab) return
  useUiStore.getState().showModal({
    title: t('labs.restart.title'),
    message: t('labs.restart.message', { title: lab.title }),
    confirmLabel: t('labs.restart.confirm'),
    onConfirm: () => {
      resetDocumentUi()
      useLabStore.getState().load(buildLabState(lab), { path: null, name: `${lab.id}.slab` })
      useLabsStore.getState().setActive(lab)
      useUiStore.getState().setRightTab('lab')
      if (lab.troubleshooting)
        beginTroubleshootSession(lab.id, lab.troubleshooting.seed, { exam: false, generated: false })
    }
  })
}
