/**
 * Infobulle stylée (survol, ou focus au clavier uniquement), avec raccourci éventuel.
 */
import type { ReactNode } from 'react'

export function Tooltip({
  label,
  shortcut,
  children
}: {
  label: string
  shortcut?: string
  children: ReactNode
}) {
  return (
    <span className="group/tt relative inline-flex">
      {children}
      <span
        role="tooltip"
        className="pointer-events-none absolute top-full left-1/2 z-50 mt-1.5 hidden -translate-x-1/2 items-center gap-1.5 rounded-md border border-line bg-overlay px-2 py-1 text-meta whitespace-nowrap text-fg shadow-md group-hover/tt:flex group-has-[:focus-visible]/tt:flex"
      >
        {label}
        {shortcut && (
          <kbd className="rounded border border-line bg-surface-2 px-1 font-mono text-meta text-fg-muted">
            {shortcut}
          </kbd>
        )}
      </span>
    </span>
  )
}
