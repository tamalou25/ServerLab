/**
 * Section repliable du panneau Propriétés ; l'état replié est mémorisé par section sur le poste.
 */
import { useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { readPref, writePref } from '../../lib/prefs'

const PREF_KEY = 'properties.closed'

function readClosed(): string[] {
  const value = readPref<string[]>(PREF_KEY, [])
  return Array.isArray(value) ? value : []
}

interface PanelSectionProps {
  id: string
  title: string
  /** Compteur affiché à côté du titre (ex. nombre d'interfaces). */
  count?: number
  /** Actions à droite du titre (boutons compacts). */
  actions?: ReactNode
  children: ReactNode
}

export function PanelSection({ id, title, count, actions, children }: PanelSectionProps) {
  const [open, setOpen] = useState(() => !readClosed().includes(id))
  const toggle = () => {
    const closed = readClosed().filter((s) => s !== id)
    if (open) closed.push(id)
    writePref(PREF_KEY, closed)
    setOpen(!open)
  }
  return (
    <section className="border-b border-line" data-testid={`section-${id}`}>
      <div className="flex h-8 items-center gap-1 pr-2 pl-2">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1 rounded px-1 py-1 text-meta font-semibold tracking-wider text-fg-subtle uppercase hover:text-fg-muted"
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span className="truncate">{title}</span>
          {count !== undefined && <span className="font-normal text-fg-subtle">({count})</span>}
        </button>
        {actions}
      </div>
      {open && <div className="px-4 pb-3">{children}</div>}
    </section>
  )
}
