/**
 * Status > Dashboard et pages de lecture des services (Services > DHCP Server / DNS Resolver,
 * System > Routing) : la modification de ces services relève de l'issue #245 (commandes à venir).
 */
import { effectiveIpv4, linkOnInterface, nicOf, PFSENSE_VERSION } from '@engine/index'
import { formatSimTime } from '../../../../lib/format'
import { Alert, Panel, Table, Td, ifaceName, useSession } from './ui'

export function DashboardPage() {
  const s = useSession()
  const fw = s.firewall
  const pf = fw.pf
  return (
    <div>
      <Panel title="System Information">
        <dl className="grid grid-cols-[160px_1fr] gap-y-1 text-[12px]">
          <dt className="font-semibold">Name</dt>
          <dd data-testid="pf-dash-name">{pf.domain ? `${pf.hostname}.${pf.domain}` : pf.hostname}</dd>
          <dt className="font-semibold">Version</dt>
          <dd>{`${pf.version || PFSENSE_VERSION}-RELEASE (amd64)`}</dd>
          <dt className="font-semibold">Platform</dt>
          <dd>pfSense CE (simulé)</dd>
          <dt className="font-semibold">Current date/time</dt>
          <dd>{formatSimTime(s.lab.clock)}</dd>
          <dt className="font-semibold">DNS server(s)</dt>
          <dd>{pf.dnsServers.length > 0 ? pf.dnsServers.join(', ') : '127.0.0.1'}</dd>
          <dt className="font-semibold">State table size</dt>
          <dd>{pf.states.length} states</dd>
        </dl>
      </Panel>
      <Panel title="Interfaces">
        <Table head={['Interface', 'Port', 'Status', 'IPv4 Address']}>
          {pf.assignments.map((a) => {
            const nic = nicOf(fw, a.key)
            const eff = nic ? effectiveIpv4(nic) : null
            const up = nic && a.enabled && linkOnInterface(s.lab, fw.id, nic.id)
            return (
              <tr key={a.key} data-testid={`pf-dash-${a.key}`}>
                <Td>{ifaceName(pf, a.key)}</Td>
                <Td>{nic?.name ?? '-'}</Td>
                <Td className={up ? 'text-[#1f7a3a]' : 'text-[#b3261e]'}>{up ? 'up' : 'down'}</Td>
                <Td>{eff ? eff.address : 'n/a'}</Td>
              </tr>
            )
          })}
        </Table>
      </Panel>
    </div>
  )
}

const PENDING = (
  <Alert kind="info">
    Modification of this service will be available with the services update (issue #245): this page shows the
    current configuration.
  </Alert>
)

export function DhcpPage() {
  const s = useSession()
  const pf = s.firewall.pf
  return (
    <Panel title="Services / DHCP Server">
      {PENDING}
      <Table head={['Interface', 'Enabled', 'Range', 'Gateway', 'DNS servers', 'Leases']}>
        {pf.assignments.map((a) => {
          const dhcp = pf.dhcp[a.key]
          return (
            <tr key={a.key}>
              <Td>{ifaceName(pf, a.key)}</Td>
              <Td>{dhcp?.enabled ? 'yes' : 'no'}</Td>
              <Td>{dhcp?.rangeFrom && dhcp.rangeTo ? `${dhcp.rangeFrom} - ${dhcp.rangeTo}` : '-'}</Td>
              <Td>{dhcp?.gateway ?? '-'}</Td>
              <Td>{dhcp?.dnsServers.join(', ') || '-'}</Td>
              <Td>{dhcp?.leases.length ?? 0}</Td>
            </tr>
          )
        })}
      </Table>
    </Panel>
  )
}

export function DnsPage() {
  const s = useSession()
  const r = s.firewall.pf.dnsResolver
  return (
    <Panel title="Services / DNS Resolver">
      {PENDING}
      <p className="mb-2 text-[12px]">
        Enable DNS resolver: {r.enabled ? 'yes' : 'no'} - DNS Query Forwarding: {r.forwarding ? 'yes' : 'no'}
      </p>
      <Table head={['Host', 'Domain', 'IP']}>
        {r.hostOverrides.map((h) => (
          <tr key={`${h.host}.${h.domain}`}>
            <Td>{h.host}</Td>
            <Td>{h.domain}</Td>
            <Td>{h.address}</Td>
          </tr>
        ))}
        {r.hostOverrides.length === 0 && (
          <tr>
            <Td className="text-[#666]">No host overrides.</Td>
          </tr>
        )}
      </Table>
    </Panel>
  )
}

export function RoutingPage() {
  const s = useSession()
  const pf = s.firewall.pf
  return (
    <Panel title="System / Routing">
      {PENDING}
      <Table head={['Gateway', 'Interface', 'Address', 'Default']}>
        {pf.gateways.map((g) => (
          <tr key={g.name}>
            <Td>{g.name}</Td>
            <Td>{ifaceName(pf, g.iface)}</Td>
            <Td>{g.address}</Td>
            <Td>{g.isDefault ? 'yes' : ''}</Td>
          </tr>
        ))}
        {pf.gateways.length === 0 && (
          <tr>
            <Td className="text-[#666]">No gateways are defined.</Td>
          </tr>
        )}
      </Table>
      <h3 className="mb-1 mt-4 text-[12px] font-semibold">Static Routes</h3>
      <Table head={['Network', 'Gateway']}>
        {pf.staticRoutes.map((r) => (
          <tr key={`${r.network}/${r.prefixLength}`}>
            <Td>{`${r.network}/${r.prefixLength}`}</Td>
            <Td>{r.gateway}</Td>
          </tr>
        ))}
        {pf.staticRoutes.length === 0 && (
          <tr>
            <Td className="text-[#666]">No static routes.</Td>
          </tr>
        )}
      </Table>
    </Panel>
  )
}
