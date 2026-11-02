/** Documents de référence du mode enseignant (lab 2 DHCP, construit par le moteur). */
import {
  createSubject,
  parseLab,
  subjectFingerprint,
  submissionFingerprint,
  type Correction,
  type Subject,
  type Submission
} from '@engine/index'
import lab2 from '../../../labs/lab-02-dhcp.json'

export function referenceSubject(): Subject {
  const parsed = parseLab(lab2)
  if (!parsed.ok) throw new Error(parsed.message)
  const lab = parsed.lab
  return createSubject(lab, {
    appVersion: '2.12.0',
    meta: { author: 'Professeur', version: '1.0' },
    oral: [
      {
        id: 'q1',
        text: 'Pourquoi exclure des adresses de l’étendue ?',
        trigger: { kind: 'criterion', criterionId: lab.criteria[0]!.id },
        points: 2
      },
      { id: 'q2', text: 'Qu’est-ce qu’un bail ?', trigger: { kind: 'minute', minute: 5 }, points: 1 }
    ]
  })
}

export const T0 = 1_793_000_000_000

export function referenceSubmission(subject = referenceSubject()): Submission {
  return {
    app: 'ServerLab',
    kind: 'rendu',
    formatVersion: 1,
    appVersion: '2.12.0',
    subject: { fingerprint: subjectFingerprint(subject), title: subject.meta.title },
    student: { name: 'Élève Test', studentId: null, classId: null },
    mode: 'exam',
    startedAt: T0,
    endedAt: T0 + 600_000,
    ending: 'finish',
    journal: [
      {
        kind: 'command',
        at: T0 + 1000,
        command: { type: 'dhcp.addScope', args: ['srv', { name: 'LAN' }], label: 'Étendue' }
      },
      { kind: 'undo', at: T0 + 2000 },
      { kind: 'redo', at: T0 + 3000 }
    ],
    hints: [{ criterionId: subject.lab.criteria[0]!.id, index: 0, at: T0 + 4000 }],
    answers: [{ questionId: 'q1', text: 'Pour les serveurs à adresse fixe.', at: T0 + 5000 }]
  }
}

export function referenceCorrection(submission = referenceSubmission()): Correction {
  return {
    app: 'ServerLab',
    kind: 'correction',
    formatVersion: 1,
    appVersion: '2.12.0',
    subject: submission.subject,
    submission: { fingerprint: submissionFingerprint(submission) },
    student: submission.student,
    correctedAt: '2026-11-02T10:00:00.000Z',
    criteria: [{ id: 'c1', label: 'Étendue créée', ok: true, points: 1, max: 1 }],
    elapsedMs: 600_000,
    errors: { refused: 0, undos: 1, total: 0 },
    hintsTaken: 1,
    penalties: { hints: 0.5 },
    components: { criteria: 1, time: 1, errors: 1 },
    oral: [{ questionId: 'q1', answer: 'Pour les serveurs à adresse fixe.', points: 2, max: 2 }],
    grade: { value: 19.5, outOf: 20 },
    comment: 'Bon travail.',
    flags: [{ code: 'mode-mismatch', message: 'Exemple de signalement.' }]
  }
}
