/**
 * Status > System Logs > Firewall et Diagnostics > States (lecture seule, plus « Clear log » et
 * « Reset States » qui s'appliquent immédiatement comme sur pfSense).
 */
import { Trash2 } from 'lucide-react'
import { command } from '@engine/index'
import { formatSimTime } from '../../../../lib/format'
import { Btn, Panel, Table, Td, ifaceName, useSession } from './ui'

export function FirewallLogPage() {
  const s = useSession()
  const pf = s.firewall.pf
  // Les entrées les plus récentes d'abord, comme sur pfSense
  const entries = [...pf.log].reverse()
  return (
    <Panel
      title="Status / System Logs / Firewall / Normal View"
      actions={
        <span className="text-[11px] font-normal">
          Last {Math.min(entries.length, 500)} firewall log entries
        </span>
      }
    >
      <Table head={['Act', 'Time', 'If', 'Rule', 'Source', 'Destination', 'Proto']}>
        {entries.map((e, i) => {
          const rule = pf.rules.find((r) => r.id === e.ruleId)
          const src = e.src
          return (
            <tr key={`${e.at}-${i}`} data-testid="pf-log-row">
              <Td className={e.action === 'pass' ? 'text-[#1f7a3a]' : 'text-[#b3261e]'}>
                {e.action === 'pass' ? 'Pass' : e.action === 'block' ? 'Block' : 'Reject'}
              </Td>
              <Td className="whitespace-nowrap">{formatSimTime(e.at)}</Td>
              <Td>{ifaceName(pf, e.iface)}</Td>
              <Td>{rule ? `${rule.descr || rule.id} (${rule.id})` : 'Default deny rule / automatic rule'}</Td>
              <Td>{src}</Td>
              <Td>{e.dst}</Td>
              <Td>{e.protocol.toUpperCase()}</Td>
            </tr>
          )
        })}
        {entries.length === 0 && (
          <tr>
            <Td className="text-[#666]">No logs to display.</Td>
          </tr>
        )}
      </Table>
      <div className="mt-3">
        <Btn kind="danger" testId="pf-log-clear" onClick={() => s.now(command('pf.clearLog', s.firewallId))}>
          <Trash2 size={13} /> Clear log
        </Btn>
      </div>
    </Panel>
  )
}

export function StatesPage() {
  const s = useSession()
  const pf = s.firewall.pf
  return (
    <Panel title="Diagnostics / States / States">
      <Table
        head={[
          'Interface',
          'Proto',
          'Source (Original Source) -> Destination (Original Destination)',
          'State'
        ]}
      >
        {pf.states.map((e, i) => (
          <tr key={`${e.createdAt}-${i}`} data-testid="pf-state-row">
            <Td>{ifaceName(pf, e.iface)}</Td>
            <Td>{e.protocol.toUpperCase()}</Td>
            <Td>
              {e.src} {'->'} {e.dst}
              {e.translation ? ` (${e.translation})` : ''}
            </Td>
            <Td>{e.protocol === 'tcp' ? 'ESTABLISHED:ESTABLISHED' : 'MULTIPLE:MULTIPLE'}</Td>
          </tr>
        ))}
        {pf.states.length === 0 && (
          <tr>
            <Td className="text-[#666]">No states were found.</Td>
          </tr>
        )}
      </Table>
      <div className="mt-3">
        <Btn
          kind="danger"
          testId="pf-states-reset"
          onClick={() => s.now(command('pf.resetStates', s.firewallId))}
        >
          <Trash2 size={13} /> Reset States
        </Btn>
      </div>
    </Panel>
  )
}
