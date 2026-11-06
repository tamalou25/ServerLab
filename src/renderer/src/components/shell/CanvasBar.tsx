/**
 * Barre du plan (au-dessus du canvas) : titre et compteurs réels de la topologie, annuler / rétablir,
 * outils du canvas, zoom. Chaque bouton appelle la même action que le menu natif ou le raccourci
 * clavier correspondant (infobulle avec le raccourci du catalogue).
 */
import { useReactFlow, useViewport } from '@xyflow/react'
import { LayoutGrid, Maximize, Minus, Plus, Redo2, Undo2, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { historyLabels, networkZones } from '@engine/index'
import { accelerator, formatShortcut, type ShortcutId } from '@shared/shortcuts'
import type { MessageKey } from '@shared/i18n'
import { useWindowSize, COMPACT_HEIGHT, NARROW_WIDTH } from '../../hooks/useWindowSize'
import { redo, undo } from '../../lib/editing'
import { useT } from '../../lib/i18n'
import { useLabStore } from '../../store/lab'
import { useUiStore } from '../../store/ui'
import { TOOLS } from '../canvas/CanvasToolbar'
import { ZONES_MAX_DEVICES } from '../canvas/NetworkZones'
import { Tooltip } from '../common/Tooltip'

const ANIMATION = { duration: 150 }

const button =
  'flex h-7 w-7 items-center justify-center rounded-control text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:pointer-events-none disabled:opacity-40'

function Separator() {
  return <span className="mx-1 h-4 w-px bg-line" aria-hidden="true" />
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
        <Icon size={15} aria-hidden />
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

/** Outils du canvas (mêmes outils, raccourcis et identifiants qu'avant). */
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
            className={`flex h-7 w-7 items-center justify-center rounded-control transition-colors ${
              tool === id
                ? id === 'delete'
                  ? 'bg-danger text-on-danger'
                  : 'bg-accent text-on-accent'
                : 'text-fg-muted hover:bg-surface-2 hover:text-fg'
            }`}
          >
            <Icon size={15} aria-hidden />
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
        <Minus size={14} aria-hidden />
      </button>
      <button
        type="button"
        className="h-7 w-12 rounded-control font-mono text-meta text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
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
        <Plus size={14} aria-hidden />
      </button>
      <button
        type="button"
        className={button}
        onClick={() => void flow.fitView({ padding: 0.3, maxZoom: 1.2, duration: 200 })}
        title={t('zoom.fit')}
        aria-label={t('zoom.fit')}
        data-testid="zoom-fit"
      >
        <Maximize size={13} aria-hidden />
      </button>
    </>
  )
}

export function CanvasBar() {
  const history = useLabStore((s) => s.history)
  const devices = useLabStore((s) => Object.keys(s.lab.devices).length)
  const links = useLabStore((s) => Object.keys(s.lab.links).length)
  const subnets = useLabStore((s) => networkZones(s.lab).length)
  const showZones = useUiStore((s) => s.showZones)
  const toggleZones = useUiStore((s) => s.toggleZones)
  const tooMany = devices > ZONES_MAX_DEVICES
  const labels = historyLabels(history)
  const { width, height } = useWindowSize()
  const narrow = width < NARROW_WIDTH
  // Barre serrée (fenêtre < 1 400 px CSS) : titre et libellés masqués, compteurs seuls
  const tight = width < 1400
  const short = height < COMPACT_HEIGHT
  const { t, tp } = useT()
  return (
    <div
      className={`flex shrink-0 items-center gap-1 border-b border-line bg-panel px-3 ${short ? 'h-9' : 'h-10'}`}
      role="toolbar"
      aria-label={t('toolbar.main')}
      data-testid="main-toolbar"
    >
      <div className="flex min-w-0 items-baseline gap-2 pr-2 whitespace-nowrap">
        {!tight && <span className="text-dense font-semibold text-fg">{t('canvas.overview')}</span>}
        <span className="truncate text-meta text-fg-muted" data-testid="status-counts">
          {tp('status.devices', devices)} · {tp('status.links', links)}
          {subnets > 0 && !narrow && ` · ${t('canvas.subnets', { count: subnets })}`}
        </span>
      </div>
      <div className="flex-1" />
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
      <Separator />
      <Tooltip label={tooMany ? t('canvas.zonesTooMany', { max: ZONES_MAX_DEVICES }) : t('canvas.zonesHint')}>
        <button
          type="button"
          aria-label={t('canvas.zones')}
          aria-pressed={showZones && !tooMany}
          disabled={tooMany}
          onClick={toggleZones}
          data-testid="toggle-zones"
          className={`flex h-7 items-center gap-1 rounded-control px-1.5 text-meta font-medium whitespace-nowrap transition-colors disabled:opacity-40 ${
            showZones && !tooMany
              ? 'bg-accent-soft text-accent-text'
              : 'text-fg-muted hover:bg-surface-2 hover:text-fg'
          }`}
        >
          <LayoutGrid size={14} aria-hidden />
          {!tight && t('canvas.zones')}
        </button>
      </Tooltip>
    </div>
  )
}
