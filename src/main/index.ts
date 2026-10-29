/**
 * Point d'entrée du process principal Electron.
 * Crée la fenêtre sécurisée, le menu natif et enregistre les handlers IPC.
 */
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  type IpcMainEvent,
  type IpcMainInvokeEvent
} from 'electron'
import { join } from 'node:path'
import {
  IPC,
  LANG_ARG_PREFIX,
  THEME_ARG_PREFIX,
  type AppInfo,
  type LanguagePreference,
  type MenuState,
  type SaveChangesChoice,
  type Theme,
  type ThemePreference
} from '../shared/ipc'
import { DEFAULT_SETTINGS } from '../shared/persisted'
import { resolveTheme } from '../shared/theme'
import { FileService, findSlabArg } from './files'
import { applyLanguage, currentLanguage, t } from './i18n'
import { buildMenu } from './menu'
import { exportExamResult, exportLabFile, importLabFile } from './labfiles'
import { fetchLibraryIndex, fetchLibraryLab } from './library'
import { exportAuditPdf } from './report'
import { applyGlobalSecurity, isTrustedIpcSender } from './security'
import { isThemePreference, loadSettings, saveSettings, THEME_BACKGROUND, type Settings } from './settings'
import { checkForUpdatesFromMenu, initUpdater, installUpdateNow } from './updater'
import { isDocState, isMenuState } from './validate'

// Permet aux tests E2E d'isoler les données utilisateur (récents, autosave) dans un dossier temporaire ;
// conservé pour l'application empaquetée, testée elle aussi par la CI (SERVERLAB_E2E_EXECUTABLE)
const userDataOverride = process.env['SERVERLAB_USER_DATA']
if (userDataOverride) app.setPath('userData', userDataOverride)

// Une seule instance : un double-clic sur un .slab est transmis à la fenêtre existante
if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

let mainWindow: BrowserWindow | null = null
let menuState: MenuState = {
  mode: 'realtime',
  showPortLabels: false,
  showProperties: true,
  showMinimap: true,
  undoLabel: null,
  redoLabel: null
}
/** Document courant ; nom vide : document sans titre (libellé traduit à l'affichage). */
let docState = { name: '', dirty: false }
/** Préférences chargées au démarrage (après le choix éventuel du dossier userData). */
let settings: Settings = { ...DEFAULT_SETTINGS }
/** Vrai quand la fermeture a été confirmée (évite de redemander). */
let closeConfirmed = false
/**
 * Raison de la fermeture : « update » quand l'utilisateur a choisi « Redémarrer maintenant » pour
 * installer une mise à jour. Elle ne vaut que pour la fermeture en cours : si l'utilisateur annule
 * (ou abandonne l'enregistrement), une fermeture ultérieure redevient une simple fermeture.
 */
type CloseIntent = 'quit' | 'update'
let closeIntent: CloseIntent = 'quit'
/** Raison mémorisée pendant que le renderer enregistre avant de confirmer la fermeture. */
let intentAfterSave: CloseIntent = 'quit'

const files = new FileService(() => refreshMenu())

/** Reconstruit le menu natif à partir de l'état courant. */
function refreshMenu(): void {
  if (!mainWindow) return
  Menu.setApplicationMenu(
    buildMenu({
      window: mainWindow,
      state: menuState,
      recent: files.recentFiles(),
      theme: settings.theme,
      onTheme: applyThemePreference,
      language: settings.language,
      onLanguage: applyLanguagePreference,
      onCheckUpdates: checkForUpdatesFromMenu
    })
  )
}

/** « Redémarrer maintenant » : fermeture habituelle (avec « Enregistrer ? ») puis installation. */
function restartToInstall(): void {
  if (!mainWindow) {
    installUpdateNow()
    return
  }
  closeIntent = 'update'
  mainWindow.close()
}

/** Thème appliqué : celui de l'OS en mode Système (nativeTheme suit `themeSource`). */
function appliedTheme(): Theme {
  return resolveTheme(settings.theme, nativeTheme.shouldUseDarkColors)
}

/** Transmet le thème appliqué : fond de la fenêtre, menu, renderer (commande `view:theme`). */
function pushTheme(): void {
  const theme = appliedTheme()
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setBackgroundColor(THEME_BACKGROUND[theme])
    mainWindow.webContents.send(IPC.menuCommand, { command: 'view:theme', arg: theme })
  }
  refreshMenu()
}

