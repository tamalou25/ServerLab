/**
 * Status > Dashboard (informations système et interfaces).
 */
import { effectiveIpv4, linkOnInterface, nicOf, PFSENSE_VERSION } from '@engine/index'
import { formatSimTime } from '../../../../lib/format'
import { Panel, Table, Td, ifaceName, useSession } from './ui'

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
