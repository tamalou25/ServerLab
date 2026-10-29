/**
 * Câble entre deux ports, avec un voyant d'état à chaque extrémité. Chaque voyant double sa couleur
 * d'une forme (rond : actif, triangle : adressage incomplet, carré barré : inactif) ; l'infobulle du
 * câble donne en texte les deux extrémités, le débit et l'état de chaque port.
 */
import { memo } from 'react'
import { BaseEdge, EdgeLabelRenderer, useInternalNode, type Edge, type EdgeProps } from '@xyflow/react'
import { canvasStatus, type LedStatus } from '@engine/index'
import { useLabStore } from '../../store/lab'
import { useUiStore } from '../../store/ui'
import { linkSpeedMbps } from '../../lib/cabling'
import { ICON_CENTER } from '../../lib/flow'
import { countRender } from '../../lib/perf'
import { useT } from '../../lib/i18n'

export type CableEdgeData = { linkId: string; offset: number }
export type CableFlowEdge = Edge<CableEdgeData, 'cable'>

// Distance du voyant au centre du nœud (carte de 64 px : 16 px au-delà du bord)
const LED_DISTANCE = 48

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
  // Noms des équipements pour l'infobulle (chaînes stables : aucun rendu pendant un glisser)
  const nameA = useLabStore((s) => (link ? s.lab.devices[link.a.deviceId]?.name : undefined))
  const nameB = useLabStore((s) => (link ? s.lab.devices[link.b.deviceId]?.name : undefined))
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
  const mbps = linkSpeedMbps(portA, portB)
  const tooltip = [
    t('link.ends', { a: nameA ?? '?', portA, b: nameB ?? '?', portB }),
    mbps >= 1000 ? t('link.gbps', { n: mbps / 1000 }) : t('link.mbps', { n: mbps }),
    `${portA} : ${t(LED_KEY[statusA])}`,
    `${portB} : ${t(LED_KEY[statusB])}`,
    ...(link.virtual ? [t('link.virtualCable')] : [])
  ].join('\n')

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
      {/* Infobulle au survol du câble (même zone que la sélection) */}
      <path d={path} className="fill-none stroke-transparent" strokeWidth={16} data-testid="cable-hit">
        <title>{tooltip}</title>
      </path>
      {visible && (
        <g data-testid={`cable-${portA}-${portB}`}>
          <LinkLed x={ledA.x} y={ledA.y} status={statusA} title={`${portA} : ${t(LED_KEY[statusA])}`} />
          <LinkLed x={ledB.x} y={ledB.y} status={statusB} title={`${portB} : ${t(LED_KEY[statusB])}`} />
        </g>
      )}
      {showPortLabels && visible && (
        <EdgeLabelRenderer>
          <PortLabel x={ledA.x + uy * 16 + ux * 14} y={ledA.y - ux * 16 + uy * 14} text={portA} />
          <PortLabel x={ledB.x + uy * 16 - ux * 14} y={ledB.y - ux * 16 - uy * 14} text={portB} />
        </EdgeLabelRenderer>
      )}
    </>
  )
}

/** Voyant d'une extrémité : couleur et forme selon l'état (data-shape pour les tests). */
function LinkLed({ x, y, status, title }: { x: number; y: number; status: LedStatus; title: string }) {
  if (status === 'up')
    return (
      <circle cx={x} cy={y} r={5} className="fill-ok stroke-canvas stroke-2" data-shape="circle">
        <title>{title}</title>
      </circle>
    )
  if (status === 'degraded')
    return (
      <path
        d={`M${x} ${y - 6}L${x + 6} ${y + 5}H${x - 6}Z`}
        className="fill-warn stroke-canvas"
        strokeWidth={1.5}
        strokeLinejoin="round"
        data-shape="triangle"
      >
        <title>{title}</title>
      </path>
    )
  return (
    <g data-shape="square">
      <title>{title}</title>
      <rect
        x={x - 5}
        y={y - 5}
        width={10}
        height={10}
        rx={1}
        className="fill-danger stroke-canvas"
        strokeWidth={1.5}
      />
      <path d={`M${x - 2.5} ${y - 2.5}l5 5m0 -5l-5 5`} className="stroke-on-danger" strokeWidth={1.5} />
    </g>
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
