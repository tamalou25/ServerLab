/**
 * Fenêtre flottante d'un équipement (double-clic) avec onglets Config / Bureau / Console.
 * Déplaçable, redimensionnable (coin inférieur droit) et agrandissable (double-clic sur le titre).
 * Barre de titre uniforme : icône, nom, type, IP principale, accès rapides Console / Bureau, fermer.
 * Le Bureau simulé garde son thème clair propre (DesktopShell, data-theme="light").
 */
import { useRef, type PointerEvent } from 'react'
import { Maximize2, Minimize2, Monitor, Settings, SquareTerminal, X, type LucideIcon } from 'lucide-react'
import { useLabStore } from '../../store/lab'
import { useUiStore, type DeviceTab, type DeviceWindowState } from '../../store/ui'
import { deviceIcon, deviceLabel, iosModel, isLinux } from '../../lib/devices'
import { ConfigTab } from './ConfigTab'
import { ConsoleTab, IosConsoleTab, PfsenseConsoleTab } from '../console/ConsoleTab'
import { DesktopShell } from '../desktop/DesktopShell'
import { canvasStatus, isHostDevice } from '@engine/index'
import { t } from '../../lib/i18n'

const TABS: { id: DeviceTab; label: string; icon: LucideIcon }[] = [
  {
    id: 'config',
    get label() {
      return t('win.tab.config')
    },
    icon: Settings
  },
  {
    id: 'desktop',
    get label() {
      return t('win.tab.desktop')
    },
    icon: Monitor
  },
  {
    id: 'console',
    get label() {
      return t('win.tab.console')
    },
    icon: SquareTerminal
  }
]

