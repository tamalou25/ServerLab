/**
 * Contrat IPC partagé entre le process principal, le preload et le renderer.
 * Toute nouvelle communication doit être déclarée ici (canaux + types).
 */
import type { AuditReportData } from './auditReport'

/** Commandes émises par la barre de menu native vers le renderer. */
export type MenuCommand =
  | 'file:home'
  | 'file:new'
  | 'file:open'
  | 'file:save'
  | 'file:saveAs'
  | 'file:openRecent'
  | 'file:openLab'
  | 'file:troubleshoot'
  | 'edit:undo'
  | 'edit:redo'
  | 'edit:copy'
  | 'edit:paste'
  | 'edit:delete'
  | 'edit:selectAll'
  | 'view:zoomIn'
  | 'view:zoomOut'
  | 'view:fit'
  | 'view:togglePortLabels'
  | 'view:toggleMinimap'
  | 'view:toggleProperties'
  | 'view:theme'
  | 'view:language'
  | 'sim:realtime'
  | 'sim:simulation'
  | 'sim:step'
  | 'sim:play'
  | 'sim:reset'
  | 'help:shortcuts'
  | 'help:guide'
  | 'help:tutorial'

export interface MenuCommandMessage {
  command: MenuCommand
  /** Argument optionnel (ex. chemin d'un fichier récent). */
  arg?: string
}

/** Thème appliqué à l'interface. */
export type Theme = 'dark' | 'light'

export const THEMES: readonly Theme[] = ['dark', 'light']

/** Préférence enregistrée : suivre le système (par défaut) ou forcer un thème. */
export type ThemePreference = 'system' | Theme

export const THEME_PREFERENCES: readonly ThemePreference[] = ['system', 'dark', 'light']

/** Argument de ligne de commande transmis au preload pour appliquer le thème dès le chargement. */
export const THEME_ARG_PREFIX = '--serverlab-theme='

/** Langue de l'interface (le système simulé, lui, reste installé en français). */
export type Lang = 'fr' | 'en'

export const LANGS: readonly Lang[] = ['fr', 'en']

/** Préférence enregistrée : langue du système (par défaut) ou langue imposée. */
export type LanguagePreference = 'system' | Lang

export const LANGUAGE_PREFERENCES: readonly LanguagePreference[] = ['system', 'fr', 'en']

/** Argument de ligne de commande transmis au preload : langue connue dès le chargement. */
export const LANG_ARG_PREFIX = '--serverlab-lang='

/** Mode de simulation, comme dans les simulateurs réseau classiques. */
export type SimMode = 'realtime' | 'simulation'

/** État de l'UI que le renderer pousse vers le main pour mettre à jour le menu. */
export interface MenuState {
  mode: SimMode
  showPortLabels: boolean
  showProperties: boolean
  showMinimap: boolean
  /** Libellé de l'élément Édition > Annuler (« Annuler : Ajouter SRV1 »), null : rien à annuler. */
  undoLabel: string | null
  /** Libellé de l'élément Édition > Rétablir, null : rien à rétablir. */
  redoLabel: string | null
}

/** Informations sur l'application. */
export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  platform: string
  isPackaged: boolean
}

/** Fichier ouvert (contenu brut, validé ensuite par le moteur côté renderer). */
export interface OpenedFile {
  path: string
  name: string
  content: string
}

/** Résultat d'une opération fichier. */
export type FileResult<T> = { ok: true; value: T } | { ok: false; canceled?: boolean; error?: string }

/** Entrée de la liste des fichiers récents. */
export interface RecentFile {
  path: string
  name: string
  openedAt: string
}

/** Fichier récent tel qu'affiché par l'écran d'accueil : signalé s'il n'existe plus. */
export interface RecentEntry extends RecentFile {
  exists: boolean
}

/** Réponse à la question « Enregistrer les modifications ? ». */
export type SaveChangesChoice = 'save' | 'discard' | 'cancel'

/** Noms des canaux IPC (une seule définition pour éviter les fautes de frappe). */
export const IPC = {
  appInfo: 'app:info',
  menuCommand: 'menu:command',
  menuState: 'menu:state',
  themeSet: 'theme:set',
  fileOpen: 'file:open',
  fileOpenRecent: 'file:openRecent',
  fileSave: 'file:save',
  fileSaveAs: 'file:saveAs',
  fileOpened: 'file:opened',
  filePending: 'file:pending',
  recentList: 'recent:list',
  recentClear: 'recent:clear',
  recentRemove: 'recent:remove',
  homeAtStartup: 'settings:homeAtStartup',
  homeAtStartupSet: 'settings:setHomeAtStartup',
  tutorialAtStartup: 'settings:tutorialAtStartup',
  tutorialAtStartupSet: 'settings:setTutorialAtStartup',
  autosaveWrite: 'autosave:write',
  autosaveClear: 'autosave:clear',
  autosaveRecover: 'autosave:recover',
  docState: 'doc:state',
  askSaveChanges: 'doc:askSaveChanges',
  closeRequested: 'app:closeRequested',
  closeConfirmed: 'app:closeConfirmed',
  auditExportPdf: 'audit:exportPdf',
  labImport: 'lab:import',
  labExport: 'lab:export',
  examExport: 'exam:export',
  libraryIndex: 'library:index',
  libraryLab: 'library:lab'
} as const

