/**
 * Onglet Parcours du sélecteur de labs : vue d'ensemble (progression réelle, prochaine étape conseillée),
 * étapes regroupées par jalon avec leur état d'après la progression enregistrée, détails dépliables
 * (récit, prérequis, compétences, résultat attendu, niveau d'aide, variantes, tentatives), et colonne des
 * compétences (travaillée ≠ démontrée). Le parcours guide sans verrouiller : chaque étape reste ouvrable.
 */
import { useEffect, useRef, useState } from 'react'
import {
  ArrowRight,
  ChevronDown,
  Circle,
  CircleCheck,
  CircleDashed,
  CircleDot,
  Clock,
  Dices,
  History,
  Sparkles,
  Timer,
  type LucideIcon
} from 'lucide-react'
import {
  COMPETENCES,
  HELP_LABELS,
  helpUsedLabel,
  PATHWAY_PME,
  pathwayOverview,
  PHASE_LABELS,
  type CompetenceState,
  type PathwayOverview,
  type StepStatus
} from '@engine/index'
import { labById } from '../../lib/labCatalog'
import { loadProgress, openStep } from '../../lib/progress'
import { useProgressStore } from '../../store/progress'
import { Badge, type BadgeTone } from '../common/Badge'
import { Button } from '../common/ui'
import { PathwayRail } from './PathwayRail'

const STATE: Record<StepStatus['state'], { label: string; tone: BadgeTone; Icon: LucideIcon; cls: string }> =
  {
    termine: { label: 'Terminée', tone: 'ok', Icon: CircleCheck, cls: 'text-ok-text' },
    recommande: { label: 'Conseillée', tone: 'accent', Icon: Sparkles, cls: 'text-accent-text' },
    disponible: { label: 'À faire', tone: 'neutral', Icon: CircleDashed, cls: 'text-fg-subtle' },
    'a-revoir': { label: 'À revoir', tone: 'warn', Icon: History, cls: 'text-warn-text' }
  }

const COMPETENCE: Record<CompetenceState, { label: string; Icon: LucideIcon; cls: string }> = {
  'non-travaillee': { label: 'non travaillée', Icon: Circle, cls: 'text-fg-subtle' },
  travaillee: { label: 'travaillée', Icon: CircleDot, cls: 'text-warn-text' },
  demontree: { label: 'démontrée', Icon: CircleCheck, cls: 'text-ok-text' }
}

const day = (iso: string) => new Date(iso).toLocaleDateString('fr-FR')

