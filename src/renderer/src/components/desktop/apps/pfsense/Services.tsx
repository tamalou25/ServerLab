/**
 * Services > DHCP Server, Services > DNS Resolver et System > Routing (passerelles, routes statiques).
 * Commandes `pf.setDhcp`, `pf.setDnsResolver`, `pf.setHostOverride`, `pf.setGateway`, `pf.addStaticRoute`…
 * Comme le reste de l'interface, « Save » met en attente et « Apply Changes » applique.
 */
import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { command, type PfIfaceKey } from '@engine/index'
import { formatSimTime } from '../../../../lib/format'
import {
  Alert,
  Btn,
  Field,
  IconBtn,
  Panel,
  Table,
  Tabs,
  Td,
  IFACE_KEYS,
  ifaceName,
  inputCls,
  useSession
} from './ui'

const words = (text: string): string[] => text.split(/[\s,]+/).filter(Boolean)

export function DhcpPage() {
  const s = useSession()
  const pf = s.firewall.pf
  const [tab, setTab] = useState<PfIfaceKey>('lan')
  const dhcp = pf.dhcp[tab]
  const [d, setD] = useState(() => ({
    enabled: dhcp?.enabled ?? false,
    from: dhcp?.rangeFrom ?? '',
    to: dhcp?.rangeTo ?? '',
    dns: (dhcp?.dnsServers ?? []).join(' '),
    gateway: dhcp?.gateway ?? '',
    lease: String(dhcp?.leaseSeconds ?? 7200)
  }))
  const [error, setError] = useState<string | null>(null)
  const select = (key: PfIfaceKey) => {
    const c = pf.dhcp[key]
    setTab(key)
    setError(null)
    setD({
      enabled: c?.enabled ?? false,
      from: c?.rangeFrom ?? '',
      to: c?.rangeTo ?? '',
      dns: (c?.dnsServers ?? []).join(' '),
      gateway: c?.gateway ?? '',
      lease: String(c?.leaseSeconds ?? 7200)
    })
  }
  const save = () =>
    setError(
      s.stage(
        command('pf.setDhcp', s.firewallId, tab, {
          enabled: d.enabled,
          rangeFrom: d.from.trim() || null,
          rangeTo: d.to.trim() || null,
          dnsServers: words(d.dns),
          gateway: d.gateway.trim() || null,
          leaseSeconds: Number(d.lease)
        })
      )
    )
  return (
    <div>
      <Tabs
        tabs={IFACE_KEYS.map((k) => ({ id: k, label: ifaceName(pf, k) }))}
        active={tab}
        onSelect={(id) => select(id as PfIfaceKey)}
      />
      {error && (
        <Alert kind="error" testId="pf-form-error">
          {error}
        </Alert>
      )}
      <Panel title={`Services / DHCP Server / ${ifaceName(pf, tab)}`}>
        <Field label="Enable">
          <label className="text-[12px]">
            <input
              type="checkbox"
              checked={d.enabled}
              onChange={(e) => setD({ ...d, enabled: e.target.checked })}
              data-testid="pf-dhcp-enable"
            />{' '}
            Enable DHCP server on {ifaceName(pf, tab)} interface
          </label>
        </Field>
        <Field label="Range">
          <div className="flex items-center gap-2">
            <input
              className={`${inputCls} w-36`}
              value={d.from}
              aria-label="Range from"
              onChange={(e) => setD({ ...d, from: e.target.value })}
              data-testid="pf-dhcp-from"
            />
            <span>to</span>
            <input
              className={`${inputCls} w-36`}
              value={d.to}
              aria-label="Range to"
              onChange={(e) => setD({ ...d, to: e.target.value })}
              data-testid="pf-dhcp-to"
            />
          </div>
        </Field>
        <Field label="DNS servers" help="Separated by spaces.">
          <input
            className={`${inputCls} w-72`}
            value={d.dns}
            onChange={(e) => setD({ ...d, dns: e.target.value })}
            data-testid="pf-dhcp-dns"
          />
        </Field>
        <Field label="Gateway">
          <input
            className={`${inputCls} w-40`}
            value={d.gateway}
            onChange={(e) => setD({ ...d, gateway: e.target.value })}
            data-testid="pf-dhcp-gateway"
          />
        </Field>
        <Field label="Default lease time" help="In seconds.">
          <input
            className={`${inputCls} w-28`}
            value={d.lease}
            onChange={(e) => setD({ ...d, lease: e.target.value })}
            data-testid="pf-dhcp-lease"
          />
        </Field>
        <div className="ml-[182px]">
          <Btn testId="pf-form-save" onClick={save}>
            Save
          </Btn>
        </div>
      </Panel>
      <Panel title="Status / DHCP Leases">
        <Table head={['IP address', 'MAC address', 'Hostname', 'End']}>
          {(dhcp?.leases ?? []).map((l) => (
            <tr key={l.ip} data-testid="pf-lease-row">
              <Td>{l.ip}</Td>
              <Td>{l.mac}</Td>
              <Td>{l.hostname}</Td>
              <Td>{formatSimTime(l.expires)}</Td>
            </tr>
          ))}
          {(dhcp?.leases.length ?? 0) === 0 && (
            <tr>
              <Td className="text-[#666]">No leases.</Td>
            </tr>
          )}
        </Table>
      </Panel>
    </div>
  )
}

