/**
 * Dépannage (mode panne) : session en cours et bilan. La logique (pannes, indices, bilan) est dans
 * le moteur (`src/engine/troubleshoot/`) ; ce store ne conserve que l'état de l'interface.
 */
import { create } from 'zustand'
import type { LabState, TroubleshootSummary } from '@engine/index'

export interface TroubleshootSession {
  /** Identifiant du lab de dépannage (celui du lab actif). */
  labId: string
  /** État cassé de départ (après injection) : référence des tickets, indices et du bilan. */
  start: LabState
  seed: number
  /** Début réel (ms) : le moteur ne lit pas l'horloge. */
  startedAt: number
  /** Dépannage chronométré (mode examen, indices désactivés). */
  exam: boolean
  /** Révision du document au lancement : un autre document ouvert met fin à la session. */
  revision: number
  /** Commandes nommées jouées depuis le départ (hors demandes d'indice). */
  played: number
  /** Plus grand nombre d'indices demandés (annuler un indice ne l'efface pas). */
  peakHints: number
  /** Vérifications « J'ai réparé » restées sans succès. */
  failedChecks: number
}

interface TroubleshootStore {
  dialogOpen: boolean
  session: TroubleshootSession | null
  summary: TroubleshootSummary | null
  set: (patch: Partial<Pick<TroubleshootStore, 'dialogOpen' | 'session' | 'summary'>>) => void
  patchSession: (patch: Partial<TroubleshootSession>) => void
}

export const useTroubleshootStore = create<TroubleshootStore>()((set) => ({
  dialogOpen: false,
  session: null,
  summary: null,
  set: (patch) => set(patch),
  patchSession: (patch) => set((s) => (s.session ? { session: { ...s.session, ...patch } } : {}))
}))
