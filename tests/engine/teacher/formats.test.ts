/* eslint-disable @typescript-eslint/no-explicit-any -- documents JSON altérés à la main */
/** Formats du mode enseignant : aller-retour, références croisées, empreintes, migrations. */
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  canonicalJson,
  CORRECTION_FORMAT,
  createSubject,
  migrateTeacherDocument,
  parseCorrection,
  parseLab,
  parseSubject,
  parseSubmission,
  serializeCorrection,
  serializeSubject,
  serializeSubmission,
  SUBJECT_FORMAT,
  subjectFingerprint,
  SUBMISSION_FORMAT,
  type TeacherFileKind,
  type TeacherFormat
} from '@engine/index'
import { readFixture } from './fixtures'
import { referenceCorrection, referenceSubject, referenceSubmission } from './helpers'

const FORMATS: [TeacherFileKind, TeacherFormat<unknown>, (t: string) => { ok: boolean }][] = [
  ['sujet', SUBJECT_FORMAT as TeacherFormat<unknown>, parseSubject],
  ['rendu', SUBMISSION_FORMAT as TeacherFormat<unknown>, parseSubmission],
  ['correction', CORRECTION_FORMAT as TeacherFormat<unknown>, parseCorrection]
]

describe('aller-retour', () => {
  it('sujet, rendu et correction se relisent à l’identique', () => {
    const subject = referenceSubject()
    const submission = referenceSubmission(subject)
    const correction = referenceCorrection(submission)
    const s = parseSubject(serializeSubject(subject))
    const r = parseSubmission(serializeSubmission(submission))
    const c = parseCorrection(serializeCorrection(correction))
    expect(s.ok && s.doc).toEqual(subject)
    expect(r.ok && r.doc).toEqual(submission)
    expect(c.ok && c.doc).toEqual(correction)
  })

  it('les identifiants réservés à la 2.13 valent null par défaut', () => {
    const raw = JSON.parse(serializeSubmission(referenceSubmission())) as Record<string, any>
    delete raw.student.studentId
    delete raw.student.classId
    const r = parseSubmission(JSON.stringify(raw))
    expect(r.ok && r.doc.student).toEqual({ name: 'Élève Test', studentId: null, classId: null })
  })
})

describe('chaque lab de la bibliothèque devient un sujet valide', () => {
  const dir = new URL('../../../labs/', import.meta.url)
  const files = readdirSync(dir).filter((f) => f.endsWith('.json') && f.startsWith('lab-'))
  it.each(files)('%s', (file) => {
    const lab = parseLab(JSON.parse(readFileSync(new URL(file, dir), 'utf8')))
    if (!lab.ok) throw new Error(lab.message)
    const subject = createSubject(lab.lab, { appVersion: 'test' })
    expect(subject.scale.criteria).toHaveLength(lab.lab.criteria.length)
    const parsed = parseSubject(serializeSubject(subject))
    if (!parsed.ok) throw new Error(parsed.message)
    expect(subjectFingerprint(parsed.doc)).toBe(subjectFingerprint(subject))
  })
})

describe('références croisées du sujet', () => {
  const edit = (change: (doc: Record<string, any>) => void) => {
    const doc = JSON.parse(serializeSubject(referenceSubject())) as Record<string, any>
    change(doc)
    return parseSubject(JSON.stringify(doc))
  }
  it.each([
    ['critère noté inconnu', (d: any) => (d.scale.criteria[0].criterionId = 'absent')],
    ['critère noté deux fois', (d: any) => d.scale.criteria.push(d.scale.criteria[0])],
    ['déclencheur inconnu', (d: any) => (d.oral[0].trigger.criterionId = 'absent')],
    ['minute au-delà de la durée', (d: any) => (d.oral[1].trigger.minute = d.scale.minutes + 1)],
    ['question en double', (d: any) => (d.oral[1].id = d.oral[0].id)],
    ['tous les poids nuls', (d: any) => (d.scale.weights = { criteria: 0, time: 0, errors: 0 })],
    ['critère du lab en double', (d: any) => d.lab.criteria.push(d.lab.criteria[0])],
    ['champ inconnu (schéma strict)', (d: any) => (d.scale.bonus = 3)],
    ['pénalité négative', (d: any) => (d.scale.hintPenalty = -1)]
  ])('%s : refusé', (_name, change) => {
    const r = edit(change)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(/^Fichier de sujet invalide/)
  })
})

describe('empreinte du sujet', () => {
  it('indépendante de l’ordre des clés, de la mise en forme et de la version de l’application', () => {
    const subject = referenceSubject()
    const reordered = JSON.parse(canonicalJson({ ...subject, appVersion: '9.9.9' }))
    expect(subjectFingerprint(reordered)).toBe(subjectFingerprint(subject))
    expect(subjectFingerprint(subject)).toMatch(/^[0-9a-f]{64}$/)
  })
  it('change si le barème change', () => {
    const subject = referenceSubject()
    const other = { ...subject, scale: { ...subject.scale, hintPenalty: 1 } }
    expect(subjectFingerprint(other)).not.toBe(subjectFingerprint(subject))
  })
  it('forme canonique : clés triées, undefined ignoré', () => {
    expect(canonicalJson({ b: 1, a: [1, undefined], c: undefined })).toBe('{"a":[1,null],"b":1}')
  })
})

describe('versions et migrations', () => {
  it.each(FORMATS)('fichier de référence %s v1 : s’ouvre toujours', (kind, _f, parse) => {
    const r = parse(readFixture(kind, 1))
    expect(r.ok).toBe(true)
  })

  it.each(FORMATS)('%s d’une version plus récente : refusé avec un message clair', (_k, format, parse) => {
    const raw = { app: 'ServerLab', kind: format.kind, formatVersion: format.version + 1 }
    const r = parse(JSON.stringify(raw)) as { ok: false; message: string }
    expect(r.ok).toBe(false)
    expect(r.message).toContain('version plus récente')
  })

  it('applique les migrations dans l’ordre jusqu’au format courant', () => {
    const format: TeacherFormat<unknown> = {
      ...SUBJECT_FORMAT,
      version: 3,
      migrations: { 1: (d) => ({ ...d, a: 1 }), 2: (d) => ({ ...d, b: (d['a'] as number) + 1 }) }
    } as TeacherFormat<unknown>
    const r = migrateTeacherDocument(format, { formatVersion: 1 })
    expect(r).toEqual({ ok: true, doc: { formatVersion: 3, a: 1, b: 2 } })
    const missing = migrateTeacherDocument({ ...format, migrations: {} }, { formatVersion: 1 })
    expect(missing.ok).toBe(false)
  })

  it.each(FORMATS)('%s : type de fichier vérifié (pas de confusion entre formats)', (kind, _f, parse) => {
    const other = kind === 'sujet' ? 'rendu' : 'sujet'
    const r = parse(readFixture(other, 1)) as { ok: false; message: string }
    expect(r.ok).toBe(false)
    expect(r.message).toContain('n’est pas un')
  })
})
