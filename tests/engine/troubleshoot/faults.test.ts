/**
 * Réparabilité (cœur de l'issue #228) : pour chaque panne du registre et 100 graines, le lab
 * démarre cassé (symptôme visible, panne non guérie), la réparation officielle le guérit.
 */
import { describe, expect, it } from 'vitest'
import { dispatch, FAULTS, mulberry32, startTroubleshooting, type LabState } from '@engine/index'
import { BASES } from './bases'

const SEEDS = Array.from({ length: 100 }, (_, i) => i + 1)

describe.each(FAULTS.map((f) => [f.id, f] as const))('panne %s', (_id, fault) => {
  const applicable = BASES.map((b) => ({ ...b, healthy: b.build() })).filter(
    (b) => fault.pick(b.healthy, mulberry32(1)) !== null
  )

  it('s’applique à au moins un lab sain de référence', () => {
    expect(applicable.length).toBeGreaterThan(0)
  })

  it('textes : ticket, 3 indices, cause non vides ; le ticket ne donne pas la solution', () => {
    for (const base of applicable) {
      const r = startTroubleshooting(base.healthy, { seed: 7, faults: [{ id: fault.id }] })
      if (!r.ok) throw new Error(r.error.message)
      const f = r.value.faults[0]!
      expect(fault.ticket(r.state, f.params).length).toBeGreaterThan(10)
      expect(fault.hints(r.state, f.params)).toHaveLength(3)
      for (const h of fault.hints(r.state, f.params)) expect(h.trim()).not.toBe('')
      expect(fault.cause(r.state, f.params).trim()).not.toBe('')
      expect(fault.ticket(r.state, f.params)).not.toContain(fault.id)
    }
  })

  it.each(SEEDS)('graine %i : cassé puis réparé', (seed) => {
    for (const base of applicable) {
      const r = startTroubleshooting(base.healthy, { seed, faults: [{ id: fault.id }] })
      if (!r.ok) throw new Error(`${base.name} : ${r.error.message}`)
      const { params } = r.value.faults[0]!
      expect(fault.healed(base.healthy, params)).toBe(true)
      expect(fault.symptomVisible(base.healthy, params)).toBe(false)
      expect(fault.symptomVisible(r.state, params)).toBe(true)
      expect(fault.healed(r.state, params)).toBe(false)

      let fixed: LabState = r.state
      for (const c of fault.repair(r.state, params)) {
        const d = dispatch(fixed, c)
        if (!d.ok) throw new Error(d.error.message)
        fixed = d.state
      }
      expect(fault.healed(fixed, params)).toBe(true)
      expect(fault.symptomVisible(fixed, params)).toBe(false)
    }
  })
})