/**
 * Enregistre la préférence (Système, Sombre, Clair) et l'applique : barre de titre et dialogues
 * natifs (nativeTheme), puis fenêtre et renderer.
 */
function applyThemePreference(preference: ThemePreference): void {
  settings = { ...settings, theme: preference }
  saveSettings(settings)
  nativeTheme.themeSource = preference
  pushTheme()
}

/**
 * Enregistre la préférence de langue (langue du système, Français, English) et l'applique : menu,
 * dialogues natifs, puis renderer (commande `view:language`).
 */
function applyLanguagePreference(preference: LanguagePreference): void {
  settings = { ...settings, language: preference }
  saveSettings(settings)
  const lang = applyLanguage(preference)
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send(IPC.menuCommand, { command: 'view:language', arg: lang })
  refreshMenu()
}

async function askSaveChanges(win: BrowserWindow, name: string): Promise<SaveChangesChoice> {
  const res = await dialog.showMessageBox(win, {
    type: 'warning',
    title: 'ServerLab',
    message: t('main.saveChanges.message', { name: name || t('main.untitled') }),
    detail: t('main.saveChanges.detail'),
    buttons: [t('main.saveChanges.save'), t('main.saveChanges.discard'), t('main.saveChanges.cancel')],
    defaultId: 0,
    cancelId: 2,
    noLink: true
  })
  return res.response === 0 ? 'save' : res.response === 1 ? 'discard' : 'cancel'
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    title: 'ServerLab',
    backgroundColor: THEME_BACKGROUND[appliedTheme()],
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Thème et langue connus dès le chargement du preload (pas de flash de couleurs ni de textes)
      additionalArguments: [`${THEME_ARG_PREFIX}${appliedTheme()}`, `${LANG_ARG_PREFIX}${currentLanguage()}`],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  })

  win.once('ready-to-show', () => win.show())

  // Confirmation avant fermeture si le document a été modifié
  win.on('close', (event) => {
    if (closeConfirmed || !docState.dirty) {
      void files.clearAutosave()
      return
    }
    event.preventDefault()
    const intent = closeIntent
    closeIntent = 'quit'
    void askSaveChanges(win, docState.name).then((choice) => {
      if (choice === 'save') {
        // Le renderer enregistre puis appelle confirmClose()
        intentAfterSave = intent
        win.webContents.send(IPC.closeRequested)
      } else if (choice === 'discard') {
        closeConfirmed = true
        closeIntent = intent
        win.close()
      }
    })
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

function registerIpc(): void {
  const win = (): BrowserWindow => {
    if (!mainWindow) throw new Error('Fenêtre principale indisponible')
    return mainWindow
  }
  // Tout message IPC doit venir de la page de l'application dans la fenêtre principale
  const trusted = (event: IpcMainEvent | IpcMainInvokeEvent) =>
    isTrustedIpcSender(event, mainWindow?.webContents)
  const ipc = {
    handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) {
      ipcMain.handle(channel, (event, ...args) => {
        if (!trusted(event)) throw new Error('Expéditeur IPC non autorisé')
        return listener(event, ...args)
      })
    },
    on(channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void) {
      ipcMain.on(channel, (event, ...args) => {
        if (trusted(event)) listener(event, ...args)
      })
    }
  }

  ipc.handle(IPC.appInfo, (): AppInfo => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    platform: process.platform,
    isPackaged: app.isPackaged
  }))

  ipc.on(IPC.menuState, (_event, state: unknown) => {
    if (!isMenuState(state)) return
    menuState = state
    refreshMenu()
  })

  ipc.on(IPC.themeSet, (_event, preference: unknown) => {
    if (isThemePreference(preference)) applyThemePreference(preference)
  })

  ipc.handle(IPC.homeAtStartup, () => settings.showHomeOnStartup)
  ipc.on(IPC.homeAtStartupSet, (_event, show: unknown) => {
    if (typeof show !== 'boolean') return
    settings = { ...settings, showHomeOnStartup: show }
    saveSettings(settings)
  })
  ipc.handle(IPC.tutorialAtStartup, () => settings.showTutorialOnStartup)
  ipc.on(IPC.tutorialAtStartupSet, (_event, show: unknown) => {
    if (typeof show !== 'boolean') return
    settings = { ...settings, showTutorialOnStartup: show }
    saveSettings(settings)
  })

  ipc.on(IPC.docState, (_event, state: unknown) => {
    if (isDocState(state)) docState = state
  })

  ipc.handle(IPC.fileOpen, () => files.openDialog(win()))
  ipc.handle(IPC.fileOpenRecent, (_e, path: unknown) => files.openRecent(path))
  ipc.handle(IPC.fileSave, (_e, path: unknown, content: unknown) => files.save(path, content))
  ipc.handle(IPC.fileSaveAs, (_e, content: unknown, name: unknown) => files.saveAs(win(), content, name))
  ipc.handle(IPC.filePending, () => files.takePending())
  ipc.handle(IPC.recentList, () => files.recentEntries())
  ipc.handle(IPC.recentRemove, (_e, path: unknown) => files.removeRecent(path))
  ipc.handle(IPC.recentClear, () => files.clearRecent())

  ipc.handle(IPC.autosaveWrite, (_e, content: unknown) => files.writeAutosave(content))
  ipc.handle(IPC.autosaveClear, () => files.clearAutosave())
  ipc.handle(IPC.autosaveRecover, () => files.recoverAutosave())

  ipc.handle(IPC.askSaveChanges, (_e, name: unknown) =>
    askSaveChanges(win(), typeof name === 'string' ? name.slice(0, 200) : '')
  )
  ipc.handle(IPC.auditExportPdf, (_e, report: unknown) => exportAuditPdf(win(), report))
  ipc.handle(IPC.labImport, () => importLabFile(win()))
  ipc.handle(IPC.labExport, (_e, content: unknown, name: unknown) => exportLabFile(win(), content, name))
  ipc.handle(IPC.libraryIndex, () => fetchLibraryIndex())
  ipc.handle(IPC.libraryLab, (_e, file: unknown) => fetchLibraryLab(file))
  ipc.handle(IPC.examExport, (_e, content: unknown, name: unknown) => exportExamResult(win(), content, name))
  ipc.on(IPC.closeConfirmed, () => {
    closeConfirmed = true
    closeIntent = intentAfterSave
    intentAfterSave = 'quit'
    mainWindow?.close()
  })
}

