/**
 * Sous-interfaces d'un routeur (routeur « on a stick ») : une par VLAN, encapsulation dot1Q,
 * sur une carte physique reliée à un trunk.
 */
import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { command, toCidr, type RouterDevice } from '@engine/index'
import { runCommand } from '../../../lib/run'
import { Button, Section, inputClass } from '../../common/ui'
import { t } from '../../../lib/i18n'

export function SubinterfacesPanel({ device }: { device: RouterDevice }) {
  const physical = device.interfaces.filter((i) => !i.subinterface)
  const subs = device.interfaces.filter((i) => i.subinterface)
  const [parent, setParent] = useState(physical[0]?.id ?? '')
  const [vlan, setVlan] = useState('')

  const add = () => {
    if (runCommand(command('net.addSubinterface', device.id, parent, Number(vlan))) !== undefined) setVlan('')
  }

  return (
    <Section title={t('win.sousInterfaces8021q')}>
      <table className="mb-3 w-full max-w-xl text-xs" data-testid="subif-list">
        <thead className="text-left text-fg-muted">
          <tr>
            <th className="py-1">{t('win.interface')}</th>
            <th className="py-1">{t('win.encapsulation')}</th>
            <th className="py-1">{t('win.adresse')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {subs.length === 0 && (
            <tr>
              <td colSpan={4} className="py-2 text-fg-subtle">
                {t('win.aucuneSousInterface')}
              </td>
            </tr>
          )}
          {subs.map((i) => (
            <tr key={i.id} className="border-t border-line">
              <td className="py-1 font-mono">{i.name}</td>
              <td className="py-1">dot1Q {i.subinterface?.vlan}</td>
              <td className="py-1 font-mono">
                {i.address && i.prefixLength !== null ? toCidr(i.address, i.prefixLength) : '—'}
              </td>
              <td className="py-1 text-right">
                <button
                  type="button"
                  className="rounded p-1 text-fg-subtle hover:bg-danger-soft hover:text-danger-text"
                  title={t('win.supprimerLaSousInterface')}
                  onClick={() => runCommand(command('net.removeSubinterface', device.id, i.id))}
                >
                  <Trash2 size={13} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="grid max-w-xl grid-cols-[1fr_140px_auto] items-end gap-2">
        <select
          className={inputClass}
          value={parent}
          aria-label={t('win.interface')}
          onChange={(e) => setParent(e.target.value)}
        >
          {physical.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </select>
        <input
          className={inputClass}
          placeholder={t('win.vlan10')}
          value={vlan}
          data-testid="subif-vlan"
          onChange={(e) => setVlan(e.target.value)}
          aria-label={t('win.vlan10')}
        />
        <Button variant="primary" onClick={add} data-testid="subif-add">
          Créer
        </Button>
      </div>
      <p className="mt-2 text-xs text-fg-muted">
        Chaque sous-interface reçoit les trames étiquetées de son VLAN ; configurez ensuite son adresse IPv4
        (passerelle des postes du VLAN) dans la liste des interfaces.
      </p>
    </Section>
  )
}
