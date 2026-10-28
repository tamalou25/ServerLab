/**
 * Outils du canvas (affichés dans la barre d'outils principale) et consigne de l'outil actif,
 * superposée en haut du canvas.
 */
import { Cable, MousePointer2, Send, Trash2, type LucideIcon } from 'lucide-react'
import type { MessageKey } from '@shared/i18n'
import { useT } from '../../lib/i18n'
import { useUiStore, type Tool } from '../../store/ui'

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
  const cableStart = useUiStore((s) => s.cableStart)
  const pduSource = useUiStore((s) => s.pduSource)
  const { t } = useT()
  const hintKey = HINTS[tool]?.(tool === 'cable' ? !!cableStart : !!pduSource)
  if (!hintKey) return null
  return (
    <div className="pointer-events-none absolute top-2.5 left-1/2 z-10 -translate-x-1/2">
      <span
        className={`rounded-md border bg-panel/95 px-2 py-0.5 text-meta shadow-sm ${
          tool === 'delete' ? 'border-danger/40 text-danger-text' : 'border-accent/40 text-accent-text'
        }`}
        data-testid="tool-hint"
        role="status"
      >
        {t('toolbar.hint.cancel', { hint: t(hintKey) })}
      </span>
    </div>
  )
}
