/**
 * Onglet Lab : énoncé, objectifs à valider, bouton Vérifier (✅ / ❌ et indice en cas d'échec).
 */
import { useEffect, useRef } from 'react'
import { CircleCheck, CircleDashed, CircleX, ClipboardCheck, Flag, RotateCcw, Timer, X } from 'lucide-react'
import { askFinishExam, askStartExam } from '../../lib/exam'
import { restartLab, verifyLab } from '../../lib/labs'
import { useExamStore } from '../../store/exam'
import { useLabsStore } from '../../store/labs'
import { Button } from '../common/ui'
import { ExamBanner } from './Exam'
import { Markdown } from './Markdown'
import { t } from '../../lib/i18n'

const DIFFICULTY_CLASS: Record<string, string> = {
  Débutant: 'bg-ok-soft text-ok-text',
  Intermédiaire: 'bg-warn-soft text-warn-text',
  Avancé: 'bg-danger-soft text-danger-text'
}

export function LabPanel() {
  const lab = useLabsStore((s) => s.active)
  const verified = useLabsStore((s) => s.progress)
  // Examen : ni résultat intermédiaire ni indice jusqu'à la vérification finale
  const exam = useExamStore((s) => s.session !== null)
  const progress = exam ? null : verified
  const objectives = useRef<HTMLHeadingElement>(null)
  // Après une vérification, les objectifs (et leurs indices) sont amenés à l'écran
  useEffect(() => {
    if (progress) objectives.current?.scrollIntoView({ block: 'start' })
  }, [progress])
  if (!lab) return null
  const resultOf = (id: string) => progress?.results.find((r) => r.id === id)
  const percent = progress ? Math.round((progress.passed / progress.total) * 100) : 0
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="lab-panel">
      {exam && <ExamBanner />}
      <div className="border-b border-line px-4 py-3">
        <div className="mb-1 flex items-center gap-2">
          <span
            className={`rounded-sm px-1.5 py-0.5 text-meta font-semibold ${DIFFICULTY_CLASS[lab.difficulty] ?? ''}`}
          >
            {lab.difficulty}
          </span>
          <span className="text-meta text-fg-subtle">{lab.duration}</span>
          <button
            type="button"
            onClick={() => useLabsStore.getState().setActive(null)}
            className="ml-auto rounded p-1 text-fg-subtle hover:bg-surface-2 hover:text-fg"
            title={t('lab.quitterLeLabLe')}
            aria-label={t('lab.quitterLeLab')}
            data-testid="lab-quit"
          >
            <X size={14} />
          </button>
        </div>
        <h2 className="text-ui font-semibold text-fg" data-testid="lab-title">
          {lab.title}
        </h2>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <Markdown text={lab.statement} />
        <h3
          ref={objectives}
          className="mt-4 mb-2 scroll-mt-2 text-meta font-semibold tracking-wider text-fg-subtle uppercase"
        >
          Objectifs
        </h3>
        <ul className="flex flex-col gap-2" data-testid="lab-criteria">
          {lab.criteria.map((c) => {
            const r = resultOf(c.id)
            return (
              <li
                key={c.id}
                className="flex gap-2"
                data-testid={`lab-criterion-${c.id}`}
                data-state={r ? (r.ok ? 'ok' : 'ko') : 'pending'}
              >
                {!r ? (
                  <CircleDashed size={15} className="mt-0.5 shrink-0 text-fg-subtle" />
                ) : r.ok ? (
                  <CircleCheck size={15} className="mt-0.5 shrink-0 text-ok-text" />
                ) : (
                  <CircleX size={15} className="mt-0.5 shrink-0 text-danger-text" />
                )}
                <div className="min-w-0 text-ui">
                  <div className={r?.ok ? 'text-fg' : 'text-fg-muted'}>{c.label}</div>
                  {r && !r.ok && <Hints id={c.id} levels={[c.hint, ...c.hints]} />}
                </div>
              </li>
            )
          })}
        </ul>
      </div>
      <div className="border-t border-line px-4 py-3">
        <div className="mb-2 flex items-center justify-between text-dense text-fg-muted">
          <span data-testid="lab-score">
            {progress
              ? t('lab.progress', { passed: progress.passed, total: progress.total })
              : t('lab.notChecked')}
          </span>
          <span className="font-mono">{progress ? `${percent} %` : ''}</span>
        </div>
        <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-surface-2">
          <div
            className={`h-full rounded-full transition-[width] ${percent === 100 ? 'bg-ok' : 'bg-accent'}`}
            style={{ width: `${percent}%` }}
          />
        </div>
        {exam ? (
          <Button variant="primary" onClick={askFinishExam} data-testid="exam-finish" className="w-full">
            <Flag size={14} /> Terminer l’examen
          </Button>
        ) : (
          <div className="flex gap-2">
            <Button variant="primary" onClick={verifyLab} data-testid="lab-check" className="flex-1">
              <ClipboardCheck size={14} /> Vérifier
            </Button>
            <Button
              onClick={askStartExam}
              data-testid="exam-start"
              title={t('lab.modeExamenChronometreSans')}
            >
              <Timer size={14} /> Examen
            </Button>
            <Button onClick={restartLab} data-testid="lab-restart" title={t('lab.recommencerDepuisLetatDe')}>
              <RotateCcw size={14} />
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

/** Indices progressifs : le premier niveau, puis les suivants à la demande. */
function Hints({ id, levels }: { id: string; levels: string[] }) {
  const level = useLabsStore((s) => s.hintLevels[id] ?? 0)
  const shown = levels.slice(0, level + 1)
  return (
    <div className="mt-0.5 flex flex-col gap-0.5 text-dense text-warn-text" data-testid={`lab-hint-${id}`}>
      {shown.map((hint, i) => (
        <div key={i}>
          {shown.length > 1 ? t('lab.hintN', { n: i + 1 }) : t('lab.hint')}
          {hint}
        </div>
      ))}
      {level + 1 < levels.length && (
        <button
          type="button"
          onClick={() => useLabsStore.getState().revealHint(id)}
          className="self-start text-meta text-accent hover:underline"
          data-testid={`lab-more-hint-${id}`}
        >
          Indice suivant ({level + 2} / {levels.length})
        </button>
      )}
    </div>
  )
}
