/**
 * Propriétés IPv4 d'une carte réseau (serveur ou poste), à la manière de l'assistant système.
 */
import { useEffect, useState } from 'react'
import { command, effectiveIpv4, prefixToMask, type Device, type NetInterface } from '@engine/index'
import { runCommand } from '../../../lib/run'
import { runNetworkOperation } from '../../../lib/network'
import { useLabStore } from '../../../store/lab'
import { useUiStore } from '../../../store/ui'
import { Button, Section, inputClass } from '../../common/ui'
import { t } from '../../../lib/i18n'

interface FormState {
  addressing: 'static' | 'dhcp'
  address: string
  mask: string
  gateway: string
  dnsMode: 'static' | 'dhcp'
  dns1: string
  dns2: string
}

/** Masque par défaut selon la classe de l'adresse (A, B ou C). */
function classfulMask(address: string): string {
  const first = Number(address.trim().split('.')[0])
  if (!address.trim() || Number.isNaN(first) || first < 1 || first > 223) return ''
  return first < 128 ? '255.0.0.0' : first < 192 ? '255.255.0.0' : '255.255.255.0'
}

function fromIface(iface: NetInterface): FormState {
  return {
    addressing: iface.addressing,
    address: iface.address ?? '',
    mask: iface.prefixLength !== null ? prefixToMask(iface.prefixLength) : '',
    gateway: iface.gateway ?? '',
    dnsMode: iface.dnsMode,
    dns1: iface.dnsServers[0] ?? '',
    dns2: iface.dnsServers[1] ?? ''
  }
}

