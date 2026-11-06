/**
 * Indicateurs de la classe, calculés par le moteur (classStats) depuis les copies importées :
 * nombre de copies (le nombre d'élèves attendus n'est pas connu), moyenne sur 20, durée moyenne
 * face à la durée prévue, critère le plus raté, copies signalées. Masqués sans copie.
 */
import { classStats, type Correction } from '@engine/index'
import type { ReactNode } from 'react'
import { useT } from '../../lib/i18n'

const fmt = (n: number | null) => (n === null ? '—' : String(Math.round(n * 100) / 100).replace('.', ','))
const minutes = (ms: number) => Math.round(ms / 60_000)

function Metric({
  label,
  value,
  unit,
  caption,
  testId
}: {
  label: string
  value: ReactNode
  unit?: string
  caption?: string
  testId?: string
}) {
  return (
    <div className="rounded-card border border-line bg-panel px-4 py-3" data-testid={testId}>
      <div className="text-meta text-fg-muted">{label}</div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="text-display font-semibold tracking-tight text-fg tabular-nums">{value}</span>
        {unit && <span className="text-dense text-fg-subtle">{unit}</span>}
      </div>
      {caption && <div className="mt-1 text-meta text-fg-subtle">{caption}</div>}
    </div>
  )
}

export function ClassMetrics({
  corrections,
  minutesPlanned
}: {
  corrections: Correction[]
  minutesPlanned: number
}) {
  const { t } = useT()
  if (corrections.length === 0) return null
  const stats = classStats(corrections)
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="grading-stats">
      <Metric
        label={t('grading.metric.copies')}
        value={stats.count}
        caption={
          stats.flagged > 0
            ? t('grading.metric.flagged', { count: stats.flagged })
            : t('grading.metric.noFlag')
        }
        testId="grading-metric-copies"
      />
      <Metric
        label={t('grading.mean')}
        value={fmt(stats.mean)}
        unit="/ 20"
        caption={t('grading.metric.recomputed')}
        testId="grading-metric-mean"
      />
      <Metric
        label={t('grading.meanTime')}
        value={stats.meanElapsedMs === null ? '—' : minutes(stats.meanElapsedMs)}
        unit="min"
        caption={t('grading.metric.planned', { minutes: minutesPlanned })}
        testId="grading-metric-time"
      />
      <Metric
        label={t('grading.mostFailed')}
        value={
          stats.mostFailed ? (
            <span className="line-clamp-2 text-ui leading-snug font-semibold">{stats.mostFailed.label}</span>
          ) : (
            '—'
          )
        }
        caption={
          stats.mostFailed
            ? t('grading.metric.missed', { failures: stats.mostFailed.failures, count: stats.count })
            : t('grading.metric.allPassed')
        }
        testId="grading-metric-failed"
      />
    </div>
  )
}
