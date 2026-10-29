/**
 * Câble entre deux ports, avec un voyant d'état à chaque extrémité.
 */
import { memo } from 'react'
import { BaseEdge, EdgeLabelRenderer, useInternalNode, type Edge, type EdgeProps } from '@xyflow/react'
import { canvasStatus, type LedStatus } from '@engine/index'
import { useLabStore } from '../../store/lab'
import { useUiStore } from '../../store/ui'
import { ICON_CENTER } from '../../lib/flow'
import { countRender } from '../../lib/perf'
import { useT } from '../../lib/i18n'

export type CableEdgeData = { linkId: string; offset: number }
export type CableFlowEdge = Edge<CableEdgeData, 'cable'>

const LED_DISTANCE = 44

const LED_CLASS: Record<LedStatus, string> = {
  up: 'fill-ok',
  degraded: 'fill-warn',
  down: 'fill-danger'
}

/** Infobulle du voyant (clés `link.<état>`). */
const LED_KEY = {
  up: 'link.up',
  degraded: 'link.degraded',
  down: 'link.down'
} as const satisfies Record<LedStatus, string>

function CableEdgeComponent({ id, source, target, data, selected }: EdgeProps<CableFlowEdge>) {
  countRender(`edge:${id}`)
  const { t } = useT()
  const sourceNode = useInternalNode(source)
  const targetNode = useInternalNode(target)
  // Abonné à son seul câble et à son résumé (voyants, noms de ports)
  const link = useLabStore((s) => (data ? s.lab.links[data.linkId] : undefined))
  const view = useLabStore((s) => (data ? canvasStatus(s.lab).links[data.linkId] : undefined))
  // Noms de ports aux extrémités : option d'affichage, ou automatiquement pendant le câblage
  const showPortLabels = useUiStore((s) => s.showPortLabels || s.tool === 'cable')
  if (!sourceNode || !targetNode || !link || !view) return null

  // Extrémités au centre des icônes, décalées si plusieurs câbles relient les mêmes équipements
  const sx0 = sourceNode.internals.positionAbsolute.x + ICON_CENTER.x
  const sy0 = sourceNode.internals.positionAbsolute.y + ICON_CENTER.y
  const tx0 = targetNode.internals.positionAbsolute.x + ICON_CENTER.x
  const ty0 = targetNode.internals.positionAbsolute.y + ICON_CENTER.y
  const dx = tx0 - sx0
  const dy = ty0 - sy0
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len
  const uy = dy / len
  const off = data?.offset ?? 0
  const sx = sx0 - uy * off
  const sy = sy0 + ux * off
  const tx = tx0 - uy * off
  const ty = ty0 + ux * off
  const path = `M ${sx},${sy} L ${tx},${ty}`

  const ledA = { x: sx + ux * LED_DISTANCE, y: sy + uy * LED_DISTANCE }
  const ledB = { x: tx - ux * LED_DISTANCE, y: ty - uy * LED_DISTANCE }
  const { a: statusA, b: statusB, portA, portB } = view
  const visible = len > LED_DISTANCE * 2 + 8

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        interactionWidth={16}
        className={selected ? '!stroke-accent !stroke-[2.5px]' : '!stroke-fg-subtle !stroke-2'}
        // Liaison virtuelle (Hyper-V) : tracé en pointillés
        {...(link.virtual ? { style: { strokeDasharray: '6 4' } } : {})}
      />
      {visible && (
        <g data-testid={`cable-${portA}-${portB}`}>
          <circle cx={ledA.x} cy={ledA.y} r={5} className={`${LED_CLASS[statusA]} stroke-canvas stroke-2`}>
            <title>{`${portA} : ${t(LED_KEY[statusA])}`}</title>
          </circle>
          <circle cx={ledB.x} cy={ledB.y} r={5} className={`${LED_CLASS[statusB]} stroke-canvas stroke-2`}>
            <title>{`${portB} : ${t(LED_KEY[statusB])}`}</title>
          </circle>
        </g>
      )}
      {showPortLabels && visible && (
        <EdgeLabelRenderer>
          <PortLabel x={ledA.x + uy * 14} y={ledA.y - ux * 14} text={portA} />
          <PortLabel x={ledB.x + uy * 14} y={ledB.y - ux * 14} text={portB} />
        </EdgeLabelRenderer>
      )}
    </>
  )
}

/** Étiquette de port positionnée via une classe de transformation (compatible CSP). */
function PortLabel({ x, y, text }: { x: number; y: number; text: string }) {
  return (
    <div
      className="nodrag nopan pointer-events-none absolute rounded border border-line bg-panel/90 px-1 font-mono text-meta text-fg-muted shadow-xs"
      style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}
    >
      {text}
    </div>
  )
}

export const CableEdge = memo(CableEdgeComponent)
