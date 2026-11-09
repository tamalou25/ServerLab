/**
 * Petits composants d'interface réutilisables.
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react'

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'ghostDanger'
type Size = 'sm' | 'md'

const SIZES: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-dense',
  md: 'h-8 px-3 text-dense'
}

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-on-accent hover:bg-accent-hover disabled:opacity-50',
  secondary:
    'border border-line-strong bg-surface text-fg hover:bg-surface-2 disabled:text-fg-subtle disabled:hover:bg-surface',
  danger: 'bg-danger text-on-danger hover:brightness-110 disabled:opacity-50',
  ghost: 'text-fg-muted hover:bg-surface-2 hover:text-fg disabled:text-fg-subtle',
  ghostDanger: 'text-danger-text hover:bg-danger-soft disabled:opacity-50'
}

export function Button({
  variant = 'secondary',
  size = 'md',
  iconOnly = false,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant
  size?: Size
  /** Bouton à icône seule (carré) : `aria-label` obligatoire. */
  iconOnly?: boolean
}) {
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex items-center justify-center gap-1.5 rounded-control font-medium transition-colors disabled:cursor-not-allowed ${
        iconOnly ? (size === 'sm' ? 'h-7 w-7' : 'h-8 w-8') : SIZES[size]
      } ${VARIANTS[variant]} ${className}`}
    />
  )
}

export function Section({
  title,
  children,
  actions
}: {
  title: string
  children: ReactNode
  actions?: ReactNode
}) {
  return (
    <section className="border-b border-line px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-meta font-semibold tracking-wider text-fg-subtle uppercase">{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  )
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-dense text-fg-muted">
      <span className="font-medium">{label}</span>
      {children}
    </label>
  )
}

export const inputClass =
  'h-8 w-full rounded-control border border-line-strong bg-surface px-2 text-ui text-fg outline-none placeholder:text-fg-subtle focus:border-accent focus:ring-2 focus:ring-accent/25 disabled:bg-surface-2 disabled:text-fg-subtle'

/** Pastille colorée d'état. */
export function StatusDot({ status }: { status: 'up' | 'degraded' | 'down' | 'none' }) {
  const color =
    status === 'up'
      ? 'bg-ok'
      : status === 'degraded'
        ? 'bg-warn'
        : status === 'down'
          ? 'bg-danger'
          : 'bg-fg-subtle/50'
  return <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${color}`} />
}
