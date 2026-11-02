/**
 * Démonstration (mode enseignant) : rejeu pas à pas d'un rendu, images précalculées par le
 * moteur (teacher/replay.ts : replayFrames).
 */
import { create } from 'zustand'
import type { ReplayFrame } from '@engine/index'

interface DemoStore {
  /** Images du rejeu (vide : aucune démonstration). */
  frames: ReplayFrame[]
  title: string
  index: number
  playing: boolean
  /** Pas par seconde. */
  speed: number
  projection: boolean
  set: (patch: Partial<Omit<DemoStore, 'set'>>) => void
}

export const useDemoStore = create<DemoStore>()((set) => ({
  frames: [],
  title: '',
  index: 0,
  playing: false,
  speed: 1,
  projection: false,
  set: (patch) => set(patch)
}))
