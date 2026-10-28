/**
 * Panneau Simulation (en bas de la fenêtre, mode Simulation, rétractable) : réinitialiser, lecture /
 * pause, pas à pas, vitesse, filtres de protocoles ; table des événements (pas, source, destination,
 * protocole, couche, info) et, à droite, détail du PDU sélectionné et scénarios pas à pas.
 * Branché sur le store de simulation existant (mêmes commandes que sim:* du menu natif).
 */
import { ChevronDown, ChevronUp, Pause, Play, RotateCcw, StepForward } from 'lucide-react'
import { useState } from 'react'
import { PROTOCOLS } from '@engine/index'
import { formatShortcut } from '@shared/shortcuts'
import { useLabStore } from '../../store/lab'
import { SIM_SPEEDS, useSimStore, visibleSteps, type PlayedEvent, type SimSpeed } from '../../store/sim'
import { useUiStore } from '../../store/ui'
import { OUTCOME_LABELS, PROTOCOL_COLORS } from '../../lib/protocols'
import { readPref, writePref } from '../../lib/prefs'
import { useT } from '../../lib/i18n'
import { Tooltip } from '../common/Tooltip'
import { ScenarioTimeline } from './ScenarioTimeline'

/** Couche la plus haute portée par le PDU (L7 pour un DNS, L3 pour un ping, L2 pour un ARP…). */
const topLayer = (e: PlayedEvent): number => Math.max(0, ...e.layers.map((l) => l.layer))

const OUTCOME_TONE = {
  delivered: 'text-ok-text',
  forwarded: 'text-fg-muted',
  ignored: 'text-fg-subtle',
  dropped: 'text-danger-text'
} as const

/** Symbole de l'issue (second indice, en plus de la couleur et du texte). */
const OUTCOME_MARK = { delivered: '✓', forwarded: '→', ignored: '–', dropped: '✕' } as const

const iconButton =
  'flex h-7 w-7 items-center justify-center rounded text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:pointer-events-none disabled:opacity-40'

