/**
 * Tirage contrôlé (issue #231) : déterminisme, diversité, réparabilité de TOUT tirage valide
 * (version rapide ; la couverture complète est dans draw.long.test.ts, `npm run test:long`)
 * et erreurs métier.
 */
import { describe, expect, it } from 'vitest'
import { allRepaired, startTroubleshooting } from '@engine/index'
import { BASES } from './bases'
import { checkReparability, repairAll } from './reparability'

const SEEDS = Array.from({ length: 100 }, (_, i) => i + 1)

describe('tirage : propriété de réparabilité (version rapide)', () => {
  it('tout tirage valide est réparable (ordre inverse et ordre d’injection)', { timeout: 120_000 }, () => {
    // 20 graines (10 pour 3 pannes) × 5 domaines ; 100 graines et plus de 500 tirages : npm run test:long
    const valid = checkReparability(SEEDS.slice(0, 20), SEEDS.slice(0, 10))
    expect(valid).toBeGreaterThan(150)
  })
})

describe('tirage : déterminisme et diversité', () => {
  const bases = BASES.map((b) => ({ name: b.name, healthy: b.build() }))

  it('même graine : mêmes pannes, mêmes cibles, même ordre', { timeout: 120_000 }, () => {
    for (const base of bases)
      for (const seed of SEEDS) {
        const spec = { seed, count: 2 }
        const a = startTroubleshooting(base.healthy, spec)
        const b = startTroubleshooting(base.healthy, spec)
        expect(JSON.stringify(a)).toBe(JSON.stringify(b))
      }
  })

  it('graines différentes : diversité des pannes tirées', { timeout: 120_000 }, () => {
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

describe('tirage : pannes DHCP et réseau d’un même poste (#327, #328)', () => {
  const lab02 = BASES.find((b) => b.name === 'lab-02-dhcp')!.build()

  it('lab-02-dhcp, 2 pannes : réparable dans les deux ordres', () => {
    for (const seed of [9, 14, 20, 24, 25, 26, 27, 32, 35, 36, 37]) {
      const r = startTroubleshooting(lab02, { seed, count: 2 })
      if (!r.ok) continue
      for (const list of [r.value.faults, [...r.value.faults].reverse()])
        expect(allRepaired(repairAll(r.state, list)), `graine ${seed}`).toBe(true)
    }
  })
})
