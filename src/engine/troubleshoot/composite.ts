/**
 * Pannes composées (chantier D, #230) : deux causes dont l'une MASQUE l'autre. La seconde cause
 * n'est observable qu'une fois la première réparée (p. ex. DNS arrêté masque un enregistrement A
 * erroné : tant que le service est arrêté, le nom ne se résout pas, on ne voit pas qu'il pointerait
 * au mauvais endroit).
 *
 * Une panne composée est une `FaultDef` ordinaire du registre (son identifiant se passe à
 * `startTroubleshooting`, le tirage par graine peut la choisir) avec `parts: [masquante, masquée]` :
 * - ses cibles sont celles des deux parties, préfixées `a.` (masquante) et `b.` (masquée) ;
 * - injection : la masquée d'abord, puis la masquante (la seconde cause doit pouvoir être posée
 *   tant que le lab est sain) ;
 * - le symptôme visible, le ticket et les deux premiers indices sont ceux de la masquante ;
 * - réparation : la masquante, puis la masquée ; guérie quand les DEUX parties le sont.
 * `pick` ne retient que des cibles vraiment masquées : après injection le symptôme de la masquée est
 * invisible, et il apparaît dès que la masquante seule est réparée.
 */
import type { LabState } from '../model/schema'
import { dispatch } from '../commands/dispatch'
import type { FaultDef, FaultTargetParams } from './types'

const PREFIX_A = 'a.'
const PREFIX_B = 'b.'

/** Cibles d'une partie, sans le préfixe. */
function part(p: FaultTargetParams, prefix: string): FaultTargetParams {
  const out: FaultTargetParams = {}
  for (const [k, v] of Object.entries(p)) if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v
  return out
}

function join(a: FaultTargetParams, b: FaultTargetParams): FaultTargetParams {
  const out: FaultTargetParams = {}
  for (const [k, v] of Object.entries(a)) out[PREFIX_A + k] = v
  for (const [k, v] of Object.entries(b)) out[PREFIX_B + k] = v
  return out
}

/** Parties d'une panne composée et accès à leurs cibles (null : panne simple). */
export function compositeParts(fault: FaultDef): {
  masker: FaultDef
  masked: FaultDef
  pa: (p: FaultTargetParams) => FaultTargetParams
  pb: (p: FaultTargetParams) => FaultTargetParams
} | null {
  if (!fault.parts) return null
  const [masker, masked] = fault.parts
  return { masker, masked, pa: (p) => part(p, PREFIX_A), pb: (p) => part(p, PREFIX_B) }
}

function apply(state: LabState, fault: FaultDef, p: FaultTargetParams, repair: boolean): LabState | null {
  let next = state
  for (const c of repair ? fault.repair(state, p) : fault.inject(state, p)) {
    const r = dispatch(next, c)
    if (!r.ok) return null
    next = r.state
  }
  return next
}

export interface CompositeSpec {
  id: string
  title: string
  difficulty: 2 | 3
  /** Cause visible en premier (sa réparation lève le masque). */
  masker: FaultDef
  /** Cause cachée par la première. */
  masked: FaultDef
}

/** Tentatives de tirage d'un couple (cibles) réellement masqué. */
const ATTEMPTS = 60

export function defineComposite(spec: CompositeSpec): FaultDef {
  const resolve = () => {
    const c = compositeParts(def)
    if (!c) throw new Error(`Panne composée ${spec.id} : parties inconnues.`)
    return c
  }

  const def: FaultDef = {
    id: spec.id,
    domain: 'windows',
    difficulty: spec.difficulty,
    title: spec.title,
    parts: [spec.masker, spec.masked],

    pick(state, rand) {
      const { masker, masked } = resolve()
      for (let i = 0; i < ATTEMPTS; i++) {
        const a = masker.pick(state, rand)
        const b = masked.pick(state, rand)
        if (!a || !b) return null
        const p = join(a, b)
        if (maskedAsExpected(state, def, p)) return p
      }
      return null
    },

    inject(state, p) {
      const { masker, masked, pa, pb } = resolve()
      return [...masked.inject(state, pb(p)), ...masker.inject(state, pa(p))]
    },

    // Le symptôme visible est celui de la première cause
    symptomVisible(state, p) {
      const { masker, pa } = resolve()
      return masker.symptomVisible(state, pa(p))
    },

    ticket(state, p) {
      const { masker, pa } = resolve()
      return masker.ticket(state, pa(p))
    },

    hints(state, p) {
      const { masker, masked, pa, pb } = resolve()
      const [symptom, zone] = masker.hints(state, pa(p))
      return [
        symptom,
        zone,
        `Deux causes se cumulent : corrigez la première, puis testez de nouveau. ${masked.hints(state, pb(p))[0]}`
      ]
    },

    cause(state, p) {
      const { masker, masked, pa, pb } = resolve()
      return `Première cause : ${masker.cause(state, pa(p))} Seconde cause, cachée par la première : ${masked.cause(state, pb(p))}`
    },

    // Ordre de réparation : la masquante d'abord, la masquée ensuite
    repair(state, p) {
      const { masker, masked, pa, pb } = resolve()
      return [...masker.repair(state, pa(p)), ...masked.repair(state, pb(p))]
    },

    healed(state, p) {
      const { masker, masked, pa, pb } = resolve()
      return masker.healed(state, pa(p)) && masked.healed(state, pb(p))
    }
  }
  return def
}

/**
 * Le couple se comporte-t-il en panne composée ? Après injection : la masquante est visible, la
 * masquée ne l'est pas ; la masquante seule réparée, la masquée devient visible.
 */
export function maskedAsExpected(state: LabState, fault: FaultDef, p: FaultTargetParams): boolean {
  const c = compositeParts(fault)
  if (!c) return false
  const broken = apply(state, fault, p, false)
  if (!broken) return false
  if (!c.masker.symptomVisible(broken, c.pa(p)) || c.masked.symptomVisible(broken, c.pb(p))) return false
  const half = apply(broken, c.masker, c.pa(p), true)
  return !!half && c.masked.symptomVisible(half, c.pb(p)) && !c.masker.symptomVisible(half, c.pa(p))
}
