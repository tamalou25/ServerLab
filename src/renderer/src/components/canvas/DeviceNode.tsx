/**
 * Nœud « équipement » du canvas : carte de 64 px sur la surface du thème. La forme de l'icône porte
 * la catégorie (bandeau « IOS » pour un équipement Cisco), le voyant en coin porte l'état par sa
 * couleur et sa forme ; nom et adresse IP principale (police mono) sous le nœud.
 */
import { memo, useEffect, useRef, useState } from 'react'
import { Handle, NodeToolbar, Position, type Node, type NodeProps } from '@xyflow/react'
import { canvasStatus } from '@engine/index'
import { useLabStore } from '../../store/lab'
import { useUiStore } from '../../store/ui'
import { PortTray } from './PortTray'
import { StatusLed } from '../../assets/icons/StatusLed'
import { deviceIcon, iosModel } from '../../lib/devices'
import { countRender } from '../../lib/perf'
import { useT } from '../../lib/i18n'

export type DeviceNodeData = { deviceId: string }
export type DeviceFlowNode = Node<DeviceNodeData, 'device'>

/** Poignée invisible centrée sur la carte : les câbles sont tracés de centre à centre. */
const handleClass =
  '!pointer-events-none !absolute !top-8 !left-8 !h-px !w-px !min-h-0 !min-w-0 !border-0 !bg-transparent'

const IP_TONE = { normal: 'text-fg-muted', warn: 'text-warn-text', none: 'text-fg-subtle' } as const

/** Délai avant de masquer le panneau de ports (le temps d'y amener la souris). */
const HOVER_GRACE_MS = 180

function DeviceNodeComponent({ data, selected, dragging }: NodeProps<DeviceFlowNode>) {
  countRender(`node:${data.deviceId}`)
  // Abonné à son seul équipement et à son résumé (réutilisé tant qu'il ne change pas) :
  // déplacer un autre nœud ne redessine pas celui-ci
  const device = useLabStore((s) => s.lab.devices[data.deviceId])
  const view = useLabStore((s) => canvasStatus(s.lab).devices[data.deviceId])
  const tool = useUiStore((s) => s.tool)
  const { t } = useT()
  const [hover, setHover] = useState(false)
  const leaveTimer = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (leaveTimer.current) window.clearTimeout(leaveTimer.current)
    },
    []
  )
  const enter = (e?: { buttons: number }) => {
    if (leaveTimer.current) window.clearTimeout(leaveTimer.current)
    // Bouton enfoncé : un autre élément est en cours de glisser, pas de panneau de ports
    if (e && e.buttons !== 0) return
    setHover(true)
  }
  const leave = () => {
    leaveTimer.current = window.setTimeout(() => setHover(false), HOVER_GRACE_MS)
  }

  if (!device || !view) return null
  const cableMode = tool === 'cable'
  // Panneau de ports au survol (outils Sélection et Câble), jamais pendant un déplacement
  const showPorts = hover && !dragging && (tool === 'select' || cableMode)
  const Icon = deviceIcon(device)
  const { health, ip } = view
  const ios = iosModel(device)
  return (
    <div
      className="relative h-16 w-16"
      data-testid={`device-${device.name}`}
      data-health={health.status}
      onMouseEnter={enter}
      onMouseLeave={leave}
    >
      <div
        className={`relative flex h-16 w-16 items-center justify-center rounded-md border bg-surface text-fg-muted shadow-xs transition-colors ${
          selected ? 'border-accent ring-1 ring-accent' : 'border-line-strong hover:border-fg-subtle'
        } ${device.powered ? '' : 'opacity-50'} ${device.hostedBy ? 'border-dashed' : ''}`}
        title={device.hostedBy ? t('node.virtual') : undefined}
      >
        <Icon size={44} />
        {ios && (
          <span
            className="absolute -top-2 left-1/2 -translate-x-1/2 rounded-sm bg-accent px-1 text-meta leading-tight font-bold text-on-accent"
            title={t('node.iosHint')}
            data-testid="device-ios"
          >
            {t('node.ios')}
          </span>
        )}
        {device.hostedBy && (
          <span
            className="absolute right-0.5 bottom-0.5 rounded-sm bg-panel px-0.5 text-meta leading-none font-semibold text-fg-subtle"
            data-testid="device-virtual"
          >
            {device.kind === 'switch' ? 'vSW' : 'VM'}
          </span>
        )}
      </div>
      <StatusLed
        status={health.status}
        label={health.label}
        className="absolute -top-1.5 -right-1.5"
        testId="device-led"
      />
      <div className="pointer-events-none absolute top-full left-1/2 mt-1 flex -translate-x-1/2 flex-col items-center leading-tight whitespace-nowrap">
        <span
          className={`max-w-36 truncate rounded bg-canvas/85 px-1 text-dense font-medium ${selected ? 'text-accent-text' : 'text-fg'}`}
        >
          {device.name}
        </span>
        {ip && (
          <span className={`rounded bg-canvas/85 px-1 font-mono text-meta ${IP_TONE[ip.tone]}`}>
            {ip.text}
            {ip.more > 0 && <span className="text-fg-subtle"> +{ip.more}</span>}
          </span>
        )}
      </div>
      <NodeToolbar isVisible={showPorts} position={Position.Right} align="start" offset={14}>
        <PortTray device={device} interactive={cableMode} onMouseEnter={enter} onMouseLeave={leave} />
      </NodeToolbar>
      <Handle type="source" position={Position.Top} className={handleClass} isConnectable={false} />
      <Handle type="target" position={Position.Top} className={handleClass} isConnectable={false} />
    </div>
  )
}

export const DeviceNode = memo(DeviceNodeComponent)
