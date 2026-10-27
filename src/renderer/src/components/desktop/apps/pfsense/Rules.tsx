/**
 * Firewall > Rules : un onglet par interface, ajout / modification / ordre / désactivation / suppression.
 * Les modifications passent par les commandes `pf.*` et attendent « Apply Changes » (voir PfSenseWeb).
 */
import { useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Ban,
  Check,
  CircleCheck,
  CircleX,
  Lock,
  Pencil,
  Plus,
  Trash2
} from 'lucide-react'
import {
  PF_ANTI_LOCKOUT_PORTS,
  PF_RULE_ACTIONS,
  command,
  type PfIfaceKey,
  type PfRule,
  type PfRuleInput
} from '@engine/index'
import {
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
  type EndpointDraft,
  type PortDraft
} from './ui'

const ACTION_LABEL: Record<(typeof PF_RULE_ACTIONS)[number], string> = {
  pass: 'Pass',
  block: 'Block',
  reject: 'Reject'
}

export function RulesPage() {
  const s = useSession()
  const pf = s.firewall.pf
  const [tab, setTab] = useState<PfIfaceKey>('lan')
  const [editing, setEditing] = useState<{ id: string | null; before: string | null } | null>(null)
  const [listError, setListError] = useState<string | null>(null)

  if (editing)
    return (
      <RuleForm iface={tab} ruleId={editing.id} before={editing.before} onDone={() => setEditing(null)} />
    )

  const rules = pf.rules.filter((r) => r.iface === tab)
  const assignment = pf.assignments.find((a) => a.key === tab)
  const move = (rule: PfRule, dir: -1 | 1) => {
    const i = rules.findIndex((r) => r.id === rule.id)
    // « Vers le haut » : juste avant la règle précédente ; « vers le bas » : juste avant la règle qui suit la suivante
    const before = dir === -1 ? rules[i - 1]?.id : (rules[i + 2]?.id ?? null)
    if (before === undefined) return
    const err = s.stage(command('pf.moveRule', s.firewallId, rule.id, before))
    if (err) setListError(err)
  }
  const remove = (rule: PfRule) => {
    const err = s.stage(command('pf.removeRule', s.firewallId, rule.id))
    if (err) setListError(err)
  }
  const toggle = (rule: PfRule) =>
    s.stage(command('pf.updateRule', s.firewallId, rule.id, { disabled: !rule.disabled }))

  return (
    <div>
      <Tabs
        tabs={IFACE_KEYS.map((k) => ({ id: k, label: ifaceName(pf, k) }))}
        active={tab}
        onSelect={(id) => setTab(id as PfIfaceKey)}
      />
      {listError && <Alert kind="error">{listError}</Alert>}
      <Panel title="Rules (Drag to Change Order)">
        <Table head={['', 'Protocol', 'Source', 'Port', 'Destination', 'Port', 'Description', 'Actions']}>
          {tab === 'lan' && (
            <tr className="bg-[#f6f7f9]" data-testid="pf-rule-antilockout">
              <Td>
                <Lock size={13} className="text-[#1f7a3a]" />
              </Td>
              <Td>IPv4 TCP</Td>
              <Td>*</Td>
              <Td>*</Td>
              <Td>{ifaceName(pf, 'lan')} address</Td>
              <Td>{PF_ANTI_LOCKOUT_PORTS.join(', ')}</Td>
              <Td>Anti-Lockout Rule</Td>
              <Td />
            </tr>
          )}
          {tab === 'wan' && assignment?.blockPrivate && (
            <tr className="bg-[#f6f7f9]" data-testid="pf-rule-blockprivate">
              <Td>
                <CircleX size={13} className="text-[#b3261e]" />
              </Td>
              <Td>*</Td>
              <Td>RFC 1918 networks</Td>
              <Td>*</Td>
              <Td>*</Td>
              <Td>*</Td>
              <Td>Block private networks</Td>
              <Td />
            </tr>
          )}
          {tab === 'wan' && assignment?.blockBogons && (
            <tr className="bg-[#f6f7f9]" data-testid="pf-rule-blockbogons">
              <Td>
                <CircleX size={13} className="text-[#b3261e]" />
              </Td>
              <Td>*</Td>
              <Td>Reserved/not assigned by IANA</Td>
              <Td>*</Td>
              <Td>*</Td>
              <Td>*</Td>
              <Td>Block bogon networks</Td>
              <Td />
            </tr>
          )}
          {rules.map((rule, i) => (
            <tr
              key={rule.id}
              className={rule.disabled ? 'bg-[#f1f1f1] text-[#888]' : ''}
              data-testid={`pf-rule-${rule.id}`}
            >
              <Td>
                {rule.action === 'pass' ? (
                  <CircleCheck size={14} className="text-[#1f7a3a]" aria-label="Pass" />
                ) : (
                  <CircleX size={14} className="text-[#b3261e]" aria-label={ACTION_LABEL[rule.action]} />
                )}
              </Td>
              <Td>{protocolText(rule.protocol)}</Td>
              <Td>{endpointText(pf, rule.source)}</Td>
              <Td>{portText(rule.sourcePort)}</Td>
              <Td>{endpointText(pf, rule.destination)}</Td>
              <Td>{portText(rule.destinationPort)}</Td>
              <Td>{rule.descr}</Td>
              <Td className="whitespace-nowrap">
                <IconBtn
                  title="Edit rule"
                  testId={`pf-rule-edit-${rule.id}`}
                  onClick={() => setEditing({ id: rule.id, before: null })}
                >
                  <Pencil size={13} />
                </IconBtn>
                {i > 0 && (
                  <IconBtn
                    title="Move rule up"
                    testId={`pf-rule-up-${rule.id}`}
                    onClick={() => move(rule, -1)}
                  >
                    <ArrowUp size={13} />
                  </IconBtn>
                )}
                {i < rules.length - 1 && (
                  <IconBtn
                    title="Move rule down"
                    testId={`pf-rule-down-${rule.id}`}
                    onClick={() => move(rule, 1)}
                  >
                    <ArrowDown size={13} />
                  </IconBtn>
                )}
                <IconBtn
                  title={rule.disabled ? 'Enable rule' : 'Disable rule'}
                  testId={`pf-rule-toggle-${rule.id}`}
                  onClick={() => toggle(rule)}
                >
                  {rule.disabled ? <Check size={13} /> : <Ban size={13} />}
                </IconBtn>
                <IconBtn
                  title="Delete rule"
                  testId={`pf-rule-delete-${rule.id}`}
                  onClick={() => remove(rule)}
                >
                  <Trash2 size={13} />
                </IconBtn>
              </Td>
            </tr>
          ))}
          {rules.length === 0 && tab !== 'lan' && (
            <tr>
              <Td className="text-[#666]">
                No rules are currently defined for this interface. All incoming connections on this interface
                will be blocked until pass rules are added.
              </Td>
            </tr>
          )}
        </Table>
        <div className="mt-3 flex gap-2">
          <Btn
            testId="pf-rule-add-top"
            onClick={() => setEditing({ id: null, before: rules[0]?.id ?? null })}
          >
            <Plus size={13} /> Add
          </Btn>
          <Btn testId="pf-rule-add" kind="secondary" onClick={() => setEditing({ id: null, before: null })}>
            <Plus size={13} /> Add (bottom)
          </Btn>
        </div>
      </Panel>
    </div>
  )
}

