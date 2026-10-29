/**
 * État d'interface (non simulé) : mode, outils, sélection, fenêtres, notifications…
 * L'état simulé, lui, vit dans le moteur (voir store/lab.ts).
 */
import type { PaletteKind } from '../lib/devices'
import { create } from 'zustand'
import type { Device, Link } from '@engine/index'
import type { SimMode, Theme } from '@shared/ipc'
import { readPref, writePref } from '../lib/prefs'
import { useLabStore } from './lab'

/** Outil actif sur le canvas. */
export type Tool = 'select' | 'cable' | 'delete' | 'pdu'

export type DeviceTab = 'config' | 'desktop' | 'console'

export interface DeviceWindowState {
  deviceId: string
  x: number
  y: number
  /** Taille de la fenêtre (redimensionnable par le coin inférieur droit). */
  w: number
  h: number
  maximized: boolean
  z: number
  tab: DeviceTab
}

/**
 * Taille par défaut d'une fenêtre d'équipement : le panneau de droite (Propriétés / Simulation)
 * reste visible ; la fenêtre peut ensuite être agrandie ou redimensionnée.
 */
function defaultWindowSize(): { w: number; h: number } {
  return {
    w: Math.max(760, Math.min(1080, window.innerWidth - 420)),
    h: Math.max(520, Math.min(740, window.innerHeight - 90))
  }
}

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'warning' | 'error'
  message: string
}

/** Résultat d'un PDU simple (liste façon « scénario »). */
export interface PduResult {
  id: number
  source: string
  target: string
  success: boolean
}

export type RightTab = 'lab' | 'properties' | 'simulation' | 'audit' | 'troubleshoot'

/** Boîte de dialogue modale applicative. */
export interface ModalState {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  onConfirm?: () => void
  onCancel?: () => void
}

export interface Selection {
  devices: string[]
  link: string | null
}

/** Premier port choisi lors du câblage. */
export interface CableStart {
  deviceId: string
  ifaceId: string
}

/** Thème appliqué au document (le main en est la source : préférence enregistrée). */
export function initialTheme(): Theme {
  return window.serverlab?.initialTheme === 'light' ? 'light' : 'dark'
}

/** Pose l'attribut lu par les tokens CSS (voir styles.css). */
export function applyThemeToDocument(theme: Theme): void {
  document.documentElement.dataset['theme'] = theme
}

export interface UiState {
  theme: Theme
  mode: SimMode
  showPortLabels: boolean
  showProperties: boolean
  showMinimap: boolean
  tool: Tool
  /** Équipement de la palette « armé » (clic puis clic sur le canvas). */
  armed: PaletteKind | null
  selection: Selection
  cableStart: CableStart | null
  /** Source choisie avec l'outil PDU simple. */
  pduSource: string | null
  pduResults: PduResult[]
  rightTab: RightTab
  windows: DeviceWindowState[]
  toasts: Toast[]
  modal: ModalState | null
  helpPanel: 'guide' | 'shortcuts' | null
  /** Écran d'accueil affiché (lancement sans fichier, Fichier > Accueil). */
  home: boolean
  clipboard: { devices: Device[]; links: Link[] } | null
  pasteCount: number
  appVersion: string
  /** Heure (horloge du poste) de la dernière copie de récupération écrite. */
  lastAutosave: number | null

  setTheme: (theme: Theme) => void
  setMode: (mode: SimMode) => void
  togglePortLabels: () => void
  toggleMinimap: () => void
  toggleProperties: () => void
  setTool: (tool: Tool) => void
  setArmed: (kind: PaletteKind | null) => void
  select: (selection: Partial<Selection>) => void
  clearSelection: () => void
  setCableStart: (start: CableStart | null) => void
  setPduSource: (deviceId: string | null) => void
  addPduResult: (result: Omit<PduResult, 'id'>) => void
  clearPduResults: () => void
  setRightTab: (tab: RightTab) => void
  openWindow: (deviceId: string, tab?: DeviceTab) => void
  closeWindow: (deviceId: string) => void
  focusWindow: (deviceId: string) => void
  moveWindow: (deviceId: string, x: number, y: number) => void
  resizeWindow: (deviceId: string, w: number, h: number) => void
  toggleMaximizeWindow: (deviceId: string) => void
  setWindowTab: (deviceId: string, tab: DeviceTab) => void
  notify: (kind: Toast['kind'], message: string) => void
  dismissToast: (id: number) => void
  showModal: (modal: ModalState | null) => void
  setHelpPanel: (panel: UiState['helpPanel']) => void
  setHome: (home: boolean) => void
  setClipboard: (clip: UiState['clipboard']) => void
  nextPasteOffset: () => number
  setAppVersion: (version: string) => void
  setLastAutosave: (time: number | null) => void
}

let toastSeq = 0
let pduSeq = 0

