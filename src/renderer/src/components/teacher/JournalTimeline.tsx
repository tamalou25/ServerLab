/**
 * Chronologie d'une copie : le journal réel de l'élève (commandes, annulations, glisser, indices,
 * réponses), en temps relatif au départ. Rien n'est interprété ni regroupé.
 */
import { Lightbulb, MessageCircle, Redo2, Terminal, Undo2, type LucideIcon } from 'lucide-react'
import { journalTimeline, type CopyTimelineEntry, type Submission } from '@engine/index'
import { useT } from '../../lib/i18n'

const ICONS: Record<CopyTimelineEntry['kind'], LucideIcon> = {
  command: Terminal,
  transaction: Terminal,
  undo: Undo2,
  redo: Redo2,
  hint: Lightbulb,
  answer: MessageCircle
}

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000)
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

export function JournalTimeline({ submission }: { submission: Submission }) {
  const { t } = useT()
  const entries = journalTimeline(submission)
  if (entries.length === 0) return <p className="text-dense text-fg-muted">{t('grading.timeline.empty')}</p>
  return (
    <ol className="flex gap-4 overflow-x-auto pb-1" data-testid="grading-timeline">
      {entries.map((e, i) => {
        const Icon = ICONS[e.kind]
        return (
          <li key={i} className="relative flex min-w-36 shrink-0 flex-col gap-1 border-t-2 border-line pt-2">
            <span
              className="absolute -top-[7px] left-0 h-3 w-3 rounded-full border-2 border-accent bg-panel"
              aria-hidden
            />
            <span className="font-mono text-meta text-fg-subtle">{clock(e.offsetMs)}</span>
            <span className="flex items-center gap-1 text-dense text-fg">
              <Icon size={12} className="shrink-0 text-fg-muted" aria-hidden />
              <span className="truncate" title={e.label}>
                {e.label}
              </span>
            </span>
          </li>
        )
      })}
    </ol>
  )
}
