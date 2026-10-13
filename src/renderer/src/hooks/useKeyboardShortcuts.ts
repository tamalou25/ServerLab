/**
 * Raccourcis clavier gérés par le renderer (ceux qui ne doivent pas être volés aux champs de saisie).
 */
import { useEffect } from 'react'
import {
  copySelection,
  deleteSelection,
  isEditableTarget,
  paste,
  redo,
  selectAll,
  undo
} from '../lib/editing'
import { useUiStore, type Tool } from '../store/ui'

/** Raccourcis des outils du canvas (affichés dans les infobulles de la barre d'outils). */
const TOOL_KEYS: Record<string, Tool> = { v: 'select', c: 'cable', p: 'pdu' }

/** Vrai si l'événement vient d'une fenêtre d'équipement (Bureau, console…). */
function inDeviceWindow(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && !!target.closest('[role="dialog"]')
}

export function useKeyboardShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return
      // Dialogue modal ouvert : aucun raccourci n'agit sur le lab derrière lui (Suppr, Ctrl+Z…)
      if (document.querySelector('[aria-modal="true"]')) return
      // Écran d'accueil affiché : le canvas, masqué, ne reçoit aucun raccourci
      if (useUiStore.getState().home) return
      const ctrl = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()
      const plain = !ctrl && !e.altKey && !e.shiftKey
      const tool = TOOL_KEYS[key]
      if (plain && tool && !inDeviceWindow(e.target)) {
        e.preventDefault()
        useUiStore.getState().setTool(tool)
        return
      }
      if (ctrl && key === 'z' && !e.shiftKey) {
        e.preventDefault()
        undo()
      } else if (ctrl && (key === 'y' || (key === 'z' && e.shiftKey))) {
        e.preventDefault()
        redo()
      } else if (ctrl && key === 'c') {
        copySelection()
      } else if (ctrl && key === 'v') {
        e.preventDefault()
        paste()
      } else if (ctrl && key === 'a') {
        e.preventDefault()
        selectAll()
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        const { selection, setTool } = useUiStore.getState()
        // Suppr sans sélection : outil Supprimer (comme indiqué dans la barre d'outils)
        if (selection.devices.length === 0 && !selection.link) {
          if (e.key === 'Delete' && !inDeviceWindow(e.target)) setTool('delete')
          return
        }
        deleteSelection()
      } else if (e.key === 'Escape') {
        const ui = useUiStore.getState()
        ui.setTool('select')
        ui.setArmed(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
