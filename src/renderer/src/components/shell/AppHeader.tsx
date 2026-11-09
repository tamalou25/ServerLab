/**
 * En-tête de l'application : marque et badge de l'espace, nom du document et état d'enregistrement,
 * bascule Temps réel / Simulation, Nouveau / Ouvrir / Enregistrer. Chaque bouton appelle la même action
 * que le menu natif et le raccourci correspondant (infobulle avec le raccourci du catalogue).
 */
import { Clock, FilePlus2, FolderOpen, Footprints, Layers, Save } from 'lucide-react'
import { accelerator, formatShortcut } from '@shared/shortcuts'
import { useWindowSize, COMPACT_HEIGHT, NARROW_WIDTH } from '../../hooks/useWindowSize'
import { newDocument, openDocument, saveDocument } from '../../lib/document'
import { dateLocale, useT } from '../../lib/i18n'
import { useWorkspace } from '../../lib/workspace'
import { useAttemptStore } from '../../store/attempt'
import { useLabStore } from '../../store/lab'
import { useUiStore } from '../../store/ui'
import { Badge } from '../common/Badge'
import { Segmented } from '../common/Segmented'
import { Tooltip } from '../common/Tooltip'
import { Button } from '../common/ui'

/** État d'enregistrement : point vert (à jour) ou ambre (modifié, avec l'heure de la copie automatique). */
function SaveState() {
  const { lang, t } = useT()
  const dirty = useLabStore((s) => s.dirty)
  const filePath = useLabStore((s) => s.filePath)
  const lastAutosave = useUiStore((s) => s.lastAutosave)
  if (!dirty)
    return (
      <span className="flex items-center gap-1.5 text-meta text-fg-muted" data-testid="status-save">
        <span className="h-1.5 w-1.5 rounded-full bg-ok" aria-hidden />
        {filePath ? t('status.saved') : t('status.newDocument')}
      </span>
    )
  const time = lastAutosave
    ? new Date(lastAutosave).toLocaleTimeString(dateLocale(lang), { hour: '2-digit', minute: '2-digit' })
    : null
  return (
    <span
      className="flex items-center gap-1.5 text-meta text-fg-muted"
      title={t('status.autosaveHint')}
      data-testid="status-save"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-warn" aria-hidden />
      {time ? t('status.modifiedAt', { time }) : t('status.modified')}
    </span>
  )
}

/** Bascule Temps réel / Simulation (mêmes identifiants que l'ancienne barre d'outils). */
function ModeSwitch({ compact }: { compact: boolean }) {
  const mode = useUiStore((s) => s.mode)
  const setMode = useUiStore((s) => s.setMode)
  // Passation : Temps réel imposé (le rejeu ne retrouverait pas l'état)
  const locked = useAttemptStore((s) => s.attempt !== null)
  const { t } = useT()
  return (
    <Segmented
      label={t('status.mode')}
      value={mode}
      onChange={setMode}
      size={compact ? 'sm' : 'md'}
      items={[
        {
          id: 'realtime',
          label: t('status.realtime'),
          icon: <Clock size={13} aria-hidden />,
          title: t('status.realtimeHint'),
          tone: 'ok',
          testId: 'mode-realtime'
        },
        {
          id: 'simulation',
          label: t('status.simulation'),
          icon: <Footprints size={13} aria-hidden />,
          title: t('status.simulationHint'),
          testId: 'mode-simulation',
          disabled: locked
        }
      ]}
    />
  )
}

export function AppHeader() {
  const { lang, t } = useT()
  const { workspace } = useWorkspace()
  const fileName = useLabStore((s) => s.fileName)
  const filePath = useLabStore((s) => s.filePath)
  const { width, height } = useWindowSize()
  const narrow = width < NARROW_WIDTH
  const short = height < COMPACT_HEIGHT
  const shortcut = (id: 'newFile' | 'open' | 'save') => formatShortcut(accelerator(id), lang)
  return (
    <header
      className={`flex shrink-0 items-center gap-3 border-b border-line bg-panel px-3 ${short ? 'h-10' : 'h-11'}`}
      data-testid="app-header"
    >
      <div className="flex items-center gap-2">
        <span
          className="flex h-7 w-7 items-center justify-center rounded-control bg-accent text-on-accent"
          aria-hidden
        >
          <Layers size={16} />
        </span>
        <span className="text-title font-semibold tracking-tight text-fg">ServerLab</span>
        <Badge tone="accent" testId="header-workspace">
          {t(`workspace.${workspace}`)}
        </Badge>
      </div>
      <div className="flex min-w-0 flex-col border-l border-line pl-3 leading-tight">
        <span className="truncate text-dense font-semibold text-fg" title={filePath ?? undefined}>
          {fileName || t('header.untitled')}
        </span>
        <SaveState />
      </div>
      <div className="flex-1" />
      <ModeSwitch compact={short} />
      <div
        className="flex items-center gap-1 border-l border-line pl-3"
        role="group"
        aria-label={t('menu.file').replace('&', '')}
      >
        <Tooltip label={t('menu.file.new')} shortcut={shortcut('newFile')}>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={t('menu.file.new')}
            onClick={() => void newDocument()}
            data-testid="toolbar-new"
          >
            <FilePlus2 size={15} aria-hidden />
          </Button>
        </Tooltip>
        <Tooltip label={t('menu.file.open')} shortcut={shortcut('open')}>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={t('menu.file.open')}
            onClick={() => void openDocument()}
            data-testid="toolbar-open"
          >
            <FolderOpen size={15} aria-hidden />
          </Button>
        </Tooltip>
        <Tooltip label={t('menu.file.save')} shortcut={shortcut('save')}>
          <Button
            variant="secondary"
            size="sm"
            iconOnly={narrow}
            aria-label={t('menu.file.save')}
            onClick={() => void saveDocument()}
            data-testid="toolbar-save"
          >
            <Save size={15} aria-hidden />
            {!narrow && t('menu.file.save')}
          </Button>
        </Tooltip>
      </div>
    </header>
  )
}
