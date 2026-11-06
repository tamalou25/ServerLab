/**
 * État vide d'un panneau ou d'une liste : icône, titre, explication et action éventuelle, centrés.
 */
import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

export interface EmptyStateProps {
  icon?: LucideIcon
  title: ReactNode
  children?: ReactNode
  action?: ReactNode
  className?: string
  testId?: string
}

export function EmptyState({ icon: Icon, title, children, action, className = '', testId }: EmptyStateProps) {
  return (
    <div
      className={`flex flex-col items-center justify-center gap-2 px-6 py-8 text-center ${className}`}
      data-testid={testId}
    >
      {Icon && (
        <span className="flex h-10 w-10 items-center justify-center rounded-panel bg-surface-2 text-fg-subtle">
          <Icon size={20} aria-hidden />
        </span>
      )}
      <p className="text-ui font-semibold text-fg">{title}</p>
      {children && <div className="max-w-sm text-dense leading-relaxed text-fg-muted">{children}</div>}
      {action && <div className="mt-1 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  )
}
