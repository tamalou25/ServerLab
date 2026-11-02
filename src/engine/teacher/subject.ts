/**
 * Format `.slabsujet` : un sujet d'évaluation = lab de départ (topologie, énoncé, critères),
 * barème, questions d'oral et métadonnées. Son empreinte SHA-256 identifie le sujet dans les rendus.
 */
import { z } from 'zod'
import { LabDefinitionSchema, type LabDefinition } from '../labs/lab'
import { durationMinutes } from '../labs/exam'
import { sha256 } from '../labs/sha256'
import {
  canonicalJson,
  envelope,
  parseTeacherText,
  parseTeacherValue,
  ReservedIdSchema,
  boundedText,
  type TeacherFormat,
  type TeacherParseResult
} from './format'

export const SUBJECT_FORMAT_VERSION = 1
/** Un sujet embarque un lab (instantané de topologie compris) : même ordre de grandeur qu'un lab. */
export const MAX_SUBJECT_LENGTH = 4 * 1024 * 1024
export const MAX_ORAL_QUESTIONS = 30
/** Durée maximale d'une épreuve (minutes). */
export const MAX_SUBJECT_MINUTES = 8 * 60

const Points = z.number().min(0).max(1000)
/** Poids relatif d'une composante de la note (0 = composante ignorée). */
const Weight = z.number().min(0).max(100)

/** Points d'un critère du lab. */
export const CriterionScaleSchema = z.strictObject({ criterionId: boundedText(128), points: Points })

/**
 * Barème. La note finale combine trois composantes pondérées (critères, temps, erreurs), moins
 * les pénalités d'indices ; le calcul est fait par la correction (rejeu), jamais lu d'un fichier.
 */
export const ScaleSchema = z.strictObject({
  criteria: z.array(CriterionScaleSchema).max(500),
  /** Points retirés par indice consulté pendant la passation. */
  hintPenalty: Points,
  weights: z.strictObject({ criteria: Weight, time: Weight, errors: Weight }),
  /** Durée de l'épreuve (minutes). */
  minutes: z.number().int().min(1).max(MAX_SUBJECT_MINUTES),
  /** Nombre d'erreurs au-delà duquel la composante « erreurs » vaut 0. */
  maxErrors: z.number().int().min(1).max(10_000),
  /** Une annulation (Ctrl+Z) compte comme une erreur. */
  undoIsError: z.boolean(),
  /** Note sur (20 en BTS). */
  outOf: z.number().int().min(1).max(1000)
})

/** Déclencheur d'une question d'oral : après validation d'un critère, ou à la minute N. */
export const OralTriggerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('criterion'), criterionId: boundedText(128) }),
  z.strictObject({ kind: z.literal('minute'), minute: z.number().int().min(0).max(MAX_SUBJECT_MINUTES) })
])

/** Question écrite prévue dans le sujet ; réponse texte de l'élève, notée à la main. */
export const OralQuestionSchema = z.strictObject({
  id: boundedText(64),
  text: boundedText(2000),
  trigger: OralTriggerSchema,
  points: Points
})

export const SubjectMetaSchema = z.strictObject({
  title: boundedText(200).min(1),
  author: boundedText(120),
  /** Version libre du sujet (« 1.0 », « 2026-B »…). */
  version: boundedText(40),
  /** Lab de la bibliothèque d'origine ('' : sujet construit à la main). */
  sourceLabId: boundedText(80),
  /** Réservé 2.13 : classe à laquelle le sujet est destiné. */
  classId: ReservedIdSchema
})

const SubjectShape = z.strictObject({
  ...envelope('sujet', SUBJECT_FORMAT_VERSION),
  meta: SubjectMetaSchema,
  lab: LabDefinitionSchema,
  scale: ScaleSchema,
  oral: z.array(OralQuestionSchema).max(MAX_ORAL_QUESTIONS)
})

