/**
 * Inspecteur (panneau de droite) à onglets : Résumé (équipement, câble ou vue d'ensemble du lab),
 * Lab (quand un lab ou un résultat d'examen est ouvert), Audit, Dépannage, et Simulation.
 */
import { AuditPanel } from './audit/AuditPanel'
import { ExamResultPanel } from './labs/Exam'
import { LabPanel } from './labs/LabPanel'
import { TroubleshootPanel, TroubleshootSummaryPanel } from './labs/Troubleshoot'
import { openTroubleshootDialog } from '../lib/troubleshoot'
import { Button } from './common/ui'
import { SimulationPanel } from './simulation/SimulationPanel'
import { PropertiesPanel } from './properties/PropertiesPanel'
import { useT } from '../lib/i18n'
import { useExamStore } from '../store/exam'
import { useLabsStore } from '../store/labs'
import { useTroubleshootStore } from '../store/troubleshoot'
import { useUiStore, type RightTab } from '../store/ui'

export function RightPanel() {
  const selected = useUiStore((s) => s.rightTab)
  const setTab = useUiStore((s) => s.setRightTab)
  const active = useLabsStore((s) => s.active)
  const examResult = useExamStore((s) => s.result)
  const tshoot = useTroubleshootStore((s) => s.session)
  const tshootSummary = useTroubleshootStore((s) => s.summary)
  const { t } = useT()
  // Le résultat d'un examen reste consultable même si le lab a été fermé
  const lab = active ?? examResult
  const inTshoot = !!(tshoot || tshootSummary)
  // Un dépannage en cours a son propre onglet : l'onglet Lab sert aux labs et à l'examen
  const showLab = !!lab && !inTshoot
  const TABS: { id: RightTab; label: string }[] = [
    { id: 'properties', label: t('panel.properties') },
    ...(showLab ? [{ id: 'lab' as const, label: t('panel.lab') }] : []),
    { id: 'audit', label: t('panel.audit') },
    { id: 'troubleshoot', label: t('panel.troubleshoot') },
    { id: 'simulation', label: t('panel.simulation') }
  ]
  // Onglet Lab demandé sans lab (ou pendant un dépannage) : onglet correspondant
  const tab = selected === 'lab' && !showLab ? (inTshoot ? 'troubleshoot' : 'properties') : selected
  return (
    <aside
      className="flex w-80 shrink-0 flex-col border-l border-line bg-panel"
      aria-label={t('panel.label')}
    >
      <div className="flex border-b border-line" role="tablist" aria-label={t('panel.label')}>
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            data-testid={`right-tab-${item.id}`}
            onClick={() => setTab(item.id)}
            className={`flex-1 border-b-2 px-1 py-2 text-dense font-semibold ${
              tab === item.id
                ? 'border-accent text-fg'
                : 'border-transparent text-fg-subtle hover:text-fg-muted'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>
      {tab === 'lab' ? (
        examResult ? (
          <ExamResultPanel result={examResult} />
        ) : (
          <LabPanel />
        )
      ) : tab === 'troubleshoot' ? (
        tshootSummary ? (
          <TroubleshootSummaryPanel />
        ) : tshoot ? (
          <TroubleshootPanel />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-dense text-fg-muted">
            <p>{t('panel.tshootIntro')}</p>
            <Button variant="primary" onClick={openTroubleshootDialog} data-testid="tshoot-open">
              {t('panel.tshootStart')}
            </Button>
          </div>
        )
      ) : tab === 'properties' ? (
        <PropertiesPanel />
      ) : tab === 'audit' ? (
        <AuditPanel />
      ) : (
        <SimulationPanel />
      )}
    </aside>
  )
}
