/** Passation : questions d'oral, indices, rendu, transaction (glisser) rejouée comme l'interface. */
import { describe, expect, it } from 'vitest'
import {
  buildLabState,
  correctSubmission,
  createSubject,
  dispatch,
  dueQuestions,
  finishAttempt,
  hintText,
  journalEntry,
  nextHint,
  parseLab,
  parseSubmission,
  recordEntry,
  emptyHistory,
  replayFrames,
  replaySubmission,
  serializeSubmission,
  startAttempt,
  undoStep,
  unwrap,
  type Subject
} from '@engine/index'
import lab37 from '../../../labs/lab-37-csv.json'
import { T0 } from './helpers'

const parsed = parseLab(lab37)
if (!parsed.ok) throw new Error(parsed.message)
const LAB = parsed.lab

function subject(): Subject {
  const s = createSubject(LAB, { appVersion: 'test' })
  return {
    ...s,
    scale: { ...s.scale, minutes: 30 },
    oral: [
      { id: 'q1', text: 'Minute 5', trigger: { kind: 'minute', minute: 5 }, points: 1 },
      {
        id: 'q2',
        text: 'Après critère',
        trigger: { kind: 'criterion', criterionId: LAB.criteria[0]!.id },
        points: 1
      }
    ]
  }
}

describe('passation', () => {
  const s = subject()
  const start = buildLabState(s.lab)

  it('questions d’oral : à la minute prévue, une seule fois', () => {
    const a = startAttempt(s, ' Alice ', 'exam', T0)
    expect(a.studentName).toBe('Alice')
    expect(dueQuestions(a, start, T0 + 4 * 60_000, new Set()).map((q) => q.id)).toEqual([])
    expect(dueQuestions(a, start, T0 + 5 * 60_000, new Set()).map((q) => q.id)).toEqual(['q1'])
    expect(dueQuestions(a, start, T0 + 5 * 60_000, new Set(['q1']))).toEqual([])
  })

  it('indices : premier critère non validé, de plus en plus précis, puis épuisés', () => {
    let a = startAttempt(s, 'Alice', 'exam', T0)
    const first = nextHint(a, start)!
    expect(first.index).toBe(0)
    expect(first.text).toBe(hintText(s, first.criterionId, 0))
    for (let i = 0; i < 50; i++) {
      const h = nextHint(a, start)
      if (!h) break
      a = { ...a, hints: [...a.hints, { criterionId: h.criterionId, index: h.index, at: T0 + i }] }
    }
    expect(nextHint(a, start)).toBeNull()
  })

  it('rendu : valide, temps écoulé borné à la durée', () => {
    const a = startAttempt(s, 'Alice', 'self', T0)
    const r = finishAttempt(a, { now: T0 + 40 * 60_000, ending: 'timeout', appVersion: 'test' })
    expect(r.endedAt).toBe(T0 + 30 * 60_000)
    expect(parseSubmission(serializeSubmission(r)).ok).toBe(true)
    expect(correctSubmission(s, r, { appVersion: 't', correctedAt: 'x' }).flags).toEqual([])
  })
})

describe('transaction (glisser un équipement)', () => {
  it('une seule entrée d’historique : annuler défait tout le déplacement', () => {
    const s = subject()
    const base = buildLabState(s.lab)
    const id = Object.keys(base.devices)[0]!
    const moves = [10, 20, 30].map((x) => ({ type: 'topology.moveDevice', args: [id, { x, y: x }] }))
    const r = finishAttempt(
      {
        ...startAttempt(s, 'A', 'exam', T0),
        journal: [
          { kind: 'transaction', at: T0 + 1, label: 'Déplacer', commands: moves },
          { kind: 'undo', at: T0 + 2 }
        ]
      },
      { now: T0 + 3, ending: 'finish', appVersion: 't' }
    )
    const replay = replaySubmission(s, r)
    expect(replay.outcomes).toEqual(['applied', 'undone'])
    expect(replay.state.devices[id]!.position).toEqual(base.devices[id]!.position)

    // Même résultat que l'historique de l'interface
    let state = base
    for (const m of moves) state = unwrap(dispatch(state, m)).state
    const entry = journalEntry(base, state, { type: 'batch', args: [], label: 'Déplacer' })!
    const undone = undoStep(state, recordEntry(emptyHistory(), entry))
    expect(undone.ok && undone.state.devices[id]!.position).toEqual(base.devices[id]!.position)
  })
})

describe('démonstration', () => {
  it('une image par pas, la dernière égale à l’état du rejeu', () => {
    const s = subject()
    const base = buildLabState(s.lab)
    const id = Object.keys(base.devices)[0]!
    const r = finishAttempt(
      {
        ...startAttempt(s, 'A', 'exam', T0),
        journal: [
          {
            kind: 'command',
            at: T0 + 1,
            command: { type: 'topology.moveDevice', args: [id, { x: 5, y: 5 }] }
          },
          { kind: 'command', at: T0 + 2, command: { type: 'x.y', args: [] } },
          { kind: 'undo', at: T0 + 3 }
        ]
      },
      { now: T0 + 4, ending: 'finish', appVersion: 't' }
    )
    const frames = replayFrames(s, r)
    expect(frames.map((f) => f.outcome)).toEqual(['start', 'applied', 'refused', 'undone'])
    expect(frames[1]!.state.devices[id]!.position).toEqual({ x: 5, y: 5 })
    expect(frames.at(-1)!.state).toEqual(replaySubmission(s, r).state)
  })
})
