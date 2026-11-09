/**
 * Détail d'une copie : badges d'état, nom, méta, note recalculée, résultats par critère, composantes
 * de la note (valeurs réelles de la correction), oral à noter, commentaire, chronologie du journal,
 * rejeu pas à pas et export. La note décrit le résultat de cette épreuve, pas une maîtrise générale.
 */
import { CircleCheck, CircleX, FileDown, Flag, PlayCircle } from 'lucide-react'
import { useT } from '../../lib/i18n'
import { exportCorrection, updateCopy } from '../../lib/grading'
import { startDemo } from '../../lib/demo'
import { useGradingStore, type GradedCopy } from '../../store/grading'
import { Badge } from '../common/Badge'
import { Field, inputClass, Button } from '../common/ui'
import { CopyStatusBadges } from './CopyStatusBadges'
import { JournalTimeline } from './JournalTimeline'

const fmt = (n: number | null) => (n === null ? '—' : String(Math.round(n * 100) / 100).replace('.', ','))
const minutes = (ms: number) => `${Math.round(ms / 60_000)} min`

function Component({ label, value, weight }: { label: string; value: number; weight: number }) {
  const pct = Math.round(value * 100)
  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between text-meta">
        <span className="text-fg-muted">{label}</span>
        <span className="font-mono text-fg">
          {pct} % · {weight}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
        <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

export function CopyDetail({ copy }: { copy: GradedCopy }) {
  const { t } = useT()
  const c = copy.correction
  const subject = useGradingStore((s) => s.subject)!
  const name = copy.submission.student.name
  return (
    <article
      className="flex min-w-0 flex-col rounded-panel border border-line bg-panel"
      data-testid="grading-detail"
    >
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div className="min-w-0">
          <CopyStatusBadges correction={c} />
          <h2 className="mt-1.5 text-heading font-semibold text-fg">{name}</h2>
          <p className="text-dense text-fg-muted">
            {t('grading.line', {
              time: minutes(c.elapsedMs),
              errors: c.errors.total,
              refused: c.errors.refused,
              undos: c.errors.undos,
              penalty: fmt(c.penalties.hints)
            })}
          </p>
          {c.flags.map((f) => (
            <p
              key={f.code}
              className="mt-1 flex items-start gap-1.5 text-dense text-warn-text"
              data-testid="grading-flag"
            >
              <Flag size={13} className="mt-0.5 shrink-0" aria-hidden /> {f.message}
            </p>
          ))}
        </div>
        <div className="text-right">
          <div className="text-display font-semibold tracking-tight text-fg tabular-nums">
            <span data-testid="grading-grade">{fmt(c.grade.value)}</span>
            <span className="text-ui font-normal text-fg-subtle"> / {c.grade.outOf}</span>
          </div>
          <div className="text-meta text-fg-subtle">{t('grading.detail.grade')}</div>
        </div>
      </header>

      <div className="grid gap-5 px-5 py-4 lg:grid-cols-[minmax(0,1fr)_260px]">
        <section>
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <h3 className="text-ui font-semibold text-fg">{t('grading.detail.criteria')}</h3>
            <span className="text-meta text-fg-subtle">{t('grading.detail.criteriaHint')}</span>
          </div>
          <table className="w-full text-dense">
            <thead>
              <tr className="text-left text-meta font-semibold tracking-wider text-fg-subtle uppercase">
                <th className="py-1.5 pr-2 font-semibold">{t('teacher.scale.criterion')}</th>
                <th className="w-28 py-1.5 pr-2 font-semibold">{t('grading.detail.result')}</th>
                <th className="w-20 py-1.5 text-right font-semibold">{t('teacher.scale.points')}</th>
              </tr>
            </thead>
            <tbody>
              {c.criteria.map((k) => (
                <tr key={k.id} className="border-t border-line" data-state={k.ok ? 'ok' : 'ko'}>
                  <td className="py-2 pr-2 text-body text-fg">{k.label}</td>
                  <td className="py-2 pr-2">
                    <Badge
                      tone={k.ok ? 'ok' : 'danger'}
                      icon={k.ok ? <CircleCheck size={11} aria-hidden /> : <CircleX size={11} aria-hidden />}
                    >
                      {k.ok ? t('lab.valide') : t('lab.nonValide')}
                    </Badge>
                  </td>
                  <td className="py-2 text-right font-mono text-fg-muted tabular-nums">
                    {fmt(k.points)} / {fmt(k.max)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-4 grid gap-3 sm:grid-cols-3" data-testid="grading-components">
            <Component
              label={t('teacher.scale.weight.criteria')}
              value={c.components.criteria}
              weight={subject.scale.weights.criteria}
            />
            <Component
              label={t('teacher.scale.weight.time')}
              value={c.components.time}
              weight={subject.scale.weights.time}
            />
            <Component
              label={t('teacher.scale.weight.errors')}
              value={c.components.errors}
              weight={subject.scale.weights.errors}
            />
          </div>
          <p className="mt-3 text-meta leading-relaxed text-fg-subtle">{t('grading.detail.disclaimer')}</p>
        </section>

        <aside className="flex flex-col gap-3 border-t border-line pt-4 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-5">
          <h3 className="text-ui font-semibold text-fg">{t('grading.detail.feedback')}</h3>
          {subject.oral.length === 0 && (
            <p className="text-dense text-fg-muted">{t('grading.detail.noOral')}</p>
          )}
          {subject.oral.map((q, i) => (
            <div
              key={q.id}
              className="flex flex-col gap-1.5 rounded-control border border-line bg-surface p-2.5"
            >
              <p className="text-dense font-medium text-fg">{q.text}</p>
              <p className="text-dense text-fg-muted italic">{c.oral[i]?.answer || t('grading.noAnswer')}</p>
              <label className="flex items-center gap-2 text-dense text-fg">
                {t('teacher.oral.points')}
                <input
                  className={`${inputClass} w-16 font-mono`}
                  inputMode="decimal"
                  defaultValue={copy.oralPoints[i] ?? ''}
                  aria-label={t('grading.oralPoints', { index: i + 1 })}
                  onBlur={(e) => {
                    const v = e.target.value.trim()
                    const n = Number(v.replace(',', '.'))
                    const points = [...copy.oralPoints]
                    points[i] = v === '' || !Number.isFinite(n) ? null : Math.min(q.points, Math.max(0, n))
                    updateCopy(copy.file, { oralPoints: points })
                  }}
                  data-testid={`grading-oral-${i}`}
                />
                / {fmt(q.points)}
              </label>
            </div>
          ))}
          <Field label={t('grading.comment')}>
            <textarea
              className={`${inputClass} h-24 py-1.5 text-body`}
              defaultValue={copy.comment}
              maxLength={5000}
              onBlur={(e) => updateCopy(copy.file, { comment: e.target.value })}
              data-testid="grading-comment"
            />
          </Field>
          <Button
            variant="primary"
            onClick={() => void exportCorrection(copy.file)}
            data-testid="grading-export"
          >
            <FileDown size={14} aria-hidden />
            {t('grading.export')}
          </Button>
        </aside>
      </div>

      <section className="border-t border-line px-5 py-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-ui font-semibold text-fg">{t('grading.timeline.title')}</h3>
            <p className="text-meta text-fg-subtle">{t('grading.timeline.hint')}</p>
          </div>
          <Button onClick={() => startDemo(subject, copy.submission)} data-testid="grading-demo">
            <PlayCircle size={14} aria-hidden />
            {t('demo.start')}
          </Button>
        </div>
        <JournalTimeline submission={copy.submission} />
      </section>
    </article>
  )
}
