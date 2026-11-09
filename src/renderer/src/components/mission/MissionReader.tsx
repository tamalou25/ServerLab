/**
 * Lecteur de mission (espace Mission, à droite du plan) : panneau redimensionnable et élargissable
 * qui accueille l'énoncé du lab, le résultat d'examen, l'épreuve ou le dépannage, et un onglet Résumé
 * pour inspecter l'équipement sélectionné sans quitter la mission. Les règles d'affichage (examen,
 * épreuve, dépannage généré ou fourni) sont celles de l'inspecteur v2, inchangées.
 */
import { Maximize2, Minimize2 } from 'lucide-react'
import { useWindowSize } from '../../hooks/useWindowSize'
import { useResizablePane } from '../../hooks/useResizablePane'
import { useT } from '../../lib/i18n'
import { useAttemptStore } from '../../store/attempt'
import { useExamStore } from '../../store/exam'
import { useLabsStore } from '../../store/labs'
import { useTroubleshootStore } from '../../store/troubleshoot'
import { useUiStore, type MissionTab } from '../../store/ui'
import { SplitHandle } from '../common/SplitHandle'
import { Tabs, type TabItem } from '../common/Tabs'
import { Button } from '../common/ui'
import { ExamResultPanel } from '../labs/Exam'
import { LabPanel } from '../labs/LabPanel'
import { TroubleshootPanel, TroubleshootSummaryPanel } from '../labs/Troubleshoot'
import { PropertiesPanel } from '../properties/PropertiesPanel'
import { AttemptPanel } from '../teacher/AttemptPanel'

export const MISSION_DEFAULT_WIDTH = 440
export const MISSION_WIDE_WIDTH = 560
const MISSION_MIN_WIDTH = 320

export function MissionReader() {
  const { t } = useT()
  const { width: windowWidth } = useWindowSize()
  const pane = useResizablePane({
    key: 'mission.width',
    defaultWidth: MISSION_DEFAULT_WIDTH,
    min: MISSION_MIN_WIDTH,
    max: Math.round(windowWidth * (windowWidth < 1200 ? 0.5 : 0.6))
  })
  const selected = useUiStore((s) => s.missionTab)
  const setTab = useUiStore((s) => s.setMissionTab)
  const active = useLabsStore((s) => s.active)
  const examResult = useExamStore((s) => s.result)
  const tshoot = useTroubleshootStore((s) => s.session)
  const tshootSummary = useTroubleshootStore((s) => s.summary)
  const inAttempt = useAttemptStore((s) => !!(s.pending || s.attempt || s.submission))

  // Mêmes règles que l'inspecteur v2 : le résultat d'examen reste consultable lab fermé ; un dépannage
  // généré remplace l'énoncé, un lab de dépannage fourni garde son énoncé à côté du panneau Dépannage
  const lab = active ?? examResult
  const inTshoot = !!(tshoot || tshootSummary)
  const generated = inTshoot && (tshoot?.generated ?? true)
  const showMission = inAttempt || (!!lab && !generated)
  const showTshoot = inTshoot
  const items: TabItem<MissionTab>[] = [
    ...(showMission
      ? [{ id: 'mission' as const, label: t('mission.tab.mission'), testId: 'mission-tab-mission' }]
      : []),
    ...(showTshoot
      ? [
          {
            id: 'troubleshoot' as const,
            label: t('mission.tab.troubleshoot'),
            testId: 'mission-tab-troubleshoot'
          }
        ]
      : []),
    { id: 'summary', label: t('mission.tab.summary'), testId: 'mission-tab-summary' }
  ]
  const tab = items.some((i) => i.id === selected) ? selected : (items[0]?.id ?? 'summary')
  const wide = pane.requested >= MISSION_WIDE_WIDTH

  let content
  if (tab === 'summary') content = <PropertiesPanel />
  else if (tab === 'troubleshoot')
    content = tshootSummary ? <TroubleshootSummaryPanel /> : tshoot ? <TroubleshootPanel /> : null
  else if (inAttempt) content = <AttemptPanel />
  // Le résultat d'un examen reste consultable, lab ouvert ou fermé
  else if (examResult) content = <ExamResultPanel result={examResult} />
  else content = <LabPanel />

  return (
    <aside
      className="relative flex shrink-0 flex-col border-l border-line bg-panel"
      style={{ width: pane.width }}
      aria-label={t('mission.label')}
      data-testid="mission-reader"
    >
      <SplitHandle
        edge="left"
        width={pane.width}
        min={pane.min}
        max={pane.max}
        onResize={pane.setWidth}
        onReset={pane.reset}
        label={t('mission.resize')}
        testId="mission-resize"
      />
      <Tabs
        items={items}
        value={tab}
        onChange={setTab}
        label={t('mission.label')}
        className="h-10 shrink-0 px-4"
        trailing={
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={wide ? t('mission.shrink') : t('mission.expand')}
            aria-pressed={wide}
            title={wide ? t('mission.shrink') : t('mission.expand')}
            onClick={() => pane.setWidth(wide ? MISSION_DEFAULT_WIDTH : MISSION_WIDE_WIDTH)}
            data-testid="mission-expand"
          >
            {wide ? <Minimize2 size={14} aria-hidden /> : <Maximize2 size={14} aria-hidden />}
          </Button>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col">{content}</div>
    </aside>
  )
}
