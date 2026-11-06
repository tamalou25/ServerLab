/**
 * Correction (espace Enseignant) : choix du sujet, import des rendus, indicateurs de la classe calculés
 * par le moteur, liste des copies (et fichiers refusés) et détail de la copie choisie. Chaque note est
 * recalculée par rejeu ; aucune donnée n'est affichée sans copie importée.
 */
import { FolderOpen, Table, Upload } from 'lucide-react'
import { useT } from '../../lib/i18n'
import { exportClassCsv, gradeEditedSubject, importSubmissions, openGradingSubject } from '../../lib/grading'
import { useGradingStore } from '../../store/grading'
import { useTeacherStore } from '../../store/teacher'
import { EmptyState } from '../common/EmptyState'
import { Button, Section } from '../common/ui'
import { ClassMetrics } from './ClassMetrics'
import { CopyDetail } from './CopyDetail'
import { CopyList } from './CopyList'

export function GradingPanel() {
  const { t } = useT()
  const subject = useGradingStore((s) => s.subject)
  const copies = useGradingStore((s) => s.copies)
  const rejected = useGradingStore((s) => s.rejected)
  const selected = useGradingStore((s) => s.selected)
  const edited = useTeacherStore((s) => s.subject)
  if (!subject)
    return (
      <Section title={t('grading.title')}>
        <div className="flex flex-col gap-2">
          <p className="text-body text-fg-muted">{t('grading.intro')}</p>
          <div className="flex flex-wrap gap-2">
            {edited && (
              <Button variant="primary" onClick={gradeEditedSubject}>
                {t('grading.useEdited')}
              </Button>
            )}
            <Button
              variant={edited ? 'secondary' : 'primary'}
              onClick={() => void openGradingSubject()}
              data-testid="grading-open-subject"
            >
              <FolderOpen size={14} aria-hidden />
              {t('grading.openSubject')}
            </Button>
          </div>
        </div>
      </Section>
    )
  const copy = copies.find((c) => c.file === selected)
  return (
    <div className="flex flex-col gap-4 p-4" data-testid="grading-panel">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-ui font-semibold text-fg">
            {t('grading.copies', { title: subject.meta.title })}
          </h2>
          <p className="text-meta text-fg-subtle">{t('grading.subjectHint')}</p>
        </div>
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
        <Button
          variant="ghost"
          onClick={() =>
            useGradingStore.getState().set({ subject: null, copies: [], rejected: [], selected: null })
          }
        >
          {t('teacher.subject.close')}
        </Button>
      </div>
      <ClassMetrics corrections={copies.map((c) => c.correction)} minutesPlanned={subject.scale.minutes} />
      {copies.length === 0 && rejected.length === 0 ? (
        <EmptyState icon={Upload} title={t('grading.list.empty')} testId="grading-empty">
          {t('grading.list.emptyHint')}
        </EmptyState>
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
          <CopyList copies={copies} />
          {copy ? (
            <CopyDetail key={copy.file} copy={copy} />
          ) : (
            <EmptyState title={t('grading.detail.none')} testId="grading-detail-empty">
              {t('grading.detail.noneHint')}
            </EmptyState>
          )}
        </div>
      )}
    </div>
  )
}
