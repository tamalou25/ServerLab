/**
 * Pastille de filtre à bascule : `aria-pressed` et coche quand elle est active (jamais la couleur seule).
 */
import type { ReactNode } from 'react'
import { Check } from 'lucide-react'

export interface ChipProps {
  pressed: boolean
  onToggle: () => void
  children: ReactNode
  testId?: string
  title?: string
}

export function Chip({ pressed, onToggle, children, testId, title }: ChipProps) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onToggle}
      title={title}
      data-testid={testId}
      className={`inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-dense whitespace-nowrap transition-colors ${
        pressed
          ? 'border-accent bg-accent-soft font-semibold text-accent-text'
          : 'border-line-strong bg-surface text-fg-muted hover:bg-surface-2 hover:text-fg'
      }`}
    >
      {pressed && <Check size={12} aria-hidden />}
      {children}
    </button>
  )
}
