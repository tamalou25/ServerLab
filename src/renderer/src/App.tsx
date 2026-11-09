/**
 * Mise en page principale : en-tête, rail des espaces, puis selon l'espace : Atelier (palette, plan,
 * inspecteur), Mission (contexte, plan, lecteur) ou Enseignant (page recouvrant la zone centrale,
 * le plan restant monté et inerte).
 */
import { Fragment, useCallback, useEffect } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import type { MenuCommandMessage } from '@shared/ipc'
import { TopologyCanvas } from './components/canvas/TopologyCanvas'
import { HelpPanel } from './components/common/HelpPanel'
import { Modal } from './components/common/Modal'
import { Toasts } from './components/common/Toasts'
import { DeviceWindows } from './components/device-window/DeviceWindow'
import { RedBlueGame } from './components/cyber/RedBlueGame'
import { HomeScreen } from './components/home/HomeScreen'
import { TutorialCoach } from './components/tutorial/TutorialCoach'
import { Palette } from './components/Palette'
import { RightPanel } from './components/RightPanel'
import { SimulationPanel } from './components/simulation/SimulationPanel'
import { StatusBar } from './components/StatusBar'
import { useDocumentLifecycle } from './hooks/useDocumentLifecycle'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { LabPicker } from './components/labs/LabPicker'
import { TroubleshootDialog } from './components/labs/Troubleshoot'
import { LabEditor } from './components/labs/LabEditor'
import { useExamGuards } from './lib/exam'
import { openTroubleshootDialog, useTroubleshootTracking } from './lib/troubleshoot'
import { useLabsStore } from './store/labs'
import { useConsoleSessionSync } from './hooks/useConsoleSessionSync'
import { useMenuBridge } from './hooks/useMenuBridge'
import { useSimulationPlayback } from './hooks/useSimulationPlayback'
import { newDocument, openDocument, openRecentDocument, saveDocument } from './lib/document'
import { copySelection, deleteSelection, paste, redo, selectAll, undo } from './lib/editing'
import { getFlowInstance } from './lib/flow'
import { t, useLangStore } from './lib/i18n'
import { offerTutorial } from './lib/tutorial'
import { useAttemptClock } from './lib/attempt'
import { DemoBar } from './components/teacher/DemoBar'
import { TeacherWorkspace } from './components/teacher/TeacherWorkspace'
import { MissionReader } from './components/mission/MissionReader'
import { MissionSidebar } from './components/mission/MissionSidebar'
import { AppHeader } from './components/shell/AppHeader'
import { AppRail } from './components/shell/AppRail'
import { CanvasBar } from './components/shell/CanvasBar'
import { setTeacherMode } from './lib/teacher'
import { currentWorkspace, requestWorkspace, useWorkspace } from './lib/workspace'
import { useSimStore } from './store/sim'
import { useUiStore } from './store/ui'

/** Exécute une commande du menu natif. */
/** Commandes du canvas et de la simulation : sans effet tant que l'espace Enseignant recouvre le plan. */
const CANVAS_COMMANDS = new Set<MenuCommandMessage['command']>([
  'edit:undo',
  'edit:redo',
  'edit:copy',
  'edit:paste',
  'edit:delete',
  'edit:selectAll',
  'view:zoomIn',
  'view:zoomOut',
  'view:fit',
  'view:togglePortLabels',
  'sim:realtime',
  'sim:simulation',
  'sim:step',
  'sim:play',
  'sim:reset'
])

