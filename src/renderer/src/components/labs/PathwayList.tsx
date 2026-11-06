/**
 * Onglet Parcours du sélecteur de labs : l'entreprise fil rouge, les étapes (prérequis, compétences,
 * résultat attendu, niveau d'aide, suivant) avec leur état d'après la progression enregistrée, la
 * prochaine étape recommandée, les variantes d'une mission, et l'état des compétences (travaillée ≠
 * démontrée). Le parcours guide sans verrouiller : chaque étape reste ouvrable.
 */
import { useEffect, useState } from 'react'
import { ArrowRight, CircleCheck, CircleDashed, Dices, History, Sparkles, Timer } from 'lucide-react'
import {
  COMPETENCES,
  HELP_LABELS,
  helpUsedLabel,
  PATHWAY_PME,
  pathwayOverview,
  PHASE_LABELS,
  type PathwayOverview,
  type StepStatus
} from '@engine/index'
import { labById } from '../../lib/labCatalog'
import { loadProgress, openStep } from '../../lib/progress'
import { useProgressStore } from '../../store/progress'
import { Button } from '../common/ui'

const STATE_LABELS: Record<StepStatus['state'], string> = {
  termine: 'Terminée',
  recommande: 'Recommandée',
  disponible: 'Disponible',
  'a-revoir': 'À revoir'
}

const STATE_CLASS: Record<StepStatus['state'], string> = {
  termine: 'bg-ok-soft text-ok-text',
  recommande: 'bg-accent-soft text-accent',
  disponible: 'bg-surface-2 text-fg-muted',
  'a-revoir': 'bg-warn-soft text-warn-text'
}

const COMPETENCE_CLASS = {
  'non-travaillee': 'bg-surface-2 text-fg-muted',
  travaillee: 'bg-warn-soft text-warn-text',
  demontree: 'bg-ok-soft text-ok-text'
} as const

const COMPETENCE_LABELS = {
  'non-travaillee': 'non travaillée',
  travaillee: 'travaillée',
  demontree: 'démontrée'
} as const

const day = (iso: string) => new Date(iso).toLocaleDateString('fr-FR')

