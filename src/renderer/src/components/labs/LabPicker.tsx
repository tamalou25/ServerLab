/**
 * Sélecteur de labs (Fichier > Ouvrir un lab…) : labs fournis (titre, difficulté, durée, résumé)
 * et bibliothèque communautaire.
 */
import { useState } from 'react'
import { useDialog } from '../../hooks/useDialog'
import { FlaskConical, GraduationCap, Upload, X } from 'lucide-react'
import { LABS } from '../../lib/labCatalog'
import { importAndOpenLab, openLabEditor } from '../../lib/labEditor'
import { openLab } from '../../lib/labs'
import { useLabsStore } from '../../store/labs'
import { Button } from '../common/ui'
import { DifficultyBadge } from './DifficultyBadge'
import { LibraryList } from './LibraryList'
import { rich, t } from '../../lib/i18n'

export function LabPicker() {
  const open = useLabsStore((s) => s.pickerOpen)
  const [tab, setTab] = useState<'builtin' | 'library'>('builtin')
  const close = () => useLabsStore.getState().setPickerOpen(false)
  const { ref, titleId } = useDialog(open, close)
  if (!open) return null
  return (
    <div
      ref={ref}
      tabIndex={-1}
      className="fixed inset-0 z-[300] flex items-center justify-center bg-scrim outline-none"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <div
        className="flex max-h-[85vh] w-[640px] flex-col rounded-md border border-line bg-overlay shadow-lg"
        data-testid="lab-picker"
      >
        <div className="flex items-center gap-2 border-b border-line px-5 py-3">
          <GraduationCap size={18} className="text-accent" />
          <h2 id={titleId} className="text-base font-semibold text-fg">
            {t('lab.ouvrirUnLab')}
          </h2>
          <button
            type="button"
            onClick={close}
            className="ml-auto rounded p-1 text-fg-subtle hover:bg-surface-2 hover:text-fg"
            aria-label={t('lab.fermer')}
          >
            <X size={16} />
          </button>
        </div>
        <div className="flex border-b border-line px-5" role="tablist">
          {(
            [
              ['builtin', t('lab.tab.builtin')],
              ['library', t('lab.tab.library')]
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              data-testid={`picker-tab-${id}`}
              className={`border-b-2 px-3 py-2 text-[12px] font-semibold ${
                tab === id ? 'border-accent text-fg' : 'border-transparent text-fg-subtle hover:text-fg-muted'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {tab === 'library' ? (
          <LibraryList />
        ) : (
          <>
            <p className="px-5 pt-3 text-[13px] text-fg-muted">
              {rich(t('lab.pickerHelp'), { check: <strong className="text-fg">{t('lab.verifier')}</strong> })}
            </p>
            <ul className="min-h-0 flex-1 overflow-y-auto p-5">
              {LABS.map((lab, i) => (
                <li
                  key={lab.id}
                  className="mb-3 flex items-start gap-3 rounded-md border border-line bg-surface p-3"
                >
                  <span className="mt-0.5 font-mono text-[12px] text-fg-subtle">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-semibold text-fg">{lab.title}</span>
                      <DifficultyBadge difficulty={lab.difficulty} />
                      <span className="text-[11px] text-fg-subtle">{lab.duration}</span>
                    </div>
                    <p className="mt-1 text-[12px] text-fg-muted">{lab.summary}</p>
                  </div>
                  <Button
                    variant="primary"
                    onClick={() => void openLab(lab)}
                    data-testid={`lab-open-${lab.id}`}
                  >
                    Ouvrir
                  </Button>
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="flex items-center gap-2 border-t border-line px-5 py-3">
          <Button onClick={() => void importAndOpenLab()} data-testid="lab-import">
            <Upload size={14} /> Importer un lab…
          </Button>
          <Button onClick={openLabEditor} data-testid="lab-create">
            <FlaskConical size={14} /> Créer un lab…
          </Button>
        </div>
      </div>
    </div>
  )
}
