/**
 * Contrôles de vue regroupés avec la minimap (coin inférieur droit) :
 * affichage de la minimap (le zoom est dans la barre d'outils principale).
 */
import { Panel } from '@xyflow/react'
import { Map as MapIcon } from 'lucide-react'
import { useUiStore } from '../../store/ui'
import { useT } from '../../lib/i18n'

export function ZoomControls() {
  const showMinimap = useUiStore((s) => s.showMinimap)
  const toggleMinimap = useUiStore((s) => s.toggleMinimap)
  const { t } = useT()
  const button =
    'flex h-7 w-7 items-center justify-center text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg'
  return (
    <Panel position="bottom-right" className="!m-3">
      <div
        className="flex h-7  items-stretch overflow-hidden rounded-md border border-line bg-panel/80 shadow-sm backdrop-blur-sm"
        role="toolbar"
        aria-label={t('zoom.label')}
      >
        <button
          type="button"
          className={`${button} ${showMinimap ? '!text-accent-text' : ''}`}
          onClick={toggleMinimap}
          aria-pressed={showMinimap}
          title={showMinimap ? t('zoom.hideMinimap') : t('zoom.showMinimap')}
          data-testid="minimap-toggle"
        >
          <MapIcon size={14} />
        </button>
      </div>
    </Panel>
  )
}
