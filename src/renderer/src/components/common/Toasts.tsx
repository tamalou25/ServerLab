/**
 * Notifications temporaires (coin inférieur droit).
 */
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react'
import { useT } from '../../lib/i18n'
import { useUiStore } from '../../store/ui'

export function Toasts() {
  const toasts = useUiStore((s) => s.toasts)
  const dismiss = useUiStore((s) => s.dismissToast)
  const { t: tr } = useT()
  return (
    <div
      className="pointer-events-none fixed right-4 bottom-10 z-[300] flex w-96 flex-col gap-2"
      aria-live="polite"
    >
      {toasts.map((t) => {
        const Icon =
          t.kind === 'error'
            ? CircleAlert
            : t.kind === 'success'
              ? CircleCheck
              : t.kind === 'warning'
                ? TriangleAlert
                : Info
        const accent = {
          error: 'text-danger-text',
          success: 'text-ok-text',
          warning: 'text-warn-text',
          info: 'text-info-text'
        }[t.kind]
        return (
          <div
            key={t.id}
            role={t.kind === 'error' ? 'alert' : 'status'}
            data-testid={`toast-${t.kind}`}
            className="pointer-events-auto flex items-start gap-2 rounded-md border border-line bg-overlay px-3 py-2 text-fg shadow-md"
          >
            <Icon size={16} className={`mt-0.5 shrink-0 ${accent}`} />
            <p className="flex-1 text-ui">{t.message}</p>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              className="text-fg-subtle hover:text-fg"
              title={tr('common.close')}
            >
              <X size={14} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