/** Ouvre un .slab transmis par le système dans la fenêtre existante. */
async function openFromSystem(path: string): Promise<void> {
  const res = await files.openExternal(path)
  if (!mainWindow) return
  if (res.ok) mainWindow.webContents.send(IPC.fileOpened, res.value)
  else dialog.showErrorBox(t('main.openFailed'), res.error ?? t('main.error.unknown'))
}

app.on('second-instance', (_event, argv) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
  const path = findSlabArg(argv)
  if (path) void openFromSystem(path)
})

app.setName('ServerLab')

app
  .whenReady()
  .then(async () => {
    applyGlobalSecurity()
    settings = loadSettings()
    applyLanguage(settings.language)
    nativeTheme.themeSource = settings.theme
    // Mode Système : l'application suit le thème de l'OS sans redémarrer
    nativeTheme.on('updated', () => {
      if (settings.theme === 'system') pushTheme()
    })
    await files.init()
    registerIpc()

    // Fichier passé au lancement (association de l'extension .slab)
    const initial = findSlabArg(process.argv)
    if (initial) {
      const res = await files.openExternal(initial)
      if (res.ok) files.setPending(res.value)
    }

    mainWindow = createWindow()
    mainWindow.on('closed', () => {
      mainWindow = null
    })
    refreshMenu()
    // Mises à jour : vérification au démarrage de l'application installée
    initUpdater({ window: () => mainWindow, restartToInstall })
  })
  .catch((error: unknown) => {
    // Échec du démarrage (paramètres, fenêtre) : journalisé, l'application se ferme au lieu de
    // rester sans fenêtre (audit Q-01)
    console.error('Échec du démarrage de ServerLab :', error)
    app.quit()
  })

app.on('window-all-closed', () => {
  // Mise à jour acceptée : installation silencieuse puis relance de la nouvelle version
  if (closeIntent === 'update') installUpdateNow()
  else app.quit()
})
