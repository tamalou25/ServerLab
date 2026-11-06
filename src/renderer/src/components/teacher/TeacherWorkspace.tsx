/**
 * Espace Enseignant : page qui recouvre la zone centrale (palette, plan, inspecteur restent montés
 * mais inertes). Vues Sujet et Correction ; le focus arrive sur le titre à l'ouverture et retourne à
 * l'élément d'origine à la fermeture. Aucune donnée n'est affichée sans le mode enseignant.
 */
import { useEffect, useRef } from 'react'
import { useT } from '../../lib/i18n'
import { useTeacherStore } from '../../store/teacher'
import { Segmented } from '../common/Segmented'
import { GradingPanel } from './GradingPanel'
import { SubjectEditor, SubjectStart } from './TeacherPanel'

export function TeacherWorkspace() {
  const { t } = useT()
  const subject = useTeacherStore((s) => s.subject)
  const view = useTeacherStore((s) => s.view)
  const setView = useTeacherStore((s) => s.setView)
  const title = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    title.current?.focus()
    return () => {
      if (previous?.isConnected) previous.focus()
    }
  }, [])
  return (
    <section
      className="absolute inset-0 z-50 flex flex-col overflow-y-auto bg-app"
      aria-label={t('teacher.workspace.eyebrow')}
      data-testid="teacher-workspace"
    >
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-6 py-5" data-testid="teacher-panel">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="text-meta font-semibold tracking-wider text-fg-subtle uppercase">
              {t('teacher.workspace.eyebrow')}
            </div>
            <h1 ref={title} tabIndex={-1} className="text-display font-semibold text-fg outline-none">
              {view === 'grading' ? t('teacher.workspace.grading') : t('teacher.workspace.subject')}
            </h1>
            {subject && <p className="mt-0.5 text-dense text-fg-muted">{subject.meta.title}</p>}
          </div>
          <Segmented
            label={t('panel.teacher')}
            value={view}
            onChange={setView}
            items={[
              { id: 'subject', label: t('teacher.view.subject'), testId: 'teacher-view-subject' },
              { id: 'grading', label: t('teacher.view.grading'), testId: 'teacher-view-grading' }
            ]}
          />
        </header>
        <div className="flex flex-col rounded-panel border border-line bg-panel">
          {view === 'grading' ? (
            <GradingPanel />
          ) : subject ? (
            <SubjectEditor subject={subject} />
          ) : (
            <SubjectStart />
          )}
        </div>
      </div>
    </section>
  )
}
