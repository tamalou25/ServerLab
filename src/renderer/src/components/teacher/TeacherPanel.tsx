/**
 * Vues « Sujet » de l'espace Enseignant (visible seulement si le mode enseignant est activé) :
 * point de départ d'un sujet, puis éditeur (lab de départ, énoncé, barème, questions d'oral, export).
 */
import { FileDown, FolderOpen, PlayCircle, Plus, Trash2 } from 'lucide-react'
import { openSubjectForAttempt } from '../../lib/attempt'
import { useMemo, useState } from 'react'
import { checkSubjectSolution, type OralQuestion, type Subject } from '@engine/index'
import { useT } from '../../lib/i18n'
import { LABS } from '../../lib/labCatalog'
import {
  addQuestion,
  exportSubject,
  openSubjectFile,
  removeQuestion,
  setCriterionPoints,
  setMeta,
  setScale,
  setStatement,
  setWeight,
  subjectFromActiveLab,
  subjectFromEditor,
  subjectFromLibrary,
  updateQuestion
} from '../../lib/teacher'
import { useLabStore } from '../../store/lab'
import { useTeacherStore } from '../../store/teacher'
import { Button, Field, inputClass, Section } from '../common/ui'

/** Nombre saisi (virgule acceptée) ; valeur de repli si la saisie n'est pas un nombre. */
function num(text: string, fallback: number): number {
  const n = Number(text.replace(',', '.'))
  return Number.isFinite(n) ? n : fallback
}

const fmt = (n: number) => String(Math.round(n * 100) / 100).replace('.', ',')

/** Point de départ d'un sujet : lab de la bibliothèque, lab ouvert, éditeur de labs, fichier. */
export function SubjectStart() {
  const { t } = useT()
  const [labId, setLabId] = useState(LABS[0]?.id ?? '')
  return (
    <>
      <Section title={t('teacher.subject.new')}>
        <div className="flex flex-col gap-3">
          <p className="text-dense text-fg-muted">{t('teacher.subject.intro')}</p>
          <Field label={t('teacher.subject.fromLibrary')}>
            <select
              className={inputClass}
              value={labId}
              onChange={(e) => setLabId(e.target.value)}
              data-testid="teacher-lab-select"
            >
              {LABS.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.title}
                </option>
              ))}
            </select>
          </Field>
          <Button
            variant="primary"
            onClick={() => subjectFromLibrary(labId)}
            data-testid="teacher-from-library"
          >
            {t('teacher.subject.create')}
          </Button>
          <Button onClick={subjectFromActiveLab}>{t('teacher.subject.fromActive')}</Button>
          <Button onClick={subjectFromEditor}>{t('teacher.subject.fromEditor')}</Button>
          <Button onClick={() => void openSubjectFile()} data-testid="teacher-open-subject">
            <FolderOpen size={14} aria-hidden />
            {t('teacher.subject.open')}
          </Button>
        </div>
      </Section>
      <Section title={t('attempt.section')}>
        <div className="flex flex-col gap-2">
          <p className="text-dense text-fg-muted">{t('attempt.intro')}</p>
          <Button onClick={() => void openSubjectForAttempt()} data-testid="teacher-take-subject">
            <PlayCircle size={14} aria-hidden />
            {t('attempt.open')}
          </Button>
        </div>
      </Section>
    </>
  )
}

