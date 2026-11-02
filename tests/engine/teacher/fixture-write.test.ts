/**
 * Écrit les fichiers de référence manquants du format courant (jamais d'écrasement) :
 * `npm test -- tests/engine/teacher/fixture-write` après une évolution de format.
 */
import { existsSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  CORRECTION_FORMAT_VERSION,
  serializeCorrection,
  serializeSubject,
  serializeSubmission,
  SUBJECT_FORMAT_VERSION,
  SUBMISSION_FORMAT_VERSION
} from '@engine/index'
import { fixtureUrl } from './fixtures'
import { referenceCorrection, referenceSubject, referenceSubmission } from './helpers'

describe('fichiers de référence du mode enseignant', () => {
  it('existent pour chaque format courant (écrits s’ils manquent)', () => {
    const subject = referenceSubject()
    const submission = referenceSubmission(subject)
    const files = [
      [fixtureUrl('sujet', SUBJECT_FORMAT_VERSION), serializeSubject(subject)],
      [fixtureUrl('rendu', SUBMISSION_FORMAT_VERSION), serializeSubmission(submission)],
      [
        fixtureUrl('correction', CORRECTION_FORMAT_VERSION),
        serializeCorrection(referenceCorrection(submission))
      ]
    ] as const
    for (const [url, content] of files) {
      if (!existsSync(url)) writeFileSync(url, content + '\n')
      expect(existsSync(url)).toBe(true)
    }
  })
})
