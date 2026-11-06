/**
 * Pastille d'état ou de catégorie : icône et texte toujours ensemble (jamais la couleur seule).
 * `tone` choisit les couleurs (tokens `-soft` / `-text`) ; `data-tone` est lisible par les tests.
 */
import type { ReactNode } from 'react'

export type BadgeTone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'accent'

const TONES: Record<BadgeTone, string> = {
  neutral: 'bg-surface-2 text-fg-muted',
  ok: 'bg-ok-soft text-ok-text',
  warn: 'bg-warn-soft text-warn-text',
  danger: 'bg-danger-soft text-danger-text',
  info: 'bg-info-soft text-info-text',
  accent: 'bg-accent-soft text-accent-text'
}

export interface BadgeProps {
  tone?: BadgeTone
  icon?: ReactNode
  children: ReactNode
  title?: string
  className?: string
  testId?: string
}

export function Badge({ tone = 'neutral', icon, children, title, className = '', testId }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-meta font-semibold whitespace-nowrap ${TONES[tone]} ${className}`}
      data-tone={tone}
      data-testid={testId}
      title={title}
    >
      {icon}
      {children}
    </span>
  )
}
