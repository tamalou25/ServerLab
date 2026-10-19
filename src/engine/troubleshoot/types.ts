/**
 * Mode panne (v2.8, chantier D) : une panne est une transformation déterministe de l'état sain,
 * exprimée en commandes nommées (donc réparable avec les mêmes outils que l'élève).
 */
import type { AnyCommand } from '../commands/define'
import type { LabState } from '../model/schema'

export type FaultDomain = 'reseau' | 'windows' | 'linux' | 'pare-feu'

/** Cibles d'une panne : sérialisables (ids d'équipements, noms, valeurs). */
export interface FaultTargetParams {
  [k: string]: string | number | boolean
}

export interface FaultDef {
  /** Identifiant stable du catalogue (« net.wrong-mask »). */
  id: string
  domain: FaultDomain
  difficulty: 1 | 2 | 3
  /** Visible seulement en fin de dépannage. */
  title: string
  /**
   * Panne composée : [cause masquante, cause masquée] (voir `composite.ts`). Réparation dans cet ordre ;
   * les cibles des parties sont préfixées `a.` et `b.`.
   */
  parts?: readonly [FaultDef, FaultDef]
  /** Choisit des cibles valides dans l'état sain ; null si la panne ne s'applique pas à ce lab. Pur et déterministe. */
  pick(state: LabState, rand: () => number): FaultTargetParams | null
  /** Commandes nommées qui CASSENT l'état (appliquées par `dispatch`). */
  inject(state: LabState, p: FaultTargetParams): AnyCommand[]
  /** Le symptôme est-il observable ? */
  symptomVisible(state: LabState, p: FaultTargetParams): boolean
  /** Ticket utilisateur (français), sans révéler la cause. */
  ticket(state: LabState, p: FaultTargetParams): string
  /** Trois indices progressifs (symptôme, zone, piste), sans la solution. */
  hints(state: LabState, p: FaultTargetParams): [string, string, string]
  /** Cause révélée à l'abandon et au bilan. */
  cause(state: LabState, p: FaultTargetParams): string
  /** Réparation officielle : commandes nommées qui guérissent. */
  repair(state: LabState, p: FaultTargetParams): AnyCommand[]
  /** Guérison constatée sur l'état courant (critère de réparation). */
  healed(state: LabState, p: FaultTargetParams): boolean
}