export function SimulationPanel() {
  const mode = useUiStore((s) => s.mode)
  const devices = useLabStore((s) => s.lab.devices)
  const { queue, played, playing, filters, selectedKey, stepCursor, speed } = useSimStore()
  const [collapsed, setCollapsed] = useState(() => readPref('simulationCollapsed', false))
  const sim = useSimStore.getState
  const { lang, t } = useT()
  if (mode !== 'simulation') return null

  const op = queue[0]
  const totalSteps = op ? visibleSteps(op.trace, filters).length : 0
  const selected = played.find((e) => e.key === selectedKey) ?? null
  const name = (id: string) => devices[id]?.name ?? '?'
  const toggle = () => {
    setCollapsed(!collapsed)
    writePref('simulationCollapsed', !collapsed)
  }

  return (
    <section
      className={`flex shrink-0 flex-col border-t border-line bg-panel ${collapsed ? '' : 'h-60'}`}
      aria-label={t('sim.title')}
      data-testid="simulation-panel"
    >
      <div
        className="flex h-8 shrink-0 items-center gap-1 border-b border-line px-2 text-dense"
        role="toolbar"
        aria-label={t('sim.title')}
      >
        <h2 className="mr-2 text-title font-semibold text-fg">{t('sim.title')}</h2>
        <Tooltip label={t('sim.reset.hint')}>
          <button
            type="button"
            className={iconButton}
            onClick={() => sim().reset()}
            aria-label={t('sim.reset')}
          >
            <RotateCcw size={14} />
          </button>
        </Tooltip>
        <Tooltip label={t('sim.play.hint')}>
          <button
            type="button"
            className={`${iconButton} ${playing ? '!bg-accent !text-on-accent' : ''}`}
            onClick={() => sim().setPlaying(!playing)}
            disabled={!op && !playing}
            aria-label={playing ? t('sim.pause') : t('sim.play')}
            aria-pressed={playing}
            data-testid="sim-play"
          >
            {playing ? <Pause size={14} /> : <Play size={14} />}
          </button>
        </Tooltip>
        <Tooltip label={t('sim.next.hint')} shortcut={formatShortcut('F6', lang)}>
          <button
            type="button"
            className={iconButton}
            onClick={() => sim().step()}
            disabled={!op}
            aria-label={t('sim.next')}
            data-testid="sim-step"
          >
            <StepForward size={14} />
          </button>
        </Tooltip>
        <label className="ml-2 flex shrink-0 items-center gap-1.5 whitespace-nowrap text-fg-muted">
          {t('sim.speed')}
          <select
            value={speed}
            onChange={(e) => sim().setSpeed(Number(e.target.value) as SimSpeed)}
            className="h-6 rounded border border-line bg-surface px-1 font-mono text-meta text-fg"
            data-testid="sim-speed"
          >
            {SIM_SPEEDS.map((s) => (
              <option key={s} value={s}>
                {`${s}×`}
              </option>
            ))}
          </select>
        </label>
        <span className="ml-3 truncate text-fg-muted" data-testid="sim-status">
          {op ? (
            <>
              <span className="font-semibold text-fg">{op.trace.title}</span> —{' '}
              {t('sim.step', { current: Math.min(stepCursor, totalSteps), total: totalSteps })}
              {queue.length > 1 && <span> {t('sim.queued', { count: queue.length - 1 })}</span>}
            </>
          ) : (
            t('sim.empty')
          )}
        </span>
        <div
          className="ml-auto flex shrink-0 flex-wrap justify-end gap-1"
          role="group"
          aria-label={t('sim.filters')}
        >
          {PROTOCOLS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => sim().toggleFilter(p)}
              aria-pressed={filters[p]}
              className={`flex items-center gap-1 rounded-full border px-1.5 text-meta font-medium ${
                filters[p]
                  ? 'border-line-strong bg-surface text-fg'
                  : 'border-dashed border-line text-fg-subtle line-through'
              }`}
              title={
                filters[p] ? t('sim.filter.hide', { protocol: p }) : t('sim.filter.show', { protocol: p })
              }
            >
              <span className={`h-2 w-2 rounded-sm ${PROTOCOL_COLORS[p].chip}`} aria-hidden="true" /> {p}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={iconButton}
          onClick={toggle}
          aria-expanded={!collapsed}
          aria-label={collapsed ? t('sim.expand') : t('sim.collapse')}
          title={collapsed ? t('sim.expand') : t('sim.collapse')}
          data-testid="sim-collapse"
        >
          {collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>

      {!collapsed && (
        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1 overflow-y-auto">
            <table className="w-full text-dense" data-testid="sim-events">
              <thead className="sticky top-0 bg-surface-2 text-left text-meta text-fg-muted">
                <tr>
                  <th className="px-2 py-1 font-medium">#</th>
                  <th className="px-1 py-1 font-medium">{t('sim.col.step')}</th>
                  <th className="px-1 py-1 font-medium">{t('sim.col.from')}</th>
                  <th className="px-1 py-1 font-medium">{t('sim.col.to')}</th>
                  <th className="px-1 py-1 font-medium">{t('sim.col.protocol')}</th>
                  <th className="px-1 py-1 font-medium">{t('sim.col.layer')}</th>
                  <th className="px-1 py-1 font-medium">{t('sim.col.info')}</th>
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
                    <td className="px-1 py-1 font-mono text-meta text-fg-muted">{e.step}</td>
                    <td className="px-1 py-1">{name(e.fromDeviceId)}</td>
                    <td className="px-1 py-1 font-medium">{name(e.toDeviceId)}</td>
                    <td className="px-1 py-1">
                      <span className="flex items-center gap-1">
                        <span
                          className={`h-2 w-2 rounded-sm ${PROTOCOL_COLORS[e.protocol].chip}`}
                          aria-hidden="true"
                        />
                        {e.protocol}
                      </span>
                    </td>
                    <td className="px-1 py-1 font-mono text-meta text-fg-muted">L{topLayer(e)}</td>
                    <td className="max-w-0 truncate px-1 py-1 text-fg-muted" title={e.summary}>
                      {e.summary}
                    </td>
                    <td className={`px-1 py-1 whitespace-nowrap ${OUTCOME_TONE[e.outcome]}`}>
                      <span aria-hidden="true">{OUTCOME_MARK[e.outcome]} </span>
                      {t(OUTCOME_LABELS[e.outcome])}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <aside className="w-80 shrink-0 overflow-y-auto border-l border-line">
            {selected ? (
              <div className="px-3 py-2 text-dense" data-testid="pdu-details">
                <div className="mb-1 font-semibold text-fg">{selected.summary}</div>
                <p className="mb-2 text-fg-muted">{selected.note}</p>
                {selected.layers.map((layer) => (
                  <div key={layer.name} className="mb-2 rounded-md border border-line bg-surface">
                    <div className="border-b border-line px-2 py-1 font-semibold text-fg-muted">
                      {t('sim.layer', { layer: layer.layer, name: layer.name })}
                    </div>
                    <dl className="selectable grid grid-cols-[auto_1fr] gap-x-3 px-2 py-1 font-mono text-meta">
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
            ) : (
              <p className="px-3 py-2 text-dense text-fg-subtle">{t('sim.noSelection')}</p>
            )}
            <ScenarioTimeline />
          </aside>
        </div>
      )}
    </section>
  )
}
