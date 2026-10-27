/**
 * Éléments d'interface communs de l'interface web du pare-feu (webConfigurator simulé) : panneaux,
 * boutons, champs, tableaux, éditeur de source / destination et de ports.
 * Palette « système » fixe du Bureau simulé (voir CLAUDE.md : components/desktop garde ses couleurs).
 */
import { createContext, useContext, type ReactNode } from 'react'
import {
  PF_IFACE_KEYS,
  describeEndpoint,
  type AnyCommand,
  type LabState,
  type PfDevice,
  type PfEndpoint,
  type PfIfaceKey,
  type PfPortRange,
  type PfState
} from '@engine/index'

/** Contexte de la session d'administration : état prévisualisé et modifications en attente. */
export interface PfSession {
  /** Identifiant du pare-feu administré. */
  firewallId: string
  /** État du lab avec les modifications en attente (ce que montrent les pages). */
  lab: LabState
  /** Pare-feu dans l'état prévisualisé. */
  firewall: PfDevice
  /** Met une commande en attente (« Save ») ; renvoie le message d'erreur du moteur, ou null. */
  stage(command: AnyCommand): string | null
  /** Exécute tout de suite une commande qui n'exige pas « Apply Changes » (vider le journal, états). */
  now(command: AnyCommand): boolean
  /** Nombre de modifications en attente. */
  pending: number
  navigate(page: PfPage): void
}

export type PfPage =
  | 'dashboard'
  | 'interfaces'
  | 'interface:wan'
  | 'interface:lan'
  | 'interface:opt1'
  | 'rules'
  | 'aliases'
  | 'nat'
  | 'logs'
  | 'states'
  | 'dhcp'
  | 'dns'
  | 'routing'

export const SessionContext = createContext<PfSession | null>(null)

export function useSession(): PfSession {
  const s = useContext(SessionContext)
  if (!s) throw new Error('Session pfSense absente')
  return s
}

/** Nom affiché d'une interface logique : sa description (WAN, LAN, DMZ…). */
export function ifaceName(pf: PfState, key: PfIfaceKey): string {
  const a = pf.assignments.find((x) => x.key === key)
  return a?.descr || key.toUpperCase()
}

export const IFACE_KEYS = PF_IFACE_KEYS

export const inputCls =
  'h-7 rounded border border-[#c9ced6] bg-white px-2 text-[13px] text-[#1b1b1b] outline-none focus:border-[#2d5aa3]'

export function Panel({
  title,
  children,
  actions
}: {
  title: string
  children: ReactNode
  actions?: ReactNode
}) {
  return (
    <section className="mb-4 rounded border border-[#c9ced6] bg-white">
      <header className="flex items-center justify-between bg-[#1e3f75] px-3 py-1.5 text-[13px] font-semibold text-white">
        <h2>{title}</h2>
        {actions}
      </header>
      <div className="p-3">{children}</div>
    </section>
  )
}

export function Btn({
  children,
  onClick,
  kind = 'primary',
  testId,
  type = 'button',
  title
}: {
  children: ReactNode
  onClick?: () => void
  kind?: 'primary' | 'secondary' | 'danger' | 'success'
  testId?: string
  type?: 'button' | 'submit'
  title?: string
}) {
  const color = {
    primary: 'bg-[#2d5aa3] hover:bg-[#244a88]',
    secondary: 'bg-[#6b7280] hover:bg-[#565c68]',
    danger: 'bg-[#b3261e] hover:bg-[#8f1e18]',
    success: 'bg-[#1f7a3a] hover:bg-[#186230]'
  }[kind]
  return (
    <button
      type={type}
      title={title}
      onClick={onClick}
      data-testid={testId}
      className={`inline-flex h-7 items-center gap-1 rounded px-3 text-[12px] font-medium text-white ${color}`}
    >
      {children}
    </button>
  )
}

/** Petit bouton d'action d'une ligne de tableau. */
export function IconBtn({
  children,
  onClick,
  title,
  testId
}: {
  children: ReactNode
  onClick: () => void
  title: string
  testId?: string
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      data-testid={testId}
      className="rounded p-1 text-[#2d5aa3] hover:bg-[#e6ecf6]"
    >
      {children}
    </button>
  )
}

export function Field({ label, children, help }: { label: string; children: ReactNode; help?: string }) {
  return (
    <div className="mb-2 grid grid-cols-[170px_1fr] items-start gap-3">
      <label className="pt-1 text-right text-[12px] font-semibold text-[#333]">{label}</label>
      <div>
        {children}
        {help && <p className="mt-0.5 text-[11px] text-[#666]">{help}</p>}
      </div>
    </div>
  )
}

