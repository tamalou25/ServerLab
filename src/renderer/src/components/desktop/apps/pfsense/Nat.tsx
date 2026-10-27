/**
 * Firewall > NAT : Port Forward (redirections) et Outbound (mode et règles de NAT sortant).
 * Commandes `pf.addPortForward`, `pf.updatePortForward`, `pf.removePortForward`, `pf.setNatMode`,
 * `pf.addOutboundNat`, `pf.updateOutboundNat`, `pf.removeOutboundNat`.
 */
import { useState } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import {
  command,
  type PfIfaceKey,
  type PfNatMode,
  type PfOutboundNat,
  type PfPortForward
} from '@engine/index'
import {
  ANY_DRAFT,
  Alert,
  Btn,
  EndpointEditor,
  Field,
  IconBtn,
  Panel,
  PortEditor,
  Table,
  Tabs,
  Td,
  draftToEndpoint,
  draftToPort,
  endpointText,
  endpointToDraft,
  ifaceName,
  inputCls,
  portText,
  portToDraft,
  protocolText,
  useSession,
  IFACE_KEYS,
  type EndpointDraft
} from './ui'

const MODES: { id: PfNatMode; label: string }[] = [
  { id: 'automatic', label: 'Automatic outbound NAT rule generation (no manual rules can be used)' },
  { id: 'hybrid', label: 'Hybrid Outbound NAT rule generation (automatic outbound NAT + rules below)' },
  { id: 'manual', label: 'Manual Outbound NAT rule generation (AON - Advanced Outbound NAT)' },
  { id: 'disabled', label: 'Disable Outbound NAT rule generation (no Outbound NAT rules)' }
]

export function NatPage() {
  const [tab, setTab] = useState<'forward' | 'outbound'>('forward')
  return (
    <div>
      <Tabs
        tabs={[
          { id: 'forward', label: 'Port Forward' },
          { id: 'outbound', label: 'Outbound' }
        ]}
        active={tab}
        onSelect={(id) => setTab(id as 'forward' | 'outbound')}
      />
      {tab === 'forward' ? <PortForwardList /> : <OutboundList />}
    </div>
  )
}

// --- Port Forward ---------------------------------------------------------------------------------

