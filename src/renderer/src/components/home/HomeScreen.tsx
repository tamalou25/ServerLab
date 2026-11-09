/**
 * Écran d'accueil : affiché au lancement sans fichier (selon la préférence enregistrée) et par
 * Fichier > Accueil. Une action principale selon l'état réel (tutoriel proposé, prochaine étape conseillée
 * du parcours, parcours terminé), les accès (parcours, tutoriel, fichier, topologie libre), les fichiers
 * récents (un fichier disparu est signalé et peut être retiré), une sélection d'exercices et l'accès au
 * catalogue complet. Une étape conseillée n'est jamais présentée comme la reprise d'une session
 * enregistrée. Se ferme dès qu'un document est chargé.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ArrowRight,
  CircleCheck,
  CircleDashed,
  Clock,
  FilePlus2,
  FileText,
  FolderOpen,
  GraduationCap,
  History,
  LibraryBig,
  Network,
  Route,
  Sparkles,
  Timer,
  X,
  type LucideIcon
} from 'lucide-react'
import {
  HELP_LABELS,
  PATHWAY_PME,
  pathwayOverview,
  PHASE_LABELS,
  type LabDefinition,
  type PathwayStep,
  type ProgressAttempt
} from '@engine/index'
import type { RecentEntry } from '@shared/ipc'
import { formatOpenedAt, splitPath } from '@shared/recent'
import { accelerator, formatShortcut, type ShortcutId } from '@shared/shortcuts'
import { newDocument, openDocument, openRecentDocument } from '../../lib/document'
import { useT } from '../../lib/i18n'
import { labById, LABS } from '../../lib/labCatalog'
import { openLab } from '../../lib/labs'
import { loadProgress, openStep } from '../../lib/progress'
import { closeTutorial, setTutorialAtStartup, startTutorial } from '../../lib/tutorial'
import { useLabStore } from '../../store/lab'
import { useLabsStore } from '../../store/labs'
import { useProgressStore } from '../../store/progress'
import { useTutorialStore } from '../../store/tutorial'
import { useUiStore } from '../../store/ui'
import { Badge } from '../common/Badge'
import { Button } from '../common/ui'
import { DifficultyBadge } from '../labs/DifficultyBadge'
import { PathwayRail } from '../labs/PathwayRail'

function closeHome(): void {
  useUiStore.getState().setHome(false)
}

export function HomeScreen() {
  const open = useUiStore((s) => s.home)
  return open ? <HomePage /> : null
}

function HomePage() {
  const version = useUiStore((s) => s.appVersion)
  const { lang, t } = useT()
  const revision = useLabStore((s) => s.revision)
  // Révision du document à l'ouverture de l'accueil : toute nouvelle révision = document chargé
  const revisionAtOpen = useRef(revision)
  const [recent, setRecent] = useState<RecentEntry[] | null>(null)
  const [atStartup, setAtStartup] = useState<boolean | null>(null)
  const attempts = useProgressStore((s) => s.attempts)

  const refresh = useCallback(() => {
    void window.serverlab.listRecent().then(setRecent)
  }, [])

  useEffect(() => {
    refresh()
    void window.serverlab.homeAtStartup().then(setAtStartup)
    void loadProgress()
  }, [refresh])

  // Nouveau, Ouvrir, récent, lab fourni, double-clic sur un .slab, menu : l'accueil se ferme
  useEffect(() => {
    if (revision !== revisionAtOpen.current) closeHome()
  }, [revision])

  // Échap ferme l'accueil, sauf quand une fenêtre est affichée par-dessus
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const ui = useUiStore.getState()
      if (ui.modal || ui.helpPanel || useLabsStore.getState().pickerOpen) return
      closeHome()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const openRecent = async (entry: RecentEntry) => {
    await openRecentDocument(entry.path)
    // Fichier supprimé ou déplacé entre-temps : il apparaît désormais comme introuvable
    refresh()
  }

  const remove = (entry: RecentEntry) => {
    void window.serverlab.removeRecent(entry.path).then(setRecent)
  }

  const toggleAtStartup = (show: boolean) => {
    setAtStartup(show)
    window.serverlab.setHomeAtStartup(show)
  }

  const tutorialOffered = useTutorialStore((s) => s.phase === 'welcome')
  const [now] = useState(() => Date.now())
  const overview = useMemo(() => pathwayOverview(PATHWAY_PME, attempts ?? [], now), [attempts, now])
  const nextStep = overview.recommended
  const started = (attempts?.length ?? 0) > 0
  const openCatalog = () => useLabsStore.getState().setPickerOpen(true, 'builtin')
  const openPathway = () => useLabsStore.getState().setPickerOpen(true, 'pathway')

  // Suite du parcours : l'étape conseillée puis les suivantes non terminées (profil déjà engagé)
  const upcoming = overview.steps.filter((s) => s.state !== 'termine').slice(0, 3)
  // Exercices travaillés récemment : dernier résultat réel de chaque lab, du plus récent au plus ancien
  const worked: { lab: LabDefinition; attempt: ProgressAttempt }[] = []
  for (const attempt of [...(attempts ?? [])].reverse()) {
    const lab = labById(attempt.labId)
    if (lab && !worked.some((w) => w.lab.id === lab.id)) worked.push({ lab, attempt })
    if (worked.length === 3) break
  }
  const beginner = LABS.filter((l) => l.difficulty === 'Débutant')

  return (
    <div
      className="fixed inset-0 z-[250] overflow-y-auto bg-app"
      role="region"
      aria-label={t('home.label')}
      data-testid="home-screen"
    >
      <div className="mx-auto flex min-h-full max-w-[1120px] flex-col px-4 py-6 sm:px-8 sm:py-8">
        <header className="mb-6 flex items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-panel bg-accent text-on-accent">
            <Network size={20} aria-hidden />
          </div>
          <div className="min-w-0">
            <h1 className="text-heading font-semibold text-fg">ServerLab</h1>
            <p className="text-dense text-fg-muted">{t('home.subtitle', { version })}</p>
          </div>
          <button
            type="button"
            onClick={closeHome}
            className="ml-auto rounded-control p-1.5 text-fg-subtle hover:bg-surface-2 hover:text-fg"
            aria-label={t('home.close')}
            title={t('home.closeHint')}
            data-testid="home-close"
          >
            <X size={18} aria-hidden />
          </button>
        </header>

        <div className="grid flex-1 content-start gap-x-10 gap-y-8 md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <div className="flex min-w-0 flex-col gap-7">
            {attempts === null ? (
              <section
                className="h-[176px] rounded-card border border-line bg-surface"
                aria-busy="true"
                aria-label={t('home.loading')}
                data-testid="home-next-loading"
              />
            ) : tutorialOffered ? (
              <TutorialOffer nextStep={nextStep} />
            ) : nextStep ? (
              <section
                className="rounded-card border border-line bg-surface p-5"
                aria-labelledby="home-next-title"
                data-testid="home-next"
                data-state={started ? 'progress' : 'first'}
              >
                <Eyebrow icon={Route}>
                  {started ? t('home.next.eyebrow') : t('home.next.eyebrowFirst')}
                </Eyebrow>
                <h2 id="home-next-title" className="mt-1.5 text-display font-semibold text-balance text-fg">
                  {nextStep.title}
                </h2>
                <p className="mt-2 max-w-[62ch] text-body text-pretty text-fg-muted">{nextStep.story}</p>
                <StepMeta step={nextStep} />
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <Button
                    variant="primary"
                    className="h-9 px-4 text-ui"
                    onClick={() => void openStep(nextStep)}
                    data-testid="home-next-open"
                  >
                    {nextStep.mode === 'exam' ? (
                      <Timer size={15} aria-hidden />
                    ) : (
                      <ArrowRight size={15} aria-hidden />
                    )}
                    {nextStep.mode === 'exam' ? t('home.next.openExam') : t('home.next.open')}
                  </Button>
                  <span className="text-dense text-fg-muted">{t('home.next.note')}</span>
                </div>
              </section>
            ) : (
              <section
                className="rounded-card border border-line bg-surface p-5"
                aria-labelledby="home-next-title"
                data-testid="home-next"
                data-state="done"
              >
                <Eyebrow icon={CircleCheck}>{t('home.done.eyebrow')}</Eyebrow>
                <h2 id="home-next-title" className="mt-1.5 text-display font-semibold text-balance text-fg">
                  {t('home.done.title')}
                </h2>
                <p className="mt-2 max-w-[62ch] text-body text-pretty text-fg-muted">
                  {t('home.done.detail')}
                </p>
                <div className="mt-4">
                  <Button
                    variant="primary"
                    className="h-9 px-4 text-ui"
                    onClick={openCatalog}
                    data-testid="home-next-catalog"
                  >
                    <LibraryBig size={15} aria-hidden /> {t('home.catalog')}
                  </Button>
                </div>
              </section>
            )}

            <section aria-label={t('home.start')}>
              <SectionTitle>{t('home.start')}</SectionTitle>
              <div className="overflow-hidden rounded-panel border border-line bg-surface">
                <Action
                  icon={Route}
                  label={t('home.pathway')}
                  detail={
                    nextStep ? t('home.pathway.detail', { step: nextStep.title }) : t('home.pathway.done')
                  }
                  shortcut="openLab"
                  onClick={openPathway}
                  testId="home-pathway"
                  trailing={
                    attempts !== null && (
                      <span className="flex w-28 shrink-0 flex-col gap-1" data-testid="home-progress">
                        <span className="text-right font-mono text-meta text-fg-muted">
                          {t('home.pathway.progress', { done: overview.completed, total: overview.total })}
                        </span>
                        <PathwayRail steps={overview.steps} />
                      </span>
                    )
                  }
                />
                {!tutorialOffered && (
                  <Action
                    icon={GraduationCap}
                    label={t('home.tutorial')}
                    detail={t('home.tutorial.detail')}
                    onClick={() => void startTutorial()}
                    testId="home-tutorial"
                  />
                )}
                <Action
                  icon={FolderOpen}
                  label={t('home.open')}
                  detail={t('home.open.detail')}
                  shortcut="open"
                  onClick={() => void openDocument()}
                  testId="home-open"
                />
                <Action
                  icon={FilePlus2}
                  label={t('home.new')}
                  detail={t('home.new.detail')}
                  shortcut="newFile"
                  onClick={() => void newDocument()}
                  testId="home-new"
                />
              </div>
            </section>

            <section aria-label={t('home.recent')}>
              <SectionTitle>{t('home.recent')}</SectionTitle>
              {recent && recent.length === 0 && (
                <p className="text-dense text-fg-muted" data-testid="home-recent-empty">
                  {t('home.recent.empty')}
                </p>
              )}
              <ul className="flex flex-col gap-1.5">
                {recent?.map((entry) => (
                  <RecentRow
                    key={entry.path}
                    entry={entry}
                    onOpen={() => void openRecent(entry)}
                    onRemove={() => remove(entry)}
                  />
                ))}
              </ul>
            </section>
          </div>

          <div className="flex min-w-0 flex-col gap-7" data-testid="home-exercises">
            {started && upcoming.length > 0 && (
              <section aria-label={t('home.upcoming')}>
                <SectionTitle>{t('home.upcoming')}</SectionTitle>
                <ul className="overflow-hidden rounded-panel border border-line bg-surface">
                  {upcoming.map((s) => {
                    const lab = labById(s.step.labId)
                    return (
                      <ExerciseRow
                        key={s.step.id}
                        title={s.step.title}
                        detail={s.step.outcome}
                        onClick={() => void openStep(s.step)}
                        testId={`home-step-${s.step.id}`}
                        meta={
                          <>
                            {s.state === 'recommande' && (
                              <Badge tone="accent" icon={<Sparkles size={11} aria-hidden />}>
                                {t('home.step.recommended')}
                              </Badge>
                            )}
                            {s.state === 'a-revoir' && (
                              <Badge tone="warn" icon={<History size={11} aria-hidden />}>
                                {t('home.step.review')}
                              </Badge>
                            )}
                            {lab && <Duration value={lab.duration} />}
                          </>
                        }
                      />
                    )
                  })}
                </ul>
              </section>
            )}
            {worked.length > 0 && (
              <section aria-label={t('home.worked')}>
                <SectionTitle>{t('home.worked')}</SectionTitle>
                <ul className="overflow-hidden rounded-panel border border-line bg-surface">
                  {worked.map(({ lab, attempt }) => (
                    <ExerciseRow
                      key={lab.id}
                      title={lab.title}
                      onClick={() => void openLab(lab)}
                      testId={`home-lab-${lab.id}`}
                      meta={
                        <>
                          {attempt.success ? (
                            <Badge tone="ok" icon={<CircleCheck size={11} aria-hidden />}>
                              {t('home.worked.success')}
                            </Badge>
                          ) : (
                            <Badge tone="neutral" icon={<CircleDashed size={11} aria-hidden />}>
                              {t('home.worked.retry', { passed: attempt.passed, total: attempt.total })}
                            </Badge>
                          )}
                          <span className="text-meta text-fg-muted">
                            {formatOpenedAt(attempt.finishedAt, new Date(), lang)}
                          </span>
                        </>
                      }
                    />
                  ))}
                </ul>
              </section>
            )}
            {attempts !== null && !started && (
              <section aria-label={t('home.beginner')}>
                <SectionTitle>{t('home.beginner')}</SectionTitle>
                <ul className="overflow-hidden rounded-panel border border-line bg-surface">
                  {beginner.map((lab) => (
                    <ExerciseRow
                      key={lab.id}
                      title={lab.title}
                      detail={lab.summary}
                      onClick={() => void openLab(lab)}
                      testId={`home-lab-${lab.id}`}
                      meta={
                        <>
                          <DifficultyBadge difficulty={lab.difficulty} />
                          <Duration value={lab.duration} />
                        </>
                      }
                    />
                  ))}
                </ul>
              </section>
            )}
            <button
              type="button"
              onClick={openCatalog}
              className="flex items-center gap-3 rounded-panel border border-line-strong bg-surface px-4 py-3 text-left transition-colors hover:border-accent hover:bg-surface-2"
              data-testid="home-catalog"
            >
              <LibraryBig size={18} className="shrink-0 text-accent" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block text-ui font-semibold text-fg">
                  {t('home.catalog.all', { count: LABS.length })}
                </span>
                <span className="block text-dense text-fg-muted">{t('home.catalog.detail')}</span>
              </span>
              <ArrowRight size={16} className="shrink-0 text-fg-subtle" aria-hidden />
            </button>
          </div>
        </div>

        <footer className="mt-8 border-t border-line pt-4">
          <label className="inline-flex items-center gap-2 text-dense text-fg-muted">
            <input
              type="checkbox"
              checked={atStartup ?? true}
              disabled={atStartup === null}
              onChange={(e) => toggleAtStartup(e.target.checked)}
              data-testid="home-at-startup"
            />
            {t('home.atStartup')}
          </label>
        </footer>
      </div>
    </div>
  )
}

/** Proposition du tutoriel « premier ping », intégrée à l'accueil (mêmes commandes que la carte flottante). */
function TutorialOffer({ nextStep }: { nextStep: PathwayStep | null }) {
  const { t } = useT()
  const [atStartup, setAtStartup] = useState<boolean | null>(null)
  useEffect(() => {
    void window.serverlab.tutorialAtStartup().then(setAtStartup)
  }, [])
  return (
    <section
      className="rounded-card border border-line bg-surface p-5"
      aria-labelledby="home-next-title"
      data-testid="tutorial-card"
      data-phase="welcome"
    >
      <Eyebrow icon={GraduationCap}>{t('home.tuto.eyebrow')}</Eyebrow>
      <h2 id="home-next-title" className="mt-1.5 text-display font-semibold text-balance text-fg">
        {t('home.tuto.title')}
      </h2>
      <p className="mt-2 max-w-[62ch] text-body text-pretty text-fg-muted">{t('tuto.intro')}</p>
      <ol className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-dense text-fg-muted">
        {(['place', 'cable', 'address', 'ping'] as const).map((step, i) => (
          <li key={step} className="flex items-center gap-2">
            {i > 0 && <ArrowRight size={12} className="text-fg-subtle" aria-hidden />}
            {t(`home.tuto.step.${step}`)}
          </li>
        ))}
      </ol>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          className="h-9 px-4 text-ui"
          onClick={() => void startTutorial()}
          data-testid="tutorial-start"
        >
          <ArrowRight size={15} aria-hidden /> {t('home.tuto.start')}
        </Button>
        <Button
          variant="ghost"
          className="h-9"
          onClick={closeTutorial}
          title={t('home.tuto.skipHint')}
          data-testid="tutorial-skip"
        >
          {t('home.tuto.skip')}
        </Button>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-line pt-3">
        {nextStep && (
          <p className="text-dense text-fg-muted">
            {t('home.tuto.alreadyComfortable')}{' '}
            <button
              type="button"
              className="font-medium text-accent-text underline-offset-2 hover:underline"
              onClick={() => void openStep(nextStep)}
              data-testid="home-tuto-pathway"
            >
              {nextStep.title}
            </button>
          </p>
        )}
        <label className="inline-flex items-center gap-2 text-dense text-fg-muted">
          <input
            type="checkbox"
            checked={atStartup ?? true}
            disabled={atStartup === null}
            onChange={(e) => {
              setAtStartup(e.target.checked)
              setTutorialAtStartup(e.target.checked)
            }}
            data-testid="tutorial-at-startup"
          />
          {t('tuto.proposerLeTutorielAu')}
        </label>
      </div>
    </section>
  )
}

