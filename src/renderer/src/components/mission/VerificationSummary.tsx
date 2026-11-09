/**
 * Retour après « Vérifier » : ce que le moteur a constaté (objectifs validés, objectifs à reprendre), puis,
 * en cas de réussite, l'objectif atteint, les compétences travaillées et la prochaine étape conseillée.
 * Rien n'est déduit : le moteur dit ce qui n'est pas encore vrai, pas pourquoi. Une réussite n'est jamais
 * présentée comme une compétence « démontrée » (règle du moteur : `progress.ts`).
 */
import { useMemo } from 'react'
import { ArrowRight, CircleCheck, CircleX, LibraryBig, PenLine, Timer } from 'lucide-react'
import {
  COMPETENCES,
  PATHWAY_PME,
  pathwayOverview,
  stepsForLab,
  type LabDefinition,
  type LabProgress
} from '@engine/index'
import { useT } from '../../lib/i18n'
import { labHintsUsed, openStep } from '../../lib/progress'
import { useLabsStore } from '../../store/labs'
import { useProgressStore } from '../../store/progress'
import { Button } from '../common/ui'

export function VerificationSummary({ lab, progress }: { lab: LabDefinition; progress: LabProgress }) {
  const { t, tp } = useT()
  const failed = progress.total - progress.passed
  const success = failed === 0
  if (success) return <Success lab={lab} progress={progress} />
  const numbers = lab.criteria
    .map((c, i) => ({ ok: progress.results.find((r) => r.id === c.id)?.ok ?? false, n: i + 1 }))
    .filter((c) => !c.ok)
    .map((c) => String(c.n).padStart(2, '0'))
  return (
    <section
      className="mb-2 border-b border-line pb-3"
      aria-label={t('verify.title')}
      data-testid="lab-verification"
      data-state="partial"
    >
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-ui font-semibold">
        <span
          className={`inline-flex items-center gap-1.5 ${progress.passed > 0 ? 'text-ok-text' : 'text-fg-muted'}`}
        >
          <CircleCheck size={15} aria-hidden /> {tp('verify.passed', progress.passed)}
        </span>
        <span className="inline-flex items-center gap-1.5 text-danger-text">
          <CircleX size={15} aria-hidden /> {tp('verify.failed', failed)}
          {progress.passed > 0 && (
            <span className="font-mono text-dense font-normal text-fg-muted">({numbers.join(', ')})</span>
          )}
        </span>
      </p>
      <p className="mt-1.5 text-dense leading-relaxed text-fg-muted">{t('verify.limit')}</p>
    </section>
  )
}

function Success({ lab, progress }: { lab: LabDefinition; progress: LabProgress }) {
  const { t, tp } = useT()
  const attempts = useProgressStore((s) => s.attempts)
  const step = stepsForLab(lab.id)[0]?.step
  // Prochaine étape d'après la progression enregistrée (la réussite vient d'y être ajoutée)
  const next = useMemo(() => pathwayOverview(PATHWAY_PME, attempts ?? [], Date.now()).recommended, [attempts])
  const hintsUsed = labHintsUsed()
  const openCatalog = () => useLabsStore.getState().setPickerOpen(true, 'builtin')
  return (
    <section
      className="mb-3 rounded-panel border border-ok/50 bg-ok-soft/50 px-3.5 py-3"
      aria-label={t('verify.title')}
      data-testid="lab-verification"
      data-state="success"
    >
      <h4 className="flex items-center gap-1.5 text-title font-semibold text-fg">
        <CircleCheck size={17} className="text-ok-text" aria-hidden />
        {tp('verify.success', progress.total)}
      </h4>
      {step && (
        <p className="mt-1.5 text-body text-fg" data-testid="lab-success-outcome">
          {step.outcome}
        </p>
      )}
      <dl className="mt-2.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-dense">
        {step && (
          <>
            <dt className="text-fg-muted">{t('verify.competences')}</dt>
            <dd className="text-fg" data-testid="lab-success-competences">
              {step.competences.map((c) => COMPETENCES[c].label).join(' · ')}
            </dd>
          </>
        )}
        <dt className="text-fg-muted">{t('verify.help')}</dt>
        <dd className="text-fg" data-testid="lab-success-help">
          {hintsUsed === 0 ? t('verify.help.none') : tp('verify.help.used', hintsUsed)}
        </dd>
      </dl>
      {step && <p className="mt-2 text-dense leading-relaxed text-fg-muted">{t('verify.notDemonstrated')}</p>}
      <p className="mt-2.5 flex gap-1.5 border-t border-ok/30 pt-2.5 text-dense leading-relaxed text-fg-muted">
        <PenLine size={13} className="mt-0.5 shrink-0" aria-hidden />
        <span>
          <span className="font-semibold text-fg">{t('verify.selfCheck.title')}</span>{' '}
          {t('verify.selfCheck.detail')}
        </span>
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {next ? (
          <Button
            variant="primary"
            onClick={() => void openStep(next)}
            title={next.title}
            data-testid="lab-next-step"
          >
            {next.mode === 'exam' ? <Timer size={14} aria-hidden /> : <ArrowRight size={14} aria-hidden />}
            <span className="max-w-[260px] truncate">{t('verify.next', { step: next.title })}</span>
          </Button>
        ) : null}
        <Button onClick={openCatalog} data-testid="lab-success-catalog">
          <LibraryBig size={14} aria-hidden /> {t('verify.catalog')}
        </Button>
      </div>
    </section>
  )
}
