/**
 * Mode Simulation : file des opérations réseau à rejouer pas à pas.
 * Une opération = une trace de paquets + une action de fin (application de l'état, sortie console…).
 * En mode Temps réel, l'action de fin est exécutée immédiatement.
 */
import { create } from 'zustand'
import { PROTOCOLS, type PacketTrace, type PduEvent, type Protocol } from '@engine/index'

export interface SimOperation {
  id: number
  trace: PacketTrace
  onComplete?: () => void
}

/** Événement déjà joué, affiché dans la liste. */
export interface PlayedEvent extends PduEvent {
  key: string
  opTitle: string
  /** Rang global (pour l'affichage du temps). */
  index: number
}

/** Vitesses proposées pour la lecture automatique. */
export const SIM_SPEEDS = [0.5, 1, 2, 4] as const
export type SimSpeed = (typeof SIM_SPEEDS)[number]

interface SimState {
  queue: SimOperation[]
  /** Index du prochain pas à jouer dans l'opération courante. */
  stepCursor: number
  /** Événements du pas en cours d'animation. */
  current: PduEvent[]
  played: PlayedEvent[]
  playing: boolean
  /** Vitesse de la lecture automatique (multiplicateur, préférence d'interface). */
  speed: SimSpeed
  filters: Record<Protocol, boolean>
  selectedKey: string | null
  /** Incrémenté à chaque pas (relance l'animation). */
  tick: number

  enqueue: (op: Omit<SimOperation, 'id'>) => void
  step: () => void
  setPlaying: (playing: boolean) => void
  setSpeed: (speed: SimSpeed) => void
  /** Termine instantanément toutes les opérations en attente et vide l'affichage. */
  reset: () => void
  /** Termine instantanément les opérations en attente (passage en Temps réel). */
  flush: () => void
  /** Abandonne tout sans appliquer les effets (changement de document). */
  discard: () => void
  toggleFilter: (p: Protocol) => void
  select: (key: string | null) => void
}

let opSeq = 0
let playedSeq = 0

/** Pas distincts visibles d'une trace, selon les filtres. */
export function visibleSteps(trace: PacketTrace, filters: Record<Protocol, boolean>): number[] {
  return [...new Set(trace.events.filter((e) => filters[e.protocol]).map((e) => e.step))].sort(
    (a, b) => a - b
  )
}

export const useSimStore = create<SimState>()((set, get) => ({
  queue: [],
  stepCursor: 0,
  current: [],
  played: [],
  playing: false,
  speed: 1,
  filters: Object.fromEntries(PROTOCOLS.map((p) => [p, true])) as Record<Protocol, boolean>,
  selectedKey: null,
  tick: 0,

  enqueue: (op) => set((s) => ({ queue: [...s.queue, { ...op, id: ++opSeq }] })),

  step: () => {
    const s = get()
    const op = s.queue[0]
    if (!op) {
      set({ playing: false, current: [] })
      return
    }
    const steps = visibleSteps(op.trace, s.filters)
    const stepValue = steps[s.stepCursor]
    if (stepValue === undefined) {
      // Opération terminée : on applique son effet et on passe à la suivante
      op.onComplete?.()
      set((st) => ({ queue: st.queue.slice(1), stepCursor: 0, current: [], tick: st.tick + 1 }))
      // Enchaîne directement sur le premier pas de l'opération suivante
      if (get().queue.length > 0) get().step()
      else set({ playing: false })
      return
    }
    const events = op.trace.events.filter((e) => e.step === stepValue && s.filters[e.protocol])
    const played = events.map((e) => ({
      ...e,
      key: `${op.id}-${++playedSeq}`,
      opTitle: op.trace.title,
      index: playedSeq
    }))
    set((st) => ({
      stepCursor: st.stepCursor + 1,
      current: events,
      played: [...st.played, ...played].slice(-500),
      tick: st.tick + 1,
      selectedKey: played[played.length - 1]?.key ?? st.selectedKey
    }))
  },

  setPlaying: (playing) => set({ playing }),
  setSpeed: (speed) => set({ speed }),

  reset: () => {
    get().flush()
    set({ played: [], selectedKey: null, current: [] })
  },

  flush: () => {
    const ops = get().queue
    set({ queue: [], stepCursor: 0, current: [], playing: false })
    for (const op of ops) op.onComplete?.()
  },

  discard: () =>
    set({ queue: [], stepCursor: 0, current: [], played: [], playing: false, selectedKey: null }),

  toggleFilter: (p) => set((s) => ({ filters: { ...s.filters, [p]: !s.filters[p] } })),
  select: (selectedKey) => set({ selectedKey })
}))
