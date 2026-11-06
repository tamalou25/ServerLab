/**
 * Preload : seul pont entre le renderer (isolé, sandboxé) et le process principal.
 * N'expose qu'une API minimale et typée ; aucun accès Node ou disque générique.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  IPC,
  LANG_ARG_PREFIX,
  THEME_ARG_PREFIX,
  type Lang,
  type MenuCommandMessage,
  type OpenedFile,
  type ServerLabApi,
  type Theme
} from '../shared/ipc'

/** Abonne un callback à un canal et renvoie une fonction de désabonnement. */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

/** Thème transmis par le main en argument du process renderer (sombre par défaut). */
function readInitialTheme(): Theme {
  const arg = process.argv.find((a) => a.startsWith(THEME_ARG_PREFIX))
  return arg?.slice(THEME_ARG_PREFIX.length) === 'light' ? 'light' : 'dark'
}

/** Langue transmise par le main en argument du process renderer (français par défaut). */
function readInitialLanguage(): Lang {
  const arg = process.argv.find((a) => a.startsWith(LANG_ARG_PREFIX))
  return arg?.slice(LANG_ARG_PREFIX.length) === 'en' ? 'en' : 'fr'
}

const api: ServerLabApi = {
  appInfo: () => ipcRenderer.invoke(IPC.appInfo),
  initialTheme: readInitialTheme(),
  setTheme: (theme) => ipcRenderer.send(IPC.themeSet, theme),
  initialLanguage: readInitialLanguage(),
  setMenuState: (state) => ipcRenderer.send(IPC.menuState, state),
  onMenuCommand: (cb) => subscribe<MenuCommandMessage>(IPC.menuCommand, cb),

  openFile: () => ipcRenderer.invoke(IPC.fileOpen),
  openRecent: (path) => ipcRenderer.invoke(IPC.fileOpenRecent, path),
  saveFile: (path, content) => ipcRenderer.invoke(IPC.fileSave, path, content),
  saveFileAs: (content, suggestedName) => ipcRenderer.invoke(IPC.fileSaveAs, content, suggestedName),
  getPendingFile: () => ipcRenderer.invoke(IPC.filePending),
  onFileOpened: (cb) => subscribe<OpenedFile>(IPC.fileOpened, cb),

  listRecent: () => ipcRenderer.invoke(IPC.recentList),
  removeRecent: (path) => ipcRenderer.invoke(IPC.recentRemove, path),
  homeAtStartup: () => ipcRenderer.invoke(IPC.homeAtStartup),
  setHomeAtStartup: (show) => ipcRenderer.send(IPC.homeAtStartupSet, show),
  tutorialAtStartup: () => ipcRenderer.invoke(IPC.tutorialAtStartup),
  setTutorialAtStartup: (show) => ipcRenderer.send(IPC.tutorialAtStartupSet, show),

  writeAutosave: (content) => ipcRenderer.invoke(IPC.autosaveWrite, content),
  clearAutosave: () => ipcRenderer.invoke(IPC.autosaveClear),
  recoverAutosave: () => ipcRenderer.invoke(IPC.autosaveRecover),

  setDocumentState: (state) => ipcRenderer.send(IPC.docState, state),
  askSaveChanges: (docName) => ipcRenderer.invoke(IPC.askSaveChanges, docName),
  onCloseRequested: (cb) => subscribe<void>(IPC.closeRequested, () => cb()),
  confirmClose: () => ipcRenderer.send(IPC.closeConfirmed),

  exportAuditPdf: (report) => ipcRenderer.invoke(IPC.auditExportPdf, report),

  importLab: () => ipcRenderer.invoke(IPC.labImport),
  exportLab: (content, suggestedName) => ipcRenderer.invoke(IPC.labExport, content, suggestedName),
  exportExamResult: (content, suggestedName) => ipcRenderer.invoke(IPC.examExport, content, suggestedName),

  libraryIndex: () => ipcRenderer.invoke(IPC.libraryIndex),
  libraryLab: (file) => ipcRenderer.invoke(IPC.libraryLab, file),

  teacherMode: () => ipcRenderer.invoke(IPC.teacherMode),
  saveTeacherFile: (kind, content, suggestedName) =>
    ipcRenderer.invoke(IPC.teacherSave, kind, content, suggestedName),
  openTeacherFiles: (kind) => ipcRenderer.invoke(IPC.teacherOpen, kind),
  listProgress: () => ipcRenderer.invoke(IPC.progressList),
  recordAttempt: (attempt) => ipcRenderer.invoke(IPC.progressRecord, attempt),
  resetProgress: () => ipcRenderer.invoke(IPC.progressReset)
}

contextBridge.exposeInMainWorld('serverlab', api)
