/**
 * Commande segmentée (`radiogroup`) : un choix parmi quelques segments à icône et libellé
 * (Temps réel / Simulation, Sujet / Correction). Flèches pour changer de segment.
 */
import { type KeyboardEvent, type ReactNode } from 'react'

export interface SegmentItem<T extends string> {
  id: T
  label: ReactNode
  icon?: ReactNode
  title?: string
  testId?: string
  /** Couleurs du segment actif (par défaut : accent). */
  tone?: 'accent' | 'ok'
  disabled?: boolean
}

export interface SegmentedProps<T extends string> {
  items: readonly SegmentItem<T>[]
  value: T
  onChange: (id: T) => void
  label: string
  size?: 'sm' | 'md'
  className?: string
}

const TONES = {
  accent: 'bg-accent-soft font-semibold text-accent-text',
  ok: 'bg-ok-soft font-semibold text-ok-text'
}

export function Segmented<T extends string>({
  items,
  value,
  onChange,
  label,
  size = 'md',
  className = ''
}: SegmentedProps<T>) {
  const enabled = items.filter((i) => !i.disabled)
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const index = enabled.findIndex((i) => i.id === value)
    if (index < 0) return
    let next: number
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (index + 1) % enabled.length
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp')
      next = (index + enabled.length - 1) % enabled.length
    else return
    e.preventDefault()
    const target = enabled[next]!
    onChange(target.id)
    e.currentTarget.querySelector<HTMLElement>(`[role="radio"][data-segment="${target.id}"]`)?.focus()
  }
  const h = size === 'sm' ? 'h-6' : 'h-8'
  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={`flex ${h} items-stretch overflow-hidden rounded-control border border-line bg-surface ${className}`}
    >
      {items.map((item, i) => {
        const checked = item.id === value
        return (
          <button
            key={item.id}
            type="button"
            role="radio"
            data-segment={item.id}
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            disabled={item.disabled}
            title={item.title}
            onClick={() => onChange(item.id)}
            data-testid={item.testId}
            className={`flex items-center gap-1.5 px-2.5 text-dense whitespace-nowrap transition-colors disabled:opacity-50 ${
              i > 0 ? 'border-l border-line' : ''
            } ${checked ? TONES[item.tone ?? 'accent'] : 'text-fg-muted hover:bg-surface-2 hover:text-fg'}`}
          >
            {item.icon}
            {item.label}
          </button>
        )
      })}
    </div>
  )
}
