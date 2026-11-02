/**
 * Format `.slabrendu` : copie d'un élève. Elle ne contient PAS l'état final ni la note : seulement
 * le journal des commandes nommées (et des annulations), rejoué depuis le lab de départ du sujet
 * par la correction. Horodatages fournis par l'interface.
 */
import { z } from 'zod'
import { sha256 } from '../labs/sha256'
import {
  canonicalJson,
  envelope,
  parseTeacherText,
  parseTeacherValue,
  ReservedIdSchema,
  Sha256Schema,
  boundedText,
  TimestampSchema,
  type TeacherFormat,
  type TeacherParseResult
} from './format'
import { MAX_ORAL_QUESTIONS } from './subject'

export const SUBMISSION_FORMAT_VERSION = 1
export const MAX_SUBMISSION_LENGTH = 8 * 1024 * 1024
/** Nombre maximal de pas de journal (commandes + annulations) rejoués par la correction. */
export const MAX_REPLAY_STEPS = 5000
/** Nombre maximal d'arguments d'une commande (le plus long du catalogue en compte moins de 10). */
export const MAX_COMMAND_ARGS = 16
export const MAX_ANSWER_LENGTH = 4000

/** Commande nommée telle que relue d'un fichier (arguments validés au rejeu par le moteur). */
export const RecordedCommandSchema = z.strictObject({
  type: boundedText(80).regex(/^[A-Za-z][A-Za-z0-9.]*$/, 'nom de commande invalide'),
  args: z.array(z.unknown()).max(MAX_COMMAND_ARGS),
  label: boundedText(300).optional()
})

/** Pas du journal : commande exécutée, annulation ou rétablissement. */
export const JournalStepSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('command'), at: TimestampSchema, command: RecordedCommandSchema }),
  z.strictObject({ kind: z.literal('undo'), at: TimestampSchema }),
  z.strictObject({ kind: z.literal('redo'), at: TimestampSchema }),
  /**
   * Transaction (glisser un équipement) : commandes intermédiaires appliquées sans être
   * journalisées, puis une seule entrée d'historique sous `label` (comme `commitTransaction`).
   */
  z.strictObject({
    kind: z.literal('transaction'),
    at: TimestampSchema,
    label: boundedText(300),
    commands: z.array(RecordedCommandSchema).max(MAX_REPLAY_STEPS)
  })
])

export const HintTakenSchema = z.strictObject({
  criterionId: boundedText(128),
  /** Rang de l'indice pour ce critère (0 = premier). */
  index: z.number().int().min(0).max(50),
  at: TimestampSchema
})

export const OralAnswerSchema = z.strictObject({
  questionId: boundedText(64),
  text: boundedText(MAX_ANSWER_LENGTH),
  at: TimestampSchema
})

export const SubmissionSchema = z.strictObject({
  ...envelope('rendu', SUBMISSION_FORMAT_VERSION),
  subject: z.strictObject({ fingerprint: Sha256Schema, title: boundedText(200) }),
  /** Seule donnée personnelle : le nom saisi par l'élève. Identifiants réservés à la 2.13. */
  student: z.strictObject({
    name: boundedText(100).min(1),
    studentId: ReservedIdSchema,
    classId: ReservedIdSchema
  }),
  /** `exam` : rendu au professeur ; `self` : auto-évaluation (correction immédiate locale). */
  mode: z.enum(['exam', 'self']),
  startedAt: TimestampSchema,
  endedAt: TimestampSchema,
  ending: z.enum(['finish', 'timeout', 'abandon']),
  journal: z
    .array(JournalStepSchema)
    .max(MAX_REPLAY_STEPS)
    .refine(
      (steps) =>
        steps.reduce((n, s) => n + (s.kind === 'transaction' ? Math.max(1, s.commands.length) : 1), 0) <=
        MAX_REPLAY_STEPS,
      `au plus ${MAX_REPLAY_STEPS} pas de rejeu`
    ),
  hints: z.array(HintTakenSchema).max(2000),
  answers: z.array(OralAnswerSchema).max(MAX_ORAL_QUESTIONS)
})

export type Submission = z.infer<typeof SubmissionSchema>
export type JournalStep = Submission['journal'][number]
export type RecordedCommand = z.infer<typeof RecordedCommandSchema>

export const SUBMISSION_FORMAT: TeacherFormat<Submission> = {
  kind: 'rendu',
  version: SUBMISSION_FORMAT_VERSION,
  migrations: {},
  maxLength: MAX_SUBMISSION_LENGTH,
  schema: SubmissionSchema
}

export function serializeSubmission(submission: Submission): string {
  return JSON.stringify(submission, null, 2)
}

/**
 * Lecture d'un rendu. La cohérence (empreinte du sujet, horodatages, rejeu) n'est pas vérifiée
 * ici : elle donne des signalements à la correction, pas un refus d'import.
 */
export function parseSubmission(content: string): TeacherParseResult<Submission> {
  return parseTeacherText(SUBMISSION_FORMAT, content)
}

export function parseSubmissionValue(raw: unknown): TeacherParseResult<Submission> {
  return parseTeacherValue(SUBMISSION_FORMAT, raw)
}

/** Empreinte d'un rendu (forme canonique) : référencée par la correction. */
export function submissionFingerprint(submission: Submission): string {
  return sha256(canonicalJson(submission))
}
