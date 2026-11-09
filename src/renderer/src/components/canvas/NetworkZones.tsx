/**
 * Calque des zones réseau (lecture seule) : un rectangle arrondi pointillé par réseau IPv4 autour des
 * hôtes et switchs membres, étiqueté du réseau, du VLAN (s'il est unique) et des passerelles. Les
 * appartenances viennent du moteur (networkZones, mémoïsé sur le réseau) ; seule la géométrie est
 * recalculée ici quand un équipement bouge. Aucune commande : la zone ne modifie jamais l'état.
 */
import { useMemo } from 'react'
import { ViewportPortal } from '@xyflow/react'
import { networkZones, type Device, type NetworkZone } from '@engine/index'
import { NODE_SIZE } from '../../lib/flow'
import { useT } from '../../lib/i18n'
import { useLabStore } from '../../store/lab'
import { useUiStore } from '../../store/ui'

/** Au-delà de ce nombre d'équipements, les zones sont désactivées (lisibilité et performance). */
export const ZONES_MAX_DEVICES = 60

const PADDING = 26
const LABEL_HEIGHT = 22

interface ZoneBox {
  zone: NetworkZone
  x: number
  y: number
  w: number
  h: number
}

/** Enveloppe rectangulaire des membres (carte de 64 px + étiquette sous le nœud). */
function boxes(zones: NetworkZone[], devices: Record<string, Device>): ZoneBox[] {
  const out: ZoneBox[] = []
  for (const zone of zones) {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const id of zone.deviceIds) {
      const d = devices[id]
      if (!d) continue
      minX = Math.min(minX, d.position.x)
      minY = Math.min(minY, d.position.y)
      maxX = Math.max(maxX, d.position.x + NODE_SIZE)
      maxY = Math.max(maxY, d.position.y + NODE_SIZE + 30)
    }
    if (!Number.isFinite(minX)) continue
    out.push({
      zone,
      x: minX - PADDING,
      y: minY - PADDING - LABEL_HEIGHT,
      w: maxX - minX + PADDING * 2,
      h: maxY - minY + PADDING * 2 + LABEL_HEIGHT
    })
  }
  return out
}

export function NetworkZones() {
  const show = useUiStore((s) => s.showZones)
  const zones = useLabStore((s) => networkZones(s.lab))
  const devices = useLabStore((s) => s.lab.devices)
  const count = Object.keys(devices).length
  const { t } = useT()
  const list = useMemo(() => boxes(zones, devices), [zones, devices])
  if (!show || count > ZONES_MAX_DEVICES || list.length === 0) return null
  return (
    <ViewportPortal>
      <div className="pointer-events-none absolute top-0 left-0" data-testid="network-zones" aria-hidden>
        {list.map(({ zone, x, y, w, h }) => (
          <div
            key={zone.cidr}
            className="absolute rounded-card border border-dashed border-zone-line bg-zone"
            style={{ transform: `translate(${x}px, ${y}px)`, width: w, height: h }}
            data-testid={`zone-${zone.cidr}`}
          >
            <div className="absolute top-1.5 left-2.5 flex max-w-full items-center gap-1.5 text-meta leading-none whitespace-nowrap">
              <span className="h-3 w-1 rounded-sm bg-accent" />
              <span className="font-mono font-semibold text-fg">{zone.cidr}</span>
              {zone.vlan !== undefined && (
                <span className="text-fg-muted">· {t('canvas.zone.vlan', { vlan: zone.vlan })}</span>
              )}
              {zone.gateways.map((g) => (
                <span key={`${g.deviceId}-${g.ifaceName}`} className="truncate text-fg-subtle">
                  · {t('canvas.zone.gateway', { name: `${g.deviceName} ${g.ifaceName}`, address: g.address })}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </ViewportPortal>
  )
}