/** Taille maximale acceptée pour un fichier .slab (protection contre les fichiers aberrants). */
export const MAX_SLAB_BYTES = 20 * 1024 * 1024

/** Taille maximale d'un fichier de lab JSON (même limite que MAX_LAB_LENGTH du moteur). */
export const MAX_LAB_BYTES = 1024 * 1024

/** API exposée au renderer via contextBridge (window.serverlab). */
export interface ServerLabApi {
  appInfo(): Promise<AppInfo>
  /** Thème enregistré, connu dès le chargement (évite un flash de couleurs). */
  readonly initialTheme: Theme
  /** Choisit le thème (Système, Sombre, Clair) : le main l'enregistre puis renvoie `view:theme`. */
  setTheme(preference: ThemePreference): void
  /** Langue de l'interface, connue dès le chargement (Affichage > Langue ; `view:language` ensuite). */
  readonly initialLanguage: Lang
  setMenuState(state: MenuState): void
  onMenuCommand(cb: (msg: MenuCommandMessage) => void): () => void

  /** Dialogue natif d'ouverture d'un fichier .slab. */
  openFile(): Promise<FileResult<OpenedFile>>
  /** Ouvre un fichier de la liste des récents. */
  openRecent(path: string): Promise<FileResult<OpenedFile>>
  /** Enregistre à un emplacement déjà connu (ouvert ou enregistré pendant la session). */
  saveFile(path: string, content: string): Promise<FileResult<string>>
  /** Dialogue natif « Enregistrer sous ». Renvoie le chemin choisi. */
  saveFileAs(content: string, suggestedName: string): Promise<FileResult<string>>
  /** Fichier passé au lancement (double-clic sur un .slab), à ouvrir au démarrage. */
  getPendingFile(): Promise<OpenedFile | null>
  /** Fichier ouvert depuis l'extérieur alors que l'application tourne déjà. */
  onFileOpened(cb: (file: OpenedFile) => void): () => void

  /** Fichiers récents, du plus récent au plus ancien, chacun signalé s'il n'existe plus. */
  listRecent(): Promise<RecentEntry[]>
  /** Retire un fichier de la liste des récents (le fichier lui-même n'est pas touché). */
  removeRecent(path: string): Promise<RecentEntry[]>
  /** Préférence « Afficher l'accueil au démarrage ». */
  homeAtStartup(): Promise<boolean>
  setHomeAtStartup(show: boolean): void
  /** Préférence « Proposer le tutoriel au démarrage » (passée à faux une fois le tutoriel réussi). */
  tutorialAtStartup(): Promise<boolean>
  setTutorialAtStartup(show: boolean): void

  /** Écrit le fichier de récupération (autosave) ; faux si le contenu est refusé (trop volumineux). */
  writeAutosave(content: string): Promise<boolean>
  clearAutosave(): Promise<void>
  /** Contenu de récupération laissé par une session interrompue, ou null. */
  recoverAutosave(): Promise<string | null>

  /** Informe le main de l'état du document (titre, modifications non enregistrées). */
  setDocumentState(state: { name: string; dirty: boolean }): void
  /** Dialogue natif « Enregistrer les modifications ? ». */
  askSaveChanges(docName: string): Promise<SaveChangesChoice>
  /** Le main demande d'enregistrer avant fermeture. */
  onCloseRequested(cb: () => void): () => void
  /** Confirme que la fermeture peut avoir lieu (après enregistrement). */
  confirmClose(): void

  /** Rapport d'audit : dialogue natif « Enregistrer sous » puis PDF. Renvoie le chemin choisi. */
  exportAuditPdf(report: AuditReportData): Promise<FileResult<string>>

  /** Éditeur de labs : dialogue « Ouvrir » d'un lab JSON ; renvoie son texte (validé ensuite). */
  importLab(): Promise<FileResult<string>>
  /** Éditeur de labs : dialogue « Enregistrer sous » puis écriture du lab JSON. */
  exportLab(content: string, suggestedName: string): Promise<FileResult<string>>
  /** Mode examen : dialogue « Enregistrer sous » puis résultat en texte. */
  exportExamResult(content: string, suggestedName: string): Promise<FileResult<string>>

  /** Bibliothèque communautaire : texte de l'index (validé ensuite par le moteur). */
  libraryIndex(): Promise<FileResult<string>>
  /** Bibliothèque communautaire : texte d'un lab (labs/<nom>.json), vérifié ensuite par le moteur. */
  libraryLab(file: string): Promise<FileResult<string>>
}
