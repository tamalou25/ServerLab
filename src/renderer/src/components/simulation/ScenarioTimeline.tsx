/**
 * Scénarios en pas à pas : choix du scénario, bouton « Étape suivante » (une étape = un tour) et
 * chronologie des étapes jouées avec leur résultat.
 */
import { CheckCircle2, StepForward, XCircle } from 'lucide-react'
import { getScenario, scenariosOf } from '@engine/index'
import { useT } from '../../lib/i18n'
import { useLabStore } from '../../store/lab'
import { useGameStore } from '../../store/game'
import { useScenarioStore } from '../../store/scenario'
import { Button } from '../common/ui'

export function ScenarioTimeline() {
  const { scenarioId, cursor, timeline, error, select, step, reset } = useScenarioStore()
  const { t } = useT()
  const scenarios = scenariosOf(useLabStore((s) => s.lab))
  const scenario = scenarioId ? getScenario(scenarioId) : undefined
  const total = scenario?.steps.length ?? 0

  return (
    <div className="border-b border-line px-4 py-3" data-testid="scenario-panel">
      <div className="mb-2 flex items-center gap-2">
        <span className="flex-1 text-xs font-semibold text-fg">{t('scenario.title')}</span>
        <Button variant="ghost" onClick={() => useGameStore.getState().openDialog()} data-testid="game-open">
          {t('game.open')}
        </Button>
      </div>
      {scenarios.length === 0 ? (
        <p className="text-xs text-fg-muted">{t('scenario.none')}</p>
      ) : (
        <>
          <select
            className="mb-2 w-full rounded-md border border-line bg-surface px-2 py-1 text-xs text-fg"
            value={scenarioId ?? ''}
            onChange={(e) => select(e.target.value || null)}
            aria-label={t('scenario.choose')}
            data-testid="scenario-select"
          >
            <option value="">{t('scenario.choose')}</option>
            {scenarios.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <div className="mb-2 flex items-center gap-2">
            <Button
              variant="primary"
              onClick={step}
              disabled={!scenario || cursor >= total}
              data-testid="scenario-step"
            >
              <StepForward size={14} /> {t('scenario.next')}
            </Button>
            <Button variant="ghost" onClick={reset} disabled={timeline.length === 0}>
              {t('scenario.reset')}
            </Button>
            {scenario && (
              <span className="text-xs text-fg-muted">
                {t('scenario.progress', { current: cursor, total })}
              </span>
            )}
          </div>
          {error && <p className="mb-2 text-xs text-danger-text">{error}</p>}
          <ol className="space-y-1" data-testid="scenario-timeline">
            {timeline.map((r, i) => (
              <li key={`${r.stepId}-${i}`} className="flex items-start gap-1.5 text-xs">
                {r.success ? (
                  <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-ok-text" />
                ) : (
                  <XCircle size={14} className="mt-0.5 shrink-0 text-danger-text" />
                )}
                <span className="text-fg">
                  {r.label}{' '}
                  <span className="text-fg-muted">
                    — {r.success ? t('scenario.success') : t('scenario.failure')}
                    {r.eventCount > 0 && `, ${t('scenario.events', { count: r.eventCount })}`}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  )
}
