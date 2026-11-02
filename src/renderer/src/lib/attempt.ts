/**
 * Passation d'un sujet : ouverture du .slabsujet, journal des commandes de l'interface, indices
 * avec pénalité, questions d'oral, fin et rendu .slabrendu (écriture atomique par le main).
 * Le moteur (teacher/attempt.ts) construit le rendu ; la note vient du rejeu à la correction.
 */
import { useEffect } from 'react'
import {
  attemptRemainingMs,
  buildLabState,
  correctSubmission,
  dueQuestions,
  finishAttempt,
  nextHint,
  parseSubject,
  serializeSubmission,
  startAttempt,
  type Submission
} from '@engine/index'
import { useAttemptStore } from '../store/attempt'
import { setJournalRecorder, useLabStore, type JournalRecorder } from '../store/lab'
import { useLabsStore } from '../store/labs'
import { useUiStore } from '../store/ui'
import { resetDocumentUi } from './document'
import { t } from './i18n'

const showError = (title: string, message: string) => useUiStore.getState().showModal({ title, message })

/** Copie sérialisable d'une commande (le journal est écrit tel quel dans le rendu). */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** Journal : chaque pas de l'interface est horodaté et ajouté à la passation. */
const record: JournalRecorder = (step) => {
  const at = Date.now()
  const { update } = useAttemptStore.getState()
  if (step.kind === 'command')
    update((a) => ({ ...a, journal: [...a.journal, { kind: 'command', at, command: plain(step.command) }] }))
  else if (step.kind === 'transaction')
    update((a) => ({
      ...a,
      journal: [...a.journal, { kind: 'transaction', at, label: step.label, commands: plain(step.commands) }]
    }))
  else update((a) => ({ ...a, journal: [...a.journal, { kind: step.kind, at }] }))
}

/** Ouvre un sujet : l'élève saisit ensuite son nom et choisit le mode. */
export async function openSubjectForAttempt(): Promise<void> {
  const res = await window.serverlab.openTeacherFiles('sujet')
  if (!res.ok) {
    if (!res.canceled) showError(t('attempt.openFailed'), res.error ?? t('error.unknown'))
    return
  }
  const parsed = parseSubject(res.value[0]?.content ?? '')
  if (!parsed.ok) return showError(t('attempt.openFailed'), parsed.message)
  useAttemptStore.getState().set({ pending: parsed.doc, submission: null, correction: null, savedPath: null })
  useUiStore.getState().setRightTab('attempt')
}

/** Démarre la passation : lab de départ du sujet, Temps réel, journal activé. */
export function beginAttempt(name: string, mode: Submission['mode']): void {
  const subject = useAttemptStore.getState().pending
  if (!subject) return
  if (name.trim() === '') return showError(t('attempt.startFailed'), t('attempt.nameRequired'))
  let state
  try {
    state = buildLabState(subject.lab)
  } catch (e) {
    return showError(t('attempt.startFailed'), e instanceof Error ? e.message : String(e))
  }
  resetDocumentUi()
  useUiStore.getState().setMode('realtime')
  useLabsStore.getState().setActive(null)
  useLabStore.getState().load(state, { path: null, name: `${subject.meta.title}.slab` })
  useAttemptStore.getState().set({
    pending: null,
    attempt: startAttempt(subject, name, mode, Date.now()),
    shown: [],
    question: null,
    lastHint: null
  })
  setJournalRecorder(record)
  useUiStore.getState().setRightTab('attempt')
}

/** Révèle le prochain indice (pénalité confirmée avant par l'élève). */
export function takeHint(): void {
  const { attempt, update, set } = useAttemptStore.getState()
  if (!attempt) return
  const hint = nextHint(attempt, useLabStore.getState().lab)
  if (!hint) return set({ lastHint: t('attempt.noMoreHints') })
  update((a) => ({
    ...a,
    hints: [...a.hints, { criterionId: hint.criterionId, index: hint.index, at: Date.now() }]
  }))
  set({ lastHint: hint.text })
}

