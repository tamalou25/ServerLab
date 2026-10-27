/**
 * Menu de choix du port lors du câblage (libre / occupé).
 */
import { useEffect, useRef } from 'react'
import { Cable } from 'lucide-react'
import { linkOnInterface } from '@engine/index'
import { useLabStore } from '../../store/lab'

export interface PortPickerState {
  deviceId: string
  /** Position relative au conteneur du canvas. */
  x: number
  y: number
}

interface PortPickerProps {
  picker: PortPickerState
  /** Port à exclure (premier port choisi). */
  onPick: (ifaceId: string) => void
  onClose: () => void
}

export function PortPicker({ picker, onPick, onClose }: PortPickerProps) {
  const lab = useLabStore((s) => s.lab)
  const ref = useRef<HTMLDivElement>(null)
  const device = lab.devices[picker.deviceId]

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown, true)
    }
  }, [onClose])

  if (!device) return null
  return (
    <div
      ref={ref}
      className="absolute z-50 max-h-80 w-56 overflow-y-auto rounded-md border border-line bg-overlay py-1 shadow-lg"
      style={{ left: picker.x, top: picker.y }}
      role="menu"
      data-testid="port-picker"
    >
      <div className="flex items-center gap-1.5 border-b border-line px-3 py-1.5 text-xs font-semibold text-fg-muted">
        <Cable size={13} /> {device.name} — choisir un port
      </div>
      {device.interfaces
        .filter((iface) => !iface.subinterface)
        .map((iface) => {
          const link = linkOnInterface(lab, device.id, iface.id)
          const peer = link
            ? lab.devices[
                link.a.deviceId === device.id && link.a.ifaceId === iface.id
                  ? link.b.deviceId
                  : link.a.deviceId
              ]
            : undefined
          return (
            <button
              key={iface.id}
              type="button"
              role="menuitem"
              disabled={!!link}
              onClick={() => onPick(iface.id)}
              data-testid={`port-${iface.name}`}
              className="flex w-full items-center justify-between px-3 py-1.5 text-left text-ui text-fg hover:bg-accent-soft disabled:cursor-not-allowed disabled:text-fg-subtle disabled:hover:bg-transparent"
            >
              <span className="font-mono text-xs font-medium">{iface.name}</span>
              <span className="text-xs text-fg-muted">{link ? `→ ${peer?.name ?? '?'}` : 'libre'}</span>
            </button>
          )
        })}
    </div>
  )
}
