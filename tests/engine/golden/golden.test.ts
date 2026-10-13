import { describe, expect, it } from 'vitest'
import { diffLines, listCaptures, normalize, parseCapture, readCapture } from './golden'

describe('infrastructure golden', () => {
  it('chaque capture a une source et une commande', () => {
    for (const name of listCaptures()) {
      const c = readCapture(name)
      expect(c.source.length, name).toBeGreaterThan(0)
      expect(c.command.length, name).toBeGreaterThan(0)
    }
  })

  it('refuse une capture sans source', () => {
    expect(() => parseCapture('# Commande: x\nsortie')).toThrow(/Source/)
  })

  it('compare au caractère près, espaces de fin compris', () => {
    expect(diffLines(['a', 'b'], ['a', 'b'])).toEqual([])
    expect(diffLines(['a '], ['a'])).toHaveLength(1)
    expect(diffLines(['a'], ['a', ''])).toHaveLength(1)
  })

  it('ne normalise que les jetons demandés', () => {
    const l = ['SID S-1-5-21-1-2-3-500 le 13/10/2026 10:00']
    expect(normalize(l, ['sid'])).toEqual(['SID {sid} le 13/10/2026 10:00'])
    expect(normalize(l, ['sid', 'date'])).toEqual(['SID {sid} le {date}'])
    expect(normalize(['00-15-5D-01-02-03 0015.5d01.0203'], ['mac'])).toEqual(['{mac} {mac}'])
  })
})
