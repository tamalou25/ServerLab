/**
 * Interfaces > Assignments et page de configuration d'une interface (adresse IPv4, activation,
 * « Block private networks » / « Block bogon networks »). Commandes `net.setInterfaceIpv4`,
 * `net.setInterfaceEnabled` et `pf.setBlockNetworks`.
 */
import { useState } from 'react'
import { batch, command, effectiveIpv4, linkOnInterface, nicOf, type PfIfaceKey } from '@engine/index'
import { Alert, Btn, Field, Panel, Table, Td, ifaceName, inputCls, useSession, IFACE_KEYS } from './ui'

export function AssignmentsPage() {
  const s = useSession()
  const pf = s.firewall.pf
  return (
    <Panel title="Interfaces / Interface Assignments">
      <Table head={['Interface', 'Network port', 'Status', 'IPv4 Address']}>
        {pf.assignments.map((a) => {
          const nic = nicOf(s.firewall, a.key)
          const eff = nic ? effectiveIpv4(nic) : null
          return (
            <tr key={a.key} data-testid={`pf-assign-${a.key}`}>
              <Td>
                <button
                  type="button"
                  className="text-[#2d5aa3] hover:underline"
                  onClick={() => s.navigate(`interface:${a.key}` as const)}
                >
                  {ifaceName(pf, a.key)}
                </button>
              </Td>
              <Td>{nic ? `${nic.name} (${nic.mac})` : '(unassigned)'}</Td>
              <Td>{a.enabled ? 'enabled' : 'disabled'}</Td>
              <Td>{eff ? `${eff.address}/${eff.prefixLength}` : 'none'}</Td>
            </tr>
          )
        })}
      </Table>
      <p className="mt-3 text-[11px] text-[#666]">
        The simulated firewall has three network ports (em0, em1, em2): extra interfaces cannot be added.
      </p>
    </Panel>
  )
}

export function InterfacePage({ ifaceKey }: { ifaceKey: PfIfaceKey }) {
  const s = useSession()
  const pf = s.firewall.pf
  const assignment = pf.assignments.find((a) => a.key === ifaceKey)
  const nic = nicOf(s.firewall, ifaceKey)
  const eff = nic ? effectiveIpv4(nic) : null
  const [address, setAddress] = useState(eff?.address ?? '')
  const [prefix, setPrefix] = useState(String(eff?.prefixLength ?? 24))
  const [enabled, setEnabled] = useState(assignment?.enabled ?? true)
  const [priv, setPriv] = useState(assignment?.blockPrivate ?? false)
  const [bogons, setBogons] = useState(assignment?.blockBogons ?? false)
  const [error, setError] = useState<string | null>(null)
  if (!assignment || !nic) return <Alert kind="error">This interface is not assigned.</Alert>
  const linked = !!linkOnInterface(s.lab, s.firewallId, nic.id)

  const save = () => {
    setError(null)
    // Lot atomique : si une commande est refusée, aucune n'est mise en attente
    const err = s.stage(
      batch('Configurer l’interface', [
        command('net.setInterfaceIpv4', s.firewallId, nic.id, {
          addressing: 'static',
          address: address.trim() || null,
          mask: address.trim() ? prefix : null,
          gateway: nic.gateway
        }),
        command('pf.setBlockNetworks', s.firewallId, ifaceKey, { blockPrivate: priv, blockBogons: bogons }),
        command('net.setInterfaceEnabled', s.firewallId, nic.id, enabled)
      ])
    )
    if (err) {
      setError(err)
      return
    }
    s.navigate('interfaces')
  }

  return (
    <Panel title={`Interfaces / ${ifaceName(pf, ifaceKey)} (${nic.name})`}>
      {error && (
        <Alert kind="error" testId="pf-form-error">
          {error}
        </Alert>
      )}
      <Field label="Enable">
        <label className="text-[12px]">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            data-testid="pf-if-enable"
          />{' '}
          Enable interface
        </label>
      </Field>
      <Field label="Description">
        <span className="text-[13px]">{ifaceName(pf, ifaceKey)}</span>
      </Field>
      <Field label="Status">
        <span className="text-[13px]">{linked ? 'up' : 'no carrier'}</span>
      </Field>
      <Field label="IPv4 Configuration Type">
        <span className="text-[13px]">Static IPv4</span>
      </Field>
      <Field label="IPv4 Address">
        <div className="flex items-center gap-2">
          <input
            className={`${inputCls} w-40`}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            data-testid="pf-if-address"
          />
          <span>/</span>
          <select
            className={inputCls}
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
            data-testid="pf-if-prefix"
          >
            {Array.from({ length: 33 }, (_, i) => 32 - i).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
      </Field>
      <Field
        label="Block private networks"
        help="Blocks traffic from IP addresses that are reserved for private networks per RFC 1918 (10/8, 172.16/12, 192.168/16) and loopback addresses (127/8)."
      >
        <label className="text-[12px]">
          <input
            type="checkbox"
            checked={priv}
            onChange={(e) => setPriv(e.target.checked)}
            data-testid="pf-if-blockprivate"
          />{' '}
          Block private networks and loopback addresses
        </label>
      </Field>
      <Field
        label="Block bogon networks"
        help="Blocks traffic from reserved IP addresses that should not appear in the Internet routing table."
      >
        <label className="text-[12px]">
          <input
            type="checkbox"
            checked={bogons}
            onChange={(e) => setBogons(e.target.checked)}
            data-testid="pf-if-blockbogons"
          />{' '}
          Block bogon networks
        </label>
      </Field>
      <div className="ml-[182px] flex gap-2">
        <Btn testId="pf-form-save" onClick={save}>
          Save
        </Btn>
        <Btn kind="secondary" onClick={() => s.navigate('interfaces')}>
          Cancel
        </Btn>
      </div>
    </Panel>
  )
}

export const INTERFACE_PAGES = IFACE_KEYS.map((k) => `interface:${k}` as const)
