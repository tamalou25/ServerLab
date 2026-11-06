/**
 * États d'une copie et chronologie du journal : dérivés des données réelles de la correction et du
 * rendu, jamais inventés.
 */
import { describe, expect, it } from 'vitest'
import { copyStatus, journalTimeline } from '@engine/index'
import { referenceCorrection, referenceSubmission, T0 } from './helpers'

describe('copyStatus', () => {
  it('tous critères validés, oral noté, aucun signalement', () => {
    const c = { ...referenceCorrection(), flags: [] }
    expect(copyStatus({ ...c, oral: c.oral.map((q) => ({ ...q, points: 1 })) })).toEqual({
      flagged: false,
      replayFailed: false,
      oralPending: false,
      passed: 1,
      total: 1,
      criteria: 'complete'
    })
  })

  it('oral à renseigner, rejeu interrompu, partiel et aucun critère', () => {
    const c = { ...referenceCorrection(), flags: [] }
    expect(
      copyStatus({ ...c, oral: [{ questionId: 'q1', answer: 'x', points: null, max: 2 }] }).oralPending
    ).toBe(true)
    const failed = {
      ...c,
      flags: [{ code: 'replay-failed' as const, message: 'Rejeu interrompu au pas 2' }],
      criteria: [
        { id: 'a', label: 'A', ok: true, points: 1, max: 1 },
        { id: 'b', label: 'B', ok: false, points: 0, max: 1 }
      ]
    }
    expect(copyStatus(failed)).toMatchObject({
      flagged: true,
      replayFailed: true,
      passed: 1,
      total: 2,
      criteria: 'partial'
    })
    expect(
      copyStatus({ ...c, criteria: [{ id: 'a', label: 'A', ok: false, points: 0, max: 1 }] }).criteria
    ).toBe('none')
    expect(copyStatus({ ...c, flags: [{ code: 'subject-mismatch', message: 'x' }] })).toMatchObject({
      flagged: true,
      replayFailed: false
    })
  })
})

describe('journalTimeline', () => {
  it('commandes, annulations, indices et réponses triés par temps relatif au départ', () => {
    const entries = journalTimeline(referenceSubmission())
    expect(entries).toEqual([
      { offsetMs: 1000, kind: 'command', label: 'Étendue' },
      { offsetMs: 2000, kind: 'undo', label: 'Annuler' },
      { offsetMs: 3000, kind: 'redo', label: 'Rétablir' },
      { offsetMs: 4000, kind: 'hint', label: 'Indice 1' },
      { offsetMs: 5000, kind: 'answer', label: 'Réponse à l’oral' }
    ])
  })

  it('transaction (glisser) sous son libellé, commande sans libellé sous son type, horodatage antérieur borné à 0', () => {
    const s = referenceSubmission()
    const entries = journalTimeline({
      ...s,
      journal: [
        { kind: 'transaction', at: T0 + 10, label: 'Déplacer PC1', commands: [] },
        { kind: 'command', at: T0 - 50, command: { type: 'topology.setPower', args: [] } }
      ],
      hints: [],
      answers: []
    })
    expect(entries).toEqual([
      { offsetMs: 0, kind: 'command', label: 'topology.setPower' },
      { offsetMs: 10, kind: 'transaction', label: 'Déplacer PC1' }
    ])
  })
})