export function DeviceWindow({ win }: { win: DeviceWindowState }) {
  const device = useLabStore((s) => s.lab.devices[win.deviceId])
  // Adresse principale (même résumé que le nœud du canvas)
  const ip = useLabStore((s) => canvasStatus(s.lab).devices[win.deviceId]?.ip)
  const { closeWindow, focusWindow, moveWindow, resizeWindow, toggleMaximizeWindow, setWindowTab } =
    useUiStore.getState()
  const drag = useRef<{ dx: number; dy: number } | null>(null)
  const resize = useRef<{ px: number; py: number; w: number; h: number } | null>(null)

  if (!device) return null
  const Icon = deviceIcon(device)
  const isHost = device.kind === 'server' || device.kind === 'client'
  // Équipement Cisco IOS : console uniquement (configuration en CLI, comme le vrai matériel)
  const ios = iosModel(device) !== undefined
  // Poste Linux : configuration et console bash (pas de Bureau Windows)
  const tabs = ios
    ? TABS.filter((t) => t.id === 'console')
    : device.kind === 'firewall'
      ? TABS.filter((t) => t.id === 'config' || t.id === 'console')
      : !isHost
        ? TABS.filter((t) => t.id === 'config')
        : isLinux(device)
          ? TABS.filter((t) => t.id !== 'desktop')
          : TABS
  const tab = tabs.some((t) => t.id === win.tab) ? win.tab : (tabs[0]?.id ?? 'config')

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button') || win.maximized) return
    drag.current = { dx: e.clientX - win.x, dy: e.clientY - win.y }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    const x = Math.max(0, Math.min(window.innerWidth - 120, e.clientX - drag.current.dx))
    const y = Math.max(0, Math.min(window.innerHeight - 60, e.clientY - drag.current.dy))
    moveWindow(win.deviceId, x, y)
  }
  const onPointerUp = () => {
    drag.current = null
  }
  const onResizeDown = (e: PointerEvent<HTMLDivElement>) => {
    e.stopPropagation()
    resize.current = { px: e.clientX, py: e.clientY, w: win.w, h: win.h }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onResizeMove = (e: PointerEvent<HTMLDivElement>) => {
    const r = resize.current
    if (!r) return
    const w = Math.max(640, Math.min(window.innerWidth - win.x, r.w + e.clientX - r.px))
    const h = Math.max(420, Math.min(window.innerHeight - win.y, r.h + e.clientY - r.py))
    resizeWindow(win.deviceId, w, h)
  }
  const style = win.maximized
    ? { left: 0, top: 0, width: '100%', height: '100%', zIndex: 100 + win.z }
    : { left: win.x, top: win.y, width: win.w, height: win.h, zIndex: 100 + win.z }

  return (
    <div
      className={`pointer-events-auto absolute flex flex-col overflow-hidden border border-line-strong bg-panel text-fg shadow-lg ${win.maximized ? '' : 'rounded-md'}`}
      style={style}
      onPointerDownCapture={() => focusWindow(win.deviceId)}
      role="dialog"
      aria-label={`${device.name} — ${deviceLabel(device)}`}
      data-testid={`device-window-${device.name}`}
    >
      <div
        className="flex cursor-move items-center gap-2 border-b border-line bg-panel px-3 py-1.5 text-fg"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={(e) => {
          if (!(e.target as HTMLElement).closest('button')) toggleMaximizeWindow(win.deviceId)
        }}
      >
        <span className="flex h-6 w-6 items-center justify-center text-fg-muted">
          <Icon size={22} />
        </span>
        <span className="text-ui font-semibold">{device.name}</span>
        <span className="text-dense text-fg-muted">{deviceLabel(device)}</span>
        <span className="font-mono text-meta text-fg-muted" data-testid="device-window-ip">
          {ip ? ip.text : ''}
        </span>
        <div className="ml-auto flex items-center gap-1" role="group" aria-label={t('win.quickActions')}>
          {tabs
            .filter((x) => x.id === 'console' || x.id === 'desktop')
            .map(({ id, label, icon: QuickIcon }) => (
              <button
                key={id}
                type="button"
                className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-meta ${
                  tab === id
                    ? 'bg-accent-soft text-accent-text'
                    : 'text-fg-muted hover:bg-surface-2 hover:text-fg'
                }`}
                onClick={() => setWindowTab(win.deviceId, id)}
                data-testid={`win-quick-${id}`}
              >
                <QuickIcon size={12} aria-hidden="true" /> {label}
              </button>
            ))}
        </div>
        <button
          type="button"
          className="rounded p-1 text-fg-muted hover:bg-surface-2 hover:text-fg"
          onClick={() => toggleMaximizeWindow(win.deviceId)}
          title={win.maximized ? t('win.restore') : t('win.maximize')}
          aria-label={win.maximized ? t('win.restore') : t('win.maximize')}
          data-testid="maximize-device-window"
        >
          {win.maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
        <button
          type="button"
          className="rounded p-1 text-fg-muted hover:bg-danger hover:text-on-danger"
          onClick={() => closeWindow(win.deviceId)}
          title={t('win.fermer')}
          aria-label={t('win.fermer')}
          data-testid="close-device-window"
        >
          <X size={16} />
        </button>
      </div>
      <div className="flex border-b border-line bg-panel px-2" role="tablist" aria-label={device.name}>
        {tabs.map(({ id, label, icon: TabIcon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            data-testid={`tab-${id}`}
            onClick={() => setWindowTab(win.deviceId, id)}
            className={`-mb-px flex items-center gap-1.5 border-b-2 px-4 py-2 text-xs font-medium ${
              tab === id ? 'border-accent text-fg' : 'border-transparent text-fg-subtle hover:text-fg-muted'
            }`}
          >
            <TabIcon size={14} /> {label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden bg-surface">
        {tab === 'config' && <ConfigTab device={device} />}
        {tab === 'desktop' &&
          isHostDevice(device) &&
          (device.powered ? <DesktopShell device={device} /> : <Placeholder text={t('win.off')} />)}
        {tab === 'console' &&
          isHostDevice(device) &&
          (device.powered ? <ConsoleTab device={device} /> : <Placeholder text={t('win.off')} />)}
        {tab === 'console' &&
          device.kind === 'firewall' &&
          (device.powered ? <PfsenseConsoleTab deviceId={device.id} /> : <Placeholder text={t('win.off')} />)}
        {tab === 'console' &&
          ios &&
          (device.powered ? <IosConsoleTab deviceId={device.id} /> : <Placeholder text={t('win.off')} />)}
      </div>
      {!win.maximized && (
        <div
          className="absolute right-0 bottom-0 h-3 w-3 cursor-nwse-resize"
          onPointerDown={onResizeDown}
          onPointerMove={onResizeMove}
          onPointerUp={() => (resize.current = null)}
          title={t('win.redimensionner')}
          data-testid="resize-device-window"
        />
      )}
    </div>
  )
}

function Placeholder({ text }: { text: string }) {
  return <div className="flex h-full items-center justify-center p-8 text-center text-fg-subtle">{text}</div>
}

/** Calque contenant toutes les fenêtres d'équipements ouvertes. */
export function DeviceWindows() {
  const windows = useUiStore((s) => s.windows)
  return (
    <div className="pointer-events-none fixed inset-0 z-40">
      {windows.map((w) => (
        <DeviceWindow key={w.deviceId} win={w} />
      ))}
    </div>
  )
}
