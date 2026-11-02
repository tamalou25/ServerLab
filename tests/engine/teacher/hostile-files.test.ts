/**
 * Fichiers hostiles du mode enseignant : tronqués, altérés, trop gros, trop de pas de rejeu,
 * structures piégées. Jamais d'exception, toujours un message en français.
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_REPLAY_STEPS,
  parseCorrection,
  parseSubject,
  parseSubmission,
  serializeCorrection,
  serializeSubject,
  serializeSubmission,
  SUBJECT_FORMAT,
  SUBMISSION_FORMAT,
  CORRECTION_FORMAT,
  type TeacherParseResult
} from '@engine/index'
import { referenceCorrection, referenceSubject, referenceSubmission, T0 } from './helpers'

/** Générateur à graine fixe (mulberry32) : mêmes cas à chaque exécution. */
function random(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Parser = (content: string) => TeacherParseResult<unknown>
const subject = referenceSubject()
const submission = referenceSubmission(subject)
const CASES: [string, string, Parser, number][] = [
  ['sujet', serializeSubject(subject), parseSubject, SUBJECT_FORMAT.maxLength],
  ['rendu', serializeSubmission(submission), parseSubmission, SUBMISSION_FORMAT.maxLength],
  [
    'correction',
    serializeCorrection(referenceCorrection(submission)),
    parseCorrection,
    CORRECTION_FORMAT.maxLength
  ]
]

function safe(parse: Parser, content: string): TeacherParseResult<unknown> {
  let result: TeacherParseResult<unknown> | undefined
  expect(() => (result = parse(content))).not.toThrow()
  if (!result!.ok) expect(result!.message.length).toBeGreaterThan(10)
  return result!
}

describe.each(CASES)('%s hostile', (_kind, base, parse, maxLength) => {
  it('le document de base est valide', () => {
    expect(safe(parse, base).ok).toBe(true)
  })

  it('tronqué n’importe où : refusé', () => {
    for (let i = 1; i < 40; i++)
      expect(safe(parse, base.slice(0, Math.floor((base.length * i) / 40))).ok).toBe(false)
  })

  it('caractères altérés : jamais d’exception', () => {
    const next = random(212)
    const noise = '{}[]":,0-1aéz\n\\ '
    for (let n = 0; n < 200; n++) {
      const chars = base.split('')
      for (let k = 0; k < 1 + Math.floor(next() * 4); k++)
        chars[Math.floor(next() * chars.length)] = noise[Math.floor(next() * noise.length)]!
      safe(parse, chars.join(''))
    }
  })

  it('trop volumineux : refusé avant l’analyse JSON', () => {
    const r = safe(parse, ' '.repeat(maxLength + 1))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('trop volumineux')
  })

  it.each([
    ['null', 'null'],
    ['tableau', '[]'],
    ['nombre', '42'],
    ['autre application', '{"app":"Autre"}'],
    ['__proto__', '{"__proto__":{"polluted":true},"app":"ServerLab"}']
  ])('valeur de base hostile (%s) : refusée', (_n, content) => {
    expect(safe(parse, content).ok).toBe(false)
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })

  it('mauvais types à la racine : refusés sans exception', () => {
    const doc = JSON.parse(base) as Record<string, unknown>
    for (const key of Object.keys(doc))
      for (const value of [null, 1, 'x', [], {}, true, -1, 1e308]) {
        const r = safe(parse, JSON.stringify({ ...doc, [key]: value }))
        // Même type que l'original (chaîne, tableau vide) : peut rester valide
        const shape = (v: unknown) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v)
        if (shape(value) !== shape(doc[key])) expect(r.ok).toBe(false)
      }
  })
})

describe('rendu : bornes du journal', () => {
  const step = (i: number) => ({ kind: 'undo', at: T0 + i })
  it(`au plus ${MAX_REPLAY_STEPS} pas de rejeu`, () => {
    const ok = { ...submission, journal: Array.from({ length: MAX_REPLAY_STEPS }, (_, i) => step(i)) }
    expect(parseSubmission(JSON.stringify(ok)).ok).toBe(true)
    const tooMany = { ...ok, journal: [...ok.journal, step(MAX_REPLAY_STEPS)] }
    expect(parseSubmission(JSON.stringify(tooMany)).ok).toBe(false)
  })

  it.each([
    ['nom de commande piégé', { kind: 'command', at: T0, command: { type: '__proto__', args: [] } }],
    ['trop d’arguments', { kind: 'command', at: T0, command: { type: 'x.y', args: new Array(17).fill(0) } }],
    ['horodatage négatif', { kind: 'undo', at: -1 }],
    ['horodatage non entier', { kind: 'undo', at: 1.5 }],
    ['pas inconnu', { kind: 'eval', at: T0 }]
  ])('%s : refusé', (_n, bad) => {
    expect(parseSubmission(JSON.stringify({ ...submission, journal: [bad] })).ok).toBe(false)
  })

  it('nom d’élève vide ou trop long : refusé', () => {
    for (const name of ['', 'x'.repeat(101)])
      expect(
        parseSubmission(JSON.stringify({ ...submission, student: { ...submission.student, name } })).ok
      ).toBe(false)
  })

  it('imbrication très profonde dans les arguments : jamais d’exception', () => {
    const deep = '['.repeat(5000) + ']'.repeat(5000)
    const text = serializeSubmission(submission).replace('"args": [', `"args": [${deep},`)
    safe(parseSubmission, text)
  })
})
