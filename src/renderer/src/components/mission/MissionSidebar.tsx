/**
 * Barre latérale de l'espace Mission (à la place de la palette) : régime de la mission, démarche
 * suggérée et accès direct aux consoles des équipements du lab. Le titre, la difficulté et la durée sont
 * dans le lecteur (une seule fois, et visibles quand cette barre est repliée). Aucune démarche n'y est
 * cochée : rien dans l'état ne permettrait de la valider.
 */
import { SquareTerminal } from 'lucide-react'
import { useWindowSize, NARROW_WIDTH } from '../../hooks/useWindowSize'
import { useT } from '../../lib/i18n'
import { useAttemptStore } from '../../store/attempt'
import { useExamStore } from '../../store/exam'
import { useLabStore } from '../../store/lab'
import { useTroubleshootStore } from '../../store/troubleshoot'
import { useUiStore } from '../../store/ui'

type Regime = 'lab' | 'exam' | 'attempt' | 'troubleshoot'

export function MissionSidebar() {
  const { t } = useT()
  const exam = useExamStore((s) => s.session !== null)
  const attempt = useAttemptStore((s) => s.attempt)
  const pending = useAttemptStore((s) => s.pending)
  const tshoot = useTroubleshootStore((s) => s.session)
  const devices = useLabStore((s) => s.lab.devices)
  const { width } = useWindowSize()
  if (width < NARROW_WIDTH) return null
  const regime: Regime = attempt || pending ? 'attempt' : exam ? 'exam' : tshoot ? 'troubleshoot' : 'lab'
  const list = Object.values(devices)
    .filter((d) => d.kind !== 'cloud')
    .sort((a, b) => a.name.localeCompare(b.name))
  return (
    <aside
      className="flex w-52 shrink-0 flex-col gap-5 overflow-y-auto border-r border-line bg-panel px-4 py-4"
      aria-label={t('mission.sidebar.label')}
      data-testid="mission-sidebar"
    >
      <section data-testid="mission-regime" data-regime={regime}>
        <Heading>{t('mission.sidebar.regime')}</Heading>
        <p className="text-ui font-semibold text-fg">{t(`mission.regime.${regime}`)}</p>
        <p className="mt-1 text-dense leading-relaxed text-fg-muted">
          {t(`mission.sidebar.regime.${regime}`)}
        </p>
      </section>
      <section data-testid="mission-approach">
        <Heading>{t('mission.approach.title')}</Heading>
        <ol className="flex flex-col gap-1">
          {(['observe', 'diagnose', 'fix', 'verify'] as const).map((step, i) => (
            <li key={step} className="flex items-baseline gap-2 text-dense text-fg-muted">
              <span className="w-3 shrink-0 font-mono text-meta text-fg-subtle">{i + 1}</span>
              {t(`mission.approach.${step}`)}
            </li>
          ))}
        </ol>
        <p className="mt-1.5 text-meta leading-snug text-fg-subtle">{t('mission.approach.note')}</p>
      </section>
      {list.length > 0 && (
        <section>
          <Heading>{t('mission.sidebar.consoles')}</Heading>
          <ul className="-mx-1.5 flex flex-col gap-0.5">
            {list.map((d) => (
              <li key={d.id}>
                <button
                  type="button"
                  onClick={() => useUiStore.getState().openWindow(d.id, 'console')}
                  className="flex w-full items-center gap-1.5 rounded-control px-1.5 py-1 text-left font-mono text-dense text-fg-muted hover:bg-surface-2 hover:text-fg"
                  aria-label={t('mission.sidebar.console', { name: d.name })}
                  data-testid={`mission-console-${d.name}`}
                >
                  <SquareTerminal size={13} aria-hidden className="shrink-0" />
                  <span className="truncate">{d.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  )
}

function Heading({ children }: { children: string }) {
  return (
    <h3 className="mb-1.5 text-meta font-semibold tracking-wider text-fg-subtle uppercase">{children}</h3>
  )
}
