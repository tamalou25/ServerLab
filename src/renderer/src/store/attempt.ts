/**
 * Passation d'un sujet (mode enseignant) : passation en cours, questions déjà affichées, rendu
 * final et correction immédiate (auto-évaluation).
 */
import { create } from 'zustand'
import type { Attempt, Correction, Subject, Submission } from '@engine/index'

interface AttemptStore {
  /** Sujet ouvert, en attente du nom de l'élève (null : aucun). */
  pending: Subject | null
  attempt: Attempt | null
  /** Questions d'oral déjà affichées (identifiants). */
  shown: string[]
  /** Question d'oral affichée à l'élève (null : aucune). */
  question: string | null
  /** Dernier indice révélé (texte). */
  lastHint: string | null
  /** Rendu de fin de passation (null : passation en cours ou aucune). */
  submission: Submission | null
  /** Auto-évaluation : correction locale immédiate. */
  correction: Correction | null
  /** Chemin d'enregistrement du rendu (null : pas encore enregistré). */
  savedPath: string | null
  set: (patch: Partial<Omit<AttemptStore, 'set' | 'update'>>) => void
  update: (change: (attempt: Attempt) => Attempt) => void
}

export const useAttemptStore = create<AttemptStore>()((set) => ({
  pending: null,
  attempt: null,
  shown: [],
  question: null,
  lastHint: null,
  submission: null,
  correction: null,
  savedPath: null,
  set: (patch) => set(patch),
  update: (change) => set((s) => (s.attempt ? { attempt: change(s.attempt) } : {}))
}))
