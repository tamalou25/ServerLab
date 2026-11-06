/**
 * Barre d'état (24 px, en bas) : outil actif, paquets en attente, zoom, thème. Les compteurs de la
 * topologie sont dans la barre du plan, l'état d'enregistrement et la bascule de mode dans l'en-tête.
 */
import { useViewport } from '@xyflow/react'
import { Moon, Sun } from 'lucide-react'
import { rich, useT } from '../lib/i18n'
import { useSimStore } from '../store/sim'
import { useUiStore, type Tool } from '../store/ui'

/** Libellé de l'outil actif (clés `tool.<outil>`). */
const TOOL_KEYS = {
  select: 'tool.select',
  cable: 'tool.cable',
  pdu: 'tool.pdu',
  delete: 'tool.delete'
} as const satisfies Record<Tool, string>

export function StatusBar() {
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
