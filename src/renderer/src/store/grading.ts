/**
 * Correction (mode enseignant) : sujet de référence, rendus importés et saisie du professeur
 * (points de l'oral, commentaire). La note est recalculée par rejeu (lib/grading.ts).
 */
import { create } from 'zustand'
import type { Correction, Subject, Submission } from '@engine/index'

export interface GradedCopy {
  /** Nom du fichier importé (clé). */
  file: string
  submission: Submission
  /** Points de l'oral saisis par le professeur, dans l'ordre des questions (null : non noté). */
  oralPoints: (number | null)[]
  comment: string
  /** Correction recalculée (rejeu) après chaque saisie. */
  correction: Correction
}

interface GradingStore {
  subject: Subject | null
  copies: GradedCopy[]
  selected: string | null
  set: (patch: Partial<Omit<GradingStore, 'set'>>) => void
}

export const useGradingStore = create<GradingStore>()((set) => ({
  subject: null,
  copies: [],
  selected: null,
  set: (patch) => set(patch)
}))
