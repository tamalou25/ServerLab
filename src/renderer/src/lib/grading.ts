/**
 * Correction des rendus : import (plusieurs fichiers), rejeu et note par le moteur, saisie du
 * professeur, export .slabcorrection par élève et CSV de la classe.
 */
import {
  classCsv,
  correctSubmission,
  parseSubject,
  parseSubmission,
  serializeCorrection,
  type Subject,
  type Submission
} from '@engine/index'
import { useGradingStore, type GradedCopy } from '../store/grading'
import { useTeacherStore } from '../store/teacher'
import { useUiStore } from '../store/ui'
import { t } from './i18n'

const showError = (title: string, message: string) => useUiStore.getState().showModal({ title, message })

function grade(subject: Subject, submission: Submission, oralPoints: (number | null)[], comment: string) {
  const ui = useUiStore.getState()
  return correctSubmission(subject, submission, {
    appVersion: ui.appVersion,
    correctedAt: new Date().toISOString(),
    oralPoints,
    comment
  })
}

/** Sujet de référence : celui en cours d'édition, ou un .slabsujet ouvert. */
export function gradeEditedSubject(): void {
  const subject = useTeacherStore.getState().subject
  if (subject) useGradingStore.getState().set({ subject, copies: [], selected: null })
}

export async function openGradingSubject(): Promise<void> {
  const res = await window.serverlab.openTeacherFiles('sujet')
  if (!res.ok) {
    if (!res.canceled) showError(t('grading.failed'), res.error ?? t('error.unknown'))
    return
  }
  const parsed = parseSubject(res.value[0]?.content ?? '')
  if (!parsed.ok) return showError(t('grading.failed'), parsed.message)
  useGradingStore.getState().set({ subject: parsed.doc, copies: [], selected: null })
}

/** Importe des rendus : chacun est rejoué ; un fichier illisible est signalé, les autres importés. */
export async function importSubmissions(): Promise<void> {
  const { subject, copies } = useGradingStore.getState()
  if (!subject) return
  const res = await window.serverlab.openTeacherFiles('rendu')
  if (!res.ok) {
    if (!res.canceled) showError(t('grading.failed'), res.error ?? t('error.unknown'))
    return
  }
  const errors: string[] = []
  const added: GradedCopy[] = []
  for (const file of res.value) {
    const parsed = parseSubmission(file.content)
    if (!parsed.ok) {
      errors.push(`${file.name} : ${parsed.message}`)
      continue
    }
    const oralPoints = subject.oral.map(() => null)
    added.push({
      file: file.name,
      submission: parsed.doc,
      oralPoints,
      comment: '',
      correction: grade(subject, parsed.doc, oralPoints, '')
    })
  }
  const kept = copies.filter((c) => !added.some((a) => a.file === c.file))
  const next = [...kept, ...added].sort((a, b) =>
    a.submission.student.name.localeCompare(b.submission.student.name)
  )
  useGradingStore.getState().set({ copies: next, selected: added[0]?.file ?? null })
  if (errors.length > 0) showError(t('grading.someFailed'), errors.join('\n'))
}

/** Saisie du professeur : la note est recalculée (rejeu) avec les nouveaux points d'oral. */
export function updateCopy(file: string, patch: { oralPoints?: (number | null)[]; comment?: string }): void {
  const { subject, copies } = useGradingStore.getState()
  if (!subject) return
  useGradingStore.getState().set({
    copies: copies.map((c) => {
      if (c.file !== file) return c
      const oralPoints = patch.oralPoints ?? c.oralPoints
      const comment = patch.comment ?? c.comment
      return { ...c, oralPoints, comment, correction: grade(subject, c.submission, oralPoints, comment) }
    })
  })
}

export async function exportCorrection(file: string): Promise<void> {
  const copy = useGradingStore.getState().copies.find((c) => c.file === file)
  if (!copy) return
  const name = `correction-${copy.submission.student.name}`.replace(/[\\/:*?"<>|]/g, '').slice(0, 80)
  const res = await window.serverlab.saveTeacherFile('correction', serializeCorrection(copy.correction), name)
  if (res.ok) useUiStore.getState().notify('success', t('grading.exported', { path: res.value }))
  else if (!res.canceled) showError(t('grading.exportFailed'), res.error ?? t('error.unknown'))
}

export async function exportClassCsv(): Promise<void> {
  const { copies, subject } = useGradingStore.getState()
  if (copies.length === 0 || !subject) return
  const name = `notes-${subject.meta.title}`.replace(/[\\/:*?"<>|]/g, '').slice(0, 80)
  const res = await window.serverlab.saveTeacherFile('csv', classCsv(copies.map((c) => c.correction)), name)
  if (res.ok) useUiStore.getState().notify('success', t('grading.exported', { path: res.value }))
  else if (!res.canceled) showError(t('grading.exportFailed'), res.error ?? t('error.unknown'))
}
