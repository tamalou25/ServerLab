/**
 * VLAN d'un switch : base des VLAN et configuration 802.1Q de chaque port (accès ou trunk).
 */
import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { command, switchportOf, type NetInterface, type SwitchDevice } from '@engine/index'
import { runCommand, runCommandOk } from '../../../lib/run'
import { Button, Section, inputClass } from '../../common/ui'
import { t } from '../../../lib/i18n'

/** « 1,10,20-22 » → [1, 10, 20, 21, 22] ; vide → null (tous les VLAN). */
function parseVlanList(text: string): number[] | null | undefined {
  const t = text.trim()
  if (!t) return null
  const out: number[] = []
  for (const part of t.split(',')) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part)
    if (!m) return undefined
    const from = Number(m[1])
    const to = Number(m[2] ?? m[1])
    for (let v = from; v <= to && out.length <= 4094; v++) out.push(v)
  }
  return out
}

function PortRow({ device, port }: { device: SwitchDevice; port: NetInterface }) {
  const config = switchportOf(port)
  const [allowed, setAllowed] = useState(config.allowedVlans?.join(',') ?? '')
  const set = (input: Parameters<typeof applyPort>[2]) => applyPort(device, port, input)
  return (
    <tr className="border-t border-line" data-testid={`vlan-port-${port.name}`}>
      <td className="py-1 font-mono">{port.name}</td>
      <td className="py-1">
        <select
          className={inputClass}
          value={config.mode}
          aria-label={t('win.mode')}
          data-testid="vlan-mode"
          onChange={(e) => set({ mode: e.target.value as 'access' | 'trunk' })}
        >
          <option value="access">{t('win.acces')}</option>
          <option value="trunk">{t('win.trunk8021q')}</option>
        </select>
      </td>
      <td className="py-1">
        {config.mode === 'access' ? (
          <select
            className={inputClass}
            value={config.accessVlan}
            aria-label={t('win.vlan10')}
            data-testid="vlan-access"
            onChange={(e) => set({ mode: 'access', accessVlan: Number(e.target.value) })}
          >
            {device.vlans.map((v) => (
              <option key={v.id} value={v.id}>
                {v.id} — {v.name}
              </option>
            ))}
          </select>
        ) : (
          <select
            className={inputClass}
            value={config.nativeVlan}
            title={t('win.vlanNatifNonEtiquete')}
            aria-label={t('win.vlanNatifNonEtiquete')}
            onChange={(e) => set({ mode: 'trunk', nativeVlan: Number(e.target.value) })}
          >
            {device.vlans.map((v) => (
              <option key={v.id} value={v.id}>
                natif {v.id}
              </option>
            ))}
          </select>
        )}
      </td>
      <td className="py-1">
        {config.mode === 'trunk' && (
          <input
            className={inputClass}
            placeholder={t('win.allVlans')}
            value={allowed}
            title={t('win.vlanAutorises110')}
            aria-label={t('win.vlanAutorisesTrunk')}
            onChange={(e) => setAllowed(e.target.value)}
            onBlur={() => {
              const list = parseVlanList(allowed)
              if (list === undefined) setAllowed(config.allowedVlans?.join(',') ?? '')
              else set({ mode: 'trunk', allowedVlans: list })
            }}
          />
        )}
      </td>
    </tr>
  )
}

function applyPort(
  device: SwitchDevice,
  port: NetInterface,
  input: {
    mode: 'access' | 'trunk'
    accessVlan?: number
    nativeVlan?: number
    allowedVlans?: number[] | null
  }
) {
  runCommand(command('net.setSwitchport', device.id, port.id, input))
}

export function VlanPanel({ device }: { device: SwitchDevice }) {
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const portsOf = (vlan: number) =>
    device.interfaces
      .filter((p) => {
        const c = switchportOf(p)
        return c.mode === 'access' && c.accessVlan === vlan
      })
      .map((p) => p.name)
      .join(', ')

  const add = () => {
    if (runCommandOk(command('net.addVlan', device.id, Number(id), name))) {
      setId('')
      setName('')
    }
  }

  return (
    <>
      <Section title={t('win.baseDesVlan')}>
        <table className="mb-3 w-full max-w-xl text-xs" data-testid="vlan-db">
          <thead className="text-left text-fg-muted">
            <tr>
              <th className="py-1">VLAN</th>
              <th className="py-1">{t('win.nom')}</th>
              <th className="py-1">{t('win.portsDacces')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {device.vlans.map((v) => (
              <tr key={v.id} className="border-t border-line">
                <td className="py-1 font-mono">{v.id}</td>
                <td className="py-1">{v.name}</td>
                <td className="py-1 font-mono text-fg-muted">{portsOf(v.id)}</td>
                <td className="py-1 text-right">
                  {v.id !== 1 && (
                    <button
                      type="button"
                      className="rounded p-1 text-fg-subtle hover:bg-danger-soft hover:text-danger"
                      title={t('win.supprimerLeVlan')}
                      onClick={() => runCommand(command('net.removeVlan', device.id, v.id))}
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="grid max-w-xl grid-cols-[120px_1fr_auto] items-end gap-2">
          <input
            className={inputClass}
            placeholder={t('win.numero10')}
            value={id}
            aria-label={t('win.numero10')}
            data-testid="vlan-new-id"
            onChange={(e) => setId(e.target.value)}
          />
          <input
            className={inputClass}
            placeholder={t('win.nomCompta')}
            value={name}
            aria-label={t('win.nomCompta')}
            data-testid="vlan-new-name"
            onChange={(e) => setName(e.target.value)}
          />
          <Button variant="primary" onClick={add} data-testid="vlan-add">
            Créer
          </Button>
        </div>
      </Section>
      <Section title={t('win.ports')}>
        <table className="w-full max-w-2xl text-xs">
          <thead className="text-left text-fg-muted">
            <tr>
              <th className="py-1">{t('win.port')}</th>
              <th className="py-1">{t('win.mode')}</th>
              <th className="py-1">VLAN</th>
              <th className="py-1">{t('win.vlanAutorisesTrunk')}</th>
            </tr>
          </thead>
          <tbody>
            {device.interfaces.map((p) => (
              <PortRow
                key={`${p.id}-${switchportOf(p).allowedVlans?.join(',') ?? ''}`}
                device={device}
                port={p}
              />
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-fg-muted">{t('win.vlanHelp')}</p>
      </Section>
    </>
  )
}