export function PathwayList() {
  const attempts = useProgressStore((s) => s.attempts)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    void loadProgress().then(() => setNow(Date.now()))
  }, [])
  const overview: PathwayOverview = pathwayOverview(PATHWAY_PME, attempts ?? [], now)
  const stepTitle = (id: string) => PATHWAY_PME.steps.find((s) => s.id === id)?.title ?? id
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3" data-testid="pathway">
      <h3 className="text-ui font-semibold text-fg">{overview.pathway.title}</h3>
      <p className="mt-1 text-dense text-fg-muted">{overview.pathway.company}</p>
      <p className="mt-1 text-dense text-fg-muted">{overview.pathway.summary}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-dense" data-testid="pathway-progress">
        <span className="font-mono text-fg">
          {overview.completed} / {overview.total}
        </span>
        <span className="text-fg-muted">étapes terminées</span>
        {overview.recommended ? (
          <span className="flex items-center gap-1 text-fg" data-testid="pathway-recommended">
            <Sparkles size={13} className="text-accent" /> Prochaine étape conseillée :{' '}
            <strong>{overview.recommended.title}</strong>
          </span>
        ) : (
          <span className="text-ok-text" data-testid="pathway-recommended">
            Parcours terminé et compétences démontrées : rien à revoir pour le moment.
          </span>
        )}
      </div>
      <p className="mt-1 text-meta text-fg-subtle">
        Accès libre : chaque étape s’ouvre quand vous voulez. Les prérequis sont une recommandation. Une étape
        « terminée » n’est pas une compétence « démontrée » : il faut une réussite sans indice et une seconde
        réussite (autre étape, ou même étape au moins un jour plus tard).
      </p>

      <ol className="mt-4 flex flex-col gap-3" data-testid="pathway-steps">
        {overview.steps.map((s) => (
          <li
            key={s.step.id}
            className={`rounded-md border bg-surface p-3 ${s.state === 'recommande' ? 'border-accent' : 'border-line'}`}
            data-testid={`pathway-step-${s.step.id}`}
            data-state={s.state}
          >
            <div className="flex flex-wrap items-center gap-2">
              {s.state === 'termine' ? (
                <CircleCheck size={15} className="text-ok-text" />
              ) : s.state === 'a-revoir' ? (
                <History size={15} className="text-warn-text" />
              ) : (
                <CircleDashed size={15} className="text-fg-subtle" />
              )}
              <span className="text-ui font-semibold text-fg">{s.step.title}</span>
              <span className={`rounded-sm px-1.5 py-0.5 text-meta font-semibold ${STATE_CLASS[s.state]}`}>
                {STATE_LABELS[s.state]}
              </span>
              <span className="text-meta text-fg-subtle">{PHASE_LABELS[s.step.phase]}</span>
              <span className="ml-auto text-meta text-fg-subtle">
                {labById(s.step.labId)?.duration ?? ''}
              </span>
            </div>
            <p className="mt-1 text-dense text-fg-muted">{s.step.story}</p>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-dense">
              <dt className="text-fg-subtle">Lab</dt>
              <dd className="text-fg">{labById(s.step.labId)?.title ?? s.step.labId}</dd>
              <dt className="text-fg-subtle">Prérequis</dt>
              <dd className="text-fg">
                {s.step.prerequisites.length === 0
                  ? 'aucun'
                  : s.step.prerequisites.map((p) => stepTitle(p)).join(' · ')}
                {s.missingPrerequisites.length > 0 && (
                  <span className="text-warn-text">
                    {' '}
                    (non terminés : {s.missingPrerequisites.map(stepTitle).join(', ')})
                  </span>
                )}
              </dd>
              <dt className="text-fg-subtle">Compétences</dt>
              <dd className="flex flex-wrap gap-1">
                {s.step.competences.map((c) => (
                  <span key={c} className="rounded-sm bg-surface-2 px-1.5 py-0.5 text-meta text-fg">
                    {COMPETENCES[c].label}
                  </span>
                ))}
              </dd>
              <dt className="text-fg-subtle">Résultat attendu</dt>
              <dd className="text-fg">{s.step.outcome}</dd>
              <dt className="text-fg-subtle">Niveau d’aide</dt>
              <dd className="text-fg">{HELP_LABELS[s.step.help]}</dd>
              <dt className="text-fg-subtle">Ensuite</dt>
              <dd className="text-fg">{s.step.next ? stepTitle(s.step.next) : 'fin du parcours'}</dd>
              {s.availableFrom && (
                <>
                  <dt className="text-fg-subtle">Révision conseillée</dt>
                  <dd className="text-fg">à partir du {day(s.availableFrom)}</dd>
                </>
              )}
              {s.attempts > 0 && (
                <>
                  <dt className="text-fg-subtle">Tentatives</dt>
                  <dd className="text-fg" data-testid={`pathway-attempts-${s.step.id}`}>
                    {s.successes} réussite{s.successes > 1 ? 's' : ''} sur {s.attempts}
                    {s.lastSuccessAt ? `, dernière le ${day(s.lastSuccessAt)}` : ''}
                    {attempts && (
                      <span className="text-fg-subtle">
                        {' '}
                        · aide :{' '}
                        {attempts
                          .filter((a) => a.labId === s.step.labId && a.success)
                          .slice(-3)
                          .map(helpUsedLabel)
                          .join(', ')}
                      </span>
                    )}
                  </dd>
                </>
              )}
            </dl>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                variant={s.state === 'recommande' ? 'primary' : 'secondary'}
                onClick={() => void openStep(s.step)}
                data-testid={`pathway-open-${s.step.id}`}
              >
                {s.step.mode === 'exam' ? (
                  <>
                    <Timer size={14} /> Ouvrir en mode examen
                  </>
                ) : (
                  <>
                    <ArrowRight size={14} /> Ouvrir
                  </>
                )}
              </Button>
              {s.step.variantSeeds?.map((seed) => (
                <Button
                  key={seed}
                  onClick={() => void openStep(s.step, seed)}
                  title={`Même mission, autre variante (graine ${seed})`}
                  data-testid={`pathway-variant-${s.step.id}-${seed}`}
                >
                  <Dices size={14} /> Variante {seed}
                </Button>
              ))}
            </div>
          </li>
        ))}
      </ol>

      <h3 className="mt-5 mb-2 text-meta font-semibold tracking-wider text-fg-subtle uppercase">
        Compétences
      </h3>
      <ul className="flex flex-col gap-1 text-dense" data-testid="pathway-competences">
        {overview.competences.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center gap-2" data-state={c.state}>
            <span className={`rounded-sm px-1.5 py-0.5 text-meta font-semibold ${COMPETENCE_CLASS[c.state]}`}>
              {COMPETENCE_LABELS[c.state]}
            </span>
            <span className="text-fg">{c.label}</span>
            <span className="text-fg-subtle">— {COMPETENCES[c.id].detail}</span>
            {c.missing && <span className="text-fg-muted">Manque : {c.missing}.</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}
