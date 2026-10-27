/**
 * Résultats des PDU simples (coin supérieur gauche du canvas).
 */
import { CircleCheck, CircleX, X } from 'lucide-react'
import { useT } from '../../lib/i18n'
import { useUiStore } from '../../store/ui'

export function PduList() {
  const results = useUiStore((s) => s.pduResults)
  const clear = useUiStore((s) => s.clearPduResults)
  const { t } = useT()
  if (results.length === 0) return null
  return (
    <div
      className="absolute top-14 left-3 z-10 w-72 rounded-md border border-line bg-panel/95 text-xs shadow-sm"
      data-testid="pdu-list"
    >
      <div className="flex items-center justify-between border-b border-line px-3 py-1.5 font-semibold text-fg-muted">
        {t('pdu.title')}
        <button
          type="button"
          onClick={clear}
          className="rounded p-0.5 hover:bg-surface-2"
          title={t('pdu.clear')}
        >
          <X size={12} />
        </button>
      </div>
      <ul className="max-h-48 overflow-y-auto">
        {results.map((r) => (
          <li key={r.id} className="flex items-center gap-2 px-3 py-1">
            {r.success ? (
              <CircleCheck size={13} className="text-ok-text" />
            ) : (
              <CircleX size={13} className="text-danger-text" />
            )}
            <span className={r.success ? 'text-ok-text' : 'text-danger-text'}>
              {r.success ? t('pdu.success') : t('pdu.failure')}
            </span>
            <span className="truncate text-fg-muted">
              {r.source} → {r.target}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
