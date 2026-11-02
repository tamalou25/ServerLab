/**
 * Correction par rejeu : le journal d'un rendu est rejoué depuis le lab du sujet, la note est
 * recalculée (jamais lue), les incohérences sont signalées.
 */
import { describe, expect, it } from 'vitest'
import {
  buildLabState,
  classCsv,
  classStats,
  computeGrade,
  correctSubmission,
  createShellSession,
  createSubject,
  parseCorrection,
  parseLab,
  parseSubmission,
  replaySubmission,
  serializeCorrection,
  serializeSubmission,
  subjectFingerprint,
  type JournalStep,
  type LabState,
  type Subject,
  type Submission
} from '@engine/index'
import lab37 from '../../../labs/lab-37-csv.json'
import { T0 } from './helpers'

const parsed = parseLab(lab37)
if (!parsed.ok) throw new Error(parsed.message)
const LAB = parsed.lab

const LIGNE =
  'Import-Csv C:\\Scripts\\nouveaux.csv -Delimiter \';\' | ForEach-Object { New-ADUser -Name "$($_.Prenom) $($_.Nom)" -SamAccountName $_.Login -Path "OU=$($_.Service),DC=lab,DC=local" -AccountPassword (ConvertTo-SecureString \'P@ssw0rd2024!\' -AsPlainText -Force) -Enabled $true }'

function subject(change: Partial<Subject['scale']> = {}, oral: Subject['oral'] = []): Subject {
  const s = createSubject(LAB, { appVersion: 'test', oral })
  return { ...s, scale: { ...s.scale, minutes: 30, ...change } }
}

/** Session de console telle que l'interface l'enregistre (relue d'un fichier JSON). */
function exec(s: Subject, line: string, at: number): JournalStep {
  const state: LabState = createSubjectState(s)
  const srv = Object.values(state.devices).find((d) => d.name === 'SRV1')!.id
  const session = JSON.parse(JSON.stringify(createShellSession(state, srv, 'powershell'))) as unknown
  return { kind: 'command', at, command: { type: 'shell.exec', args: [session, line, []], label: line } }
}

const createSubjectState = (s: Subject) => buildLabState(s.lab)

function submission(s: Subject, journal: JournalStep[], extra: Partial<Submission> = {}): Submission {
  return {
    app: 'ServerLab',
    kind: 'rendu',
    formatVersion: 1,
    appVersion: 'test',
    subject: { fingerprint: subjectFingerprint(s), title: s.meta.title },
    student: { name: 'Alice', studentId: null, classId: null },
    mode: 'exam',
    startedAt: T0,
    endedAt: T0 + 10 * 60_000,
    ending: 'finish',
    journal,
    hints: [],
    answers: [],
    ...extra
  }
}

const correct = (s: Subject, r: Submission, oralPoints?: (number | null)[]) =>
  correctSubmission(s, r, { appVersion: 'test', correctedAt: '2026-11-02T10:00:00.000Z', oralPoints })