export function SubjectEditor({ subject }: { subject: Subject }) {
  const { t } = useT()
  const lab = useLabStore((s) => s.lab)
  // Prévisualisation recalculée à chaque modification du sujet ou du lab courant
  const preview = useMemo(() => checkSubjectSolution(subject, lab), [subject, lab])
  const { scale } = subject
  const labels = new Map(subject.lab.criteria.map((c) => [c.id, c.label]))
  return (
    <>
      <Section
        title={t('teacher.subject.title')}
        actions={
          <Button variant="ghost" onClick={() => useTeacherStore.getState().setSubject(null)}>
            {t('teacher.subject.close')}
          </Button>
        }
      >
        <div className="flex flex-col gap-2">
          <Field label={t('teacher.subject.name')}>
            <input
              className={inputClass}
              value={subject.meta.title}
              maxLength={200}
              onChange={(e) => setMeta({ title: e.target.value })}
              data-testid="teacher-title"
            />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('teacher.subject.author')}>
              <input
                className={inputClass}
                value={subject.meta.author}
                maxLength={120}
                onChange={(e) => setMeta({ author: e.target.value })}
              />
            </Field>
            <Field label={t('teacher.subject.version')}>
              <input
                className={inputClass}
                value={subject.meta.version}
                maxLength={40}
                onChange={(e) => setMeta({ version: e.target.value })}
              />
            </Field>
          </div>
          <Field label={t('teacher.subject.statement')}>
            <textarea
              className={`${inputClass} h-28 py-1`}
              value={subject.lab.statement}
              onChange={(e) => setStatement(e.target.value)}
            />
          </Field>
        </div>
      </Section>

      <Section title={t('teacher.scale.title')}>
        <div className="flex flex-col gap-2">
          <table className="w-full text-dense tabular-nums">
            <thead>
              <tr className="text-fg-subtle">
                <th className="py-1 text-left font-medium">{t('teacher.scale.criterion')}</th>
                <th className="w-16 py-1 text-right font-medium">{t('teacher.scale.points')}</th>
              </tr>
            </thead>
            <tbody>
              {scale.criteria.map((c) => (
                <tr key={c.criterionId} className="border-t border-line">
                  <td className="py-1 pr-2 text-fg">{labels.get(c.criterionId)}</td>
                  <td className="py-1">
                    <input
                      className={`${inputClass} text-right font-mono`}
                      inputMode="decimal"
                      aria-label={t('teacher.scale.pointsOf', { label: labels.get(c.criterionId) ?? '' })}
                      defaultValue={fmt(c.points)}
                      onBlur={(e) =>
                        setCriterionPoints(c.criterionId, Math.max(0, num(e.target.value, c.points)))
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="grid grid-cols-3 gap-2">
            {(['criteria', 'time', 'errors'] as const).map((k) => (
              <Field key={k} label={t(`teacher.scale.weight.${k}`)}>
                <input
                  className={`${inputClass} font-mono`}
                  inputMode="decimal"
                  defaultValue={fmt(scale.weights[k])}
                  onBlur={(e) =>
                    setWeight(k, Math.min(100, Math.max(0, num(e.target.value, scale.weights[k]))))
                  }
                  data-testid={`teacher-weight-${k}`}
                />
              </Field>
            ))}
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Field label={t('teacher.scale.minutes')}>
              <input
                className={`${inputClass} font-mono`}
                inputMode="numeric"
                defaultValue={scale.minutes}
                onBlur={(e) =>
                  setScale({
                    minutes: Math.min(480, Math.max(1, Math.round(num(e.target.value, scale.minutes))))
                  })
                }
              />
            </Field>
            <Field label={t('teacher.scale.hintPenalty')}>
              <input
                className={`${inputClass} font-mono`}
                inputMode="decimal"
                defaultValue={fmt(scale.hintPenalty)}
                onBlur={(e) => setScale({ hintPenalty: Math.max(0, num(e.target.value, scale.hintPenalty)) })}
              />
            </Field>
            <Field label={t('teacher.scale.maxErrors')}>
              <input
                className={`${inputClass} font-mono`}
                inputMode="numeric"
                defaultValue={scale.maxErrors}
                onBlur={(e) =>
                  setScale({ maxErrors: Math.max(1, Math.round(num(e.target.value, scale.maxErrors))) })
                }
              />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-dense text-fg">
            <input
              type="checkbox"
              checked={scale.undoIsError}
              onChange={(e) => setScale({ undoIsError: e.target.checked })}
            />
            {t('teacher.scale.undoIsError')}
          </label>
        </div>
      </Section>

      <Section
        title={t('teacher.oral.title')}
        actions={
          <Button variant="ghost" onClick={addQuestion} data-testid="teacher-add-question">
            <Plus size={14} aria-hidden />
            {t('teacher.oral.add')}
          </Button>
        }
      >
        <div className="flex flex-col gap-3">
          {subject.oral.length === 0 && <p className="text-dense text-fg-muted">{t('teacher.oral.none')}</p>}
          {subject.oral.map((q) => (
            <QuestionCard key={q.id} question={q} subject={subject} />
          ))}
        </div>
      </Section>

      <Section title={t('teacher.preview.title')}>
        <div className="flex flex-col gap-2 text-dense" data-testid="teacher-preview">
          <p className="text-fg">
            <span className="font-mono text-title">{fmt(preview.grade.value)}</span> / {preview.grade.outOf}
            {' · '}
            {preview.failing.length === 0 ? (
              <span className="text-ok-text">✓ {t('teacher.preview.complete')}</span>
            ) : (
              <span className="text-warn-text">
                ⚠ {t('teacher.preview.partial', { passed: preview.passed, total: preview.total })}
              </span>
            )}
          </p>
          <p className="text-fg-muted">{t('teacher.preview.hint')}</p>
          <Button variant="primary" onClick={() => void exportSubject()} data-testid="teacher-export-subject">
            <FileDown size={14} aria-hidden />
            {t('teacher.subject.export')}
          </Button>
        </div>
      </Section>
    </>
  )
}

function QuestionCard({ question: q, subject }: { question: OralQuestion; subject: Subject }) {
  const { t } = useT()
  const trigger = q.trigger
  return (
    <div className="flex flex-col gap-2 rounded-md border border-line bg-surface-2 p-2">
      <textarea
        className={`${inputClass} h-16 py-1`}
        value={q.text}
        maxLength={2000}
        placeholder={t('teacher.oral.placeholder')}
        aria-label={t('teacher.oral.text')}
        onChange={(e) => updateQuestion(q.id, { text: e.target.value })}
      />
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <select
          className={inputClass}
          aria-label={t('teacher.oral.trigger')}
          value={trigger.kind === 'minute' ? 'minute' : `c:${trigger.criterionId}`}
          onChange={(e) =>
            updateQuestion(q.id, {
              trigger:
                e.target.value === 'minute'
                  ? { kind: 'minute', minute: 0 }
                  : { kind: 'criterion', criterionId: e.target.value.slice(2) }
            })
          }
        >
          <option value="minute">{t('teacher.oral.atMinute')}</option>
          {subject.lab.criteria.map((c) => (
            <option key={c.id} value={`c:${c.id}`}>
              {t('teacher.oral.after', { label: c.label })}
            </option>
          ))}
        </select>
        <Button
          variant="ghostDanger"
          aria-label={t('teacher.oral.remove')}
          onClick={() => removeQuestion(q.id)}
        >
          <Trash2 size={14} aria-hidden />
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {trigger.kind === 'minute' && (
          <Field label={t('teacher.oral.minute')}>
            <input
              className={`${inputClass} font-mono`}
              inputMode="numeric"
              defaultValue={trigger.minute}
              onBlur={(e) =>
                updateQuestion(q.id, {
                  trigger: {
                    kind: 'minute',
                    minute: Math.min(subject.scale.minutes, Math.max(0, Math.round(num(e.target.value, 0))))
                  }
                })
              }
            />
          </Field>
        )}
        <Field label={t('teacher.oral.points')}>
          <input
            className={`${inputClass} font-mono`}
            inputMode="decimal"
            defaultValue={fmt(q.points)}
            onBlur={(e) => updateQuestion(q.id, { points: Math.max(0, num(e.target.value, q.points)) })}
          />
        </Field>
      </div>
    </div>
  )
}
