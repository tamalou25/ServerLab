/**
 * Lab pédagogique en cours : définition (énoncé, critères) et dernier résultat de vérification.
 */
import { create } from 'zustand'
import type { LabDefinition, LabProgress } from '@engine/index'

interface LabsStore {
  active: LabDefinition | null
  /** Résultat du dernier clic sur « Vérifier » (null : pas encore vérifié). */
  progress: LabProgress | null
  /** Sélecteur de lab ouvert (Fichier > Ouvrir un lab…). */
  pickerOpen: boolean
  /** Onglet du sélecteur à afficher à l'ouverture (Parcours depuis l'accueil). */
  pickerTab: 'pathway' | 'builtin' | 'library'
  /** Niveaux d'indice révélés par critère (0 : premier indice seulement). */
  hintLevels: Record<string, number>
  /** Critères dont l'aide est dépliée (le premier indice n'est pas compté, il n'est montré qu'à la demande). */
  hintsOpen: Record<string, boolean>
  setActive: (lab: LabDefinition | null) => void
  revealHint: (criterionId: string) => void
  toggleHint: (criterionId: string) => void
  setProgress: (progress: LabProgress | null) => void
  setPickerOpen: (open: boolean, tab?: 'pathway' | 'builtin' | 'library') => void
}

export const useLabsStore = create<LabsStore>()((set) => ({
  active: null,
  progress: null,
  pickerOpen: false,
  pickerTab: 'builtin',
  hintLevels: {},
  hintsOpen: {},
  setActive: (active) => set({ active, progress: null, hintLevels: {}, hintsOpen: {} }),
  toggleHint: (id) => set((s) => ({ hintsOpen: { ...s.hintsOpen, [id]: !s.hintsOpen[id] } })),
  revealHint: (id) => set((s) => ({ hintLevels: { ...s.hintLevels, [id]: (s.hintLevels[id] ?? 0) + 1 } })),
  setProgress: (progress) => set({ progress }),
  setPickerOpen: (pickerOpen, tab) => set({ pickerOpen, ...(tab ? { pickerTab: tab } : {}) })
}))