describe('rejeu', () => {
  it('la solution officielle rejouée valide 100 % des critères : 20 / 20, aucun signalement', () => {
    const s = subject()
    const c = correct(s, submission(s, [exec(s, LIGNE, T0 + 60_000)]))
    expect(c.criteria.every((k) => k.ok)).toBe(true)
    expect(c.grade).toEqual({ value: 20, outOf: 20 })
    expect(c.flags).toEqual([])
    expect(parseCorrection(serializeCorrection(c)).ok).toBe(true)
  })

  it('journal vide : 0 / 20', () => {
    const s = subject()
    expect(correct(s, submission(s, [])).grade.value).toBe(0)
  })

  it('propriété : rejouer un rendu relu du fichier donne la même note', () => {
    const s = subject({ weights: { criteria: 60, time: 20, errors: 20 } })
    const journal: JournalStep[] = [
      { kind: 'command', at: T0 + 1000, command: { type: 'topology.renameDevice', args: ['absent', 'X'] } },
      exec(s, LIGNE, T0 + 2000),
      { kind: 'undo', at: T0 + 3000 },
      { kind: 'redo', at: T0 + 4000 }
    ]
    const r = submission(s, journal)
    const reread = parseSubmission(serializeSubmission(r))
    if (!reread.ok) throw new Error(reread.message)
    const a = correct(s, r)
    const b = correct(s, reread.doc)
    expect(b.grade).toEqual(a.grade)
    expect(b.criteria).toEqual(a.criteria)
  })

  it('annuler défait la commande ; rétablir la refait (même historique que l’interface)', () => {
    const s = subject()
    const undone = replaySubmission(s, submission(s, [exec(s, LIGNE, T0 + 1), { kind: 'undo', at: T0 + 2 }]))
    expect(undone.criteria.some((k) => k.ok)).toBe(false)
    expect(undone.outcomes).toEqual(['applied', 'undone'])
    const redone = replaySubmission(
      s,
      submission(s, [exec(s, LIGNE, T0 + 1), { kind: 'undo', at: T0 + 2 }, { kind: 'redo', at: T0 + 3 }])
    )
    expect(redone.criteria.every((k) => k.ok)).toBe(true)
  })

  it('annulation sans rien à annuler : ignorée', () => {
    const s = subject()
    expect(replaySubmission(s, submission(s, [{ kind: 'undo', at: T0 + 1 }])).outcomes).toEqual(['ignored'])
  })

  it('arguments impossibles (exception) : rejeu interrompu et signalé', () => {
    const s = subject()
    const bad: JournalStep = {
      kind: 'command',
      at: T0 + 1,
      command: { type: 'shell.exec', args: [null, 42] }
    }
    const c = correct(s, submission(s, [bad, exec(s, LIGNE, T0 + 2)]))
    expect(c.flags.map((f) => f.code)).toContain('replay-failed')
    expect(c.criteria.some((k) => k.ok)).toBe(false)
  })

  it('commande inconnue : comptée comme refusée', () => {
    const s = subject()
    const r = replaySubmission(
      s,
      submission(s, [{ kind: 'command', at: T0 + 1, command: { type: 'x.y', args: [] } }])
    )
    expect(r.refused).toBe(1)
  })
})

describe('erreurs, indices, temps et oral', () => {
  const refused: JournalStep = { kind: 'command', at: T0 + 1000, command: { type: 'x.y', args: [] } }

  it('erreurs : commandes refusées, annulations si le barème le dit', () => {
    const s = subject({ weights: { criteria: 0, time: 0, errors: 1 }, maxErrors: 4, undoIsError: true })
    const c = correct(s, submission(s, [refused, exec(s, LIGNE, T0 + 2000), { kind: 'undo', at: T0 + 3000 }]))
    expect(c.errors).toEqual({ refused: 1, undos: 1, total: 2 })
    expect(c.components.errors).toBe(0.5)
    expect(c.grade.value).toBe(10)
  })

  it('pénalité par indice, note jamais négative', () => {
    const s = subject({ hintPenalty: 1 })
    const id = LAB.criteria[0]!.id
    const hints = [0, 1].map((i) => ({ criterionId: id, index: i, at: T0 + 1000 + i }))
    const c = correct(s, submission(s, [exec(s, LIGNE, T0 + 500)], { hints }))
    const max = s.scale.criteria.reduce((a, k) => a + k.points, 0)
    expect(c.penalties.hints).toBe(2)
    expect(c.grade.value).toBeCloseTo(((max - 2) / max) * 20, 2)
    expect(correct(s, submission(s, [], { hints })).grade.value).toBe(0)
  })

  it('temps : plein jusqu’à mi-durée, puis décroissant jusqu’à 0', () => {
    const s = subject({ weights: { criteria: 0, time: 1, errors: 0 } })
    const at = (min: number) => correct(s, submission(s, [], { endedAt: T0 + min * 60_000 })).components.time
    expect(at(10)).toBe(1)
    expect(at(15)).toBe(1)
    expect(at(22.5)).toBe(0.5)
    expect(at(30)).toBe(0)
  })

  it('poids réglables : moyenne pondérée des composantes', () => {
    const s = subject({ weights: { criteria: 3, time: 1, errors: 0 } })
    // Critères 100 %, temps 0 (durée entière) → 3/4 de la note
    const c = correct(s, submission(s, [exec(s, LIGNE, T0 + 1)], { endedAt: T0 + 30 * 60_000 }))
    expect(c.grade.value).toBe(15)
  })

  it('oral : points saisis par le professeur, bornés, réponse reprise du rendu', () => {
    const oral = [
      { id: 'q1', text: 'Pourquoi ?', trigger: { kind: 'minute' as const, minute: 1 }, points: 4 }
    ]
    const s = subject({}, oral)
    const r = submission(s, [exec(s, LIGNE, T0 + 1)], {
      answers: [{ questionId: 'q1', text: 'Parce que.', at: T0 + 2 }]
    })
    const max = s.scale.criteria.reduce((a, k) => a + k.points, 0)
    expect(correct(s, r).oral[0]).toEqual({ questionId: 'q1', answer: 'Parce que.', points: null, max: 4 })
    expect(correct(s, r).grade.value).toBeCloseTo((max / (max + 4)) * 20, 2)
    expect(correct(s, r, [99]).grade.value).toBe(20)
    expect(correct(s, r, [99]).oral[0]!.points).toBe(4)
  })

  it('computeGrade : barème sans aucun point → 0', () => {
    const s = subject()
    const empty = { ...s, scale: { ...s.scale, criteria: [] } }
    expect(
      computeGrade({
        subject: empty,
        passed: new Set(),
        elapsedMs: 0,
        errors: 0,
        hintsTaken: 0,
        oralPoints: []
      }).value
    ).toBe(0)
  })
})