interface RuleDraft {
  action: PfRule['action']
  disabled: boolean
  protocol: PfRule['protocol']
  source: EndpointDraft
  sourcePort: PortDraft
  destination: EndpointDraft
  destinationPort: PortDraft
  log: boolean
  descr: string
}

function RuleForm({
  iface,
  ruleId,
  before,
  onDone
}: {
  iface: PfIfaceKey
  ruleId: string | null
  before: string | null
  onDone: () => void
}) {
  const s = useSession()
  const pf = s.firewall.pf
  const existing = ruleId ? pf.rules.find((r) => r.id === ruleId) : undefined
  const [d, setD] = useState<RuleDraft>(() => ({
    action: existing?.action ?? 'pass',
    disabled: existing?.disabled ?? false,
    protocol: existing?.protocol ?? 'tcp',
    source: endpointToDraft(existing?.source ?? { type: 'any' }),
    sourcePort: portToDraft(existing?.sourcePort ?? null),
    destination: endpointToDraft(existing?.destination ?? { type: 'any' }),
    destinationPort: portToDraft(existing?.destinationPort ?? null),
    log: existing?.log ?? false,
    descr: existing?.descr ?? ''
  }))
  const [error, setError] = useState<string | null>(null)
  const patch = (p: Partial<RuleDraft>) => setD((x) => ({ ...x, ...p }))
  const hasPorts = d.protocol === 'tcp' || d.protocol === 'udp' || d.protocol === 'tcp/udp'

  const save = () => {
    const input: PfRuleInput = {
      iface,
      action: d.action,
      disabled: d.disabled,
      protocol: d.protocol,
      source: draftToEndpoint(d.source, pf),
      sourcePort: hasPorts ? draftToPort(d.sourcePort) : null,
      destination: draftToEndpoint(d.destination, pf),
      destinationPort: hasPorts ? draftToPort(d.destinationPort) : null,
      log: d.log,
      descr: d.descr
    }
    const { iface: _i, ...rest } = input
    void _i
    const err = existing
      ? s.stage(command('pf.updateRule', s.firewallId, existing.id, rest))
      : s.stage(command('pf.addRule', s.firewallId, input, before))
    if (err) setError(err)
    else onDone()
  }

  return (
    <Panel title={`Firewall / Rules / ${existing ? 'Edit' : 'Add'} (${ifaceName(pf, iface)})`}>
      {error && (
        <Alert kind="error" testId="pf-form-error">
          {error}
        </Alert>
      )}
      <Field
        label="Action"
        help="Choose what to do with packets that match the criteria specified below. Hint: the difference between block and reject is that with reject, a packet (TCP RST or ICMP port unreachable for UDP) is returned to the sender, whereas with block the packet is dropped silently."
      >
        <select
          className={inputCls}
          value={d.action}
          onChange={(e) => patch({ action: e.target.value as PfRule['action'] })}
          data-testid="pf-rule-action"
        >
          {PF_RULE_ACTIONS.map((a) => (
            <option key={a} value={a}>
              {ACTION_LABEL[a]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Disabled">
        <label className="text-[12px]">
          <input
            type="checkbox"
            checked={d.disabled}
            onChange={(e) => patch({ disabled: e.target.checked })}
            data-testid="pf-rule-disabled"
          />{' '}
          Disable this rule
        </label>
      </Field>
      <Field label="Interface">
        <span className="text-[13px]">{ifaceName(pf, iface)}</span>
      </Field>
      <Field label="Protocol">
        <select
          className={inputCls}
          value={d.protocol}
          onChange={(e) => patch({ protocol: e.target.value as PfRule['protocol'] })}
          data-testid="pf-rule-protocol"
        >
          <option value="any">Any</option>
          <option value="tcp">TCP</option>
          <option value="udp">UDP</option>
          <option value="tcp/udp">TCP/UDP</option>
          <option value="icmp">ICMP</option>
        </select>
      </Field>
      <Field label="Source">
        <EndpointEditor
          value={d.source}
          onChange={(v) => patch({ source: v })}
          pf={pf}
          testId="pf-rule-src"
        />
      </Field>
      {hasPorts && (
        <Field label="Source Port Range" help="Not evaluated by the simulator (ephemeral source ports).">
          <PortEditor
            value={d.sourcePort}
            onChange={(v) => patch({ sourcePort: v })}
            testId="pf-rule-sport"
          />
        </Field>
      )}
      <Field label="Destination">
        <EndpointEditor
          value={d.destination}
          onChange={(v) => patch({ destination: v })}
          pf={pf}
          testId="pf-rule-dst"
        />
      </Field>
      {hasPorts && (
        <Field label="Destination Port Range">
          <PortEditor
            value={d.destinationPort}
            onChange={(v) => patch({ destinationPort: v })}
            testId="pf-rule-dport"
          />
        </Field>
      )}
      <Field label="Log" help="Log packets that are handled by this rule (Status > System Logs > Firewall).">
        <label className="text-[12px]">
          <input
            type="checkbox"
            checked={d.log}
            onChange={(e) => patch({ log: e.target.checked })}
            data-testid="pf-rule-log"
          />{' '}
          Log packets that are handled by this rule
        </label>
      </Field>
      <Field label="Description">
        <input
          className={`${inputCls} w-80`}
          value={d.descr}
          onChange={(e) => patch({ descr: e.target.value })}
          data-testid="pf-rule-descr"
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
