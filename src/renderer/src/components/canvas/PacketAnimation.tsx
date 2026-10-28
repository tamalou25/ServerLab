/**
 * Animation des trames du pas courant (mode Simulation) : enveloppes se déplaçant sur les câbles,
 * colorées selon le protocole (tokens --sl-proto-*) et étiquetées de son nom (voir ProtocolLegend).
 */
import { useEffect, useState } from 'react'
import { ViewportPortal } from '@xyflow/react'
import { useLabStore } from '../../store/lab'
import { useSimStore } from '../../store/sim'
import { useUiStore } from '../../store/ui'
import { ICON_CENTER } from '../../lib/flow'
import { PROTOCOL_COLORS } from '../../lib/protocols'

const DURATION_MS = 650

export function PacketAnimation() {
  const mode = useUiStore((s) => s.mode)
  const current = useSimStore((s) => s.current)
  const tick = useSimStore((s) => s.tick)
  const devices = useLabStore((s) => s.lab.devices)
  const [t, setT] = useState(1)

  useEffect(() => {
    let frame = 0
    const start = performance.now()
    const animate = (now: number) => {
      const p = Math.min(1, (now - start) / DURATION_MS)
      setT(p)
      if (p < 1) frame = requestAnimationFrame(animate)
    }
    setT(0)
    frame = requestAnimationFrame(animate)
    return () => cancelAnimationFrame(frame)
  }, [tick])

  if (mode !== 'simulation' || current.length === 0) return null
  const ease = 1 - Math.pow(1 - t, 3)

  return (
    <ViewportPortal>
      <svg className="pointer-events-none absolute top-0 left-0 overflow-visible" width={1} height={1}>
        {current.map((e, i) => {
          const from = devices[e.fromDeviceId]
          const to = devices[e.toDeviceId]
          if (!from || !to) return null
          const x1 = from.position.x + ICON_CENTER.x
          const y1 = from.position.y + ICON_CENTER.y
          const x2 = to.position.x + ICON_CENTER.x
          const y2 = to.position.y + ICON_CENTER.y
          // L'enveloppe s'arrête au bord de l'icône d'arrivée
          const len = Math.hypot(x2 - x1, y2 - y1) || 1
          const stop = Math.max(0, 1 - 38 / len)
          const k = ease * stop
          const x = x1 + (x2 - x1) * k
          const y = y1 + (y2 - y1) * k
          const done = t >= 1
          return (
            <g key={`${tick}-${i}`} transform={`translate(${x - 11}, ${y - 8})`}>
              <rect
                width={22}
                height={16}
                rx={3}
                className={`${PROTOCOL_COLORS[e.protocol].fill} stroke-canvas stroke-[1.5]`}
              />
              <path d="M2 3 L11 10 L20 3" className="fill-none stroke-on-accent stroke-[1.5]" />
              {/* Nom du protocole : la couleur n'est jamais le seul indice */}
              <text
                x={11}
                y={28}
                textAnchor="middle"
                className="fill-fg stroke-canvas text-meta font-semibold [paint-order:stroke]"
                strokeWidth={3}
              >
                {e.protocol}
              </text>
              {done && e.outcome === 'dropped' && (
                <g transform="translate(14,-8)">
                  <circle r={7} cx={4} cy={4} className="fill-danger" />
                  <path d="M1 1 L7 7 M7 1 L1 7" className="stroke-on-accent stroke-2" />
                </g>
              )}
              {done && e.outcome === 'delivered' && (
                <g transform="translate(14,-8)">
                  <circle r={7} cx={4} cy={4} className="fill-ok" />
                  <path d="M0.5 4 L3 6.5 L7.5 1.5" className="fill-none stroke-on-accent stroke-2" />
                </g>
              )}
              {done && e.outcome === 'ignored' && (
                <g transform="translate(14,-8)">
                  <circle r={7} cx={4} cy={4} className="fill-fg-subtle" />
                  <path d="M0.5 4 L7.5 4" className="stroke-on-accent stroke-2" />
                </g>
              )}
            </g>
          )
        })}
      </svg>
    </ViewportPortal>
  )
}
