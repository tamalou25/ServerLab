/**
 * Onglets accessibles (`tablist` / `tab`) : flèches, Origine et Fin déplacent le focus et la sélection,
 * un seul onglet dans l'ordre de tabulation. Deux apparences : soulignement (panneaux) ou pastilles.
 */
import { type KeyboardEvent, type ReactNode } from 'react'

export interface TabItem<T extends string> {
  id: T
  label: ReactNode
  /** Identifiant de test de l'onglet (`data-testid`). */
  testId?: string
  disabled?: boolean
}

export interface TabsProps<T extends string> {
  items: readonly TabItem<T>[]
  value: T
  onChange: (id: T) => void
  /** Nom accessible de la liste. */
  label: string
  variant?: 'underline' | 'pills'
  className?: string
  /** Contenu à droite des onglets (bouton Élargir, fermeture…). */
  trailing?: ReactNode
  testId?: string
}

export function Tabs<T extends string>({
  items,
  value,
  onChange,
  label,
  variant = 'underline',
  className = '',
  trailing,
  testId
}: TabsProps<T>) {
  const enabled = items.filter((i) => !i.disabled)
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const index = enabled.findIndex((i) => i.id === value)
    if (index < 0 || enabled.length === 0) return
    let next: number
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (index + 1) % enabled.length
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp')
      next = (index + enabled.length - 1) % enabled.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = enabled.length - 1
    else return
    e.preventDefault()
    const target = enabled[next]!
    onChange(target.id)
    const el = e.currentTarget.querySelector<HTMLElement>(`[role="tab"][data-tab="${target.id}"]`)
    el?.focus()
  }
  const base =
    variant === 'underline'
      ? 'h-full border-b-2 px-0.5 text-dense font-semibold transition-colors'
      : 'rounded-control px-2.5 py-1 text-dense font-medium transition-colors'
  const on = variant === 'underline' ? 'border-accent text-fg' : 'bg-accent-soft text-accent-text'
  const off =
    variant === 'underline'
      ? 'border-transparent text-fg-subtle hover:text-fg-muted'
      : 'text-fg-muted hover:bg-surface-2 hover:text-fg'
  return (
    <div
      className={`flex items-center ${variant === 'underline' ? 'gap-2 border-b border-line' : 'gap-1'} ${className}`}
      data-testid={testId}
    >
      <div
        role="tablist"
        aria-label={label}
        onKeyDown={onKeyDown}
        className={`flex min-w-0 items-stretch overflow-x-auto [scrollbar-width:none] ${variant === 'underline' ? 'h-full gap-2' : 'gap-1'}`}
      >
        {items.map((item) => {
          const selected = item.id === value
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              data-tab={item.id}
              aria-selected={selected}
              aria-disabled={item.disabled || undefined}
              disabled={item.disabled}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(item.id)}
              data-testid={item.testId}
              className={`${base} whitespace-nowrap disabled:opacity-50 ${selected ? on : off}`}
            >
              {item.label}
            </button>
          )
        })}
      </div>
      {trailing && <div className="ml-auto flex shrink-0 items-center gap-1 pl-2">{trailing}</div>}
    </div>
  )
}
