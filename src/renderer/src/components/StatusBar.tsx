/**
 * Barre d'état (24 px, en bas) : contenu du lab, outil actif, zoom, état d'enregistrement,
 * thème (la bascule Temps réel / Simulation est dans la barre d'outils principale).
 */
import { useViewport } from '@xyflow/react'
import { Moon, Sun } from 'lucide-react'
import { dateLocale, rich, useT } from '../lib/i18n'
import { useLabStore } from '../store/lab'
import { useSimStore } from '../store/sim'
import { useUiStore, type Tool } from '../store/ui'

/** Libellé de l'outil actif (clés `tool.<outil>`). */
const TOOL_KEYS = {
  select: 'tool.select',
  cable: 'tool.cable',
  pdu: 'tool.pdu',
  delete: 'tool.delete'
} as const satisfies Record<Tool, string>

function SaveState() {
  const { lang, t } = useT()
  const dirty = useLabStore((s) => s.dirty)
  const filePath = useLabStore((s) => s.filePath)
  const lastAutosave = useUiStore((s) => s.lastAutosave)
  if (!dirty)
    return (
      <span className="flex items-center gap-1.5" data-testid="status-save">
        <span className="h-1.5 w-1.5 rounded-full bg-ok" />
        {filePath ? t('status.saved') : t('status.newDocument')}
      </span>
    )
  const time = lastAutosave
    ? new Date(lastAutosave).toLocaleTimeString(dateLocale(lang), { hour: '2-digit', minute: '2-digit' })
    : null
  return (
    <span className="flex items-center gap-1.5" title={t('status.autosaveHint')} data-testid="status-save">
      <span className="h-1.5 w-1.5 rounded-full bg-warn" />
      {time ? t('status.modifiedAt', { time }) : t('status.modified')}
    </span>
  )
}

export function StatusBar() {
  const devices = useLabStore((s) => Object.keys(s.lab.devices).length)
  const links = useLabStore((s) => Object.keys(s.lab.links).length)
  const tool = useUiStore((s) => s.tool)
  const mode = useUiStore((s) => s.mode)
  const theme = useUiStore((s) => s.theme)
  const pending = useSimStore((s) => s.queue.length)
  const { zoom } = useViewport()
  const { t, tp } = useT()

  return (
    <footer
      className="flex h-6 shrink-0 items-center gap-4 border-t border-line bg-panel pl-3 text-meta text-fg-muted"
      data-testid="status-bar"
    >
      <span data-testid="status-counts">
        {tp('status.devices', devices)} · {tp('status.links', links)}
      </span>
      <span>
        {rich(t('status.tool'), {
          tool: <span className="text-fg">{t(TOOL_KEYS[tool])}</span>
        })}
      </span>
      {mode === 'simulation' && (
        <span className="text-accent-text">
          {pending > 0 ? tp('status.pending', pending) : t('status.noPending')}
        </span>
      )}
      <span className="ml-auto font-mono" title={t('status.zoom')} data-testid="status-zoom">
        {Math.round(zoom * 100)} %
      </span>
      <SaveState />
      <button
        type="button"
        onClick={() => window.serverlab?.setTheme(theme === 'dark' ? 'light' : 'dark')}
        className="flex h-full items-center px-1 hover:text-fg"
        title={theme === 'dark' ? t('status.themeLight') : t('status.themeDark')}
        data-testid="status-theme"
      >
        {theme === 'dark' ? <Sun size={12} /> : <Moon size={12} />}
      </button>
    </footer>
  )
}
