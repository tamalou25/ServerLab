/**
 * Onglet Mission du lecteur : en-tête (difficulté, durée, titre), énoncé, objectifs avec leur état
 * réel après Vérifier et indices progressifs, pied fixe (progression, Vérifier, Examen, Recommencer).
 * En examen : bandeau du chronomètre, aucun résultat intermédiaire ni indice, « Terminer l'examen ».
 */
import { useEffect, useRef } from 'react'
import { ClipboardCheck, Flag, RotateCcw, Timer, X } from 'lucide-react'
import { askFinishExam, askStartExam } from '../../lib/exam'
import { restartLab, verifyLab } from '../../lib/labs'
import { useExamStore } from '../../store/exam'
import { useLabsStore } from '../../store/labs'
import { Button } from '../common/ui'
import { ObjectiveList } from '../mission/ObjectiveList'
import { PathwayContext } from '../mission/PathwayContext'
import { VerificationSummary } from '../mission/VerificationSummary'
import { DifficultyBadge } from './DifficultyBadge'
import { ExamBanner } from './Exam'
import { Markdown } from './Markdown'
import { useT } from '../../lib/i18n'

export function LabPanel() {
  const { t } = useT()
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
  const percent = progress ? Math.round((progress.passed / progress.total) * 100) : 0
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="lab-panel">
      {exam && <ExamBanner />}
      <div className="border-b border-line px-5 pt-3 pb-3">
        <div className="mb-1.5 flex items-center gap-2">
          <DifficultyBadge difficulty={lab.difficulty} />
          <span className="text-meta text-fg-subtle">{lab.duration}</span>
          <span className="text-meta text-fg-subtle">·</span>
          <span className="text-meta text-fg-subtle">
            {t('lab.objectivesCount', { count: lab.criteria.length })}
          </span>
          <button
            type="button"
            onClick={() => useLabsStore.getState().setActive(null)}
            className="ml-auto rounded-control p-1 text-fg-subtle hover:bg-surface-2 hover:text-fg"
            title={t('lab.quitterLeLabLe')}
            aria-label={t('lab.quitterLeLab')}
            data-testid="lab-quit"
          >
            <X size={14} aria-hidden />
          </button>
        </div>
        <h2 className="text-heading font-semibold text-fg" data-testid="lab-title">
          {lab.title}
        </h2>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <PathwayContext lab={lab} />
        <Markdown text={lab.statement} />
        <h3
          ref={objectives}
          className="mt-6 mb-2 flex scroll-mt-3 items-baseline gap-2 border-t border-line pt-4 text-meta font-semibold tracking-wider text-fg-subtle uppercase"
        >
          {t('lab.objectives')}
        </h3>
        {exam && <p className="mb-2 text-dense text-fg-muted">{t('lab.examObjectivesHint')}</p>}
        {progress && <VerificationSummary lab={lab} progress={progress} />}
        <ObjectiveList lab={lab} progress={progress} showHints={!exam} />
      </div>
      <div className="shrink-0 border-t border-line bg-panel px-5 py-3">
        <div className="mb-1.5 flex items-center justify-between text-dense text-fg-muted">
          <span data-testid="lab-score">
            {progress
              ? t('lab.progress', { passed: progress.passed, total: progress.total })
              : t('lab.notChecked')}
          </span>
          <span className="font-mono">{progress ? `${percent} %` : ''}</span>
        </div>
        <div
          className="mb-3 h-1.5 overflow-hidden rounded-full bg-surface-2"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-label={t('lab.objectives')}
        >
          <div
            className={`h-full rounded-full transition-[width] ${percent === 100 ? 'bg-ok' : 'bg-accent'}`}
            style={{ width: `${percent}%` }}
          />
        </div>
        {exam ? (
          <Button variant="primary" onClick={askFinishExam} data-testid="exam-finish" className="w-full">
            <Flag size={14} aria-hidden /> {t('exam.finish.title')}
          </Button>
        ) : (
          <div className="flex gap-2">
            <Button variant="primary" onClick={verifyLab} data-testid="lab-check" className="flex-1">
              <ClipboardCheck size={14} aria-hidden /> {t('lab.verifier')}
            </Button>
            <Button
              onClick={askStartExam}
              data-testid="exam-start"
              title={t('lab.modeExamenChronometreSans')}
            >
              <Timer size={14} aria-hidden /> {t('lab.exam')}
            </Button>
            <Button
              iconOnly
              onClick={restartLab}
              data-testid="lab-restart"
              title={t('lab.recommencerDepuisLetatDe')}
              aria-label={t('lab.recommencerDepuisLetatDe')}
            >
              <RotateCcw size={14} aria-hidden />
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
