/**
 * Correction (onglet Enseignant) : rendus importés, note recalculée par rejeu, signalements,
 * saisie de l'oral et du commentaire, export par élève et CSV de la classe, statistiques.
 */
import { FileDown, FolderOpen, Table, Upload } from 'lucide-react'
import { classStats } from '@engine/index'
import { useT } from '../../lib/i18n'
import {
  exportClassCsv,
  exportCorrection,
  gradeEditedSubject,
  importSubmissions,
  openGradingSubject,
  updateCopy
} from '../../lib/grading'
import { useGradingStore, type GradedCopy } from '../../store/grading'
import { useTeacherStore } from '../../store/teacher'
import { Button, Field, inputClass, Section } from '../common/ui'

const fmt = (n: number | null) => (n === null ? '—' : String(Math.round(n * 100) / 100).replace('.', ','))
const minutes = (ms: number) => `${Math.round(ms / 60_000)} min`

export function GradingPanel() {
  const { t } = useT()
  const subject = useGradingStore((s) => s.subject)
  const copies = useGradingStore((s) => s.copies)
  const selected = useGradingStore((s) => s.selected)
  const edited = useTeacherStore((s) => s.subject)
  if (!subject)
    return (
      <Section title={t('grading.title')}>
        <div className="flex flex-col gap-2">
          <p className="text-dense text-fg-muted">{t('grading.intro')}</p>
          {edited && <Button onClick={gradeEditedSubject}>{t('grading.useEdited')}</Button>}
          <Button onClick={() => void openGradingSubject()} data-testid="grading-open-subject">
            <FolderOpen size={14} aria-hidden />
            {t('grading.openSubject')}
          </Button>
        </div>
      </Section>
    )
  const stats = classStats(copies.map((c) => c.correction))
  const copy = copies.find((c) => c.file === selected)
  return (
    <>
      <Section
        title={t('grading.copies', { title: subject.meta.title })}
        actions={
          <Button
            variant="ghost"
            onClick={() => useGradingStore.getState().set({ subject: null, copies: [] })}
          >
            {t('teacher.subject.close')}
          </Button>
        }
      >
        <div className="flex flex-col gap-2 text-dense">
          <div className="flex gap-2">
            <Button variant="primary" onClick={() => void importSubmissions()} data-testid="grading-import">
              <Upload size={14} aria-hidden />
              {t('grading.import')}
            </Button>
            <Button
              onClick={() => void exportClassCsv()}
              disabled={copies.length === 0}
              data-testid="grading-csv"
            >
              <Table size={14} aria-hidden />
              CSV
            </Button>
          </div>
          {copies.length > 0 && (
            <dl className="grid grid-cols-3 gap-2" data-testid="grading-stats">
              <div>
                <dt className="text-fg-subtle">{t('grading.mean')}</dt>
                <dd className="font-mono text-fg">{fmt(stats.mean)} / 20</dd>
              </div>
              <div>
                <dt className="text-fg-subtle">{t('grading.meanTime')}</dt>
                <dd className="font-mono text-fg">
                  {stats.meanElapsedMs === null ? '—' : minutes(stats.meanElapsedMs)}
                </dd>
              </div>
              <div>
                <dt className="text-fg-subtle">{t('grading.mostFailed')}</dt>
                <dd className="text-fg">{stats.mostFailed?.label ?? '—'}</dd>
              </div>
            </dl>
          )}
          <table className="w-full tabular-nums">
            <tbody>
              {copies.map((c) => (
                <tr
                  key={c.file}
                  className={`cursor-pointer border-t border-line ${c.file === selected ? 'bg-accent-soft' : 'hover:bg-surface-2'}`}
                  onClick={() => useGradingStore.getState().set({ selected: c.file })}
                  data-testid={`grading-row-${c.submission.student.name}`}
                >
                  <td className="py-1 text-fg">
                    <button type="button" className="text-left" aria-pressed={c.file === selected}>
                      {c.submission.student.name}
                    </button>
                  </td>
                  <td className="py-1 text-right font-mono text-fg">{fmt(c.correction.grade.value)}</td>
                  <td className="w-6 py-1 text-right">
                    {c.correction.flags.length > 0 && (
                      <span
                        className="text-warn-text"
                        title={t('grading.flagged')}
                        aria-label={t('grading.flagged')}
                      >
                        ⚑
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
      {copy && <CopyDetail key={copy.file} copy={copy} />}
    </>
  )
}

function CopyDetail({ copy }: { copy: GradedCopy }) {
  const { t } = useT()
  const c = copy.correction
  const subject = useGradingStore((s) => s.subject)!
  return (
    <Section title={copy.submission.student.name}>
      <div className="flex flex-col gap-2 text-dense" data-testid="grading-detail">
        <p className="text-fg">
          <span className="font-mono text-title" data-testid="grading-grade">
            {fmt(c.grade.value)}
          </span>{' '}
          / {c.grade.outOf}
        </p>
        {c.flags.map((f) => (
          <p key={f.code} className="text-warn-text" data-testid="grading-flag">
            ⚑ {f.message}
          </p>
        ))}
        <ul className="flex flex-col gap-1">
          {c.criteria.map((k) => (
            <li key={k.id} className="flex gap-2">
              <span className={k.ok ? 'text-ok-text' : 'text-danger-text'} aria-hidden>
                {k.ok ? '✓' : '✗'}
              </span>
              <span className="sr-only">{k.ok ? t('attempt.ok') : t('attempt.ko')}</span>
              <span className="text-fg">{k.label}</span>
              <span className="ml-auto font-mono text-fg-muted">
                {fmt(k.points)}/{fmt(k.max)}
              </span>
            </li>
          ))}
        </ul>
        <p className="font-mono text-fg-muted">
          {t('grading.line', {
            time: minutes(c.elapsedMs),
            errors: c.errors.total,
            refused: c.errors.refused,
            undos: c.errors.undos,
            penalty: fmt(c.penalties.hints)
          })}
        </p>
        {subject.oral.map((q, i) => (
          <div key={q.id} className="flex flex-col gap-1 rounded-md border border-line bg-surface-2 p-2">
            <p className="text-fg">{q.text}</p>
            <p className="text-fg-muted italic">{c.oral[i]?.answer || t('grading.noAnswer')}</p>
            <label className="flex items-center gap-2 text-fg">
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
            className={`${inputClass} h-16 py-1`}
            defaultValue={copy.comment}
            maxLength={5000}
            onBlur={(e) => updateCopy(copy.file, { comment: e.target.value })}
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
      </div>
    </Section>
  )
}
