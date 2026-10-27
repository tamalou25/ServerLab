/**
 * Onglet Config d'un équipement : navigation à gauche, page de paramètres à droite.
 */
import { useState } from 'react'
import { Power } from 'lucide-react'
import { isHostDevice, type Device, command } from '@engine/index'
import { runCommand } from '../../lib/run'
import { EditableName } from '../common/EditableName'
import { Button, Field, Section } from '../common/ui'
import { InterfaceList } from '../properties/InterfaceList'
import { EventLogView } from './config/EventLogView'
import { HostInterfaceForm } from './config/HostInterfaceForm'
import { RouterInterfaceForm } from './config/RouterInterfaceForm'
import { RoutesPanel } from './config/RoutesPanel'
import { SubinterfacesPanel } from './config/SubinterfacesPanel'
import { VlanPanel } from './config/VlanPanel'
import { t } from '../../lib/i18n'

type Page =
  | { kind: 'general' }
  | { kind: 'iface'; ifaceId: string }
  | { kind: 'routes' }
  | { kind: 'events' }
  | { kind: 'vlans' }
  | { kind: 'subifs' }

export function ConfigTab({ device }: { device: Device }) {
  const [page, setPage] = useState<Page>({ kind: 'general' })
  const l3 = device.interfaces.filter((i) => i.l3)
  const iface = page.kind === 'iface' ? device.interfaces.find((i) => i.id === page.ifaceId) : undefined

  const navItem = (label: string, target: Page, testId?: string) => {
    const active =
      page.kind === target.kind &&
      (target.kind !== 'iface' || (page.kind === 'iface' && page.ifaceId === target.ifaceId))
    return (
      <button
        key={label}
        type="button"
        data-testid={testId}
        onClick={() => setPage(target)}
        className={`w-full rounded-md px-2 py-1.5 text-left ${active ? 'bg-accent-soft font-semibold text-accent-text' : 'text-fg-muted hover:bg-surface-2 hover:text-fg'}`}
      >
        {label}
      </button>
    )
  }

  return (
    <div className="flex h-full">
      <nav className="flex w-44 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line bg-panel p-2 text-xs">
        <div className="px-2 pt-1 pb-0.5 text-meta font-semibold tracking-wider text-fg-subtle uppercase">
          Global
        </div>
        {navItem(t('win.general'), { kind: 'general' })}
        {device.kind === 'router' && navItem(t('win.staticRouting'), { kind: 'routes' }, 'nav-routes')}
        {device.kind === 'router' && navItem(t('win.subifs'), { kind: 'subifs' }, 'nav-subifs')}
        {device.kind === 'switch' && !device.hostedBy && navItem('VLAN', { kind: 'vlans' }, 'nav-vlans')}
        {isHostDevice(device) && navItem(t('win.eventLog'), { kind: 'events' }, 'nav-events')}
        {l3.length > 0 && (
          <div className="px-2 pt-2 pb-0.5 text-meta font-semibold tracking-wider text-fg-subtle uppercase">
            Interfaces
          </div>
        )}
        {l3.map((i) => navItem(i.name, { kind: 'iface', ifaceId: i.id }, `nav-iface-${i.name}`))}
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto">
        {page.kind === 'general' && (
          <>
            <Section title={t('win.parametresGeneraux')}>
              <div className="grid max-w-md gap-3">
                <Field label={t('win.nom')}>
                  <EditableName deviceId={device.id} name={device.name} />
                </Field>
                <div>
                  <Button
                    onClick={() => runCommand(command('topology.setPower', device.id, !device.powered))}
                  >
                    <Power size={14} /> {device.powered ? t('win.powerOff') : t('win.powerOn')}
                  </Button>
                </div>
              </div>
            </Section>
            <Section title={device.kind === 'switch' ? t('props.portsX') : t('props.interfacesX')}>
              {device.kind === 'switch' && (
                <div className="mb-2 flex flex-wrap gap-1">
                  {device.interfaces.map((port) => (
                    <label
                      key={port.id}
                      className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs"
                    >
                      <input
                        type="checkbox"
                        checked={port.enabled}
                        onChange={(e) =>
                          runCommand(command('net.setInterfaceEnabled', device.id, port.id, e.target.checked))
                        }
                      />
                      {port.name}
                    </label>
                  ))}
                </div>
              )}
              <InterfaceList device={device} />
            </Section>
          </>
        )}
        {page.kind === 'iface' &&
          iface &&
          (isHostDevice(device) ? (
            <HostInterfaceForm device={device} iface={iface} />
          ) : (
            // Une instance par interface : aucun état de saisie ne passe d'une interface à l'autre
            <RouterInterfaceForm key={iface.id} device={device} iface={iface} />
          ))}
        {page.kind === 'routes' && device.kind === 'router' && <RoutesPanel device={device} />}
        {page.kind === 'subifs' && device.kind === 'router' && <SubinterfacesPanel device={device} />}
        {page.kind === 'vlans' && device.kind === 'switch' && <VlanPanel device={device} />}
        {page.kind === 'events' && isHostDevice(device) && <EventLogView device={device} />}
      </div>
    </div>
  )
}
