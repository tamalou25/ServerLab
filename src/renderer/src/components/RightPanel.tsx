/**
 * Panneau de droite à onglets : Propriétés / Simulation / Audit, et Lab quand un lab est ouvert.
 */
import { AuditPanel } from './audit/AuditPanel'
import { ExamResultPanel } from './labs/Exam'
import { LabPanel } from './labs/LabPanel'
import { TroubleshootPanel, TroubleshootSummaryPanel } from './labs/Troubleshoot'
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
  const TABS: { id: RightTab; label: string }[] = [
    ...(lab ? [{ id: 'lab' as const, label: t('panel.lab') }] : []),
    { id: 'properties', label: t('panel.properties') },
    { id: 'simulation', label: t('panel.simulation') },
    { id: 'audit', label: t('panel.audit') }
  ]
  // Onglet Lab demandé sans lab ouvert : retour aux propriétés
  const tab = selected === 'lab' && !lab ? 'properties' : selected
  return (
    <aside
      className="flex w-80 shrink-0 flex-col border-l border-line bg-panel"
      aria-label={t('panel.label')}
    >
      <div className="flex border-b border-line" role="tablist">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            data-testid={`right-tab-${item.id}`}
            onClick={() => setTab(item.id)}
            className={`flex-1 border-b-2 px-3 py-2 text-meta font-semibold tracking-wider uppercase ${
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
        tshootSummary ? (
          <TroubleshootSummaryPanel />
        ) : tshoot ? (
          <TroubleshootPanel />
        ) : examResult ? (
          <ExamResultPanel result={examResult} />
        ) : (
          <LabPanel />
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
