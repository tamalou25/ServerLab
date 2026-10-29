/**
 * Légende des protocoles (mode Simulation, coin inférieur gauche du canvas) : couleur des enveloppes
 * et nom de chaque protocole. Les protocoles masqués par les filtres sont barrés.
 */
import { Panel } from '@xyflow/react'
import { PROTOCOLS } from '@engine/index'
import { useT } from '../../lib/i18n'
import { PROTOCOL_COLORS } from '../../lib/protocols'
import { useSimStore } from '../../store/sim'
import { useUiStore } from '../../store/ui'

export function ProtocolLegend() {
  const mode = useUiStore((s) => s.mode)
  const filters = useSimStore((s) => s.filters)
  const { t } = useT()
  if (mode !== 'simulation') return null
  return (
    <Panel position="bottom-left" className="!m-3">
      <ul
        className="grid grid-cols-3 gap-x-3 gap-y-0.5 rounded-md border border-line bg-panel/90 px-2 py-1.5 text-meta text-fg-muted shadow-sm backdrop-blur-sm"
        aria-label={t('sim.legend')}
        data-testid="protocol-legend"
      >
        {PROTOCOLS.map((p) => (
          <li key={p} className={`flex items-center gap-1 ${filters[p] ? '' : 'line-through opacity-60'}`}>
            <span className={`h-2 w-2 rounded-sm ${PROTOCOL_COLORS[p].chip}`} aria-hidden="true" />
            {p}
          </li>
        ))}
      </ul>
    </Panel>
  )
}