export function PathwayList() {
  const attempts = useProgressStore((s) => s.attempts)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    void loadProgress().then(() => setNow(Date.now()))
  }, [])
  const overview: PathwayOverview = pathwayOverview(PATHWAY_PME, attempts ?? [], now)
  const recommendedId = overview.recommended?.id ?? null
  // Détails dépliés : l'étape conseillée par défaut, puis au choix de l'utilisateur
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const isOpen = (id: string) => open[id] ?? id === recommendedId
  const stepTitle = (id: string) => PATHWAY_PME.steps.find((s) => s.id === id)?.title ?? id
  const count = (state: CompetenceState) => overview.competences.filter((c) => c.state === state).length

  // L'étape conseillée est amenée à l'écran une fois la progression chargée
  const recommendedRef = useRef<HTMLLIElement>(null)
  const loaded = attempts !== null
  useEffect(() => {
    if (loaded) recommendedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [loaded, recommendedId])

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-testid="pathway">
      <header className="border-b border-line px-5 py-4">
        <h3 className="text-heading font-semibold text-fg">{overview.pathway.title}</h3>
        <p className="mt-1.5 max-w-[78ch] text-body text-pretty text-fg-muted">{overview.pathway.company}</p>
        <div className="mt-4 flex flex-wrap items-end gap-x-6 gap-y-3">
          <div className="min-w-[240px] flex-1" data-testid="pathway-progress">
            <div className="mb-1.5 flex items-baseline gap-2 text-dense">
              <span className="font-mono text-ui font-semibold text-fg">
                {overview.completed} / {overview.total}
              </span>
              <span className="text-fg-muted">étapes terminées</span>
            </div>
            <PathwayRail steps={overview.steps} />
          </div>
          <p className="max-w-[46ch] text-dense text-fg" data-testid="pathway-recommended">
            {overview.recommended ? (
              <>
                <span className="mb-0.5 flex items-center gap-1 text-meta font-semibold tracking-wider text-accent-text uppercase">
                  <Sparkles size={12} aria-hidden /> Prochaine étape conseillée
                </span>
                <strong className="text-ui font-semibold">{overview.recommended.title}</strong>
              </>
            ) : (
              <span className="text-ok-text">
                Parcours terminé et compétences démontrées : rien à revoir pour le moment.
              </span>
            )}
          </p>
        </div>
      </header>

      <div className="grid gap-x-6 gap-y-5 px-5 py-4 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="min-w-0">
          <p className="mb-3 text-dense text-fg-muted">
            Accès libre : chaque étape s’ouvre quand vous voulez, les prérequis sont une recommandation.
          </p>
          <ol className="flex flex-col" data-testid="pathway-steps">
            {overview.steps.map((s, i) => {
              const { label, tone, Icon, cls } = STATE[s.state]
              const lab = labById(s.step.labId)
              const expanded = isOpen(s.step.id)
              const recommended = s.state === 'recommande'
              const newPhase = i === 0 || overview.steps[i - 1]!.step.phase !== s.step.phase
              const detailsId = `pathway-details-${s.step.id}`
              return (
                <li
                  key={s.step.id}
                  ref={s.step.id === recommendedId ? recommendedRef : undefined}
                  className="scroll-mt-2"
                  data-testid={`pathway-step-${s.step.id}`}
                  data-state={s.state}
                >
                  {newPhase && (
                    <h4
                      className={`mb-1.5 text-meta font-semibold tracking-wider text-fg-subtle uppercase ${i > 0 ? 'mt-4' : ''}`}
                    >
                      {PHASE_LABELS[s.step.phase]}
                    </h4>
                  )}
                  <div
                    className={`mb-1.5 rounded-panel border ${
                      recommended ? 'border-accent bg-surface' : 'border-line bg-surface'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 px-3 py-2">
                      <Icon size={16} className={`shrink-0 ${cls}`} aria-hidden />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="text-ui font-semibold text-fg">{s.step.title}</span>
                          <Badge tone={tone}>{label}</Badge>
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-meta text-fg-muted">
                          {lab && (
                            <span className="inline-flex items-center gap-1">
                              <Clock size={11} aria-hidden /> {lab.duration}
                            </span>
                          )}
                          {s.attempts > 0 && (
                            <span data-testid={`pathway-attempts-${s.step.id}`}>
                              {s.successes} réussite{s.successes > 1 ? 's' : ''} sur {s.attempts}
                            </span>
                          )}
                          {s.missingPrerequisites.length > 0 && (
                            <span className="text-warn-text">Prérequis conseillés non terminés</span>
                          )}
                        </div>
                      </div>
                      <Button
                        variant={recommended ? 'primary' : 'secondary'}
                        onClick={() => void openStep(s.step)}
                        data-testid={`pathway-open-${s.step.id}`}
                        aria-label={`${s.step.mode === 'exam' ? 'Ouvrir en mode examen' : 'Ouvrir'} : ${s.step.title}`}
                      >
                        {s.step.mode === 'exam' ? (
                          <>
                            <Timer size={14} aria-hidden /> Ouvrir en mode examen
                          </>
                        ) : (
                          <>
                            <ArrowRight size={14} aria-hidden /> Ouvrir
                          </>
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        iconOnly
                        aria-expanded={expanded}
                        aria-controls={detailsId}
                        aria-label={`${expanded ? 'Masquer' : 'Afficher'} les détails : ${s.step.title}`}
                        title={expanded ? 'Masquer les détails' : 'Afficher les détails'}
                        onClick={() => setOpen((o) => ({ ...o, [s.step.id]: !expanded }))}
                        data-testid={`pathway-toggle-${s.step.id}`}
                      >
                        <ChevronDown
                          size={16}
                          aria-hidden
                          className={`transition-transform ${expanded ? 'rotate-180' : ''}`}
                        />
                      </Button>
                    </div>
                    {expanded && (
                      <div id={detailsId} className="border-t border-line px-3 py-3 pl-[38px]">
                        <p className="max-w-[72ch] text-body text-fg-muted">{s.step.story}</p>
                        <dl className="mt-2.5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-dense">
                          <dt className="text-fg-subtle">Résultat attendu</dt>
                          <dd className="text-fg">{s.step.outcome}</dd>
                          <dt className="text-fg-subtle">Compétences</dt>
                          <dd className="text-fg">
                            {s.step.competences.map((c) => COMPETENCES[c].label).join(' · ')}
                          </dd>
                          <dt className="text-fg-subtle">Niveau d’aide</dt>
                          <dd className="text-fg">{HELP_LABELS[s.step.help]}</dd>
                          <dt className="text-fg-subtle">Exercice</dt>
                          <dd className="text-fg">{lab?.title ?? s.step.labId}</dd>
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
                          <dt className="text-fg-subtle">Ensuite</dt>
                          <dd className="text-fg">
                            {s.step.next ? stepTitle(s.step.next) : 'fin du parcours'}
                          </dd>
                          {s.availableFrom && (
                            <>
                              <dt className="text-fg-subtle">Révision conseillée</dt>
                              <dd className="text-fg">à partir du {day(s.availableFrom)}</dd>
                            </>
                          )}
                          {s.attempts > 0 && (
                            <>
                              <dt className="text-fg-subtle">Tentatives</dt>
                              <dd className="text-fg">
                                {s.successes} réussite{s.successes > 1 ? 's' : ''} sur {s.attempts}
                                {s.lastSuccessAt ? `, dernière le ${day(s.lastSuccessAt)}` : ''}
                                {attempts && s.successes > 0 && (
                                  <span className="text-fg-muted">
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
                        {s.step.variantSeeds && s.step.variantSeeds.length > 0 && (
                          <div className="mt-3 flex flex-wrap items-center gap-2">
                            <span className="text-dense text-fg-muted">Même mission, autres cibles :</span>
                            {s.step.variantSeeds.map((seed) => (
                              <Button
                                key={seed}
                                size="sm"
                                onClick={() => void openStep(s.step, seed)}
                                title={`Même mission, autre variante (graine ${seed})`}
                                data-testid={`pathway-variant-${s.step.id}-${seed}`}
                              >
                                <Dices size={13} aria-hidden /> Variante {seed}
                              </Button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </li>
              )
            })}
          </ol>
        </div>

        <aside className="min-w-0 lg:border-l lg:border-line lg:pl-6">
          <h4 className="text-meta font-semibold tracking-wider text-fg-subtle uppercase">Compétences</h4>
          <p className="mt-1 text-dense text-fg-muted" data-testid="pathway-competences-count">
            {count('demontree')} démontrée{count('demontree') > 1 ? 's' : ''} · {count('travaillee')}{' '}
            travaillée{count('travaillee') > 1 ? 's' : ''} · {count('non-travaillee')} à travailler
          </p>
          <ul className="mt-3 flex flex-col gap-2.5" data-testid="pathway-competences">
            {overview.competences.map((c) => {
              const { label, Icon, cls } = COMPETENCE[c.state]
              return (
                <li key={c.id} className="flex gap-2" data-state={c.state} title={COMPETENCES[c.id].detail}>
                  <Icon size={14} className={`mt-0.5 shrink-0 ${cls}`} aria-hidden />
                  <div className="min-w-0 text-dense">
                    <div className="text-fg">{c.label}</div>
                    <div className={`text-meta ${cls}`}>{label}</div>
                    {c.missing && c.state === 'travaillee' && (
                      <div className="text-meta text-fg-muted">Manque : {c.missing}.</div>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
          <p className="mt-4 border-t border-line pt-3 text-meta leading-relaxed text-fg-muted">
            Une étape « terminée » n’est pas une compétence « démontrée » : il faut une réussite sans indice
            et une seconde réussite (autre étape, ou même étape au moins un jour plus tard).
          </p>
        </aside>
      </div>
    </div>
  )
}