describe('signalements', () => {
  const codes = (s: Subject, r: Submission) => correct(s, r).flags.map((f) => f.code)

  it('empreinte du sujet différente', () => {
    const s = subject()
    const r = submission(s, [])
    expect(codes(subject({ hintPenalty: 3 }), r)).toContain('subject-mismatch')
  })

  it('horodatages hors période, dans le désordre, ou fin avant début', () => {
    const s = subject()
    const step = (at: number): JournalStep => ({ kind: 'undo', at })
    expect(codes(s, submission(s, [step(T0 - 1)]))).toContain('timestamps-incoherent')
    expect(codes(s, submission(s, [step(T0 + 5), step(T0 + 2)]))).toContain('timestamps-incoherent')
    expect(codes(s, submission(s, [], { endedAt: T0 - 1 }))).toContain('timestamps-incoherent')
  })

  it('indice ou réponse hors sujet', () => {
    const s = subject()
    const r = submission(s, [], { hints: [{ criterionId: 'absent', index: 0, at: T0 + 1 }] })
    expect(codes(s, r)).toContain('timestamps-incoherent')
  })

  it('durée hors bornes : dépassement, ou « temps écoulé » trop tôt', () => {
    const s = subject()
    expect(codes(s, submission(s, [], { endedAt: T0 + 40 * 60_000 }))).toContain('duration-out-of-bounds')
    expect(codes(s, submission(s, [], { ending: 'timeout' }))).toContain('duration-out-of-bounds')
    expect(codes(s, submission(s, [], { ending: 'timeout', endedAt: T0 + 30 * 60_000 }))).toEqual([])
  })

  it('une note gonflée à la main dans le rendu n’a aucun effet (rien n’est lu)', () => {
    const s = subject()
    const raw = JSON.parse(serializeSubmission(submission(s, []))) as Record<string, unknown>
    expect(parseSubmission(JSON.stringify({ ...raw, grade: 20 })).ok).toBe(false)
  })
})

describe('bilan de classe', () => {
  const s = subject()
  const full = correct(s, submission(s, [exec(s, LIGNE, T0 + 1)]))
  const empty = correct(s, {
    ...submission(s, []),
    student: { name: '=HYPERLIEN("x");"', studentId: null, classId: null }
  })

  it('CSV : BOM, séparateur ;, une colonne par critère, formules neutralisées', () => {
    const csv = classCsv([full, empty])
    expect(csv.startsWith('\uFEFF')).toBe(true)
    const lines = csv.slice(1).trimEnd().split('\r\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]!.split(';').length).toBe(11 + LAB.criteria.length)
    expect(lines[1]).toMatch(/^Alice;20;20;/)
    expect(lines[2]).toMatch(/^"'=HYPERLIEN\(""x""\);"""/)
  })

  it('statistiques : moyenne, critère le plus raté, temps moyen', () => {
    const stats = classStats([full, empty])
    expect(stats.count).toBe(2)
    expect(stats.mean).toBe(10)
    expect(stats.meanElapsedMs).toBe(10 * 60_000)
    expect(stats.mostFailed?.failures).toBe(1)
    expect(classStats([])).toEqual({
      count: 0,
      mean: null,
      meanElapsedMs: null,
      mostFailed: null,
      flagged: 0
    })
  })
})
