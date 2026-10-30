/**
 * Fichiers hostiles : .slab et labs tronqués, énormes, aux champs inattendus, aux types faux ou
 * d'une profondeur extrême. Attendu : rejet avec message français, ni exception ni blocage.
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_LAB_LENGTH,
  MAX_SLAB_LENGTH,
  parseLab,
  parseLabText,
  parseSlab,
  parseSlabValue,
  serializeSlab
} from '@engine/index'
import { loadAllLabs, prng, type Rng } from './prng'

const TIMEOUT = 5000
const lab = loadAllLabs()[3]!
const SLAB = serializeSlab(lab.state, { savedAt: '2026-10-05T12:00:00.000Z', appVersion: 'test' })
const LAB_TEXT = JSON.stringify(lab.def)

/** Un message d'erreur lisible : non vide, en français (accents ou mots usuels), sans trace technique. */
function expectFrenchMessage(message: string): void {
  expect(message.length).toBeGreaterThan(10)
  expect(message).not.toMatch(/\bat \w+.*\(.*:\d+:\d+\)/) // pas de pile d'appels
  expect(message).not.toMatch(/Unexpected token|is not a function|Cannot read prop|undefined is not/)
  expect(message).toMatch(/[éèêàçôù’]|fichier|lab|invalide|document|champ|valeur|trop|illisible|ServerLab/i)
}

/** Remplace récursivement des valeurs par des types faux, de façon pseudo-aléatoire. */
function corrupt(value: unknown, rng: Rng, rate: number): unknown {
  if (rng.next() < rate) {
    return rng.pick([null, 42, -1, 1e308, 'x', true, [], {}, [1, 2], { a: 1 }, '', NaN, 'é\u0000😀'])
  }
  if (Array.isArray(value)) return value.map((v) => corrupt(v, rng, rate))
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, corrupt(v, rng, rate)]))
  return value
}

function nested(depth: number, leaf: unknown): unknown {
  let v = leaf
  for (let i = 0; i < depth; i++) v = { a: v }
  return v
}

describe('.slab hostile', () => {
  it('tronqué à de nombreux endroits : refusé', { timeout: TIMEOUT * 4 }, () => {
    for (let i = 0; i < 200; i++) {
      const r = parseSlab(SLAB.slice(0, Math.floor((SLAB.length * i) / 200)))
      expect(r.ok).toBe(false)
      if (!r.ok) expectFrenchMessage(r.message)
    }
  })

  it('énorme (au-delà du plafond) : refusé sans analyse', { timeout: TIMEOUT }, () => {
    const r = parseSlab(' '.repeat(MAX_SLAB_LENGTH + 1))
    expect(r.ok).toBe(false)
    if (!r.ok) expectFrenchMessage(r.message)
    const r2 = parseSlab(SLAB + ' '.repeat(MAX_SLAB_LENGTH))
    expect(r2.ok).toBe(false)
  })

  it('contenus absurdes : refusés', { timeout: TIMEOUT }, () => {
    for (const text of [
      '',
      ' ',
      'null',
      '[]',
      '0',
      '"x"',
      '{}',
      '{"app":"ServerLab"}',
      '\u0000\u0000',
      '{"app":"ServerLab","schemaVersion":"1"}',
      '[[[[',
      '{"__proto__":{"app":"ServerLab"}}'
    ]) {
      const r = parseSlab(text)
      expect(r.ok, text).toBe(false)
      if (!r.ok) expectFrenchMessage(r.message)
    }
  })

  it(
    'types faux dispersés : jamais d’exception, message français si refusé',
    { timeout: TIMEOUT * 4 },
    () => {
      const doc = JSON.parse(SLAB) as unknown
      const rng = prng(4242)
      let refused = 0
      for (let i = 0; i < 150; i++) {
        const mutated = corrupt(doc, rng, 0.002 + rng.next() * 0.02)
        let r: ReturnType<typeof parseSlabValue> | undefined
        expect(() => (r = parseSlabValue(mutated))).not.toThrow()
        if (!r!.ok) {
          refused++
          expectFrenchMessage(r!.message)
        }
      }
      expect(refused).toBeGreaterThan(50)
    }
  )

  it('champs inattendus ajoutés partout : ignorés ou refusés, sans exception', { timeout: TIMEOUT }, () => {
    const doc = JSON.parse(SLAB) as Record<string, unknown>
    doc['extra'] = { inconnu: 1 }
    doc['__proto__'] = { polluted: true }
    ;(doc['lab'] as Record<string, unknown>)['nouveauChamp'] = [1, 2, 3]
    const r = parseSlabValue(doc)
    if (!r.ok) expectFrenchMessage(r.message)
    else expect(r.doc.lab).not.toHaveProperty('nouveauChamp')
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })

  it('profondeur extrême : refusé sans dépassement de pile', { timeout: TIMEOUT }, () => {
    for (const depth of [1000, 20000]) {
      const text = '['.repeat(depth) + ']'.repeat(depth)
      const r = parseSlab(text)
      expect(r.ok).toBe(false)
      const doc = JSON.parse(SLAB) as Record<string, unknown>
      doc['lab'] = nested(5000, 1)
      let r2: ReturnType<typeof parseSlabValue> | undefined
      expect(() => (r2 = parseSlabValue(doc))).not.toThrow()
      expect(r2!.ok).toBe(false)
      // Profondeur extrême dans un champ libre d'un document par ailleurs valide
      const deep = JSON.parse(SLAB) as Record<string, unknown>
      ;(deep['meta'] as Record<string, unknown>)['title'] = nested(5000, 'x')
      expect(() => parseSlabValue(deep)).not.toThrow()
    }
  })
})

describe('lab hostile', () => {
  it('tronqué à de nombreux endroits : refusé avec un message', { timeout: TIMEOUT * 2 }, () => {
    for (let i = 0; i < 100; i++) {
      const r = parseLabText(LAB_TEXT.slice(0, Math.floor((LAB_TEXT.length * i) / 100)))
      expect(r.ok).toBe(false)
      if (!r.ok) expectFrenchMessage(r.message)
    }
  })

  it('énorme (au-delà du plafond) : refusé', { timeout: TIMEOUT }, () => {
    const r = parseLabText(' '.repeat(MAX_LAB_LENGTH + 1))
    expect(r.ok).toBe(false)
    if (!r.ok) expectFrenchMessage(r.message)
  })

  it('types faux dispersés : jamais d’exception', { timeout: TIMEOUT * 4 }, () => {
    const rng = prng(777)
    const raw = JSON.parse(LAB_TEXT) as unknown
    let refused = 0
    for (let i = 0; i < 150; i++) {
      const mutated = corrupt(raw, rng, 0.003 + rng.next() * 0.03)
      let r: ReturnType<typeof parseLab> | undefined
      expect(() => (r = parseLab(mutated))).not.toThrow()
      if (!r!.ok) {
        refused++
        expectFrenchMessage(r!.message)
      }
    }
    expect(refused).toBeGreaterThan(50)
  })

  it('contenus absurdes et profondeur extrême : refusés', { timeout: TIMEOUT }, () => {
    for (const text of [
      '',
      'null',
      '[]',
      '{}',
      '"x"',
      '[[[[',
      '{"id":1}',
      '['.repeat(50000),
      nested(3000, 1) === null ? '' : JSON.stringify(nested(3000, 1))
    ]) {
      let r: ReturnType<typeof parseLabText> | undefined
      expect(() => (r = parseLabText(text))).not.toThrow()
      expect(r!.ok).toBe(false)
      if (!r!.ok) expectFrenchMessage(r!.message)
    }
  })
})