export function HostInterfaceForm({ device, iface }: { device: Device; iface: NetInterface }) {
  const [form, setForm] = useState<FormState>(() => fromIface(iface))
  useEffect(() => setForm(fromIface(iface)), [iface])
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }))
  const eff = effectiveIpv4(iface)
  const staticIp = form.addressing === 'static'
  const dnsStatic = staticIp || form.dnsMode === 'static'
  const suggestedMask = classfulMask(form.address)

  /** Opération DHCP (renouveler/libérer) : rejouée en mode Simulation. */
  const dhcpOperation = (kind: 'renew' | 'release') => {
    const store = useLabStore.getState()
    const prepared = store.prepare(
      command(kind === 'renew' ? 'net.dhcpRenew' : 'net.dhcpRelease', device.id, iface.id)
    )
    if (!prepared.result.ok) return
    const op = prepared.result.value
    runNetworkOperation(op.trace, () => {
      useLabStore.getState().commit(prepared)
      const ui = useUiStore.getState()
      if (op.outcome === 'failed') ui.notify('error', `${iface.name} : ${op.message}`)
      else if (op.outcome === 'released') ui.notify('info', t('win.released', { iface: iface.name }))
      else if (op.address) ui.notify('success', t('win.leased', { iface: iface.name, address: op.address }))
    })
  }

  const apply = () => {
    const result = runCommand(
      command('net.setInterfaceIpv4', device.id, iface.id, {
        addressing: form.addressing,
        address: form.address,
        // Masque laissé vide : on applique celui proposé selon la classe, comme l'assistant système
        mask: form.mask.trim() || suggestedMask,
        gateway: form.gateway,
        dnsMode: dnsStatic ? 'static' : 'dhcp',
        dnsServers: [form.dns1, form.dns2]
      })
    )
    if (!result) return
    const ui = useUiStore.getState()
    if (result.warnings.length > 0) result.warnings.forEach((w) => ui.notify('warning', w))
    else ui.notify('success', t('win.applied', { iface: iface.name }))
  }

  return (
    <>
      <Section title={t('win.tcpip', { iface: iface.name })}>
        <div className="flex max-w-lg flex-col gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={iface.enabled}
              onChange={(e) =>
                runCommand(command('net.setInterfaceEnabled', device.id, iface.id, e.target.checked))
              }
            />
            {t('win.carteActivee')}
          </label>
          <fieldset className="flex flex-col gap-2 rounded-md border border-line p-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                checked={!staticIp}
                onChange={() => set('addressing', 'dhcp')}
                data-testid="ip-dhcp"
              />
              {t('win.obtenirUneAdresseIp')}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                checked={staticIp}
                onChange={() => set('addressing', 'static')}
                data-testid="ip-static"
              />
              {t('win.utiliserLadresseIpSuivante')}
            </label>
            <div className="grid grid-cols-[150px_1fr] items-center gap-2 pl-6">
              <span className="text-xs text-fg-muted">{t('win.adresseIp')}</span>
              <input
                className={inputClass}
                disabled={!staticIp}
                value={form.address}
                onChange={(e) => set('address', e.target.value)}
                aria-label={t('win.adresseIp')}
                placeholder="192.168.1.10"
                data-testid="ip-address"
              />
              <span className="text-xs text-fg-muted">{t('win.masqueDeSousReseau')}</span>
              <input
                className={inputClass}
                disabled={!staticIp}
                value={form.mask}
                onChange={(e) => set('mask', e.target.value)}
                aria-label={t('win.masqueDeSousReseau')}
                placeholder={suggestedMask || '255.255.255.0'}
                data-testid="ip-mask"
              />
              <span className="text-xs text-fg-muted">{t('win.passerelleParDefaut')}</span>
              <input
                className={inputClass}
                disabled={!staticIp}
                value={form.gateway}
                onChange={(e) => set('gateway', e.target.value)}
                aria-label={t('win.passerelleParDefaut')}
                data-testid="ip-gateway"
              />
            </div>
          </fieldset>
          <fieldset className="flex flex-col gap-2 rounded-md border border-line p-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                disabled={staticIp}
                checked={!dnsStatic}
                onChange={() => set('dnsMode', 'dhcp')}
              />
              {t('win.obtenirLesAdressesDes')}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" checked={dnsStatic} onChange={() => set('dnsMode', 'static')} />
              {t('win.utiliserLadresseDeServeur')}
            </label>
            <div className="grid grid-cols-[150px_1fr] items-center gap-2 pl-6">
              <span className="text-xs text-fg-muted">{t('win.serveurDnsPrefere')}</span>
              <input
                className={inputClass}
                disabled={!dnsStatic}
                value={form.dns1}
                onChange={(e) => set('dns1', e.target.value)}
                aria-label={t('win.serveurDnsPrefere')}
                data-testid="ip-dns1"
              />
              <span className="text-xs text-fg-muted">{t('win.serveurDnsAuxiliaire')}</span>
              <input
                className={inputClass}
                disabled={!dnsStatic}
                value={form.dns2}
                onChange={(e) => set('dns2', e.target.value)}
                aria-label={t('win.serveurDnsAuxiliaire')}
              />
            </div>
          </fieldset>
          <div className="flex gap-2">
            <Button variant="primary" onClick={apply} data-testid="ip-apply">
              Appliquer
            </Button>
            <Button onClick={() => setForm(fromIface(iface))}>{t('win.annulerLesModifications')}</Button>
          </div>
        </div>
      </Section>
      <Section
        title={t('win.etatDeLaConnexion')}
        actions={
          iface.addressing === 'dhcp' ? (
            <div className="flex gap-1">
              <Button variant="ghost" onClick={() => dhcpOperation('renew')} data-testid="dhcp-renew">
                {t('win.renouvelerLeBail')}
              </Button>
              <Button variant="ghost" onClick={() => dhcpOperation('release')}>
                Libérer
              </Button>
            </div>
          ) : null
        }
      >
        <dl className="selectable grid max-w-lg grid-cols-[180px_1fr] gap-y-1 text-xs">
          <dt className="text-fg-muted">{t('win.adressePhysique')}</dt>
          <dd className="font-mono">{iface.mac}</dd>
          <dt className="text-fg-muted">{t('win.adresseIpv4')}</dt>
          <dd className="font-mono" data-testid="ip-effective">
            {eff
              ? `${eff.address}${eff.source === 'apipa' ? ` (${t('win.apipaNoDhcp')})` : eff.source === 'dhcp' ? ' (DHCP)' : ''}`
              : '—'}
          </dd>
          <dt className="text-fg-muted">{t('win.masqueDeSousReseau')}</dt>
          <dd className="font-mono">{eff ? prefixToMask(eff.prefixLength) : '—'}</dd>
          <dt className="text-fg-muted">{t('win.passerelleParDefaut')}</dt>
          <dd className="font-mono">{eff?.gateway ?? '—'}</dd>
          <dt className="text-fg-muted">{t('win.serveursDns')}</dt>
          <dd className="font-mono">{eff && eff.dnsServers.length > 0 ? eff.dnsServers.join(', ') : '—'}</dd>
        </dl>
      </Section>
    </>
  )
}