/** Références croisées : barème et déclencheurs pointent vers des critères existants, sans doublon. */
export const SubjectSchema = SubjectShape.superRefine((doc, ctx) => {
  const ids = doc.lab.criteria.map((c) => c.id)
  const known = new Set(ids)
  if (known.size !== ids.length)
    ctx.addIssue({ code: 'custom', path: ['lab', 'criteria'], message: 'identifiant de critère en double' })
  const scaled = new Set<string>()
  doc.scale.criteria.forEach((c, i) => {
    if (!known.has(c.criterionId))
      ctx.addIssue({
        code: 'custom',
        path: ['scale', 'criteria', i],
        message: `critère inconnu « ${c.criterionId} »`
      })
    if (scaled.has(c.criterionId))
      ctx.addIssue({ code: 'custom', path: ['scale', 'criteria', i], message: 'critère noté deux fois' })
    scaled.add(c.criterionId)
  })
  const questions = new Set<string>()
  doc.oral.forEach((q, i) => {
    if (questions.has(q.id))
      ctx.addIssue({ code: 'custom', path: ['oral', i, 'id'], message: 'identifiant de question en double' })
    questions.add(q.id)
    if (q.trigger.kind === 'criterion' && !known.has(q.trigger.criterionId))
      ctx.addIssue({ code: 'custom', path: ['oral', i, 'trigger'], message: 'critère déclencheur inconnu' })
    if (q.trigger.kind === 'minute' && q.trigger.minute > doc.scale.minutes)
      ctx.addIssue({ code: 'custom', path: ['oral', i, 'trigger'], message: 'minute au-delà de la durée' })
  })
  const { criteria, time, errors } = doc.scale.weights
  if (criteria + time + errors <= 0)
    ctx.addIssue({
      code: 'custom',
      path: ['scale', 'weights'],
      message: 'au moins un poids doit être positif'
    })
})

export type Subject = z.infer<typeof SubjectShape>
export type Scale = Subject['scale']
export type OralQuestion = Subject['oral'][number]
export type SubjectMeta = Subject['meta']

export const SUBJECT_FORMAT: TeacherFormat<Subject> = {
  kind: 'sujet',
  version: SUBJECT_FORMAT_VERSION,
  migrations: {},
  maxLength: MAX_SUBJECT_LENGTH,
  schema: SubjectSchema
}

/** Barème par défaut : 1 point par critère, poids 100 % critères, durée indicative du lab. */
export function defaultScale(lab: LabDefinition): Scale {
  return {
    criteria: lab.criteria.map((c) => ({ criterionId: c.id, points: 1 })),
    hintPenalty: 0.5,
    weights: { criteria: 100, time: 0, errors: 0 },
    minutes: Math.min(MAX_SUBJECT_MINUTES, durationMinutes(lab.duration)),
    maxErrors: 20,
    undoIsError: false,
    outOf: 20
  }
}

export interface CreateSubjectOptions {
  appVersion: string
  meta?: Partial<Omit<SubjectMeta, 'classId'>>
  scale?: Scale
  oral?: OralQuestion[]
}

/** Crée un sujet à partir d'un lab (bibliothèque ou construit à la main). */
export function createSubject(lab: LabDefinition, options: CreateSubjectOptions): Subject {
  return {
    app: 'ServerLab',
    kind: 'sujet',
    formatVersion: SUBJECT_FORMAT_VERSION,
    appVersion: options.appVersion,
    meta: {
      title: options.meta?.title ?? lab.title,
      author: options.meta?.author ?? '',
      version: options.meta?.version ?? '1.0',
      sourceLabId: options.meta?.sourceLabId ?? lab.id,
      classId: null
    },
    lab,
    scale: options.scale ?? defaultScale(lab),
    oral: options.oral ?? []
  }
}

export function serializeSubject(subject: Subject): string {
  return JSON.stringify(subject, null, 2)
}

export function parseSubject(content: string): TeacherParseResult<Subject> {
  return parseTeacherText(SUBJECT_FORMAT, content)
}

export function parseSubjectValue(raw: unknown): TeacherParseResult<Subject> {
  return parseTeacherValue(SUBJECT_FORMAT, raw)
}

/**
 * Empreinte du sujet (SHA-256 de sa forme canonique, après validation) : indépendante de la mise en
 * forme du fichier et de `appVersion`. Toute modification de l'énoncé, du lab ou du barème la change.
 */
export function subjectFingerprint(subject: Subject): string {
  const { appVersion: _ignored, ...content } = subject
  return sha256(canonicalJson(content))
}
