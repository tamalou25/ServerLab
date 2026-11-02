/**
 * Onglet « Épreuve » : passation d'un sujet. Critères masqués, solution inaccessible, indices
 * avec pénalité confirmée, questions d'oral au déclencheur, chronomètre, rendu en fin d'épreuve.
 */
import { Clock, FileDown, Lightbulb, Send } from 'lucide-react'
import { useEffect, useState } from 'react'
import { attemptRemainingMs, type Correction } from '@engine/index'
import { useT } from '../../lib/i18n'
import {
  answerQuestion,
  askEndAttempt,
  askHint,
  beginAttempt,
  closeAttemptResult,
  saveAgain
} from '../../lib/attempt'
import { useAttemptStore } from '../../store/attempt'
import { Button, Field, inputClass, Section } from '../common/ui'
import { Markdown } from '../labs/Markdown'

const clock = (ms: number) => {
  const s = Math.ceil(ms / 1000)
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

export function AttemptPanel() {
  const pending = useAttemptStore((s) => s.pending)
  const attempt = useAttemptStore((s) => s.attempt)
  const submission = useAttemptStore((s) => s.submission)
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid="attempt-panel">
      {attempt ? <Running /> : pending ? <Start /> : submission ? <Done /> : null}
    </div>
  )
}

function Start() {
  const { t } = useT()
  const subject = useAttemptStore((s) => s.pending)!
  const [name, setName] = useState('')
  const [mode, setMode] = useState<'exam' | 'self'>('exam')
  return (
    <Section title={t('attempt.title')}>
      <div className="flex flex-col gap-3 text-dense">
        <p className="font-semibold text-fg">{subject.meta.title}</p>
        <p className="text-fg-muted">
          {t('attempt.duration', { minutes: subject.scale.minutes })}
          {subject.meta.author && ` · ${subject.meta.author}`}
        </p>
        <Field label={t('attempt.name')}>
          <input
            className={inputClass}
            value={name}
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
            data-testid="attempt-name"
          />
        </Field>
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-xs font-medium text-fg-muted">{t('attempt.mode')}</legend>
          {(['exam', 'self'] as const).map((m) => (
            <label key={m} className="flex items-center gap-2 text-fg">
              <input type="radio" name="attempt-mode" checked={mode === m} onChange={() => setMode(m)} />
              {t(`attempt.mode.${m}`)}
            </label>
          ))}
        </fieldset>
        <p className="text-fg-muted">{t('attempt.privacy')}</p>
        <Button variant="primary" onClick={() => beginAttempt(name, mode)} data-testid="attempt-start">
          {t('attempt.start')}
        </Button>
      </div>
    </Section>
  )
}

function Running() {
  const { t } = useT()
  const attempt = useAttemptStore((s) => s.attempt)!
  const questionId = useAttemptStore((s) => s.question)
  const lastHint = useAttemptStore((s) => s.lastHint)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const remaining = attemptRemainingMs(attempt, now)
  const question = attempt.subject.oral.find((q) => q.id === questionId)
  const steps = attempt.journal.length
  const penalty = attempt.hints.length * attempt.subject.scale.hintPenalty
  return (
    <>
      <Section title={attempt.subject.meta.title}>
        <div className="flex items-center gap-2">
          <Clock size={16} aria-hidden className="text-fg-muted" />
          <span
            className={`font-mono text-title ${remaining < 5 * 60_000 ? 'text-warn-text' : 'text-fg'}`}
            role="timer"
            aria-label={t('attempt.remaining')}
            data-testid="attempt-timer"
          >
            {clock(remaining)}
          </span>
          <Button variant="danger" className="ml-auto" onClick={askEndAttempt} data-testid="attempt-end">
            <Send size={14} aria-hidden />
            {t('attempt.end')}
          </Button>
        </div>
        <p className="mt-1 text-dense text-fg-muted">
          {t('attempt.studentLine', { name: attempt.studentName })}
        </p>
      </Section>
      {question && <QuestionBox id={question.id} text={question.text} />}
      <Section title={t('attempt.statement')}>
        <div className="text-dense">
          <Markdown text={attempt.subject.lab.statement} />
        </div>
        <p className="mt-2 text-dense text-fg-muted">{t('attempt.criteriaHidden')}</p>
      </Section>
      <Section title={t('attempt.hints')}>
        <div className="flex flex-col gap-2 text-dense">
          <Button onClick={askHint} data-testid="attempt-hint">
            <Lightbulb size={14} aria-hidden />
            {t('attempt.hintAsk', { penalty: String(attempt.subject.scale.hintPenalty).replace('.', ',') })}
          </Button>
          {lastHint && (
            <p
              className="rounded-md border border-line bg-surface-2 p-2 text-fg"
              data-testid="attempt-hint-text"
            >
              {lastHint}
            </p>
          )}
          <p className="text-fg-muted">
            {t('attempt.hintsTaken', {
              count: attempt.hints.length,
              penalty: String(penalty).replace('.', ',')
            })}
          </p>
          <p className="font-mono text-fg-muted">{t('attempt.journal', { count: steps })}</p>
        </div>
      </Section>
    </>
  )
}

