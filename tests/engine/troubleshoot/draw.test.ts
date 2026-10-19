/**
 * Tirage contrôlé (issue #231) : déterminisme, diversité, réparabilité de TOUT tirage valide
 * (propriété sur les labs sains × graines × nombre de pannes × domaine) et erreurs métier.
 */
import { describe, expect, it } from 'vitest'
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

const SEEDS = Array.from({ length: 100 }, (_, i) => i + 1)
const DOMAINS: (FaultDomain | undefined)[] = ['reseau', 'windows']

/** Applique la réparation officielle de chaque panne, dans l'ordre donné. */
function repairAll(start: LabState, faults: ActiveFault[]): LabState {
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

describe('tirage : propriété de réparabilité', () => {
  const bases = BASES.map((b) => ({ name: b.name, healthy: b.build() }))

  it('tout tirage valide est réparable (ordre inverse et ordre d’injection)', { timeout: 120_000 }, () => {
    let valid = 0
    for (const base of bases)
      for (const domain of DOMAINS)
        for (const count of [1, 2, 3])
          for (const seed of count === 3 ? SEEDS.slice(0, 50) : SEEDS) {
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
    expect(valid).toBeGreaterThan(500)
  })
})

describe('tirage : déterminisme et diversité', () => {
  const bases = BASES.map((b) => ({ name: b.name, healthy: b.build() }))

  it('même graine : mêmes pannes, mêmes cibles, même ordre', { timeout: 60_000 }, () => {
    for (const base of bases)
      for (const seed of SEEDS) {
        const spec = { seed, count: 2 }
        const a = startTroubleshooting(base.healthy, spec)
        const b = startTroubleshooting(base.healthy, spec)
        expect(JSON.stringify(a)).toBe(JSON.stringify(b))
      }
  })

  it('graines différentes : diversité des pannes tirées', { timeout: 60_000 }, () => {
    // Un lab comme le lab 13 (VLAN) offre au moins 3 pannes différentes sur 100 graines
    const ids = new Set<string>()
    for (const seed of SEEDS) {
      const r = startTroubleshooting(bases.find((b) => b.name.includes('13'))!.healthy, { seed })
      if (r.ok) ids.add(r.value.faults[0]!.id)
    }
    expect(ids.size).toBeGreaterThanOrEqual(3)
    const all = new Set<string>()
    for (const base of bases)
      for (const seed of SEEDS) {
        const r = startTroubleshooting(base.healthy, { seed, count: 2 })
        if (r.ok) for (const f of r.value.faults) all.add(f.id)
      }
    expect(all.size).toBeGreaterThanOrEqual(8)
  })
})

describe('tirage : erreurs métier', () => {
  const healthy = BASES[0]!.build()

  it('domaine sans panne applicable', () => {
    const r = startTroubleshooting(healthy, { seed: 1, domain: 'pare-feu' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('NoFaultAvailable')
      expect(r.error.message).toMatch(/Aucune panne/)
    }
  })

  it('trop de pannes demandées', () => {
    const r = startTroubleshooting(healthy, { seed: 1, count: 50 })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('NoFaultAvailable')
      expect(r.error.message).toMatch(/Impossible de tirer 50 pannes/)
    }
  })

  it('panne imposée inconnue', () => {
    const r = startTroubleshooting(healthy, { seed: 1, faults: [{ id: 'net.inconnue' }] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('UnknownFault')
  })
})
