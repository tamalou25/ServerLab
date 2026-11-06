/**
 * Barre latérale de l'espace Mission (à la place de la palette) : contexte de la mission (titre,
 * difficulté, régime), résumé, durée indicative et accès direct aux consoles des équipements du lab.
 * Aucune démarche n'y est cochée : rien dans l'état ne permettrait de la valider.
 */
import { Clock3, SquareTerminal } from 'lucide-react'
import { useWindowSize, NARROW_WIDTH } from '../../hooks/useWindowSize'
import { useT } from '../../lib/i18n'
import { useAttemptStore } from '../../store/attempt'
import { useExamStore } from '../../store/exam'
import { useLabStore } from '../../store/lab'
import { useLabsStore } from '../../store/labs'
import { useTroubleshootStore } from '../../store/troubleshoot'
import { useUiStore } from '../../store/ui'
import { DifficultyBadge } from '../labs/DifficultyBadge'

type Regime = 'lab' | 'exam' | 'attempt' | 'troubleshoot'

export function MissionSidebar() {
  const { t } = useT()
  const lab = useLabsStore((s) => s.active)
  const exam = useExamStore((s) => s.session !== null)
  const attempt = useAttemptStore((s) => s.attempt)
  const pending = useAttemptStore((s) => s.pending)
  const tshoot = useTroubleshootStore((s) => s.session)
  const devices = useLabStore((s) => s.lab.devices)
  const { width } = useWindowSize()
  if (width < NARROW_WIDTH) return null
  const subject = attempt?.subject ?? pending
  const title = subject?.meta.title ?? lab?.title ?? ''
  const regime: Regime = attempt || pending ? 'attempt' : exam ? 'exam' : tshoot ? 'troubleshoot' : 'lab'
  const duration = subject ? `${subject.scale.minutes} min` : lab?.duration
  const summary = subject ? null : lab?.summary
  const list = Object.values(devices)
    .filter((d) => d.kind !== 'cloud')
    .sort((a, b) => a.name.localeCompare(b.name))
  return (
    <aside
      className="flex w-52 shrink-0 flex-col gap-4 overflow-y-auto border-r border-line bg-panel px-4 py-4"
      aria-label={t('mission.sidebar.label')}
      data-testid="mission-sidebar"
    >
      <div className="flex flex-col gap-2">
        <h2 className="text-heading font-semibold text-fg" data-testid="mission-sidebar-title">
          {title}
        </h2>
        {lab && !subject && <DifficultyBadge difficulty={lab.difficulty} />}
        {summary && <p className="text-dense leading-relaxed text-fg-muted">{summary}</p>}
      </div>
      {duration && (
        <div className="border-t border-line pt-3">
          <div className="flex items-center gap-1.5 text-meta text-fg-subtle">
            <Clock3 size={13} aria-hidden /> {t('mission.sidebar.duration')}
          </div>
          <div className="mt-0.5 text-ui font-semibold text-fg">{duration}</div>
          <p className="mt-2 text-dense leading-relaxed text-fg-muted">
            {t(`mission.sidebar.regime.${regime}`)}
          </p>
        </div>
      )}
      {list.length > 0 && (
        <div className="border-t border-line pt-3">
          <h3 className="mb-1.5 text-meta font-semibold tracking-wider text-fg-subtle uppercase">
            {t('mission.sidebar.consoles')}
          </h3>
          <ul className="flex flex-col gap-0.5">
            {list.map((d) => (
              <li key={d.id}>
                <button
                  type="button"
                  onClick={() => useUiStore.getState().openWindow(d.id, 'console')}
                  className="flex w-full items-center gap-1.5 rounded-control px-1.5 py-1 text-left text-dense text-fg-muted hover:bg-surface-2 hover:text-fg"
                  aria-label={t('mission.sidebar.console', { name: d.name })}
                  data-testid={`mission-console-${d.name}`}
                >
                  <SquareTerminal size={13} aria-hidden className="shrink-0" />
                  <span className="truncate">{d.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </aside>
  )
}
