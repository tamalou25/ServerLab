/**
 * Mode examen : bandeau du chronomètre pendant l'épreuve et résultat détaillé (note par critère,
 * durée, fin, sorties du mode examen), exportable.
 */
import { useEffect, useState } from 'react'
import { CircleCheck, CircleX, Download, Timer, TriangleAlert, X } from 'lucide-react'
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
    <div className="border-b border-line bg-accent-soft px-4 py-2" data-testid="exam-banner">
      <div className="flex items-center gap-2">
        <Timer size={16} className={left < 5 * 60_000 ? 'text-danger-text' : 'text-accent'} />
        <span className="text-dense font-semibold text-fg">{t('lab.examenEnCours')}</span>
        <span
          className={`ml-auto font-mono text-title font-semibold ${left < 5 * 60_000 ? 'text-danger-text' : 'text-fg'}`}
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
      <div className="flex items-start gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <div className="text-meta font-semibold tracking-wider text-fg-subtle uppercase">
            {t('lab.resultatDeLexamen')}
          </div>
          <h2 className="text-ui font-semibold text-fg">{result.labTitle}</h2>
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
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <div className={`text-2xl font-semibold ${gradeClass}`} data-testid="exam-grade">
          {String(result.grade).replace('.', ',')}
          <span className="text-ui text-fg-subtle"> / 20</span>
        </div>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-dense">
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
        <ul className="mt-3 flex flex-col gap-1.5" data-testid="exam-criteria">
          {result.criteria.map((c) => (
            <li key={c.id} className="flex gap-2 text-ui" data-state={c.ok ? 'ok' : 'ko'}>
              {c.ok ? (
                <CircleCheck size={15} className="mt-0.5 shrink-0 text-ok-text" />
              ) : (
                <CircleX size={15} className="mt-0.5 shrink-0 text-danger-text" />
              )}
              <span className={c.ok ? 'text-fg' : 'text-fg-muted'}>{c.label}</span>
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
      <div className="border-t border-line px-4 py-3">
        <Button className="w-full" onClick={() => void exportExamResult()} data-testid="exam-export">
          <Download size={14} /> Exporter le résultat…
        </Button>
      </div>
    </div>
  )
}
