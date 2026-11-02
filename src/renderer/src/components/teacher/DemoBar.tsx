/**
 * Barre de démonstration (bas de la fenêtre) : rejeu pas à pas d'un rendu, vitesse, projection.
 */
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Pause,
  Play,
  Projector,
  X
} from 'lucide-react'
import { useT } from '../../lib/i18n'
import { closeDemo, demoGoto, demoStep, setProjection, useDemoPlayback } from '../../lib/demo'
import { useDemoStore } from '../../store/demo'
import { Button } from '../common/ui'

const SPEEDS = [0.5, 1, 2, 4]

export function DemoBar() {
  const { t } = useT()
  const frames = useDemoStore((s) => s.frames)
  const index = useDemoStore((s) => s.index)
  const playing = useDemoStore((s) => s.playing)
  const speed = useDemoStore((s) => s.speed)
  const projection = useDemoStore((s) => s.projection)
  const title = useDemoStore((s) => s.title)
  useDemoPlayback()
  if (frames.length === 0) return null
  const frame = frames[index]!
  const last = frames.length - 1
  const set = useDemoStore.getState().set
  return (
    <div
      className="flex flex-wrap items-center gap-2 border-t border-line bg-panel px-3 py-2 text-dense"
      role="toolbar"
      aria-label={t('demo.label')}
      data-testid="demo-bar"
    >
      <span className="font-semibold text-fg">{title}</span>
      <Button variant="ghost" aria-label={t('demo.first')} onClick={() => demoGoto(0)} disabled={index === 0}>
        <ChevronsLeft size={16} aria-hidden />
      </Button>
      <Button
        variant="ghost"
        aria-label={t('demo.back')}
        onClick={() => demoStep(-1)}
        disabled={index === 0}
        data-testid="demo-back"
      >
        <ChevronLeft size={16} aria-hidden />
      </Button>
      <Button
        variant="primary"
        aria-label={playing ? t('demo.pause') : t('demo.play')}
        onClick={() => set({ playing: !playing })}
        data-testid="demo-play"
      >
        {playing ? <Pause size={16} aria-hidden /> : <Play size={16} aria-hidden />}
      </Button>
      <Button
        variant="ghost"
        aria-label={t('demo.forward')}
        onClick={() => demoStep(1)}
        disabled={index === last}
        data-testid="demo-forward"
      >
        <ChevronRight size={16} aria-hidden />
      </Button>
      <Button
        variant="ghost"
        aria-label={t('demo.last')}
        onClick={() => demoGoto(last)}
        disabled={index === last}
      >
        <ChevronsRight size={16} aria-hidden />
      </Button>
      <span className="font-mono text-fg-muted" data-testid="demo-position">
        {index} / {last}
      </span>
      <span className="min-w-0 flex-1 truncate text-fg" data-testid="demo-label">
        {frame.outcome === 'refused' && <span className="text-danger-text">✗ {t('demo.refused')} · </span>}
        {frame.label}
      </span>
      <label className="flex items-center gap-1 text-fg-muted">
        {t('demo.speed')}
        <select
          className="h-7 rounded-md border border-line-strong bg-surface px-1 text-fg"
          value={speed}
          onChange={(e) => set({ speed: Number(e.target.value) })}
        >
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              ×{String(s).replace('.', ',')}
            </option>
          ))}
        </select>
      </label>
      <Button
        variant={projection ? 'primary' : 'secondary'}
        aria-pressed={projection}
        onClick={() => setProjection(!projection)}
        data-testid="demo-projection"
      >
        <Projector size={14} aria-hidden />
        {t('demo.projection')}
      </Button>
      <Button variant="ghost" aria-label={t('demo.close')} onClick={closeDemo} data-testid="demo-close">
        <X size={16} aria-hidden />
      </Button>
    </div>
  )
}