export function askHint(): void {
  const attempt = useAttemptStore.getState().attempt
  if (!attempt) return
  useUiStore.getState().showModal({
    title: t('attempt.hintTitle'),
    message: t('attempt.hintMessage', {
      penalty: String(attempt.subject.scale.hintPenalty).replace('.', ',')
    }),
    confirmLabel: t('attempt.hintConfirm'),
    onConfirm: takeHint
  })
}

/** Réponse de l'élève à une question d'oral (remplace une réponse précédente). */
export function answerQuestion(questionId: string, text: string): void {
  useAttemptStore.getState().update((a) => ({
    ...a,
    answers: [
      ...a.answers.filter((x) => x.questionId !== questionId),
      { questionId, text: text.slice(0, 4000), at: Date.now() }
    ]
  }))
  useAttemptStore.getState().set({ question: null })
}

async function saveSubmission(submission: Submission): Promise<void> {
  const safe = `${submission.student.name}-${submission.subject.title}`
    .replace(/[\\/:*?"<>|]/g, '')
    .slice(0, 80)
  const res = await window.serverlab.saveTeacherFile(
    'rendu',
    serializeSubmission(submission),
    safe || 'rendu'
  )
  if (res.ok) {
    useAttemptStore.getState().set({ savedPath: res.value })
    useUiStore.getState().notify('success', t('attempt.saved', { path: res.value }))
  } else if (!res.canceled) showError(t('attempt.saveFailed'), res.error ?? t('error.unknown'))
}

/** Fin de la passation (bouton ou temps écoulé) : rendu, enregistrement, correction locale. */
export function endAttempt(ending: Submission['ending']): void {
  const { attempt } = useAttemptStore.getState()
  if (!attempt) return
  setJournalRecorder(null)
  const appVersion = useUiStore.getState().appVersion
  const submission = finishAttempt(attempt, { now: Date.now(), ending, appVersion })
  const correction =
    attempt.mode === 'self'
      ? correctSubmission(attempt.subject, submission, { appVersion, correctedAt: new Date().toISOString() })
      : null
  useAttemptStore.getState().set({ attempt: null, submission, correction, question: null, savedPath: null })
  void saveSubmission(submission)
}

export function askEndAttempt(): void {
  useUiStore.getState().showModal({
    title: t('attempt.endTitle'),
    message: t('attempt.endMessage'),
    confirmLabel: t('attempt.endConfirm'),
    onConfirm: () => endAttempt('finish')
  })
}

/** Enregistre de nouveau le rendu (dialogue annulé la première fois). */
export function saveAgain(): void {
  const submission = useAttemptStore.getState().submission
  if (submission) void saveSubmission(submission)
}

export function closeAttemptResult(): void {
  useAttemptStore.getState().set({ submission: null, correction: null, savedPath: null, pending: null })
}

/** Horloge de la passation : temps écoulé → fin automatique ; questions d'oral au déclencheur. */
export function useAttemptClock(): void {
  const active = useAttemptStore((s) => s.attempt !== null)
  useEffect(() => {
    if (!active) return
    // Autre document ouvert pendant l'épreuve (Fichier > Ouvrir, Nouveau…) : épreuve abandonnée
    const revision = useLabStore.getState().revision
    const unsubscribe = useLabStore.subscribe((s) => {
      if (s.revision !== revision && useAttemptStore.getState().attempt) endAttempt('abandon')
    })
    const tick = () => {
      const { attempt, shown, question, set } = useAttemptStore.getState()
      if (!attempt) return
      const now = Date.now()
      if (attemptRemainingMs(attempt, now) === 0) return endAttempt('timeout')
      if (question) return
      const due = dueQuestions(attempt, useLabStore.getState().lab, now, new Set(shown))
      if (due[0]) set({ question: due[0].id, shown: [...shown, due[0].id] })
    }
    const timer = window.setInterval(tick, 1000)
    return () => {
      window.clearInterval(timer)
      unsubscribe()
    }
  }, [active])
}
