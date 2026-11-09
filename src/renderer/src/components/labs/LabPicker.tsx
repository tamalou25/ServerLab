/**
 * Sélecteur de labs (Fichier > Ouvrir un lab…) : parcours, catalogue des exercices fournis (recherche et
 * filtres) et bibliothèque communautaire ; import, éditeur et dépannage en pied.
 */
import { useEffect, useState } from 'react'
import { useDialog } from '../../hooks/useDialog'
import { FlaskConical, GraduationCap, Upload, Wrench, X } from 'lucide-react'
import { PathwayList } from './PathwayList'
import { importAndOpenLab, openLabEditor } from '../../lib/labEditor'
import { openTroubleshootDialog } from '../../lib/troubleshoot'
import { useLabsStore } from '../../store/labs'
import { Button } from '../common/ui'
import { LabCatalog } from './LabCatalog'
import { LibraryList } from './LibraryList'
import { t } from '../../lib/i18n'

export function LabPicker() {
  const open = useLabsStore((s) => s.pickerOpen)
  const initialTab = useLabsStore((s) => s.pickerTab)
  const [tab, setTab] = useState<'pathway' | 'builtin' | 'library'>(initialTab)
  // Onglet demandé à l'ouverture (bouton Parcours de l'accueil, menu Ouvrir un lab…)
  useEffect(() => {
    if (open) setTab(initialTab)
  }, [open, initialTab])
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
        className="flex h-[min(780px,calc(100vh-48px))] w-[min(1040px,calc(100vw-48px))] flex-col rounded-panel border border-line bg-overlay shadow-lg"
        data-testid="lab-picker"
      >
        <div className="flex items-center gap-2 border-b border-line px-5 py-3">
          <GraduationCap size={18} className="text-accent" />
          <h2 id={titleId} className="text-title font-semibold text-fg">
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
              ['pathway', t('lab.tab.pathway')],
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
              className={`border-b-2 px-3 py-2 text-dense font-semibold ${
                tab === id ? 'border-accent text-fg' : 'border-transparent text-fg-subtle hover:text-fg-muted'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {tab === 'library' ? <LibraryList /> : tab === 'pathway' ? <PathwayList /> : <LabCatalog />}
        <div className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-3">
          <Button onClick={() => void importAndOpenLab()} data-testid="lab-import">
            <Upload size={14} /> Importer un lab…
          </Button>
          <Button onClick={openLabEditor} data-testid="lab-create">
            <FlaskConical size={14} /> Créer un lab…
          </Button>
          <Button onClick={openTroubleshootDialog} data-testid="lab-troubleshoot">
            <Wrench size={14} /> Lancer un dépannage…
          </Button>
        </div>
      </div>
    </div>
  )
}
