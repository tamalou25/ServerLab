/**
 * Mode enseignant, création de sujet : actions de l'interface. Formats, validation, contrôle de
 * la solution et note : moteur (src/engine/teacher).
 */
import {
  checkSubjectSolution,
  createSubject,
  parseSubject,
  parseSubjectValue,
  serializeSubject,
  type LabDefinition,
  type OralQuestion,
  type Scale,
  type Subject,
  type SubjectCheck,
  type SubjectMeta
} from '@engine/index'
import { useLabStore } from '../store/lab'
import { useLabsStore } from '../store/labs'
import { useTeacherStore } from '../store/teacher'
import { useUiStore } from '../store/ui'
import { t } from './i18n'
import { labById } from './labCatalog'
import { currentDefinition } from './labEditor'

const showError = (title: string, message: string) => useUiStore.getState().showModal({ title, message })

/** Active ou désactive le mode enseignant (commande de menu `view:teacherMode`). */
export function setTeacherMode(on: boolean): void {
  useTeacherStore.getState().setEnabled(on)
  const ui = useUiStore.getState()
  if (!on && ui.rightTab === 'teacher') ui.setRightTab('properties')
}

function start(lab: LabDefinition): void {
  useTeacherStore
    .getState()
    .setSubject(createSubject(lab, { appVersion: useUiStore.getState().appVersion, meta: { author: '' } }))
}

/** Nouveau sujet à partir d'un lab fourni avec l'application. */
export function subjectFromLibrary(labId: string): void {
  const lab = labById(labId)
  if (lab) start(lab)
}

/** Nouveau sujet à partir du lab ouvert (onglet Lab). */
export function subjectFromActiveLab(): void {
  const lab = useLabsStore.getState().active
  if (lab) start(lab)
  else showError(t('teacher.subject.failed'), t('teacher.subject.noActiveLab'))
}

/** Nouveau sujet à partir de l'éditeur de labs (topologie capturée et critères du catalogue). */
export function subjectFromEditor(): void {
  const def = currentDefinition()
  if (!def.ok) return showError(t('teacher.subject.failed'), def.message)
  start(def.lab)
  // Lab construit à la main : pas de lab d'origine dans la bibliothèque
  useTeacherStore.getState().edit((s) => ({ ...s, meta: { ...s.meta, sourceLabId: '' } }))
}

/** Ouvre un sujet existant pour le modifier. */
export async function openSubjectFile(): Promise<void> {
  const res = await window.serverlab.openTeacherFiles('sujet')
  if (!res.ok) {
    if (!res.canceled) showError(t('teacher.subject.openFailed'), res.error ?? t('error.unknown'))
    return
  }
  const parsed = parseSubject(res.value[0]?.content ?? '')
  if (!parsed.ok) return showError(t('teacher.subject.openFailed'), parsed.message)
  useTeacherStore.getState().setSubject(parsed.doc)
}

const edit = (change: (s: Subject) => Subject) => useTeacherStore.getState().edit(change)

export function setMeta(patch: Partial<SubjectMeta>): void {
  edit((s) => ({ ...s, meta: { ...s.meta, ...patch } }))
}

export function setStatement(statement: string): void {
  edit((s) => ({ ...s, lab: { ...s.lab, statement } }))
}

export function setScale(patch: Partial<Scale>): void {
  edit((s) => ({ ...s, scale: { ...s.scale, ...patch } }))
}

export function setWeight(key: keyof Scale['weights'], value: number): void {
  edit((s) => ({ ...s, scale: { ...s.scale, weights: { ...s.scale.weights, [key]: value } } }))
}

export function setCriterionPoints(criterionId: string, points: number): void {
  edit((s) => ({
    ...s,
    scale: {
      ...s.scale,
      criteria: s.scale.criteria.map((c) => (c.criterionId === criterionId ? { ...c, points } : c))
    }
  }))
}

/** Identifiant libre pour une nouvelle question (q1, q2…). */
function nextQuestionId(subject: Subject): string {
  const used = new Set(subject.oral.map((q) => q.id))
  let n = subject.oral.length + 1
  while (used.has(`q${n}`)) n++
  return `q${n}`
}

export function addQuestion(): void {
  edit((s) => ({
    ...s,
    oral: [...s.oral, { id: nextQuestionId(s), text: '', trigger: { kind: 'minute', minute: 0 }, points: 1 }]
  }))
}

export function updateQuestion(id: string, patch: Partial<OralQuestion>): void {
  edit((s) => ({ ...s, oral: s.oral.map((q) => (q.id === id ? { ...q, ...patch } : q)) }))
}

export function removeQuestion(id: string): void {
  edit((s) => ({ ...s, oral: s.oral.filter((q) => q.id !== id) }))
}

/** Sujet validé par le schéma (références croisées comprises), ou message d'erreur. */
export function validateSubject(
  subject: Subject
): { ok: true; subject: Subject } | { ok: false; message: string } {
  const parsed = parseSubjectValue(subject)
  return parsed.ok ? { ok: true, subject: parsed.doc } : parsed
}

/** Note obtenue par l'état courant (prévisualisation, contrôle à l'export). */
export function previewSubject(subject: Subject): SubjectCheck {
  return checkSubjectSolution(subject, useLabStore.getState().lab)
}

async function writeSubject(subject: Subject): Promise<void> {
  const name = subject.meta.title.replace(/[\\/:*?"<>|]/g, '').slice(0, 80) || 'sujet'
  const res = await window.serverlab.saveTeacherFile('sujet', serializeSubject(subject), name)
  if (res.ok) useUiStore.getState().notify('success', t('teacher.subject.exported', { path: res.value }))
  else if (!res.canceled) showError(t('teacher.subject.exportFailed'), res.error ?? t('error.unknown'))
}

/**
 * Exporte le sujet. Contrôle : l'état courant (la solution du professeur) doit valider 100 % des
 * critères ; sinon avertissement avec la liste des critères manquants, export possible quand même.
 */
export async function exportSubject(): Promise<void> {
  const current = useTeacherStore.getState().subject
  if (!current) return
  const valid = validateSubject({ ...current, appVersion: useUiStore.getState().appVersion })
  if (!valid.ok) return showError(t('teacher.subject.exportFailed'), valid.message)
  const check = previewSubject(valid.subject)
  if (check.failing.length === 0) return writeSubject(valid.subject)
  useUiStore.getState().showModal({
    title: t('teacher.subject.checkTitle'),
    message: t('teacher.subject.checkMessage', {
      passed: check.passed,
      total: check.total,
      list: check.failing.map((l) => `• ${l}`).join('\n')
    }),
    confirmLabel: t('teacher.subject.exportAnyway'),
    cancelLabel: t('teacher.subject.fix'),
    onConfirm: () => void writeSubject(valid.subject)
  })
}
