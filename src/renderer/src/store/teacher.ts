/**
 * Mode enseignant : drapeau (Affichage > Mode enseignant, désactivé par défaut) et sujet en cours
 * d'édition. Le sujet est une donnée du moteur (format .slabsujet) modifiée par lib/teacher.ts.
 */
import { create } from 'zustand'
import type { Subject } from '@engine/index'

interface TeacherStore {
  /** Drapeau de fonctionnalité : désactivé = aucun onglet, menu ni bouton visible. */
  enabled: boolean
  /** Sujet en cours de création (null : aucun). */
  subject: Subject | null
  /** Vue de l'espace Enseignant (conservée d'un passage à l'autre, ex. après une démonstration). */
  view: 'subject' | 'grading'
  setView: (view: 'subject' | 'grading') => void
  setEnabled: (enabled: boolean) => void
  setSubject: (subject: Subject | null) => void
  /** Modification immuable du sujet en cours (sans effet s'il n'y en a pas). */
  edit: (change: (subject: Subject) => Subject) => void
}

export const useTeacherStore = create<TeacherStore>()((set) => ({
  enabled: false,
  subject: null,
  view: 'subject',
  setView: (view) => set({ view }),
  setEnabled: (enabled) => set({ enabled }),
  setSubject: (subject) => set({ subject }),
  edit: (change) => set((s) => (s.subject ? { subject: change(s.subject) } : {}))
}))
