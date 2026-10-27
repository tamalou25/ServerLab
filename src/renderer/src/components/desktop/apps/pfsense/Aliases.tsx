/**
 * Firewall > Aliases : hôtes, réseaux et ports nommés (commandes `pf.setAlias` / `pf.removeAlias`).
 */
import { useState } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { command, type PfAlias } from '@engine/index'
import { Alert, Btn, Field, IconBtn, Panel, Table, Td, inputCls, useSession } from './ui'

const TYPE_LABEL: Record<PfAlias['type'], string> = {
  host: 'Host(s)',
  network: 'Network(s)',
  port: 'Port(s)'
}

export function AliasesPage() {
  const s = useSession()
  const pf = s.firewall.pf
  const [editing, setEditing] = useState<{ name: string | null } | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (editing) return <AliasForm name={editing.name} onDone={() => setEditing(null)} />

  const remove = (name: string) => setError(s.stage(command('pf.removeAlias', s.firewallId, name)))
  return (
    <div>
      {error && <Alert kind="error">{error}</Alert>}
      <Panel title="Firewall / Aliases / IP">
        <Table head={['Name', 'Type', 'Values', 'Description', 'Actions']}>
          {pf.aliases.map((a) => (
            <tr key={a.name} data-testid={`pf-alias-${a.name}`}>
              <Td>{a.name}</Td>
              <Td>{TYPE_LABEL[a.type]}</Td>
              <Td>{a.values.join(', ')}</Td>
              <Td>{a.descr}</Td>
              <Td className="whitespace-nowrap">
                <IconBtn
                  title="Edit alias"
                  testId={`pf-alias-edit-${a.name}`}
                  onClick={() => setEditing({ name: a.name })}
                >
                  <Pencil size={13} />
                </IconBtn>
                <IconBtn
                  title="Delete alias"
                  testId={`pf-alias-delete-${a.name}`}
                  onClick={() => remove(a.name)}
                >
                  <Trash2 size={13} />
                </IconBtn>
              </Td>
            </tr>
          ))}
          {pf.aliases.length === 0 && (
            <tr>
              <Td className="text-[#666]">No aliases are currently defined.</Td>
            </tr>
          )}
        </Table>
        <div className="mt-3">
          <Btn testId="pf-alias-add" onClick={() => setEditing({ name: null })}>
            <Plus size={13} /> Add
          </Btn>
        </div>
      </Panel>
    </div>
  )
}

function AliasForm({ name, onDone }: { name: string | null; onDone: () => void }) {
  const s = useSession()
  const existing = name ? s.firewall.pf.aliases.find((a) => a.name === name) : undefined
  const [d, setD] = useState({
    name: existing?.name ?? '',
    type: existing?.type ?? ('host' as PfAlias['type']),
    values: (existing?.values ?? []).join('\n'),
    descr: existing?.descr ?? ''
  })
  const [error, setError] = useState<string | null>(null)
  const save = () => {
    const alias: PfAlias = {
      name: d.name.trim(),
      type: d.type,
      values: d.values
        .split(/[\n,\s]+/)
        .map((v) => v.trim())
        .filter(Boolean),
      descr: d.descr
    }
    const err = s.stage(command('pf.setAlias', s.firewallId, alias))
    if (err) setError(err)
    else onDone()
  }
  return (
    <Panel title={`Firewall / Aliases / ${existing ? 'Edit' : 'Add'}`}>
      {error && (
        <Alert kind="error" testId="pf-form-error">
          {error}
        </Alert>
      )}
      <Field
        label="Name"
        help="The name of the alias may only consist of the characters a-z, A-Z, 0-9 and _."
      >
        <input
          className={`${inputCls} w-60`}
          value={d.name}
          disabled={!!existing}
          onChange={(e) => setD({ ...d, name: e.target.value })}
          data-testid="pf-alias-name"
        />
      </Field>
      <Field label="Description">
        <input
          className={`${inputCls} w-80`}
          value={d.descr}
          onChange={(e) => setD({ ...d, descr: e.target.value })}
          data-testid="pf-alias-descr"
        />
      </Field>
      <Field label="Type">
        <select
          className={inputCls}
          value={d.type}
          onChange={(e) => setD({ ...d, type: e.target.value as PfAlias['type'] })}
          data-testid="pf-alias-type"
        >
          <option value="host">Host(s)</option>
          <option value="network">Network(s)</option>
          <option value="port">Port(s)</option>
        </select>
      </Field>
      <Field
        label="Values"
        help={
          d.type === 'port'
            ? 'One port or range (80, 8000:8080) per line.'
            : d.type === 'network'
              ? 'One network (192.168.10.0/24) or alias per line.'
              : 'One address or alias per line.'
        }
      >
        <textarea
          className={`${inputCls} h-24 w-80 py-1`}
          value={d.values}
          onChange={(e) => setD({ ...d, values: e.target.value })}
          data-testid="pf-alias-values"
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
