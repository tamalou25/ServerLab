/**
 * Légende des mises en évidence du plan (coin supérieur gauche), affichée seulement quand l'une
 * d'elles est visible : câble sélectionné, branche de l'équipement sélectionné, chemin de l'échange
 * choisi, enveloppes de l'échange en cours, zones réseau. Chaque entrée associe un trait et un texte.
 */
import { Panel } from '@xyflow/react'
import { networkZones } from '@engine/index'
import { useT } from '../../lib/i18n'
import { useLabStore } from '../../store/lab'
import { useSimStore } from '../../store/sim'
import { useUiStore } from '../../store/ui'
import { ZONES_MAX_DEVICES } from './NetworkZones'

function Line({ className, dashed }: { className: string; dashed?: boolean }) {
  return (
    <svg width="22" height="8" aria-hidden className="shrink-0">
      <line
        x1="1"
        y1="4"
        x2="21"
        y2="4"
        className={className}
        strokeWidth={dashed ? 3 : 2.5}
        strokeDasharray={dashed ? '5 3' : undefined}
        strokeLinecap="round"
      />
    </svg>
  )
}

export function StateLegend() {
  const { t } = useT()
  const link = useUiStore((s) => s.selection.link)
  const branch = useUiStore((s) => s.selection.devices.length === 1)
  const path = useSimStore((s) => s.highlighted.size > 0)
  const exchange = useSimStore((s) => s.current.length > 0)
  const mode = useUiStore((s) => s.mode)
  const zonesOn = useUiStore((s) => s.showZones)
  const zones = useLabStore((s) => (zonesOn ? networkZones(s.lab).length : 0))
  const devices = useLabStore((s) => Object.keys(s.lab.devices).length)
  const showZones = zonesOn && zones > 0 && devices <= ZONES_MAX_DEVICES
  const items: { key: string; label: string; swatch: React.ReactNode }[] = []
  if (link)
    items.push({ key: 'selected', label: t('legend.selected'), swatch: <Line className="stroke-accent" /> })
  if (branch)
    items.push({ key: 'branch', label: t('legend.branch'), swatch: <Line className="stroke-accent" /> })
  if (path)
    items.push({ key: 'path', label: t('legend.path'), swatch: <Line className="stroke-info" dashed /> })
  if (mode === 'simulation' && exchange)
    items.push({
      key: 'exchange',
      label: t('legend.exchange'),
      swatch: <span className="h-2.5 w-3.5 shrink-0 rounded-xs border border-fg-muted bg-panel" aria-hidden />
    })
  if (showZones)
    items.push({
      key: 'zone',
      label: t('legend.zone'),
      swatch: (
        <span
          className="h-3 w-5 shrink-0 rounded-sm border border-dashed border-zone-line bg-zone"
          aria-hidden
        />
      )
    })
  if (items.length === 0) return null
  return (
    <Panel position="top-left" className="!m-3">
      <ul
        className="flex flex-col gap-0.5 rounded-control border border-line bg-panel/90 px-2 py-1.5 text-meta text-fg-muted shadow-sm backdrop-blur-sm"
        aria-label={t('legend.label')}
        data-testid="state-legend"
      >
        {items.map((item) => (
          <li key={item.key} className="flex items-center gap-1.5" data-legend={item.key}>
            {item.swatch}
            {item.label}
          </li>
        ))}
      </ul>
    </Panel>
  )
}