export function DnsPage() {
  const s = useSession()
  const pf = s.firewall.pf
  const r = pf.dnsResolver
  const [error, setError] = useState<string | null>(null)
  const [host, setHost] = useState('')
  const [domain, setDomain] = useState(pf.domain)
  const [address, setAddress] = useState('')
  const [servers, setServers] = useState(pf.dnsServers.join(' '))
  const run = (cmd: ReturnType<typeof command>) => setError(s.stage(cmd))
  return (
    <div>
      {error && (
        <Alert kind="error" testId="pf-form-error">
          {error}
        </Alert>
      )}
      <Panel title="Services / DNS Resolver / General Settings">
        <Field label="Enable">
          <label className="text-[12px]">
            <input
              type="checkbox"
              checked={r.enabled}
              onChange={(e) => run(command('pf.setDnsResolver', s.firewallId, { enabled: e.target.checked }))}
              data-testid="pf-dns-enable"
            />{' '}
            Enable DNS resolver
          </label>
        </Field>
        <Field label="DNS Query Forwarding">
          <label className="text-[12px]">
            <input
              type="checkbox"
              checked={r.forwarding}
              onChange={(e) =>
                run(command('pf.setDnsResolver', s.firewallId, { forwarding: e.target.checked }))
              }
              data-testid="pf-dns-forwarding"
            />{' '}
            Enable Forwarding Mode
          </label>
        </Field>
        <Field label="DNS servers" help="System > General Setup. Separated by spaces.">
          <div className="flex gap-2">
            <input
              className={`${inputCls} w-72`}
              value={servers}
              onChange={(e) => setServers(e.target.value)}
              data-testid="pf-dns-servers"
            />
            <Btn onClick={() => run(command('pf.setDnsServers', s.firewallId, words(servers)))}>Save</Btn>
          </div>
        </Field>
      </Panel>
      <Panel title="Host Overrides">
        <Table head={['Host', 'Domain', 'IP', '']}>
          {r.hostOverrides.map((h) => (
            <tr key={`${h.host}.${h.domain}`} data-testid="pf-override-row">
              <Td>{h.host}</Td>
              <Td>{h.domain}</Td>
              <Td>{h.address}</Td>
              <Td>
                <IconBtn
                  title="Delete host override"
                  onClick={() => run(command('pf.removeHostOverride', s.firewallId, h.host, h.domain))}
                >
                  <Trash2 size={13} />
                </IconBtn>
              </Td>
            </tr>
          ))}
          {r.hostOverrides.length === 0 && (
            <tr>
              <Td className="text-[#666]">No host overrides.</Td>
            </tr>
          )}
        </Table>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            className={`${inputCls} w-28`}
            placeholder="Host"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            data-testid="pf-override-host"
          />
          <input
            className={`${inputCls} w-36`}
            placeholder="Domain"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            data-testid="pf-override-domain"
          />
          <input
            className={`${inputCls} w-36`}
            placeholder="IP address"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            data-testid="pf-override-address"
          />
          <Btn
            testId="pf-override-add"
            onClick={() => run(command('pf.setHostOverride', s.firewallId, { host, domain, address }))}
          >
            Add
          </Btn>
        </div>
      </Panel>
    </div>
  )
}

