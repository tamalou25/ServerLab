import { describe, expect, it } from 'vitest'
import { FAULTS, getFault } from '@engine/index'

describe('registre des pannes', () => {
  it('identifiants uniques, domaine et difficulté valides', () => {
    const ids = FAULTS.map((f) => f.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const f of FAULTS) {
      expect(['reseau', 'windows', 'linux', 'pare-feu']).toContain(f.domain)
      expect([1, 2, 3]).toContain(f.difficulty)
      expect(f.title.trim()).not.toBe('')
      expect(getFault(f.id)).toBe(f)
    }
    expect(getFault('inconnue')).toBeUndefined()
  })

  it('catalogue initial : windows.service-stopped et net.wrong-mask', () => {
    expect(FAULTS.map((f) => f.id).sort()).toEqual(['net.wrong-mask', 'windows.service-stopped'])
  })
})
