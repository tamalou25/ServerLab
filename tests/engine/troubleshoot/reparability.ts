/**
 * Propriété de réparabilité du tirage (issue #231) partagée par la version rapide (`npm test`,
 * draw.test.ts) et la version complète (`npm run test:long`, draw.long.test.ts).
 */
import { expect } from 'vitest'
import {
  allRepaired,
  dispatch,
  getFault,
  startTroubleshooting,
  type ActiveFault,
  type FaultDomain,
  type LabState
} from '@engine/index'
import { BASES } from './bases'

export const DOMAINS: (FaultDomain | undefined)[] = [undefined, 'reseau', 'windows', 'linux', 'pare-feu']

/** Applique la réparation officielle de chaque panne, dans l'ordre donné. */
export function repairAll(start: LabState, faults: ActiveFault[]): LabState {
  let s = start
  for (const a of faults) {
    for (const c of getFault(a.id)!.repair(s, a.params)) {
      const d = dispatch(s, c)
      if (!d.ok) throw new Error(`${a.id} : ${d.error.message}`)
      s = d.state
    }
  }
  return s
}

/**
 * Tout tirage valide (labs sains × domaines × 1 à 3 pannes × graines) est réparable, dans l'ordre
 * inverse et dans l'ordre d'injection. Renvoie le nombre de tirages valides.
 */
export function checkReparability(seeds: number[], seedsForThree: number[]): number {
  const bases = BASES.map((b) => ({ name: b.name, healthy: b.build() }))
  let valid = 0
  for (const base of bases)
    for (const domain of DOMAINS)
      for (const count of [1, 2, 3])
        for (const seed of count === 3 ? seedsForThree : seeds) {
          const r = startTroubleshooting(base.healthy, { seed, domain, count })
          if (!r.ok) continue
          valid++
          const ctx = `${base.name} ${domain} x${count} graine ${seed}`
          for (const order of count === 1 ? ['inverse'] : ['inverse', 'injection']) {
            const list = order === 'inverse' ? [...r.value.faults].reverse() : r.value.faults
            const fixed = repairAll(r.state, list)
            expect(allRepaired(fixed), `${ctx} (${order})`).toBe(true)
            for (const a of r.value.faults)
              expect(getFault(a.id)!.symptomVisible(fixed, a.params), `${ctx} ${a.id}`).toBe(false)
          }
        }
  return valid
}
