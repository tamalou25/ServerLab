/**
 * Onglet Console : Invite de commandes ou PowerShell ; bash sur un poste Linux ; console IOS sur
 * un routeur ou un switch Cisco.
 */
import { useState } from 'react'
import type { HostDevice, ShellKind } from '@engine/index'
import { Terminal } from './Terminal'
import { t } from '../../lib/i18n'

export function ConsoleTab({ device }: { device: HostDevice }) {
  const [kind, setKind] = useState<ShellKind>(device.kind === 'server' ? 'powershell' : 'cmd')
  if (device.host.os === 'linux')
    return (
      <div className="h-full" data-testid="console-bash">
        <Terminal key={k(device.id, 'bash')} deviceId={device.id} kind="bash" autoFocus />
      </div>
    )
  if (!device.host.session)
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-fg-muted">
        {t('console.aucuneSessionOuverteConnectez')}
      </div>
    )
  return (
    <div className="flex h-full flex-col">
      <div className="flex gap-1 border-b border-line bg-surface-2 px-2 py-1">
        {(['cmd', 'powershell'] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(k)}
            data-testid={`console-${k}`}
            className={`rounded px-3 py-1 text-xs font-medium ${kind === k ? 'bg-accent text-on-accent' : 'text-fg-muted hover:bg-surface-3'}`}
          >
            {k === 'cmd' ? t('console.cmd') : 'PowerShell'}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        <Terminal key={k(device.id, kind)} deviceId={device.id} kind={kind} autoFocus />
      </div>
    </div>
  )
}

/** Console IOS (ligne console) d'un équipement Cisco. */
export function IosConsoleTab({ deviceId }: { deviceId: string }) {
  return (
    <div className="h-full" data-testid="console-ios">
      <Terminal key={k(deviceId, 'ios')} deviceId={deviceId} kind="ios" autoFocus />
    </div>
  )
}

/** Console du pare-feu pfSense : menu numéroté puis shell. */
export function PfsenseConsoleTab({ deviceId }: { deviceId: string }) {
  return (
    <div className="h-full" data-testid="console-pfsense">
      <Terminal key={k(deviceId, 'pfsense')} deviceId={deviceId} kind="pfsense" autoFocus />
    </div>
  )
}

function k(deviceId: string, kind: ShellKind): string {
  return `${deviceId}-${kind}`
}