export function Alert({
  kind,
  children,
  testId
}: {
  kind: 'info' | 'warn' | 'error' | 'ok'
  children: ReactNode
  testId?: string
}) {
  const color = {
    info: 'border-[#9db7e0] bg-[#eaf0fa] text-[#1e3f75]',
    warn: 'border-[#e0c97a] bg-[#fdf6dc] text-[#6b5400]',
    error: 'border-[#e0a3a0] bg-[#fbeceb] text-[#8f1e18]',
    ok: 'border-[#9fd3ac] bg-[#e9f6ec] text-[#186230]'
  }[kind]
  return (
    <div role="alert" data-testid={testId} className={`mb-3 rounded border px-3 py-2 text-[12px] ${color}`}>
      {children}
    </div>
  )
}

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr className="border-b border-[#c9ced6] bg-[#f1f3f6] text-left">
            {head.map((h, i) => (
              <th key={`${h}-${i}`} className="px-2 py-1 font-semibold text-[#333]">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

export const Td = ({ children, className = '' }: { children?: ReactNode; className?: string }) => (
  <td className={`border-b border-[#e3e6eb] px-2 py-1 align-middle ${className}`}>{children}</td>
)

export function Tabs({
  tabs,
  active,
  onSelect
}: {
  tabs: { id: string; label: string }[]
  active: string
  onSelect: (id: string) => void
}) {
  return (
    <div className="mb-3 flex gap-px border-b border-[#c9ced6]" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={t.id === active}
          data-testid={`pf-tab-${t.id}`}
          onClick={() => onSelect(t.id)}
          className={`px-3 py-1.5 text-[12px] ${
            t.id === active
              ? 'rounded-t border border-b-white border-[#c9ced6] bg-white font-semibold text-[#1e3f75]'
              : 'text-[#2d5aa3] hover:bg-[#e6ecf6]'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

// --- Source / destination et ports --------------------------------------------------------------------

/** Brouillon de l'éditeur : type de la liste déroulante et texte saisi. */
export interface EndpointDraft {
  kind: string
  text: string
  prefix: string
}

export const ANY_DRAFT: EndpointDraft = { kind: 'any', text: '', prefix: '24' }

export function endpointToDraft(ep: PfEndpoint): EndpointDraft {
  switch (ep.type) {
    case 'any':
      return ANY_DRAFT
    case 'address':
      return { kind: 'host', text: ep.address, prefix: '24' }
    case 'alias':
      return { kind: 'host', text: ep.name, prefix: '24' }
    case 'network':
      return { kind: 'network', text: ep.address, prefix: String(ep.prefixLength) }
    case 'interface':
      return { kind: `${ep.key}:${ep.what}`, text: '', prefix: '24' }
  }
}

/** Brouillon → point de terminaison ; « host » devient un alias s'il en porte le nom. */
export function draftToEndpoint(d: EndpointDraft, pf: PfState): PfEndpoint {
  if (d.kind === 'any') return { type: 'any' }
  if (d.kind === 'host') {
    const text = d.text.trim()
    return pf.aliases.some((a) => a.name === text)
      ? { type: 'alias', name: text }
      : { type: 'address', address: text }
  }
  if (d.kind === 'network')
    return { type: 'network', address: d.text.trim(), prefixLength: Number(d.prefix) || 0 }
  const [key, what] = d.kind.split(':') as [PfIfaceKey, 'net' | 'address']
  return { type: 'interface', key, what }
}

export function EndpointEditor({
  value,
  onChange,
  pf,
  testId
}: {
  value: EndpointDraft
  onChange: (v: EndpointDraft) => void
  pf: PfState
  testId: string
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        className={inputCls}
        value={value.kind}
        onChange={(e) => onChange({ ...value, kind: e.target.value })}
        data-testid={`${testId}-kind`}
      >
        <option value="any">Any</option>
        <option value="host">Address or Alias</option>
        <option value="network">Network</option>
        {PF_IFACE_KEYS.map((k) => (
          <option key={`${k}:net`} value={`${k}:net`}>
            {ifaceName(pf, k)} net
          </option>
        ))}
        {PF_IFACE_KEYS.map((k) => (
          <option key={`${k}:address`} value={`${k}:address`}>
            {ifaceName(pf, k)} address
          </option>
        ))}
      </select>
      {(value.kind === 'host' || value.kind === 'network') && (
        <input
          className={`${inputCls} w-40`}
          value={value.text}
          onChange={(e) => onChange({ ...value, text: e.target.value })}
          aria-label="Address"
          data-testid={`${testId}-text`}
        />
      )}
      {value.kind === 'network' && (
        <select
          className={inputCls}
          value={value.prefix}
          onChange={(e) => onChange({ ...value, prefix: e.target.value })}
          aria-label="Mask"
        >
          {Array.from({ length: 33 }, (_, i) => 32 - i).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      )}
    </div>
  )
}

export interface PortDraft {
  from: string
  to: string
}

export const portToDraft = (r: PfPortRange): PortDraft =>
  r ? { from: String(r.from), to: String(r.to) } : { from: '', to: '' }

/** Brouillon → plage ; « to » vide = port unique ; tout vide = tous les ports. */
export function draftToPort(d: PortDraft): PfPortRange {
  const from = Number(d.from)
  if (!d.from.trim() || !Number.isInteger(from)) return null
  const to = d.to.trim() ? Number(d.to) : from
  return { from, to: Number.isInteger(to) ? to : from }
}

export function PortEditor({
  value,
  onChange,
  testId
}: {
  value: PortDraft
  onChange: (v: PortDraft) => void
  testId: string
}) {
  return (
    <div className="flex items-center gap-2">
      <input
        className={`${inputCls} w-20`}
        placeholder="from"
        aria-label="Port from"
        value={value.from}
        onChange={(e) => onChange({ ...value, from: e.target.value })}
        data-testid={`${testId}-from`}
      />
      <span className="text-[12px] text-[#666]">to</span>
      <input
        className={`${inputCls} w-20`}
        placeholder="to"
        aria-label="Port to"
        value={value.to}
        onChange={(e) => onChange({ ...value, to: e.target.value })}
        data-testid={`${testId}-to`}
      />
    </div>
  )
}

// --- Affichage ------------------------------------------------------------------------------------

export function portText(r: PfPortRange): string {
  if (!r) return '*'
  return r.from === r.to ? String(r.from) : `${r.from} - ${r.to}`
}

export function endpointText(pf: PfState, ep: PfEndpoint): string {
  const text = describeEndpoint(pf, ep)
  return text === 'any' ? '*' : text
}

export function protocolText(p: string): string {
  return p === 'any' ? 'IPv4 *' : `IPv4 ${p.toUpperCase()}`
}