function handleMenuCommand(msg: MenuCommandMessage): void {
  const ui = useUiStore.getState()
  const flow = getFlowInstance()
  if (currentWorkspace() === 'teacher' && CANVAS_COMMANDS.has(msg.command)) return
  switch (msg.command) {
    case 'file:home':
      ui.setHome(true)
      break
    case 'file:new':
      void newDocument()
      break
    case 'file:open':
      void openDocument()
      break
    case 'file:openRecent':
      if (msg.arg) void openRecentDocument(msg.arg)
      break
    case 'file:save':
      void saveDocument()
      break
    case 'file:saveAs':
      void saveDocument(true)
      break
    case 'file:openLab':
      useLabsStore.getState().setPickerOpen(true, 'builtin')
      break
    case 'file:troubleshoot':
      openTroubleshootDialog()
      break
    // Menu « Annuler : … » : toujours la commande annoncée, même si le focus est dans un champ
    case 'edit:undo':
      undo('lab')
      break
    case 'edit:redo':
      redo('lab')
      break
    case 'edit:copy':
      copySelection()
      break
    case 'edit:paste':
      paste()
      break
    case 'edit:delete':
      deleteSelection()
      break
    case 'edit:selectAll':
      selectAll()
      break
    case 'view:zoomIn':
      void flow?.zoomIn()
      break
    case 'view:zoomOut':
      void flow?.zoomOut()
      break
    case 'view:fit':
      void flow?.fitView({ padding: 0.3, maxZoom: 1.2 })
      break
    case 'view:togglePortLabels':
      ui.togglePortLabels()
      break
    case 'view:toggleProperties':
      ui.toggleProperties()
      break
    case 'view:toggleMinimap':
      ui.toggleMinimap()
      break
    case 'view:theme':
      if (msg.arg === 'dark' || msg.arg === 'light') ui.setTheme(msg.arg)
      break
    case 'view:teacherMode':
      setTeacherMode(msg.arg === 'on')
      break
    case 'view:workspace':
      if (msg.arg === 'atelier' || msg.arg === 'mission' || msg.arg === 'teacher') {
        if (!requestWorkspace(msg.arg)) ui.notify('info', t('workspace.unavailable'))
      }
      break
    case 'view:language':
      if (msg.arg === 'fr' || msg.arg === 'en') useLangStore.getState().setLang(msg.arg)
      break
    case 'sim:realtime':
      ui.setMode('realtime')
      break
    case 'sim:simulation':
      ui.setMode('simulation')
      break
    case 'sim:step':
      useSimStore.getState().step()
      break
    case 'sim:play':
      useSimStore.getState().setPlaying(!useSimStore.getState().playing)
      break
    case 'sim:reset':
      useSimStore.getState().reset()
      break
    case 'help:guide':
      ui.setHelpPanel('guide')
      break
    case 'help:shortcuts':
      ui.setHelpPanel('shortcuts')
      break
    case 'help:tutorial':
      offerTutorial()
      break
    default:
      break
  }
}

/** Attribut `inert` (React 18 ne le type pas) : la zone recouverte ne reçoit ni focus, ni clic. */
const inertWhen = (on: boolean): Record<string, string> => (on ? { inert: '' } : {})

export function App() {
  const showProperties = useUiStore((s) => s.showProperties)
  const { workspace } = useWorkspace()
  // Changement de langue : l'interface est reconstruite (textes traduits au rendu) ; l'état vit
  // dans les stores, le canvas garde sa vue (ReactFlowProvider conservé)
  const lang = useLangStore((s) => s.lang)
  const onMenu = useCallback((msg: MenuCommandMessage) => handleMenuCommand(msg), [])
  useMenuBridge(onMenu)
  useKeyboardShortcuts()
  useDocumentLifecycle()
  useSimulationPlayback()
  useConsoleSessionSync()
  useExamGuards()
  useTroubleshootTracking()
  useAttemptClock()
  useEffect(() => {
    // Mode enseignant : préférence enregistrée (désactivé par défaut)
    void window.serverlab.teacherMode().then(setTeacherMode)
  }, [])

  return (
    <ReactFlowProvider>
      <Fragment key={lang}>
        <div className="flex h-full flex-col">
          <AppHeader />
          <div className="flex min-h-0 flex-1">
            <AppRail />
            <div className="relative flex min-w-0 flex-1 flex-col" data-workspace={workspace}>
              <div className="flex min-h-0 flex-1" {...inertWhen(workspace === 'teacher')}>
                {workspace === 'mission' ? <MissionSidebar /> : <Palette />}
                <main className="flex min-w-0 flex-1 flex-col">
                  <CanvasBar />
                  <div className="relative min-h-0 flex-1">
                    <TopologyCanvas />
                  </div>
                </main>
                {workspace === 'mission' ? <MissionReader /> : showProperties && <RightPanel />}
              </div>
              {workspace !== 'teacher' && <SimulationPanel />}
              {workspace === 'teacher' && <TeacherWorkspace />}
            </div>
          </div>
          <DemoBar />
          <StatusBar />
        </div>
        <HomeScreen />
        <TutorialCoach />
        {workspace !== 'teacher' && <DeviceWindows />}
        <LabPicker />
        <TroubleshootDialog />
        <LabEditor />
        <RedBlueGame />
        <Toasts />
        <HelpPanel />
        <Modal />
      </Fragment>
    </ReactFlowProvider>
  )
}
