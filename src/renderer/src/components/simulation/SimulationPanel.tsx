/**
 * Panneau Simulation : contrôles pas à pas, filtres de protocoles, liste des événements, détail du PDU.
 */
import { Pause, Play, RotateCcw, StepForward } from 'lucide-react'
import { PROTOCOLS } from '@engine/index'
import { useLabStore } from '../../store/lab'
import { useSimStore, visibleSteps } from '../../store/sim'
import { useUiStore } from '../../store/ui'
import { OUTCOME_LABELS, PROTOCOL_COLORS } from '../../lib/protocols'
import { rich, useT } from '../../lib/i18n'
import { Button } from '../common/ui'
import { ScenarioTimeline } from './ScenarioTimeline'

export function SimulationPanel() {
  const mode = useUiStore((s) => s.mode)
  const devices = useLabStore((s) => s.lab.devices)
  const { queue, played, playing, filters, selectedKey, stepCursor } = useSimStore()
  const sim = useSimStore.getState
  const op = queue[0]
  const totalSteps = op ? visibleSteps(op.trace, filters).length : 0
  const selected = played.find((e) => e.key === selectedKey) ?? null
  const name = (id: string) => devices[id]?.name ?? '?'
  const { t } = useT()

  if (mode !== 'simulation') {
    return (
      <div className="p-6 text-center text-sm text-fg-muted">
        {rich(t('sim.switchMode'), { mode: <b>{t('sim.switchMode.mode')}</b> })}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="simulation-panel">
      <div className="border-b border-line px-4 py-3">
        <div className="mb-2 text-xs text-fg-muted">
          {op ? (
            <>
              <span className="font-semibold text-fg">{op.trace.title}</span> —{' '}
              {t('sim.step', { current: Math.min(stepCursor, totalSteps), total: totalSteps })}
              {queue.length > 1 && <span> {t('sim.queued', { count: queue.length - 1 })}</span>}
            </>
          ) : (
            t('sim.empty')
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            onClick={() => sim().step()}
            disabled={!op}
            data-testid="sim-step"
            title={t('sim.next.hint')}
          >
            <StepForward size={14} /> {t('sim.next')}
          </Button>
          <Button
            onClick={() => sim().setPlaying(!playing)}
            disabled={!op && !playing}
            title={t('sim.play.hint')}
          >
            {playing ? <Pause size={14} /> : <Play size={14} />} {playing ? t('sim.pause') : t('sim.play')}
          </Button>
          <Button variant="ghost" onClick={() => sim().reset()} title={t('sim.reset.hint')}>
            <RotateCcw size={14} /> {t('sim.reset')}
          </Button>
        </div>
      </div>

      <ScenarioTimeline />

      <div className="flex flex-wrap gap-1 border-b border-line px-4 py-2">
        {PROTOCOLS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => sim().toggleFilter(p)}
            className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
              filters[p]
                ? 'border-line-strong bg-surface text-fg'
                : 'border-transparent bg-surface-2 text-fg-subtle line-through'
            }`}
            title={filters[p] ? t('sim.filter.hide', { protocol: p }) : t('sim.filter.show', { protocol: p })}
          >
            <span className={`h-2 w-2 rounded-sm ${PROTOCOL_COLORS[p].chip}`} /> {p}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <table className="w-full text-[11px]" data-testid="sim-events">
          <thead className="sticky top-0 bg-surface-2 text-left text-fg-muted">
            <tr>
              <th className="px-2 py-1 font-medium">#</th>
              <th className="px-1 py-1 font-medium">{t('sim.col.from')}</th>
              <th className="px-1 py-1 font-medium">{t('sim.col.to')}</th>
              <th className="px-1 py-1 font-medium">{t('sim.col.type')}</th>
              <th className="px-1 py-1 font-medium">{t('sim.col.result')}</th>
            </tr>
          </thead>
          <tbody>
            {played.map((e) => (
              <tr
                key={e.key}
                onClick={() => sim().select(e.key)}
                tabIndex={0}
                aria-selected={e.key === selectedKey}
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault()
                    sim().select(e.key)
                  }
                }}
                className={`cursor-pointer border-t border-line ${e.key === selectedKey ? 'bg-accent-soft' : 'hover:bg-surface-2'}`}
              >
                <td className="px-2 py-1 text-fg-subtle">{e.index}</td>
                <td className="px-1 py-1">{name(e.fromDeviceId)}</td>
                <td className="px-1 py-1 font-medium">{name(e.toDeviceId)}</td>
                <td className="px-1 py-1">
                  <span className="flex items-center gap-1">
                    <span className={`h-2 w-2 rounded-sm ${PROTOCOL_COLORS[e.protocol].chip}`} />
                    {e.protocol}
                  </span>
                </td>
                <td className="px-1 py-1 text-fg-muted">{t(OUTCOME_LABELS[e.outcome])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selected && (
        <div
          className="max-h-[45%] overflow-y-auto border-t border-line bg-surface-2 px-4 py-3 text-xs"
          data-testid="pdu-details"
        >
          <div className="mb-1 font-semibold text-fg">{selected.summary}</div>
          <p className="mb-2 text-fg-muted">{selected.note}</p>
          {selected.layers.map((layer) => (
            <div key={layer.name} className="mb-2 rounded-md border border-line bg-surface">
              <div className="border-b border-line px-2 py-1 font-semibold text-fg-muted">
                {t('sim.layer', { layer: layer.layer, name: layer.name })}
              </div>
              <dl className="selectable grid grid-cols-[auto_1fr] gap-x-3 px-2 py-1 font-mono text-[11px]">
                {layer.fields.map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-fg-muted">{k}</dt>
                    <dd className="text-fg">{v}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