function QuestionBox({ id, text }: { id: string; text: string }) {
  const { t } = useT()
  const previous = useAttemptStore((s) => s.attempt?.answers.find((a) => a.questionId === id)?.text ?? '')
  const [answer, setAnswer] = useState(previous)
  return (
    <Section title={t('attempt.question')}>
      <div className="flex flex-col gap-2 text-dense" data-testid="attempt-question">
        <p className="text-fg">{text}</p>
        <textarea
          className={`${inputClass} h-20 py-1`}
          value={answer}
          maxLength={4000}
          aria-label={t('attempt.answer')}
          onChange={(e) => setAnswer(e.target.value)}
          data-testid="attempt-answer"
        />
        <div className="flex gap-2">
          <Button onClick={() => useAttemptStore.getState().set({ question: null })}>
            {t('attempt.later')}
          </Button>
          <Button
            variant="primary"
            onClick={() => answerQuestion(id, answer)}
            data-testid="attempt-answer-save"
          >
            {t('attempt.answerSave')}
          </Button>
        </div>
      </div>
    </Section>
  )
}

function Done() {
  const { t } = useT()
  const submission = useAttemptStore((s) => s.submission)!
  const correction = useAttemptStore((s) => s.correction)
  const savedPath = useAttemptStore((s) => s.savedPath)
  return (
    <Section title={t('attempt.done')}>
      <div className="flex flex-col gap-2 text-dense" data-testid="attempt-done">
        <p className="text-fg">{t(`attempt.ending.${submission.ending}`)}</p>
        <p className="text-fg-muted">
          {savedPath ? t('attempt.savedAt', { path: savedPath }) : t('attempt.notSaved')}
        </p>
        {correction && <SelfCorrection correction={correction} />}
        <div className="flex gap-2">
          <Button onClick={saveAgain}>
            <FileDown size={14} aria-hidden />
            {t('attempt.saveAgain')}
          </Button>
          <Button variant="ghost" onClick={closeAttemptResult}>
            {t('attempt.close')}
          </Button>
        </div>
      </div>
    </Section>
  )
}

/** Auto-évaluation : note et détail par critère (symbole en plus de la couleur). */
export function SelfCorrection({ correction }: { correction: Correction }) {
  const { t } = useT()
  const fmt = (n: number) => String(n).replace('.', ',')
  return (
    <div className="flex flex-col gap-2" data-testid="attempt-correction">
      <p className="text-fg">
        <span className="font-mono text-title" data-testid="attempt-grade">
          {fmt(correction.grade.value)}
        </span>{' '}
        / {correction.grade.outOf}
      </p>
      <ul className="flex flex-col gap-1">
        {correction.criteria.map((c) => (
          <li key={c.id} className="flex gap-2">
            <span className={c.ok ? 'text-ok-text' : 'text-danger-text'} aria-hidden>
              {c.ok ? '✓' : '✗'}
            </span>
            <span className="sr-only">{c.ok ? t('attempt.ok') : t('attempt.ko')}</span>
            <span className="text-fg">{c.label}</span>
            <span className="ml-auto font-mono text-fg-muted">
              {fmt(c.points)}/{fmt(c.max)}
            </span>
          </li>
        ))}
      </ul>
      <p className="font-mono text-fg-muted">
        {t('attempt.summary', {
          errors: correction.errors.total,
          hints: correction.hintsTaken,
          penalty: fmt(correction.penalties.hints)
        })}
      </p>
      {correction.flags.map((f) => (
        <p key={f.code} className="text-warn-text">
          ⚑ {f.message}
        </p>
      ))}
    </div>
  )
}
