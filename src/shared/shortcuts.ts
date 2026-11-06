/**
 * Catalogue unique des raccourcis clavier : le menu natif (process principal) y prend ses
 * accélérateurs et l'aide « Raccourcis clavier » l'affiche en entier ; les deux ne peuvent pas
 * diverger. Les touches sont au format des accélérateurs Electron (CmdOrCtrl+Shift+S, F6, Delete).
 * Libellés traduits : `shortcut.<id>` et `shortcutGroup.<groupe>` (shared/i18n).
 */
import type { Lang } from './ipc'
import { translate, type MessageKey } from './i18n'

export type ShortcutGroup = 'file' | 'edit' | 'tools' | 'view' | 'workspace' | 'simulation' | 'help'

export interface Shortcut {
  /** Touches équivalentes ; la première est celle affichée dans le menu. */
  keys: readonly string[]
  group: ShortcutGroup
}

export const SHORTCUTS = {
  newFile: { keys: ['CmdOrCtrl+N'], group: 'file' },
  open: { keys: ['CmdOrCtrl+O'], group: 'file' },
  save: { keys: ['CmdOrCtrl+S'], group: 'file' },
  saveAs: { keys: ['CmdOrCtrl+Shift+S'], group: 'file' },
  openLab: { keys: ['CmdOrCtrl+L'], group: 'file' },
  quit: { keys: ['CmdOrCtrl+Q'], group: 'file' },

  undo: { keys: ['CmdOrCtrl+Z'], group: 'edit' },
  redo: { keys: ['CmdOrCtrl+Y', 'CmdOrCtrl+Shift+Z'], group: 'edit' },
  copy: { keys: ['CmdOrCtrl+C'], group: 'edit' },
  paste: { keys: ['CmdOrCtrl+V'], group: 'edit' },
  delete: {
    keys: ['Delete'],
    group: 'edit'
  },
  selectAll: { keys: ['CmdOrCtrl+A'], group: 'edit' },

  toolSelect: { keys: ['V'], group: 'tools' },
  toolCable: { keys: ['C'], group: 'tools' },
  toolPdu: { keys: ['P'], group: 'tools' },
  cancel: {
    keys: ['Escape'],
    group: 'tools'
  },

  zoomIn: { keys: ['CmdOrCtrl+='], group: 'view' },
  zoomOut: { keys: ['CmdOrCtrl+-'], group: 'view' },
  fit: { keys: ['CmdOrCtrl+0'], group: 'view' },
  fullScreen: { keys: ['F11'], group: 'view' },

  // Espaces de travail (Ctrl+1 / Ctrl+2 restent Temps réel / Simulation)
  workspaceAtelier: { keys: ['CmdOrCtrl+Shift+A'], group: 'workspace' },
  workspaceMission: { keys: ['CmdOrCtrl+Shift+M'], group: 'workspace' },
  workspaceTeacher: { keys: ['CmdOrCtrl+Shift+E'], group: 'workspace' },

  realtime: { keys: ['CmdOrCtrl+1'], group: 'simulation' },
  simulation: { keys: ['CmdOrCtrl+2'], group: 'simulation' },
  step: { keys: ['F6'], group: 'simulation' },
  play: { keys: ['F7'], group: 'simulation' },
  reset: { keys: ['F8'], group: 'simulation' },

  guide: { keys: ['F1'], group: 'help' }
} as const satisfies Record<string, Shortcut>

export type ShortcutId = keyof typeof SHORTCUTS

/** Ordre d'affichage des groupes dans l'aide. */
export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  'file',
  'edit',
  'tools',
  'view',
  'workspace',
  'simulation',
  'help'
]

/** Accélérateur du menu natif pour un raccourci (première touche). */
export function accelerator(id: ShortcutId): string {
  return SHORTCUTS[id].keys[0]
}

/** Touches dont le nom dépend de la langue (clavier français : Maj, Suppr, Échap). */
const KEY_NAMES: Record<string, MessageKey> = {
  Shift: 'key.Shift',
  Delete: 'key.Delete',
  Escape: 'key.Escape'
}

/** Touche lisible : « CmdOrCtrl+Shift+S » → « Ctrl+Maj+S » (fr) ou « Ctrl+Shift+S » (en). */
export function formatShortcut(key: string, lang: Lang): string {
  return key
    .split('+')
    .map((part) => {
      if (part === 'CmdOrCtrl') return 'Ctrl'
      const name = KEY_NAMES[part]
      return name ? translate(lang, name) : part
    })
    .join('+')
}

/** Libellé d'un raccourci dans l'aide. */
export function shortcutLabel(id: ShortcutId, lang: Lang): string {
  return translate(lang, `shortcut.${id}`)
}

/** Nom d'un groupe de raccourcis dans l'aide. */
export function shortcutGroupLabel(group: ShortcutGroup, lang: Lang): string {
  return translate(lang, `shortcutGroup.${group}`)
}
