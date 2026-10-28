/**
 * Menu contextuel d'un nœud (clic droit, ou touche Menu / Maj+F10 sur un nœud qui a le focus) :
 * Console, Bureau, Allumer / Éteindre, Renommer, Supprimer. Accessible au clavier : flèches,
 * Origine / Fin, Entrée, Échap ; le focus revient au canvas à la fermeture.
 */
import { useEffect, useRef, type KeyboardEvent } from 'react'
import { Monitor, Pencil, Power, SquareTerminal, Trash2, type LucideIcon } from 'lucide-react'
import { command, isHostDevice } from '@engine/index'
import { iosModel, isLinux } from '../../lib/devices'
import { useT } from '../../lib/i18n'
import { runCommand } from '../../lib/run'
import { useLabStore } from '../../store/lab'
import { useUiStore } from '../../store/ui'

export interface NodeMenuState {
  deviceId: string
  x: number
  y: number
}

interface Item {
  id: string
  label: string
  icon: LucideIcon
  danger?: boolean
  run: () => void
}

/** Sélectionne l'équipement et place le focus dans son champ de nom (onglet Résumé). */
function startRename(deviceId: string): void {
  const ui = useUiStore.getState()
  ui.select({ devices: [deviceId], link: null })
  if (!ui.showProperties) ui.toggleProperties()
  ui.setRightTab('properties')
  requestAnimationFrame(() => {
    const input = document.querySelector<HTMLInputElement>('[data-testid="device-name-input"]')
    input?.focus()
    input?.select()
  })
}

export function NodeContextMenu({ menu, onClose }: { menu: NodeMenuState; onClose: () => void }) {
  const device = useLabStore((s) => s.lab.devices[menu.deviceId])
  const ref = useRef<HTMLDivElement>(null)
  const { t } = useT()

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    window.addEventListener('pointerdown', close, true)
    return () => window.removeEventListener('pointerdown', close, true)
  }, [onClose])

  if (!device) return null
  const ui = useUiStore.getState
  const host = isHostDevice(device)
  const hasConsole = host || iosModel(device) !== undefined || device.kind === 'firewall'
  const items: Item[] = [
    ...(hasConsole
      ? [
          {
            id: 'console',
            label: t('node.menu.console'),
            icon: SquareTerminal,
            run: () => ui().openWindow(device.id, 'console')
          }
        ]
      : []),
    ...(host && !isLinux(device)
      ? [
          {
            id: 'desktop',
            label: t('node.menu.desktop'),
            icon: Monitor,
            run: () => ui().openWindow(device.id, 'desktop')
          }
        ]
      : []),
    {
      id: 'power',
      label: device.powered ? t('node.menu.powerOff') : t('node.menu.powerOn'),
      icon: Power,
      run: () => runCommand(command('topology.setPower', device.id, !device.powered))
    },
    { id: 'rename', label: t('node.menu.rename'), icon: Pencil, run: () => startRename(device.id) },
    {
      id: 'delete',
      label: t('node.menu.delete'),
      icon: Trash2,
      danger: true,
      run: () => runCommand(command('topology.removeDevices', [device.id]))
    }
  ]

  const onKeyDown = (e: KeyboardEvent) => {
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const go = (n: number) => buttons[(n + buttons.length) % buttons.length]?.focus()
    // Les touches du menu ne remontent jamais aux raccourcis du canvas
    e.stopPropagation()
    if (e.key === 'ArrowDown') go(i + 1)
    else if (e.key === 'ArrowUp') go(i - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(buttons.length - 1)
    else if (e.key === 'Escape' || e.key === 'Tab') onClose()
    else return
    e.preventDefault()
  }

  // Position bornée à la fenêtre
  const left = Math.min(menu.x, window.innerWidth - 200)
  const top = Math.min(menu.y, window.innerHeight - items.length * 30 - 16)
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={t('node.menu', { name: device.name })}
      className="fixed z-50 min-w-44 rounded-md border border-line-strong bg-overlay py-1 text-dense text-fg shadow-lg"
      style={{ left, top }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      data-testid="node-menu"
    >
      {items.map(({ id, label, icon: Icon, danger, run }) => (
        <button
          key={id}
          type="button"
          role="menuitem"
          className={`flex w-full items-center gap-2 px-3 py-1.5 text-left outline-none hover:bg-surface-2 focus-visible:bg-surface-2 ${
            danger ? 'text-danger-text' : ''
          }`}
          onClick={() => {
            onClose()
            run()
          }}
          data-testid={`node-menu-${id}`}
        >
          <Icon size={14} aria-hidden="true" />
          {label}
        </button>
      ))}
    </div>
  )
}
