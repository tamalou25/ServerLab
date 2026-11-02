/**
 * Format `.slabcorrection` : correction d'un rendu par le professeur. Les points sont ceux du
 * rejeu (recalculés à la correction) ; seuls le commentaire et la note de l'oral sont saisis.
 */
import { z } from 'zod'
import {
  envelope,
  parseTeacherText,
  parseTeacherValue,
  ReservedIdSchema,
  Sha256Schema,
  boundedText,
  type TeacherFormat,
  type TeacherParseResult
} from './format'
import { MAX_ORAL_QUESTIONS } from './subject'

export const CORRECTION_FORMAT_VERSION = 1
export const MAX_CORRECTION_LENGTH = 1024 * 1024

const Points = z.number().min(-100_000).max(100_000)
const Count = z.number().int().min(0).max(1_000_000)

/** Signalements de la correction (codes stables, message en français). */
export const FLAG_CODES = [
  'subject-mismatch',
  'replay-failed',
  'timestamps-incoherent',
  'duration-out-of-bounds',
  'mode-mismatch'
] as const

export const CorrectionFlagSchema = z.strictObject({ code: z.enum(FLAG_CODES), message: boundedText(500) })

export const CorrectionSchema = z.strictObject({
  ...envelope('correction', CORRECTION_FORMAT_VERSION),
  subject: z.strictObject({ fingerprint: Sha256Schema, title: boundedText(200) }),
  /** Empreinte du fichier de rendu corrigé. */
  submission: z.strictObject({ fingerprint: Sha256Schema }),
  student: z.strictObject({ name: boundedText(100), studentId: ReservedIdSchema, classId: ReservedIdSchema }),
  /** Date ISO de la correction (fournie par l'interface). */
  correctedAt: boundedText(40),
  criteria: z
    .array(
      z.strictObject({
        id: boundedText(128),
        label: boundedText(500),
        ok: z.boolean(),
        points: Points,
        max: Points
      })
    )
    .max(500),
  elapsedMs: Count.max(8.64e15),
  errors: z.strictObject({ refused: Count, undos: Count, total: Count }),
  hintsTaken: Count,
  penalties: z.strictObject({ hints: Points }),
  /** Composantes de la note (0 à 1) avant pondération. */
  components: z.strictObject({
    criteria: z.number().min(0).max(1),
    time: z.number().min(0).max(1),
    errors: z.number().min(0).max(1)
  }),
  oral: z
    .array(
      z.strictObject({
        questionId: boundedText(64),
        answer: boundedText(4000),
        /** null : pas encore noté par le professeur. */
        points: Points.nullable(),
        max: Points
      })
    )
    .max(MAX_ORAL_QUESTIONS),
  grade: z.strictObject({ value: Points, outOf: z.number().int().min(1).max(1000) }),
  comment: boundedText(5000),
  flags: z.array(CorrectionFlagSchema).max(50)
})

export type Correction = z.infer<typeof CorrectionSchema>
export type CorrectionFlag = Correction['flags'][number]
export type FlagCode = (typeof FLAG_CODES)[number]

export const CORRECTION_FORMAT: TeacherFormat<Correction> = {
  kind: 'correction',
  version: CORRECTION_FORMAT_VERSION,
  migrations: {},
  maxLength: MAX_CORRECTION_LENGTH,
  schema: CorrectionSchema
}

export function serializeCorrection(correction: Correction): string {
  return JSON.stringify(correction, null, 2)
}

export function parseCorrection(content: string): TeacherParseResult<Correction> {
  return parseTeacherText(CORRECTION_FORMAT, content)
}

export function parseCorrectionValue(raw: unknown): TeacherParseResult<Correction> {
  return parseTeacherValue(CORRECTION_FORMAT, raw)
}
