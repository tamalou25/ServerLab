/**
 * Écran d'accueil : affiché au lancement sans fichier (selon la préférence enregistrée) et par
 * Fichier > Accueil. Nouveau lab, Ouvrir…, labs récents (un fichier disparu est signalé et peut
 * être retiré de la liste) et labs fournis. Se ferme dès qu'un document est chargé.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Clock, FilePlus2, FileText, FolderOpen, Network, X, type LucideIcon } from 'lucide-react'
import type { RecentEntry } from '@shared/ipc'
import { formatOpenedAt, splitPath } from '@shared/recent'
import { accelerator, formatShortcut, type ShortcutId } from '@shared/shortcuts'
import { newDocument, openDocument, openRecentDocument } from '../../lib/document'
import { useT } from '../../lib/i18n'
import { LABS } from '../../lib/labCatalog'
import { openLab } from '../../lib/labs'
import { useLabStore } from '../../store/lab'
import { useLabsStore } from '../../store/labs'
import { useUiStore } from '../../store/ui'
import { DifficultyBadge } from '../labs/DifficultyBadge'

function closeHome(): void {
  useUiStore.getState().setHome(false)
}

export function HomeScreen() {
  const open = useUiStore((s) => s.home)
  return open ? <HomePage /> : null
}

function HomePage() {
  const version = useUiStore((s) => s.appVersion)
  const { t } = useT()
  const revision = useLabStore((s) => s.revision)
  // Révision du document à l'ouverture de l'accueil : toute nouvelle révision = document chargé
  const revisionAtOpen = useRef(revision)
  const [recent, setRecent] = useState<RecentEntry[] | null>(null)
  const [atStartup, setAtStartup] = useState<boolean | null>(null)

  const refresh = useCallback(() => {
    void window.serverlab.listRecent().then(setRecent)
  }, [])

  useEffect(() => {
    refresh()
    void window.serverlab.homeAtStartup().then(setAtStartup)
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

  return (
    <div
      className="fixed inset-0 z-[250] overflow-y-auto bg-app"
      role="region"
      aria-label={t('home.label')}
      data-testid="home-screen"
    >
      <div className="mx-auto flex min-h-full max-w-[1040px] flex-col px-4 py-8 sm:px-8">
        <header className="mb-8 flex items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
            <Network size={22} />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-fg">ServerLab</h1>
            <p className="text-dense text-fg-muted">{t('home.subtitle', { version })}</p>
          </div>
          <button
            type="button"
            onClick={closeHome}
            className="ml-auto rounded p-1.5 text-fg-subtle hover:bg-surface-2 hover:text-fg"
            aria-label={t('home.close')}
            title={t('home.closeHint')}
            data-testid="home-close"
          >
            <X size={18} />
          </button>
        </header>

        <div className="grid flex-1 content-start gap-8 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <div className="flex min-w-0 flex-col gap-8">
            <section>
              <SectionTitle>{t('home.start')}</SectionTitle>
              <div className="flex flex-col gap-2">
                <Action
                  icon={FilePlus2}
                  label={t('home.new')}
                  detail={t('home.new.detail')}
                  shortcut="newFile"
                  onClick={() => void newDocument()}
                  testId="home-new"
                />
                <Action
                  icon={FolderOpen}
                  label={t('home.open')}
                  detail={t('home.open.detail')}
                  shortcut="open"
                  onClick={() => void openDocument()}
                  testId="home-open"
                />
              </div>
            </section>

            <section>
              <SectionTitle>{t('home.recent')}</SectionTitle>
              {recent && recent.length === 0 && (
                <p className="text-dense text-fg-muted" data-testid="home-recent-empty">
                  {t('home.recent.empty')}
                </p>
              )}
              <ul className="flex flex-col gap-2">
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

          <section className="min-w-0">
            <SectionTitle>{t('home.labs')}</SectionTitle>
            <ul className="flex flex-col gap-2">
              {LABS.map((lab) => (
                <li key={lab.id}>
                  <button
                    type="button"
                    onClick={() => void openLab(lab)}
                    className="w-full rounded-md border border-line bg-surface p-3 text-left transition-colors hover:border-accent hover:bg-surface-2"
                    data-testid={`home-lab-${lab.id}`}
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-ui font-semibold text-fg">{lab.title}</span>
                      <DifficultyBadge difficulty={lab.difficulty} />
                      <span className="inline-flex items-center gap-1 text-meta text-fg-subtle">
                        <Clock size={12} aria-hidden />
                        {lab.duration}
                      </span>
                    </span>
                    <span className="mt-1 line-clamp-2 block text-dense text-fg-muted">{lab.summary}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
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

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h2 className="mb-2 text-meta font-semibold tracking-wider text-fg-subtle uppercase">{children}</h2>
  )
}

function Action({
  icon: Icon,
  label,
  detail,
  shortcut,
  onClick,
  testId
}: {
  icon: LucideIcon
  label: string
  detail: string
  shortcut: ShortcutId
  onClick: () => void
  testId: string
}) {
  const { lang } = useT()
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-3 rounded-md border border-line bg-surface px-3 py-2.5 text-left transition-colors hover:border-accent hover:bg-surface-2"
      data-testid={testId}
    >
      <Icon size={18} className="shrink-0 text-accent" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block text-ui font-medium text-fg">{label}</span>
        <span className="block text-meta text-fg-muted">{detail}</span>
      </span>
      <kbd className="font-mono text-meta text-fg-subtle">
        {formatShortcut(accelerator(shortcut), lang)}
      </kbd>
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
      className="flex items-center gap-1 rounded-md border border-line bg-surface pr-1"
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
