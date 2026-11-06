/**
 * Mode examen : bandeau du chronomètre pendant l'épreuve et résultat détaillé (note par critère,
 * durée, fin, sorties du mode examen), exportable.
 */
import { useEffect, useState } from 'react'
import { CircleCheck, CircleX, Download, Timer, TriangleAlert, X } from 'lucide-react'
import { Badge } from '../common/Badge'
import { formatDuration, remainingMs, type ExamResult } from '@engine/index'
import { exportExamResult } from '../../lib/exam'
import { useExamStore } from '../../store/exam'
import { Button } from '../common/ui'
import { t } from '../../lib/i18n'

/** « 19:59 » */
const clock = (ms: number) => {
  const s = Math.ceil(ms / 1000)
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

export function ExamBanner() {
  const session = useExamStore((s) => s.session)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(timer)
  }, [])
  if (!session) return null
  const left = remainingMs(session, now)
  const exits = session.events.filter((e) => e.type === 'leave').length
  return (
    <div className="border-b border-line bg-accent-soft px-5 py-2.5" data-testid="exam-banner">
      <div className="flex items-center gap-2">
        <Timer
          size={16}
          className={left < 5 * 60_000 ? 'text-danger-text' : 'text-accent-text'}
          aria-hidden
        />
        <span className="text-ui font-semibold text-fg">{t('lab.examenEnCours')}</span>
        <span
          role="timer"
          className={`ml-auto font-mono text-heading font-semibold tabular-nums ${left < 5 * 60_000 ? 'text-danger-text' : 'text-fg'}`}
          data-testid="exam-timer"
        >
          {clock(left)}
        </span>
      </div>
      <p className="mt-0.5 text-meta text-fg-muted">
        {t('lab.indicesDesactivesVerificationFinale')}
        {exits > 0 ? t('exam.exits', { count: exits }) : ''}
      </p>
    </div>
  )
}

const ENDINGS: Record<ExamResult['ending'], string> = {
  get finish() {
    return t('exam.end.finish')
  },
  get timeout() {
    return t('exam.timeout')
  },
  get abandon() {
    return t('exam.end.abandon')
  }
}

const EXITS: Partial<Record<ExamResult['exits'][number]['type'], string>> = {
  get leave() {
    return t('exam.exit.leave')
  },
  get abandon() {
    return t('exam.exit.abandon')
  },
  get timeout() {
    return t('exam.timeout')
  }
}

export function ExamResultPanel({ result }: { result: ExamResult }) {
  const gradeClass = result.grade >= 10 ? 'text-ok-text' : 'text-danger-text'
  const time = (at: number) => new Date(at).toLocaleTimeString('fr-FR')
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="exam-result">
      <div className="flex items-start gap-2 border-b border-line px-5 py-3">
        <div className="min-w-0">
          <div className="text-meta font-semibold tracking-wider text-fg-subtle uppercase">
            {t('lab.resultatDeLexamen')}
          </div>
          <h2 className="text-heading font-semibold text-fg">{result.labTitle}</h2>
        </div>
        <button
          type="button"
          onClick={() => useExamStore.getState().set({ result: null })}
          className="ml-auto rounded p-1 text-fg-subtle hover:bg-surface-2 hover:text-fg"
          aria-label={t('lab.fermerLeResultat')}
          data-testid="exam-close"
        >
          <X size={14} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="flex flex-wrap items-end justify-between gap-3 rounded-panel border border-line bg-surface px-4 py-3">
          <div className={`text-display font-semibold tabular-nums ${gradeClass}`} data-testid="exam-grade">
            {String(result.grade).replace('.', ',')}
            <span className="text-ui font-normal text-fg-subtle"> / 20</span>
          </div>
          <Badge
            tone={result.passed === result.total ? 'ok' : 'neutral'}
            icon={
              result.passed === result.total ? (
                <CircleCheck size={11} aria-hidden />
              ) : (
                <CircleX size={11} aria-hidden />
              )
            }
          >
            {result.passed} / {result.total} {t('lab.criteres').toLowerCase()}
          </Badge>
        </div>
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-dense">
          <dt className="text-fg-subtle">{t('lab.criteres')}</dt>
          <dd className="text-fg">
            {result.passed} / {result.total} validé(s)
          </dd>
          <dt className="text-fg-subtle">{t('lab.duree')}</dt>
          <dd className="text-fg">
            {formatDuration(result.elapsedMs)} sur {result.minutes} min
          </dd>
          <dt className="text-fg-subtle">{t('lab.fin')}</dt>
          <dd className="text-fg" data-testid="exam-ending">
            {ENDINGS[result.ending]}
          </dd>
        </dl>
        <h3 className="mt-4 mb-2 text-meta font-semibold tracking-wider text-fg-subtle uppercase">
          {t('lab.objectives')}
        </h3>
        <ul className="flex flex-col gap-1.5" data-testid="exam-criteria">
          {result.criteria.map((c) => (
            <li
              key={c.id}
              className="flex gap-2.5 rounded-panel border border-line px-3 py-2 text-body"
              data-state={c.ok ? 'ok' : 'ko'}
            >
              {c.ok ? (
                <CircleCheck size={16} className="mt-0.5 shrink-0 text-ok-text" aria-hidden />
              ) : (
                <CircleX size={16} className="mt-0.5 shrink-0 text-danger-text" aria-hidden />
              )}
              <span className="flex-1 text-fg">{c.label}</span>
              <span
                className={`shrink-0 text-meta font-medium ${c.ok ? 'text-ok-text' : 'text-danger-text'}`}
              >
                {c.ok ? t('lab.valide') : t('lab.nonValide')}
              </span>
            </li>
          ))}
        </ul>
        <div className="mt-3" data-testid="exam-exits">
          {result.exits.length === 0 ? (
            <p className="text-dense text-fg-muted">{t('lab.aucuneSortieDuMode')}</p>
          ) : (
            <>
              <p className="flex items-center gap-1 text-dense font-semibold text-warn-text">
                <TriangleAlert size={13} /> Sorties du mode examen ({result.exits.length})
              </p>
              <ul className="mt-1 flex flex-col gap-0.5 text-dense text-fg-muted">
                {result.exits.map((e, i) => (
                  <li key={i}>
                    {time(e.at)} — {EXITS[e.type] ?? e.type}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
      <div className="shrink-0 border-t border-line px-5 py-3">
        <Button className="w-full" onClick={() => void exportExamResult()} data-testid="exam-export">
          <Download size={14} aria-hidden /> Exporter le résultat…
        </Button>
      </div>
    </div>
  )
}
