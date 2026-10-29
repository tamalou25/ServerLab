/**
 * Configuration d'une interface de routeur ou du lien WAN du nuage (adressage statique).
 */
import { useEffect, useState } from 'react'
import { prefixToMask, type Device, type NetInterface, command } from '@engine/index'
import { runCommand, runCommandOk } from '../../../lib/run'
import { useUiStore } from '../../../store/ui'
import { Button, Section, inputClass } from '../../common/ui'
import { t } from '../../../lib/i18n'

export function RouterInterfaceForm({ device, iface }: { device: Device; iface: NetInterface }) {
  const [address, setAddress] = useState(iface.address ?? '')
  const [mask, setMask] = useState(iface.prefixLength !== null ? prefixToMask(iface.prefixLength) : '')
  // Réinitialisé quand l'adresse enregistrée change, pas à chaque mise à jour de l'interface
  // (activation, relais…) : la saisie en cours est conservée
  useEffect(() => {
    setAddress(iface.address ?? '')
    setMask(iface.prefixLength !== null ? prefixToMask(iface.prefixLength) : '')
  }, [iface.address, iface.prefixLength])

  const apply = (clear = false) => {
    const result = runCommand(
      command('net.setInterfaceIpv4', device.id, iface.id, {
        addressing: 'static',
        address: clear ? '' : address,
        mask: clear ? '' : mask
      })
    )
    if (!result) return
    const ui = useUiStore.getState()
    result.warnings.forEach((w) => ui.notify('warning', w))
    if (result.warnings.length === 0) ui.notify('success', t('win.ifConfigured', { iface: iface.name }))
  }

  return (
    <Section
      title={
        iface.subinterface
          ? t('win.subifTitle', { iface: iface.name, vlan: iface.subinterface.vlan ?? '—' })
          : t('win.ifTitle', { iface: iface.name })
      }
    >
      <div className="flex max-w-lg flex-col gap-3">
        <label className="flex items-center gap-2 text-ui">
          <input
            type="checkbox"
            data-testid="if-enabled"
            checked={iface.enabled}
            onChange={(e) =>
              runCommand(command('net.setInterfaceEnabled', device.id, iface.id, e.target.checked))
            }
          />
          {t('win.interfaceActivee')}
        </label>
        <div className="grid grid-cols-[150px_1fr] items-center gap-2">
          <span className="text-xs text-fg-muted">{t('win.adresseIpv4')}</span>
          <input
            className={inputClass}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            aria-label={t('win.adresseIpv4')}
            data-testid="if-address"
          />
          <span className="text-xs text-fg-muted">{t('win.masqueDeSousReseau')}</span>
          <input
            className={inputClass}
            value={mask}
            onChange={(e) => setMask(e.target.value)}
            aria-label={t('win.masqueDeSousReseau')}
            data-testid="if-mask"
          />
          <span className="text-xs text-fg-muted">{t('win.adresseMac')}</span>
          <span className="selectable font-mono text-xs">{iface.mac}</span>
        </div>
        <div className="flex gap-2">
          <Button variant="primary" onClick={() => apply()} data-testid="if-apply">
            Appliquer
          </Button>
          <Button onClick={() => apply(true)}>{t('win.effacerLadresse')}</Button>
        </div>
        {device.kind === 'router' && <HelperAddresses device={device} iface={iface} />}
      </div>
    </Section>
  )
}

/** Agent de relais DHCP : serveurs vers lesquels les diffusions DHCP de l'interface sont relayées. */
function HelperAddresses({ device, iface }: { device: Device; iface: NetInterface }) {
  const [text, setText] = useState(iface.helperAddresses?.join(', ') ?? '')
  useEffect(() => setText(iface.helperAddresses?.join(', ') ?? ''), [iface])
  const save = () => {
    const list = text.split(/[,;\s]+/).filter(Boolean)
    if (runCommandOk(command('net.setHelperAddresses', device.id, iface.id, list)))
      useUiStore
        .getState()
        .notify('success', list.length ? t('win.relayOn', { iface: iface.name }) : t('win.relayOff'))
  }
  return (
    <div className="mt-2 border-t border-line pt-3">
      <div className="mb-1 text-xs font-medium text-fg-muted">{t('win.relaisDhcpIpHelper')}</div>
      <div className="flex gap-2">
        <input
          className={inputClass}
          placeholder={t('win.adresseDuServeurDhcp')}
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label={t('win.adresseDuServeurDhcp')}
          data-testid="if-helper"
        />
        <Button onClick={save} data-testid="if-helper-apply">
          Enregistrer
        </Button>
      </div>
      <p className="mt-1 text-xs text-fg-muted">{t('win.relayHelp')}</p>
    </div>
  )
}
