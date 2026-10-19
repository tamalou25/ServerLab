/**
 * Mise en page principale : palette à gauche, canvas au centre, propriétés à droite.
 */
import { Fragment, useCallback } from 'react'
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
import { useLangStore } from './lib/i18n'
import { offerTutorial } from './lib/tutorial'
import { useSimStore } from './store/sim'
import { useUiStore } from './store/ui'

/** Exécute une commande du menu natif. */
function handleMenuCommand(msg: MenuCommandMessage): void {
  const ui = useUiStore.getState()
  const flow = getFlowInstance()
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
      useLabsStore.getState().setPickerOpen(true)
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

export function App() {
  const showProperties = useUiStore((s) => s.showProperties)
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

  return (
    <ReactFlowProvider>
      <Fragment key={lang}>
        <div className="flex h-full flex-col">
          <div className="flex min-h-0 flex-1">
            <Palette />
            <main className="min-w-0 flex-1">
              <TopologyCanvas />
            </main>
            {showProperties && <RightPanel />}
          </div>
          <StatusBar />
        </div>
        <HomeScreen />
        <TutorialCoach />
        <DeviceWindows />
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
