/**
 * Barre d'outils principale (32 px, sous le menu natif) : fichier, annuler / rétablir, outils du
 * canvas, zoom et bascule Temps réel / Simulation. Chaque bouton appelle la même action que le menu
 * natif ou le raccourci clavier correspondant (infobulle avec le raccourci du catalogue).
 */
import { useReactFlow, useViewport } from '@xyflow/react'
import {
  Clock,
  FilePlus2,
  FolderOpen,
  Footprints,
  Maximize,
  Minus,
  Plus,
  Redo2,
  Save,
  Undo2,
  type LucideIcon
} from 'lucide-react'
import type { ReactNode } from 'react'
import { historyLabels } from '@engine/index'
import { accelerator, formatShortcut, type ShortcutId } from '@shared/shortcuts'
import type { MessageKey } from '@shared/i18n'
import { newDocument, openDocument, saveDocument } from '../lib/document'
import { redo, undo } from '../lib/editing'
import { useT } from '../lib/i18n'
import { useLabStore } from '../store/lab'
import { useUiStore } from '../store/ui'
import { TOOLS } from './canvas/CanvasToolbar'
import { Tooltip } from './common/Tooltip'

const ANIMATION = { duration: 150 }

const button =
  'flex h-7 w-7 items-center justify-center rounded text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:pointer-events-none disabled:opacity-40'

function Separator() {
  return <span className="mx-1.5 h-4 w-px bg-line" aria-hidden="true" />
}

interface ActionProps {
  label: MessageKey
  icon: LucideIcon
  shortcut?: ShortcutId
  onClick: () => void
  disabled?: boolean
  testId: string
}

/** Bouton d'action à icône seule : nom accessible et infobulle (avec raccourci). */
function Action({ label, icon: Icon, shortcut, onClick, disabled, testId }: ActionProps) {
  const { lang, t } = useT()
  return (
    <Tooltip label={t(label)} shortcut={shortcut ? formatShortcut(accelerator(shortcut), lang) : undefined}>
      <button
        type="button"
        aria-label={t(label)}
        onClick={onClick}
        disabled={disabled}
        className={button}
        data-testid={testId}
      >
        <Icon size={15} />
      </button>
    </Tooltip>
  )
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-0.5" role="group" aria-label={label}>
      {children}
    </div>
  )
}

/** Outils du canvas (mêmes outils, raccourcis et identifiants que la barre flottante d'avant). */
function ToolButtons() {
  const tool = useUiStore((s) => s.tool)
  const setTool = useUiStore((s) => s.setTool)
  const { lang, t } = useT()
  return (
    <>
      {TOOLS.map(({ tool: id, label, icon: Icon, shortcut }) => (
        <Tooltip key={id} label={t(label)} shortcut={formatShortcut(shortcut, lang)}>
          <button
            type="button"
            aria-label={t(label)}
            aria-pressed={tool === id}
            data-testid={`tool-${id}`}
            onClick={() => setTool(id)}
            className={`flex h-7 w-7 items-center justify-center rounded transition-colors ${
              tool === id
                ? id === 'delete'
                  ? 'bg-danger text-on-danger'
                  : 'bg-accent text-on-accent'
                : 'text-fg-muted hover:bg-surface-2 hover:text-fg'
            }`}
          >
            <Icon size={15} />
          </button>
        </Tooltip>
      ))}
    </>
  )
}