export const useUiStore = create<UiState>()((set, get) => ({
  theme: initialTheme(),
  mode: 'realtime',
  showPortLabels: false,
  showProperties: true,
  showMinimap: readPref('minimap', true),
  tool: 'select',
  armed: null,
  selection: { devices: [], link: null },
  cableStart: null,
  pduSource: null,
  pduResults: [],
  rightTab: 'properties',
  windows: [],
  toasts: [],
  modal: null,
  helpPanel: null,
  home: false,
  clipboard: null,
  pasteCount: 0,
  appVersion: '0.0.0',
  lastAutosave: null,

  setTheme: (theme) => {
    applyThemeToDocument(theme)
    set({ theme })
  },
  setMode: (mode) => {
    set({ mode, rightTab: mode === 'simulation' ? 'simulation' : 'properties' })
    // Tâches de fond des rôles : actives en Temps réel, suspendues en Simulation
    useLabStore.getState().setRealtime(mode === 'realtime')
  },
  togglePortLabels: () => set((s) => ({ showPortLabels: !s.showPortLabels })),
  toggleMinimap: () =>
    set((s) => {
      writePref('minimap', !s.showMinimap)
      return { showMinimap: !s.showMinimap }
    }),
  toggleProperties: () => set((s) => ({ showProperties: !s.showProperties })),
  setTool: (tool) => set({ tool, cableStart: null, pduSource: null, armed: null }),
  setArmed: (armed) => set({ armed, tool: 'select', cableStart: null, pduSource: null }),
  select: (selection) => set((s) => ({ selection: { ...s.selection, ...selection } })),
  clearSelection: () => set({ selection: { devices: [], link: null } }),
  setCableStart: (cableStart) => set({ cableStart }),
  setPduSource: (pduSource) => set({ pduSource }),
  addPduResult: (result) =>
    set((s) => ({ pduResults: [...s.pduResults, { ...result, id: ++pduSeq }].slice(-8) })),
  clearPduResults: () => set({ pduResults: [] }),
  setRightTab: (rightTab) => set({ rightTab }),

  openWindow: (deviceId, tab) =>
    set((s) => {
      const z = Math.max(0, ...s.windows.map((w) => w.z)) + 1
      const existing = s.windows.find((w) => w.deviceId === deviceId)
      if (existing) {
        return {
          windows: s.windows.map((w) => (w.deviceId === deviceId ? { ...w, z, tab: tab ?? w.tab } : w))
        }
      }
      const offset = (s.windows.length % 6) * 28
      const size = defaultWindowSize()
      const x = Math.max(0, Math.min(80 + offset, window.innerWidth - size.w - 20))
      const y = Math.max(0, Math.min(30 + offset, window.innerHeight - size.h - 20))
      return {
        windows: [...s.windows, { deviceId, x, y, ...size, maximized: false, z, tab: tab ?? 'config' }]
      }
    }),
  closeWindow: (deviceId) => set((s) => ({ windows: s.windows.filter((w) => w.deviceId !== deviceId) })),
  focusWindow: (deviceId) =>
    set((s) => {
      const top = Math.max(0, ...s.windows.map((w) => w.z))
      const current = s.windows.find((w) => w.deviceId === deviceId)
      if (!current || current.z === top) return {}
      return { windows: s.windows.map((w) => (w.deviceId === deviceId ? { ...w, z: top + 1 } : w)) }
    }),
  moveWindow: (deviceId, x, y) =>
    set((s) => ({ windows: s.windows.map((w) => (w.deviceId === deviceId ? { ...w, x, y } : w)) })),
  resizeWindow: (deviceId, w, h) =>
    set((s) => ({ windows: s.windows.map((win) => (win.deviceId === deviceId ? { ...win, w, h } : win)) })),
  toggleMaximizeWindow: (deviceId) =>
    set((s) => ({
      windows: s.windows.map((w) => (w.deviceId === deviceId ? { ...w, maximized: !w.maximized } : w))
    })),
  setWindowTab: (deviceId, tab) =>
    set((s) => ({ windows: s.windows.map((w) => (w.deviceId === deviceId ? { ...w, tab } : w)) })),

  notify: (kind, message) => {
    const id = ++toastSeq
    set((s) => ({ toasts: [...s.toasts.slice(-4), { id, kind, message }] }))
    setTimeout(() => get().dismissToast(id), kind === 'error' || kind === 'warning' ? 6000 : 3500)
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  showModal: (modal) => set({ modal }),
  setHelpPanel: (helpPanel) => set({ helpPanel }),
  setHome: (home) => set({ home }),
  setClipboard: (clipboard) => set({ clipboard, pasteCount: 0 }),
  nextPasteOffset: () => {
    const count = get().pasteCount + 1
    set({ pasteCount: count })
    return count * 40
  },
  setAppVersion: (appVersion) => set({ appVersion }),
  setLastAutosave: (lastAutosave) => set({ lastAutosave })
}))
