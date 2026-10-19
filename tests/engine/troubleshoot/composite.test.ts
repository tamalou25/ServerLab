/**
 * Pannes composées (#230) : deux causes dont la première masque la seconde. Pour chaque composée du
 * registre et 100 graines : le symptôme de la seconde cause n'est PAS observable tant que la première
 * n'est pas réparée, il le devient dès qu'elle l'est, et la réparation des deux guérit le lab.
 */
import { describe, expect, it } from 'vitest'
import {
  allRepaired,
  compositeParts,
  dispatch,
  FAULTS,
  mulberry32,
  startTroubleshooting,
  unwrap,
  type AnyCommand,
  type FaultDef,
  type LabState
} from '@engine/index'
import { BASES } from './bases'

const SEEDS = Array.from({ length: 100 }, (_, i) => i + 1)
const COMPOSITES = FAULTS.filter((f) => f.parts !== undefined)

function play(state: LabState, commands: AnyCommand[]): LabState {
  let next = state
  for (const c of commands) {
    const r = dispatch(next, c)
    if (!r.ok) throw new Error(`${c.type} : ${r.error.message}`)
    next = r.state
  }
  return next
}

describe('pannes composées : définition', () => {
  it('le catalogue compte au moins six pannes composées Windows, de parties distinctes', () => {
    expect(COMPOSITES.length).toBeGreaterThanOrEqual(6)
    for (const f of COMPOSITES) {
      const c = compositeParts(f)!
      expect(f.id.startsWith('win.combo.')).toBe(true)
      expect(c.masker).not.toBe(c.masked)
      expect(c.masker.parts).toBeUndefined()
      expect(c.masked.parts).toBeUndefined()
      expect(f.difficulty).toBeGreaterThanOrEqual(Math.max(c.masker.difficulty, c.masked.difficulty))
    }
  })

  it('une panne simple n’a pas de parties', () => {
    expect(compositeParts(FAULTS.find((f) => f.parts === undefined)!)).toBeNull()
  })
})

describe.each(COMPOSITES.map((f) => [f.id, f] as const))('panne composée %s', (_id, fault: FaultDef) => {
  const c = compositeParts(fault)!
  const applicable = BASES.map((b) => ({ ...b, healthy: b.build() })).filter(
    (b) => fault.pick(b.healthy, mulberry32(1)) !== null
  )

  it('s’applique à au moins un lab sain de référence', () => {
    expect(applicable.length).toBeGreaterThan(0)
  })

  it('textes : le ticket est celui de la première cause, la cause cite les deux', () => {
    for (const base of applicable) {
      const r = unwrap(startTroubleshooting(base.healthy, { seed: 3, faults: [{ id: fault.id }] }))
      const p = r.value.faults[0]!.params
      expect(fault.ticket(r.state, p)).toBe(c.masker.ticket(r.state, c.pa(p)))
      expect(fault.hints(r.state, p)).toHaveLength(3)
      expect(fault.cause(r.state, p)).toContain(c.masker.cause(r.state, c.pa(p)))
      expect(fault.cause(r.state, p)).toContain(c.masked.cause(r.state, c.pb(p)))
    }
  })

  it.each(SEEDS)('graine %i : la seconde cause n’apparaît qu’après réparation de la première', (seed) => {
    for (const base of applicable) {
      const r = unwrap(startTroubleshooting(base.healthy, { seed, faults: [{ id: fault.id }] }))
      const p = r.value.faults[0]!.params
      const [pa, pb] = [c.pa(p), c.pb(p)]

      // Cassé : seule la première cause se voit ; la seconde est présente mais masquée
      expect(c.masker.symptomVisible(r.state, pa)).toBe(true)
      expect(c.masked.symptomVisible(r.state, pb)).toBe(false)
      expect(c.masked.healed(r.state, pb)).toBe(false)

      // Première cause réparée seule : le symptôme de la seconde se révèle, la panne n'est pas guérie
      const half = play(r.state, c.masker.repair(r.state, pa))
      expect(c.masker.symptomVisible(half, pa)).toBe(false)
      expect(c.masked.symptomVisible(half, pb)).toBe(true)
      expect(fault.healed(half, p)).toBe(false)

      // Seconde cause réparée à son tour : tout est guéri
      const done = play(half, c.masked.repair(half, pb))
      expect(fault.healed(done, p)).toBe(true)
      expect(fault.symptomVisible(done, p)).toBe(false)
    }
  })

  it('le tirage par graine peut choisir la panne composée', () => {
    const base = applicable[0]!
    const r = unwrap(startTroubleshooting(base.healthy, { seed: 5, faults: [{ id: fault.id }] }))
    expect(r.value.faults.map((f) => f.id)).toEqual([fault.id])
    expect(r.state.troubleshooting?.faults[0]?.id).toBe(fault.id)
  })
})

describe('tirage automatique', () => {
  it('une graine peut tirer une panne composée parmi le domaine windows', () => {
    const lab = BASES.find((b) => b.name === 'lab-03-dns')!.build()
    const drawn = new Set<string>()
    for (let seed = 1; seed <= 200; seed++) {
      const r = startTroubleshooting(lab, { seed, domain: 'windows' })
      if (r.ok) for (const f of r.value.faults) drawn.add(f.id)
    }
    expect([...drawn].some((id) => id.startsWith('win.combo.'))).toBe(true)
  })

  it('le tirage automatique est reproductible ; réparer toutes les pannes dans l’ordre guérit le lab', () => {
    const lab = BASES.find((b) => b.name === 'lab-04-ad-gpo')!.build()
    for (let seed = 1; seed <= 40; seed++) {
      const a = startTroubleshooting(lab, { seed, domain: 'windows', count: 2 })
      const b = startTroubleshooting(lab, { seed, domain: 'windows', count: 2 })
      expect(a.ok).toBe(b.ok)
      if (!a.ok || !b.ok) continue
      expect(a.value.faults).toEqual(b.value.faults)
      let fixed: LabState = a.state
      for (const f of a.value.faults) {
        const def = FAULTS.find((x) => x.id === f.id)!
        fixed = play(fixed, def.repair(fixed, f.params))
      }
      expect(allRepaired(fixed)).toBe(true)
    }
  })
})