function ZoomButtons() {
  const flow = useReactFlow()
  const { zoom } = useViewport()
  const { t } = useT()
  return (
    <>
      <button
        type="button"
        className={button}
        onClick={() => void flow.zoomOut(ANIMATION)}
        title={t('zoom.out')}
        aria-label={t('zoom.out')}
        data-testid="zoom-out"
      >
        <Minus size={14} />
      </button>
      <button
        type="button"
        className="h-7 w-12 rounded font-mono text-meta text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
        onClick={() => void flow.zoomTo(1, ANIMATION)}
        title={t('zoom.reset')}
        data-testid="zoom-level"
      >
        {Math.round(zoom * 100)} %
      </button>
      <button
        type="button"
        className={button}
        onClick={() => void flow.zoomIn(ANIMATION)}
        title={t('zoom.in')}
        aria-label={t('zoom.in')}
        data-testid="zoom-in"
      >
        <Plus size={14} />
      </button>
      <button
        type="button"
        className={button}
        onClick={() => void flow.fitView({ padding: 0.3, maxZoom: 1.2, duration: 200 })}
        title={t('zoom.fit')}
        aria-label={t('zoom.fit')}
        data-testid="zoom-fit"
      >
        <Maximize size={13} />
      </button>
    </>
  )
}

/** Bascule Temps réel / Simulation (déplacée depuis la barre d'état, mêmes identifiants). */
function ModeSwitch() {
  const mode = useUiStore((s) => s.mode)
  const setMode = useUiStore((s) => s.setMode)
  const { t } = useT()
  const segment = 'flex items-center gap-1.5 px-2.5 text-dense transition-colors'
  return (
    <div
      className="ml-auto flex h-6 items-stretch overflow-hidden rounded border border-line"
      role="radiogroup"
      aria-label={t('status.mode')}
    >
      <button
        type="button"
        role="radio"
        aria-checked={mode === 'realtime'}
        data-testid="mode-realtime"
        title={t('status.realtimeHint')}
        onClick={() => setMode('realtime')}
        className={`${segment} ${mode === 'realtime' ? 'bg-ok-soft font-semibold text-ok-text' : 'text-fg-muted hover:bg-surface-2 hover:text-fg'}`}
      >
        <Clock size={12} /> {t('status.realtime')}
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={mode === 'simulation'}
        data-testid="mode-simulation"
        title={t('status.simulationHint')}
        onClick={() => setMode('simulation')}
        className={`${segment} border-l border-line ${mode === 'simulation' ? 'bg-accent-soft font-semibold text-accent-text' : 'text-fg-muted hover:bg-surface-2 hover:text-fg'}`}
      >
        <Footprints size={12} /> {t('status.simulation')}
      </button>
    </div>
  )
}

export function MainToolbar() {
  const history = useLabStore((s) => s.history)
  const labels = historyLabels(history)
  const { t } = useT()
  return (
    <div
      className="flex h-8 shrink-0 items-center gap-1 border-b border-line bg-panel px-2"
      role="toolbar"
      aria-label={t('toolbar.main')}
      data-testid="main-toolbar"
    >
      <Group label={t('menu.file').replace('&', '')}>
        <Action
          label="menu.file.new"
          icon={FilePlus2}
          shortcut="newFile"
          onClick={() => void newDocument()}
          testId="toolbar-new"
        />
        <Action
          label="menu.file.open"
          icon={FolderOpen}
          shortcut="open"
          onClick={() => void openDocument()}
          testId="toolbar-open"
        />
        <Action
          label="menu.file.save"
          icon={Save}
          shortcut="save"
          onClick={() => void saveDocument()}
          testId="toolbar-save"
        />
      </Group>
      <Separator />
      <Group label={t('menu.edit').replace('&', '')}>
        <Action
          label="menu.edit.undo"
          icon={Undo2}
          shortcut="undo"
          onClick={() => undo('lab')}
          disabled={labels.undo === null}
          testId="toolbar-undo"
        />
        <Action
          label="menu.edit.redo"
          icon={Redo2}
          shortcut="redo"
          onClick={() => redo('lab')}
          disabled={labels.redo === null}
          testId="toolbar-redo"
        />
      </Group>
      <Separator />
      <Group label={t('toolbar.label')}>
        <ToolButtons />
      </Group>
      <Separator />
      <Group label={t('zoom.label')}>
        <ZoomButtons />
      </Group>
      <ModeSwitch />
    </div>
  )
}