function Eyebrow({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <p className="flex items-center gap-1.5 text-meta font-semibold tracking-wider text-accent-text uppercase">
      <Icon size={13} aria-hidden /> {children}
    </p>
  )
}

/** Repères réels d'une étape : jalon, durée annoncée du lab, niveau d'aide. */
function StepMeta({ step }: { step: PathwayStep }) {
  const lab = labById(step.labId)
  return (
    <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-dense text-fg-muted">
      <span>{PHASE_LABELS[step.phase]}</span>
      {lab && <Duration value={lab.duration} />}
      <span>{HELP_LABELS[step.help]}</span>
    </p>
  )
}

function Duration({ value }: { value: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-meta text-fg-muted">
      <Clock size={12} aria-hidden />
      {value}
    </span>
  )
}

/** Ligne d'exercice d'une liste de l'accueil (bouton pleine largeur, séparée par un filet). */
function ExerciseRow({
  title,
  detail,
  meta,
  onClick,
  testId
}: {
  title: string
  detail?: string
  meta: ReactNode
  onClick: () => void
  testId: string
}) {
  return (
    <li className="border-b border-line last:border-b-0">
      <button
        type="button"
        onClick={onClick}
        className="group flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-surface-2"
        data-testid={testId}
      >
        <span className="min-w-0 flex-1">
          <span className="block text-ui font-semibold text-fg">{title}</span>
          {detail && <span className="mt-0.5 line-clamp-2 block text-dense text-fg-muted">{detail}</span>}
          <span className="mt-1 flex flex-wrap items-center gap-2">{meta}</span>
        </span>
        <ArrowRight
          size={15}
          className="shrink-0 text-fg-subtle transition-colors group-hover:text-accent"
          aria-hidden
        />
      </button>
    </li>
  )
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="mb-2 text-meta font-semibold tracking-wider text-fg-subtle uppercase">{children}</h2>
}

