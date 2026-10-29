/**
 * Barre d'outils du canvas : icônes seules, infobulles avec raccourci, outil actif mis en évidence.
 */
import { Cable, MousePointer2, Send, Trash2, type LucideIcon } from 'lucide-react'
import { formatShortcut } from '@shared/shortcuts'
import type { MessageKey } from '@shared/i18n'
import { useT } from '../../lib/i18n'
import { useUiStore, type Tool } from '../../store/ui'
import { Tooltip } from '../common/Tooltip'

/** Outils : libellé (clé de traduction), icône, touche (format des accélérateurs). */
export const TOOLS: { tool: Tool; label: MessageKey; icon: LucideIcon; shortcut: string }[] = [
  { tool: 'select', label: 'tool.select', icon: MousePointer2, shortcut: 'V' },
  { tool: 'cable', label: 'tool.cable', icon: Cable, shortcut: 'C' },
  { tool: 'pdu', label: 'toolbar.pdu', icon: Send, shortcut: 'P' },
  { tool: 'delete', label: 'tool.delete', icon: Trash2, shortcut: 'Delete' }
]

/** Consigne de l'outil actif, selon que le premier clic a eu lieu. */
const HINTS: Partial<Record<Tool, (started: boolean) => MessageKey>> = {
  cable: (started) => (started ? 'toolbar.hint.cable.second' : 'toolbar.hint.cable.first'),
  pdu: (started) => (started ? 'toolbar.hint.pdu.target' : 'toolbar.hint.pdu.source'),
  delete: () => 'toolbar.hint.delete'
}

export function CanvasToolbar() {
  const tool = useUiStore((s) => s.tool)
  const setTool = useUiStore((s) => s.setTool)
  const cableStart = useUiStore((s) => s.cableStart)
  const pduSource = useUiStore((s) => s.pduSource)
  const { lang, t } = useT()
  const hintKey = HINTS[tool]?.(tool === 'cable' ? !!cableStart : !!pduSource)
  return (
    <div className="absolute top-2.5 left-1/2 z-10 flex -translate-x-1/2 flex-col items-center gap-1.5">
      <div
        className="flex h-8 items-center gap-0.5 rounded-md border border-line bg-panel/90 p-0.5 shadow-sm backdrop-blur-sm"
        role="toolbar"
        aria-label={t('toolbar.label')}
      >
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
      </div>
      {hintKey && (
        <span
          className={`rounded-md border bg-panel/95 px-2 py-0.5 text-meta shadow-sm ${
            tool === 'delete' ? 'border-danger/40 text-danger-text' : 'border-accent/40 text-accent-text'
          }`}
          data-testid="tool-hint"
        >
          {t('toolbar.hint.cancel', { hint: t(hintKey) })}
        </span>
      )}
    </div>
  )
}
