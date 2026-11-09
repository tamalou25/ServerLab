/**
 * Inspecteur (panneau de droite de l'espace Atelier) à onglets : Résumé (équipement, câble ou vue
 * d'ensemble du lab), Audit et Dépannage. L'énoncé d'un lab, l'examen et l'épreuve vivent dans
 * l'espace Mission ; la Simulation a son panneau en bas de la fenêtre (SimulationPanel).
 */
import { AuditPanel } from './audit/AuditPanel'
import { TroubleshootPanel, TroubleshootSummaryPanel } from './labs/Troubleshoot'
import { openTroubleshootDialog } from '../lib/troubleshoot'
import { Button } from './common/ui'
import { SplitHandle } from './common/SplitHandle'
import { Tabs } from './common/Tabs'
import { PropertiesPanel } from './properties/PropertiesPanel'
import { useResizablePane } from '../hooks/useResizablePane'
import { useWindowSize, NARROW_WIDTH } from '../hooks/useWindowSize'
import { useT } from '../lib/i18n'
import { useAttemptStore } from '../store/attempt'
import { useTroubleshootStore } from '../store/troubleshoot'
import { useUiStore, type RightTab } from '../store/ui'

export const INSPECTOR_DEFAULT_WIDTH = 348

export function RightPanel() {
  const selected = useUiStore((s) => s.rightTab)
  const setTab = useUiStore((s) => s.setRightTab)
  const tshoot = useTroubleshootStore((s) => s.session)
  const tshootSummary = useTroubleshootStore((s) => s.summary)
  // Épreuve en cours : l'Audit et le Dépannage révéleraient la solution sans indice compté
  const inAttempt = useAttemptStore((s) => s.attempt !== null)
  const { t } = useT()
  const { width: windowWidth } = useWindowSize()
  const pane = useResizablePane({
    key: 'inspector.width',
    defaultWidth: INSPECTOR_DEFAULT_WIDTH,
    min: 280,
    max: windowWidth < NARROW_WIDTH ? 300 : 480
  })
  const TABS: { id: RightTab; label: string; testId: string }[] = [
    { id: 'properties', label: t('panel.properties'), testId: 'right-tab-properties' },
    { id: 'interfaces', label: t('panel.interfaces'), testId: 'right-tab-interfaces' },
    { id: 'events', label: t('panel.events'), testId: 'right-tab-events' },
    ...(inAttempt
      ? []
      : [
          { id: 'audit' as const, label: t('panel.audit'), testId: 'right-tab-audit' },
          { id: 'troubleshoot' as const, label: t('panel.troubleshoot'), testId: 'right-tab-troubleshoot' }
        ])
  ]
  const tab = TABS.some((item) => item.id === selected) ? selected : 'properties'
  return (
    <aside
      className="relative flex shrink-0 flex-col border-l border-line bg-panel"
      style={{ width: pane.width }}
      aria-label={t('panel.label')}
      data-testid="inspector"
    >
      <SplitHandle
        edge="left"
        width={pane.width}
        min={pane.min}
        max={pane.max}
        onResize={pane.setWidth}
        onReset={pane.reset}
        label={t('canvas.resize')}
        testId="inspector-resize"
      />
      <Tabs
        items={TABS}
        value={tab}
        onChange={setTab}
        label={t('panel.label')}
        className="h-10 shrink-0 px-4"
      />
      {tab === 'troubleshoot' ? (
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
      ) : tab === 'interfaces' ? (
        <PropertiesPanel view="interfaces" />
      ) : tab === 'events' ? (
        <PropertiesPanel view="events" />
      ) : (
        <AuditPanel />
      )}
    </aside>
  )
}