function PortForwardList() {
  const s = useSession()
  const pf = s.firewall.pf
  const [editing, setEditing] = useState<{ id: string | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (editing) return <ForwardForm id={editing.id} onDone={() => setEditing(null)} />
  const forwards = pf.nat.portForwards
  return (
    <Panel title="Firewall / NAT / Port Forward">
      {error && <Alert kind="error">{error}</Alert>}
      <Table
        head={[
          'Interface',
          'Protocol',
          'Dest. Address',
          'Dest. Ports',
          'NAT IP',
          'NAT Ports',
          'Description',
          'Actions'
        ]}
      >
        {forwards.map((f) => (
          <tr key={f.id} className={f.disabled ? 'text-[#888]' : ''} data-testid={`pf-fwd-${f.id}`}>
            <Td>{ifaceName(pf, f.iface)}</Td>
            <Td>{protocolText(f.protocol)}</Td>
            <Td>{endpointText(pf, f.destination)}</Td>
            <Td>{portText(f.destinationPort)}</Td>
            <Td>{f.targetAddress}</Td>
            <Td>{f.targetPort ?? portText(f.destinationPort)}</Td>
            <Td>{f.descr}</Td>
            <Td className="whitespace-nowrap">
              <IconBtn
                title="Edit rule"
                testId={`pf-fwd-edit-${f.id}`}
                onClick={() => setEditing({ id: f.id })}
              >
                <Pencil size={13} />
              </IconBtn>
              <IconBtn
                title="Delete rule"
                testId={`pf-fwd-delete-${f.id}`}
                onClick={() => setError(s.stage(command('pf.removePortForward', s.firewallId, f.id)))}
              >
                <Trash2 size={13} />
              </IconBtn>
            </Td>
          </tr>
        ))}
        {forwards.length === 0 && (
          <tr>
            <Td className="text-[#666]">No port forward rules are currently defined.</Td>
          </tr>
        )}
      </Table>
      <div className="mt-3">
        <Btn testId="pf-fwd-add" onClick={() => setEditing({ id: null })}>
          <Plus size={13} /> Add
        </Btn>
      </div>
    </Panel>
  )
}

function ForwardForm({ id, onDone }: { id: string | null; onDone: () => void }) {
  const s = useSession()
  const pf = s.firewall.pf
  const existing = id ? pf.nat.portForwards.find((f) => f.id === id) : undefined
  const [d, setD] = useState(() => ({
    disabled: existing?.disabled ?? false,
    iface: (existing?.iface ?? 'wan') as PfIfaceKey,
    protocol: (existing?.protocol ?? 'tcp') as PfPortForward['protocol'],
    destination: endpointToDraft(existing?.destination ?? { type: 'interface', key: 'wan', what: 'address' }),
    destinationPort: portToDraft(existing?.destinationPort ?? null),
    targetAddress: existing?.targetAddress ?? '',
    targetPort: existing?.targetPort ? String(existing.targetPort) : '',
    associatedRule: existing?.associatedRule ?? true,
    descr: existing?.descr ?? ''
  }))
  const [error, setError] = useState<string | null>(null)
  const patch = (p: Partial<typeof d>) => setD((x) => ({ ...x, ...p }))
  const save = () => {
    const destinationPort = draftToPort(d.destinationPort)
    const targetPort = d.targetPort.trim() ? Number(d.targetPort) : null
    const common = {
      iface: d.iface,
      protocol: d.protocol,
      destination: draftToEndpoint(d.destination, pf),
      targetAddress: d.targetAddress.trim(),
      targetPort,
      associatedRule: d.associatedRule,
      disabled: d.disabled,
      descr: d.descr
    }
    const err = existing
      ? s.stage(command('pf.updatePortForward', s.firewallId, existing.id, { ...common, destinationPort }))
      : destinationPort
        ? s.stage(command('pf.addPortForward', s.firewallId, { ...common, destinationPort }))
        : 'Indiquez le port de destination à rediriger (Destination port range).'
    if (err) setError(err)
    else onDone()
  }
  return (
    <Panel title={`Firewall / NAT / Port Forward / ${existing ? 'Edit' : 'Add'}`}>
      {error && (
        <Alert kind="error" testId="pf-form-error">
          {error}
        </Alert>
      )}
      <Field label="Disabled">
        <label className="text-[12px]">
          <input
            type="checkbox"
            checked={d.disabled}
            onChange={(e) => patch({ disabled: e.target.checked })}
          />{' '}
          Disable this rule
        </label>
      </Field>
      <Field label="Interface">
        <select
          className={inputCls}
          value={d.iface}
          onChange={(e) => patch({ iface: e.target.value as PfIfaceKey })}
          data-testid="pf-fwd-iface"
        >
          {IFACE_KEYS.map((k) => (
            <option key={k} value={k}>
              {ifaceName(pf, k)}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Protocol">
        <select
          className={inputCls}
          value={d.protocol}
          onChange={(e) => patch({ protocol: e.target.value as PfPortForward['protocol'] })}
          data-testid="pf-fwd-protocol"
        >
          <option value="tcp">TCP</option>
          <option value="udp">UDP</option>
          <option value="tcp/udp">TCP/UDP</option>
        </select>
      </Field>
      <Field label="Destination">
        <EndpointEditor
          value={d.destination}
          onChange={(v) => patch({ destination: v })}
          pf={pf}
          testId="pf-fwd-dst"
        />
      </Field>
      <Field label="Destination port range">
        <PortEditor
          value={d.destinationPort}
          onChange={(v) => patch({ destinationPort: v })}
          testId="pf-fwd-dport"
        />
      </Field>
      <Field
        label="Redirect target IP"
        help="Enter the internal IP address of the server on which to map the ports."
      >
        <input
          className={`${inputCls} w-48`}
          value={d.targetAddress}
          onChange={(e) => patch({ targetAddress: e.target.value })}
          data-testid="pf-fwd-target"
        />
      </Field>
      <Field label="Redirect target port" help="Leave empty to use the destination port.">
        <input
          className={`${inputCls} w-24`}
          value={d.targetPort}
          onChange={(e) => patch({ targetPort: e.target.value })}
          data-testid="pf-fwd-tport"
        />
      </Field>
      <Field label="Description">
        <input
          className={`${inputCls} w-80`}
          value={d.descr}
          onChange={(e) => patch({ descr: e.target.value })}
          data-testid="pf-fwd-descr"
        />
      </Field>
      <Field label="Filter rule association">
        <label className="text-[12px]">
          <input
            type="checkbox"
            checked={d.associatedRule}
            onChange={(e) => patch({ associatedRule: e.target.checked })}
            data-testid="pf-fwd-assoc"
          />{' '}
          Add associated filter rule
        </label>
      </Field>
      <div className="ml-[182px] flex gap-2">
        <Btn testId="pf-form-save" onClick={save}>
          Save
        </Btn>
        <Btn kind="secondary" onClick={onDone}>
          Cancel
        </Btn>
      </div>
    </Panel>
  )
}

// --- Outbound -------------------------------------------------------------------------------------

function OutboundList() {
  const s = useSession()
  const pf = s.firewall.pf
  const [editing, setEditing] = useState<{ id: string | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (editing) return <OutboundForm id={editing.id} onDone={() => setEditing(null)} />
  const manual = pf.nat.outboundMode === 'hybrid' || pf.nat.outboundMode === 'manual'
  return (
    <div>
      {error && <Alert kind="error">{error}</Alert>}
      <Panel title="Firewall / NAT / Outbound / Mode">
        {MODES.map((m) => (
          <label key={m.id} className="mb-1 block text-[12px]">
            <input
              type="radio"
              name="nat-mode"
              checked={pf.nat.outboundMode === m.id}
              onChange={() => setError(s.stage(command('pf.setNatMode', s.firewallId, m.id)))}
              data-testid={`pf-nat-mode-${m.id}`}
            />{' '}
            {m.label}
          </label>
        ))}
      </Panel>
      <Panel title="Mappings">
        <Table head={['Interface', 'Source', 'Destination', 'NAT Address', 'Description', 'Actions']}>
          {pf.nat.outbound.map((o) => (
            <tr key={o.id} className={o.disabled ? 'text-[#888]' : ''} data-testid={`pf-out-${o.id}`}>
              <Td>{ifaceName(pf, o.iface)}</Td>
              <Td>{endpointText(pf, o.source)}</Td>
              <Td>{endpointText(pf, o.destination)}</Td>
              <Td>{o.translation ?? 'Interface address'}</Td>
              <Td>{o.descr}</Td>
              <Td className="whitespace-nowrap">
                <IconBtn
                  title="Edit mapping"
                  testId={`pf-out-edit-${o.id}`}
                  onClick={() => setEditing({ id: o.id })}
                >
                  <Pencil size={13} />
                </IconBtn>
                <IconBtn
                  title="Delete mapping"
                  testId={`pf-out-delete-${o.id}`}
                  onClick={() => setError(s.stage(command('pf.removeOutboundNat', s.firewallId, o.id)))}
                >
                  <Trash2 size={13} />
                </IconBtn>
              </Td>
            </tr>
          ))}
          {pf.nat.outbound.length === 0 && (
            <tr>
              <Td className="text-[#666]">No manual outbound NAT mappings are defined.</Td>
            </tr>
          )}
        </Table>
        {!manual && pf.nat.outbound.length > 0 && (
          <p className="mt-2 text-[11px] text-[#666]">
            These mappings are ignored in {pf.nat.outboundMode} mode: choose Hybrid or Manual to use them.
          </p>
        )}
        <div className="mt-3">
          <Btn testId="pf-out-add" onClick={() => setEditing({ id: null })}>
            <Plus size={13} /> Add
          </Btn>
        </div>
      </Panel>
    </div>
  )
}

function OutboundForm({ id, onDone }: { id: string | null; onDone: () => void }) {
  const s = useSession()
  const pf = s.firewall.pf
  const existing: PfOutboundNat | undefined = id ? pf.nat.outbound.find((o) => o.id === id) : undefined
  const [d, setD] = useState(() => ({
    disabled: existing?.disabled ?? false,
    iface: (existing?.iface ?? 'wan') as PfIfaceKey,
    source: endpointToDraft(existing?.source ?? { type: 'interface', key: 'lan', what: 'net' }),
    destination: existing ? endpointToDraft(existing.destination) : (ANY_DRAFT as EndpointDraft),
    translation: existing?.translation ?? '',
    descr: existing?.descr ?? ''
  }))
  const [error, setError] = useState<string | null>(null)
  const patch = (p: Partial<typeof d>) => setD((x) => ({ ...x, ...p }))
  const save = () => {
    const body = {
      iface: d.iface,
      source: draftToEndpoint(d.source, pf),
      destination: draftToEndpoint(d.destination, pf),
      translation: d.translation.trim() || null,
      disabled: d.disabled,
      descr: d.descr
    }
    const err = existing
      ? s.stage(command('pf.updateOutboundNat', s.firewallId, existing.id, body))
      : s.stage(command('pf.addOutboundNat', s.firewallId, body))
    if (err) setError(err)
    else onDone()
  }
  return (
    <Panel title={`Firewall / NAT / Outbound / ${existing ? 'Edit' : 'Add'}`}>
      {error && (
        <Alert kind="error" testId="pf-form-error">
          {error}
        </Alert>
      )}
      <Field label="Disabled">
        <label className="text-[12px]">
          <input
            type="checkbox"
            checked={d.disabled}
            onChange={(e) => patch({ disabled: e.target.checked })}
          />{' '}
          Disable this rule
        </label>
      </Field>
      <Field label="Interface">
        <select
          className={inputCls}
          value={d.iface}
          onChange={(e) => patch({ iface: e.target.value as PfIfaceKey })}
          data-testid="pf-out-iface"
        >
          {IFACE_KEYS.map((k) => (
            <option key={k} value={k}>
              {ifaceName(pf, k)}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Source">
        <EndpointEditor value={d.source} onChange={(v) => patch({ source: v })} pf={pf} testId="pf-out-src" />
      </Field>
      <Field label="Destination">
        <EndpointEditor
          value={d.destination}
          onChange={(v) => patch({ destination: v })}
          pf={pf}
          testId="pf-out-dst"
        />
      </Field>
      <Field
        label="Translation address"
        help="Leave empty to use the address of the outgoing interface (Interface address)."
      >
        <input
          className={`${inputCls} w-48`}
          value={d.translation}
          onChange={(e) => patch({ translation: e.target.value })}
          data-testid="pf-out-translation"
        />
      </Field>
      <Field label="Description">
        <input
          className={`${inputCls} w-80`}
          value={d.descr}
          onChange={(e) => patch({ descr: e.target.value })}
        />
      </Field>
      <div className="ml-[182px] flex gap-2">
        <Btn testId="pf-form-save" onClick={save}>
          Save
        </Btn>
        <Btn kind="secondary" onClick={onDone}>
          Cancel
        </Btn>
      </div>
    </Panel>
  )
}
