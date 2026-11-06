/**
 * Progression du parcours : tentatives enregistrées (lues depuis le main au premier besoin). Les règles
 * (étapes terminées, compétences démontrées, prochaine étape) sont dans le moteur (labs/progress.ts).
 */
import { create } from 'zustand'
import type { ProgressAttempt } from '@engine/index'

interface ProgressStore {
  /** null : pas encore chargée. */
  attempts: ProgressAttempt[] | null
  set: (attempts: ProgressAttempt[]) => void
}

export const useProgressStore = create<ProgressStore>()((set) => ({
  attempts: null,
  set: (attempts) => set({ attempts })
}))
