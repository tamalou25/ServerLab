/**
 * Panneau des ports d'un équipement, affiché au survol du nœud et en mode Câble :
 * nom du port, état du lien, équipement raccordé. En mode Câble, un clic sur un port libre
 * le choisit directement (sans passer par le menu).
 */
import type { MouseEvent } from 'react'
import { endStatus, linkOnInterface, type Device, type LedStatus } from '@engine/index'
import { useLabStore } from '../../store/lab'
import { useUiStore } from '../../store/ui'
import { pickCablePort } from '../../lib/cabling'
import { useT } from '../../lib/i18n'

type PortState = LedStatus | 'free' | 'disabled'

const DOT: Record<PortState, string> = {
  up: 'bg-ok',
  degraded: 'bg-warn',
  down: 'bg-danger',
  free: 'border border-fg-subtle bg-transparent',
  disabled: 'bg-fg-subtle/40'
}

/** État du port dans l'infobulle (clés `port.state.<état>`). */
const STATE_KEY = {
  up: 'port.state.up',
  degraded: 'port.state.degraded',
  down: 'port.state.down',
  free: 'port.state.free',
  disabled: 'port.state.disabled'
} as const satisfies Record<PortState, string>

interface PortTrayProps {
  device: Device
  /** Mode Câble : les ports libres sont cliquables. */
  interactive: boolean
  onMouseEnter: () => void
  onMouseLeave: () => void
}

export function PortTray({ device, interactive, onMouseEnter, onMouseLeave }: PortTrayProps) {
  const lab = useLabStore((s) => s.lab)
  const cableStart = useUiStore((s) => s.cableStart)
  const { t, tp } = useT()
  // Les sous-interfaces partagent le port de leur carte parente
  const ports = device.interfaces
    .filter((iface) => !iface.subinterface)
    .map((iface) => {
      const link = linkOnInterface(lab, device.id, iface.id)
      const side = link && link.a.deviceId === device.id && link.a.ifaceId === iface.id ? 'a' : 'b'
      const peerEnd = link ? (side === 'a' ? link.b : link.a) : null
      const peer = peerEnd ? lab.devices[peerEnd.deviceId] : undefined
      const peerPort = peerEnd ? peer?.interfaces.find((i) => i.id === peerEnd.ifaceId)?.name : undefined
      const state: PortState = link ? endStatus(lab, link, side) : iface.enabled ? 'free' : 'disabled'
      const chosen = cableStart?.deviceId === device.id && cableStart.ifaceId === iface.id
      return { iface, state, peer: peer ? `${peer.name} · ${peerPort ?? '?'}` : null, chosen }
    })
  const free = ports.filter((p) => p.state === 'free').length
  const cols = ports.length > 8 ? 'grid-cols-4' : ports.length > 2 ? 'grid-cols-2' : 'grid-cols-1'

  const pick = (e: MouseEvent, ifaceId: string) => {
    // Le panneau est rendu dans un portail : l'événement remonterait jusqu'au nœud
    e.stopPropagation()
    pickCablePort(device.id, ifaceId)
  }

  return (
    <div
      className="nodrag nopan rounded-md border border-line bg-overlay/95 p-1.5 shadow-md backdrop-blur-sm"
      data-testid={`port-tray-${device.name}`}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="mb-1 flex items-center justify-between gap-4 px-0.5 text-meta font-semibold tracking-wider text-fg-subtle uppercase">
        <span>{t('port.tray.title')}</span>
        <span className="font-normal normal-case">{tp('port.tray.free', free, { total: ports.length })}</span>
      </div>
      <div className={`grid gap-0.5 ${cols}`}>
        {ports.map(({ iface, state, peer, chosen }) => {
          const title = `${iface.name} — ${t(STATE_KEY[state])}${peer ? ` → ${peer}` : ''}`
          const content = (
            <>
              <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[state]}`} />
              <span className={state === 'disabled' ? 'line-through' : ''}>{iface.name}</span>
            </>
          )
          const base =
            'flex items-center gap-1.5 rounded px-1.5 py-0.5 font-mono text-meta whitespace-nowrap'
          if (!interactive)
            return (
              <div key={iface.id} className={`${base} text-fg-muted`} title={title}>
                {content}
              </div>
            )
          const selectable = state === 'free' && !chosen
          return (
            <button
              key={iface.id}
              type="button"
              disabled={!selectable}
              title={selectable ? t('port.tray.connect', { title }) : title}
              onClick={(e) => pick(e, iface.id)}
              data-testid={`port-chip-${iface.name}`}
              className={`${base} ${
                chosen
                  ? 'bg-accent text-on-accent'
                  : selectable
                    ? 'text-fg hover:bg-accent-soft hover:text-accent-text'
                    : 'cursor-not-allowed text-fg-subtle'
              }`}
            >
              {content}
            </button>
          )
        })}
      </div>
    </div>
  )
}
