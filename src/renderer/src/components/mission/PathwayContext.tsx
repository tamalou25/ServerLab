/**
 * Place d'un exercice dans le parcours : étape, récit de l'entreprise fil rouge et rappel que l'énoncé
 * d'origine peut nommer une autre société. Les labs sont réutilisés tels quels par le parcours : seul le
 * récit change, jamais les manipulations ni les critères. Absent si le lab n'appartient à aucun parcours.
 */
import { Route } from 'lucide-react'
import { stepsForLab, type LabDefinition } from '@engine/index'
import { useT } from '../../lib/i18n'
import { useExamStore } from '../../store/exam'

export function PathwayContext({ lab }: { lab: LabDefinition }) {
  const { t } = useT()
  const exam = useExamStore((s) => s.session !== null)
  const entries = stepsForLab(lab.id)
  // Un lab réutilisé deux fois (exercice puis révision en examen) : l'étape qui correspond au régime
  const entry = entries.find((e) => (e.step.mode === 'exam') === exam) ?? entries[0]
  if (!entry) return null
  const { pathway, step } = entry
  const index = pathway.steps.findIndex((s) => s.id === step.id) + 1
  const sameCompany = lab.statement.includes('Lambert')
  return (
    <section
      className="mb-4 border-l-2 border-accent pl-3"
      aria-label={t('mission.pathway.label')}
      data-testid="mission-pathway"
    >
      <p className="flex flex-wrap items-center gap-x-1.5 text-meta font-semibold tracking-wider text-accent-text uppercase">
        <Route size={12} aria-hidden />
        {t('mission.pathway.step', { n: index, total: pathway.steps.length })}
      </p>
      <p className="mt-0.5 text-ui font-semibold text-fg">{step.title}</p>
      <p className="mt-1 text-dense leading-relaxed text-fg-muted">{step.story}</p>
      {!sameCompany && (
        <p className="mt-1 text-dense leading-relaxed text-fg-muted" data-testid="mission-pathway-note">
          {t('mission.pathway.note')}
        </p>
      )}
    </section>
  )
}
