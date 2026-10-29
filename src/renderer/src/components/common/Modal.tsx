/**
 * Boîte de dialogue modale applicative (alerte ou confirmation).
 */
import { useDialog } from '../../hooks/useDialog'
import { useT } from '../../lib/i18n'
import { useUiStore } from '../../store/ui'
import { Button } from './ui'

export function Modal() {
  const modal = useUiStore((s) => s.modal)
  const { t } = useT()
  const close = () => useUiStore.getState().showModal(null)

  const { ref, titleId } = useDialog(!!modal, () => {
    modal?.onCancel?.()
    close()
  })

  if (!modal) return null
  const isConfirm = !!modal.onConfirm
  return (
    <div
      ref={ref}
      tabIndex={-1}
      className="fixed inset-0 z-[400] flex items-center justify-center bg-scrim outline-none"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <div className="w-[440px] rounded-md border border-line bg-overlay p-5 shadow-lg" data-testid="modal">
        <h2 id={titleId} className="mb-2 text-title font-semibold text-fg">
          {modal.title}
        </h2>
        <p className="selectable mb-5 text-ui whitespace-pre-line text-fg-muted">{modal.message}</p>
        <div className="flex justify-end gap-2">
          {isConfirm && (
            <Button
              onClick={() => {
                modal.onCancel?.()
                close()
              }}
            >
              {modal.cancelLabel ?? t('common.cancel')}
            </Button>
          )}
          <Button
            variant="primary"
            data-testid="modal-confirm"
            onClick={() => {
              modal.onConfirm?.()
              close()
            }}
          >
            {modal.confirmLabel ?? t('common.ok')}
          </Button>
        </div>
      </div>
    </div>
  )
}