export function RoutingPage() {
  const s = useSession()
  const pf = s.firewall.pf
  const [error, setError] = useState<string | null>(null)
  const [gw, setGw] = useState({ name: '', iface: 'wan' as PfIfaceKey, address: '', isDefault: false })
  const [route, setRoute] = useState({ network: '', prefix: '24', gateway: '' })
  const run = (cmd: ReturnType<typeof command>) => setError(s.stage(cmd))
  return (
    <div>
      {error && (
        <Alert kind="error" testId="pf-form-error">
          {error}
        </Alert>
      )}
      <Panel title="System / Routing / Gateways">
        <Table head={['Name', 'Interface', 'Gateway', 'Default', '']}>
          {pf.gateways.map((g) => (
            <tr key={g.name} data-testid={`pf-gw-${g.name}`}>
              <Td>{g.name}</Td>
              <Td>{ifaceName(pf, g.iface)}</Td>
              <Td>{g.address}</Td>
              <Td>
                <input
                  type="radio"
                  name="pf-default-gw"
                  aria-label={`Default gateway ${g.name}`}
                  checked={g.isDefault}
                  onChange={() => run(command('pf.setDefaultGateway', s.firewallId, g.name))}
                />
              </Td>
              <Td>
                <IconBtn
                  title="Delete gateway"
                  onClick={() => run(command('pf.removeGateway', s.firewallId, g.name))}
                >
                  <Trash2 size={13} />
                </IconBtn>
              </Td>
            </tr>
          ))}
          {pf.gateways.length === 0 && (
            <tr>
              <Td className="text-[#666]">No gateways are defined.</Td>
            </tr>
          )}
        </Table>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            className={`${inputCls} w-28`}
            placeholder="Name"
            value={gw.name}
            onChange={(e) => setGw({ ...gw, name: e.target.value })}
            data-testid="pf-gw-name"
          />
          <select
            className={inputCls}
            value={gw.iface}
            onChange={(e) => setGw({ ...gw, iface: e.target.value as PfIfaceKey })}
            aria-label="Gateway interface"
          >
            {IFACE_KEYS.map((k) => (
              <option key={k} value={k}>
                {ifaceName(pf, k)}
              </option>
            ))}
          </select>
          <input
            className={`${inputCls} w-36`}
            placeholder="Gateway IP"
            value={gw.address}
            onChange={(e) => setGw({ ...gw, address: e.target.value })}
            data-testid="pf-gw-address"
          />
          <label className="text-[12px]">
            <input
              type="checkbox"
              checked={gw.isDefault}
              onChange={(e) => setGw({ ...gw, isDefault: e.target.checked })}
            />{' '}
            Default
          </label>
          <Btn
            testId="pf-gw-add"
            onClick={() =>
              run(
                command('pf.setGateway', s.firewallId, {
                  name: gw.name.trim(),
                  iface: gw.iface,
                  address: gw.address.trim(),
                  isDefault: gw.isDefault
                })
              )
            }
          >
            Add
          </Btn>
        </div>
      </Panel>
      <Panel title="System / Routing / Static Routes">
        <Table head={['Network', 'Gateway', '']}>
          {pf.staticRoutes.map((r) => (
            <tr key={`${r.network}/${r.prefixLength}`} data-testid="pf-route-row">
              <Td>{`${r.network}/${r.prefixLength}`}</Td>
              <Td>{r.gateway}</Td>
              <Td>
                <IconBtn
                  title="Delete static route"
                  onClick={() =>
                    run(command('pf.removeStaticRoute', s.firewallId, r.network, r.prefixLength))
                  }
                >
                  <Trash2 size={13} />
                </IconBtn>
              </Td>
            </tr>
          ))}
          {pf.staticRoutes.length === 0 && (
            <tr>
              <Td className="text-[#666]">No static routes are defined.</Td>
            </tr>
          )}
        </Table>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            className={`${inputCls} w-36`}
            placeholder="Network"
            value={route.network}
            onChange={(e) => setRoute({ ...route, network: e.target.value })}
            data-testid="pf-route-network"
          />
          <input
            className={`${inputCls} w-16`}
            placeholder="Mask"
            value={route.prefix}
            onChange={(e) => setRoute({ ...route, prefix: e.target.value })}
            data-testid="pf-route-prefix"
          />
          <select
            className={inputCls}
            value={route.gateway}
            onChange={(e) => setRoute({ ...route, gateway: e.target.value })}
            aria-label="Route gateway"
            data-testid="pf-route-gateway"
          >
            <option value="">Gateway...</option>
            {pf.gateways.map((g) => (
              <option key={g.name} value={g.name}>
                {g.name}
              </option>
            ))}
          </select>
          <Btn
            testId="pf-route-add"
            onClick={() =>
              run(
                command('pf.addStaticRoute', s.firewallId, {
                  network: route.network.trim(),
                  prefixLength: Number(route.prefix),
                  gateway: route.gateway
                })
              )
            }
          >
            Add
          </Btn>
        </div>
      </Panel>
    </div>
  )
}