function Action({
  icon: Icon,
  label,
  detail,
  shortcut,
  onClick,
  testId,
  trailing
}: {
  icon: LucideIcon
  label: string
  detail: string
  shortcut?: ShortcutId
  onClick: () => void
  testId: string
  trailing?: ReactNode
}) {
  const { lang } = useT()
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 border-b border-line px-4 py-2.5 text-left transition-colors last:border-b-0 hover:bg-surface-2"
      data-testid={testId}
    >
      <Icon size={17} className="shrink-0 text-fg-muted" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block text-ui font-medium text-fg">{label}</span>
        <span className="block truncate text-dense text-fg-muted">{detail}</span>
      </span>
      {trailing}
      {shortcut && (
        <kbd className="w-14 shrink-0 text-right font-mono text-meta text-fg-subtle">
          {formatShortcut(accelerator(shortcut), lang)}
        </kbd>
      )}
    </button>
  )
}

/** Lab récent : nom, dossier, date ; un fichier disparu est signalé et ne peut pas être ouvert. */
function RecentRow({
  entry,
  onOpen,
  onRemove
}: {
  entry: RecentEntry
  onOpen: () => void
  onRemove: () => void
}) {
  const { lang, t } = useT()
  const { folder } = splitPath(entry.path)
  const missing = !entry.exists
  return (
    <li
      className="flex items-center gap-1 rounded-panel border border-line bg-surface pr-1"
      data-testid="home-recent"
      data-missing={missing ? 'true' : undefined}
    >
      <button
        type="button"
        onClick={onOpen}
        disabled={missing}
        title={missing ? `${entry.path}\n${t('home.recent.missingHint')}` : entry.path}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-l-md px-3 py-2 text-left transition-colors enabled:hover:bg-surface-2 disabled:cursor-default"
      >
        <FileText
          size={16}
          className={`shrink-0 ${missing ? 'text-fg-subtle' : 'text-accent'}`}
          aria-hidden
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className={`truncate text-ui font-medium ${missing ? 'text-fg-muted' : 'text-fg'}`}>
              {entry.name}
            </span>
            {missing && (
              <span className="shrink-0 rounded-sm bg-danger-soft px-1.5 py-0.5 text-meta font-semibold text-danger-text">
                {t('home.recent.missing')}
              </span>
            )}
          </span>
          <span className="block truncate font-mono text-meta text-fg-subtle">{folder}</span>
        </span>
        <span className="shrink-0 text-meta text-fg-subtle">
          {formatOpenedAt(entry.openedAt, new Date(), lang)}
        </span>
      </button>
      <button
        type="button"
        onClick={onRemove}
        className="shrink-0 rounded p-1.5 text-fg-subtle hover:bg-surface-2 hover:text-fg"
        aria-label={t('home.recent.removeLabel', { name: entry.name })}
        title={t('home.recent.remove')}
        data-testid="home-recent-remove"
      >
        <X size={14} />
      </button>
    </li>
  )
}
