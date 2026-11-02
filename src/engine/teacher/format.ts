/**
 * Socle commun des fichiers du mode enseignant (`.slabsujet`, `.slabrendu`, `.slabcorrection`) :
 * enveloppe, numéro de format propre à chaque type, migrations, taille maximale et analyse sans
 * exception. Ces formats sont indépendants du `.slab` (aucune migration du lab n'est requise).
 */
import { z } from 'zod'

/** Types de fichiers du mode enseignant (champ `kind` de l'enveloppe). */
export type TeacherFileKind = 'sujet' | 'rendu' | 'correction'

export const TEACHER_EXTENSIONS: Record<TeacherFileKind, string> = {
  sujet: 'slabsujet',
  rendu: 'slabrendu',
  correction: 'slabcorrection'
}

const NOUNS: Record<TeacherFileKind, string> = {
  sujet: 'sujet',
  rendu: 'rendu',
  correction: 'correction'
}

type RawDocument = Record<string, unknown>

/** Migration d'un document de la version N vers N + 1 (données brutes, avant validation). */
export type TeacherMigration = (doc: RawDocument) => RawDocument

export function isRecord(value: unknown): value is RawDocument {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export type TeacherParseResult<T> = { ok: true; doc: T } | { ok: false; message: string }

/** Description d'un format : version courante, migrations, taille maximale et schéma. */
export interface TeacherFormat<T> {
  kind: TeacherFileKind
  version: number
  /** `migrations[n]` : version n → n + 1. */
  migrations: Readonly<Record<number, TeacherMigration>>
  /** Longueur maximale du texte (caractères ; un texte de N octets UTF-8 en compte au plus N). */
  maxLength: number
  schema: z.ZodType<T>
}

/**
 * Identifiants réservés à la version « serveur de l'école » (2.13) : présents dans les formats,
 * toujours null en 2.12. Les prévoir dès maintenant évite une migration plus tard.
 */
export const ReservedIdSchema = z.string().max(128).nullable().default(null)

/** Texte borné (titre, nom, commentaire). */
export const boundedText = (max: number) => z.string().max(max)

/** Horodatage réel en millisecondes fourni par l'interface (le moteur ne lit pas l'horloge). */
export const TimestampSchema = z.number().int().min(0).max(8.64e15)

/** Empreinte SHA-256 en hexadécimal minuscule. */
export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'empreinte SHA-256 attendue')

/** Enveloppe commune (champs fixes de tout fichier du mode enseignant). */
export function envelope<K extends TeacherFileKind>(kind: K, version: number) {
  return {
    app: z.literal('ServerLab'),
    kind: z.literal(kind),
    formatVersion: z.literal(version),
    appVersion: boundedText(32)
  }
}

/**
 * Applique les migrations d'un document brut jusqu'à la version courante. Un document d'une
 * version plus récente que l'application est refusé (l'élève ou le professeur doit mettre à jour).
 */
export function migrateTeacherDocument<T>(
  format: TeacherFormat<T>,
  raw: RawDocument
): { ok: true; doc: RawDocument } | { ok: false; message: string } {
  const noun = NOUNS[format.kind]
  const version = raw['formatVersion']
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1)
    return { ok: false, message: `Fichier de ${noun} invalide : numéro de format absent ou incorrect.` }
  if (version > format.version)
    return {
      ok: false,
      message: `Ce fichier de ${noun} a été créé par une version plus récente de ServerLab (format ${version}). Mettez l’application à jour.`
    }
  let doc = raw
  for (let v = version; v < format.version; v++) {
    const migrate = format.migrations[v]
    if (!migrate) return { ok: false, message: `Migration du format ${v} du ${noun} introuvable.` }
    doc = { ...migrate(doc), formatVersion: v + 1 }
  }
  return { ok: true, doc }
}

/**
 * Lit un fichier du mode enseignant : taille, JSON, enveloppe, migrations puis schéma strict.
 * Ne lève jamais d'exception : tout contenu invalide donne un message en français.
 */
export function parseTeacherText<T>(format: TeacherFormat<T>, content: string): TeacherParseResult<T> {
  const noun = NOUNS[format.kind]
  if (typeof content !== 'string') return { ok: false, message: `Fichier de ${noun} illisible.` }
  if (content.length > format.maxLength)
    return { ok: false, message: `Le fichier de ${noun} est trop volumineux.` }
  let raw: unknown
  try {
    raw = JSON.parse(content)
  } catch {
    return {
      ok: false,
      message: `Le fichier de ${noun} n’est pas un document ServerLab valide (JSON illisible).`
    }
  }
  return parseTeacherValue(format, raw)
}

/** Variante de `parseTeacherText` pour un objet JSON déjà lu. Ne lève jamais d'exception. */
export function parseTeacherValue<T>(format: TeacherFormat<T>, raw: unknown): TeacherParseResult<T> {
  const noun = NOUNS[format.kind]
  try {
    if (!isRecord(raw) || raw['app'] !== 'ServerLab')
      return { ok: false, message: `Ce fichier n’est pas un ${noun} ServerLab.` }
    if (raw['kind'] !== format.kind) {
      const other = typeof raw['kind'] === 'string' ? raw['kind'] : 'inconnu'
      return {
        ok: false,
        message: `Ce fichier n’est pas un ${noun} (type « ${other.slice(0, 20)} »).`
      }
    }
    const migrated = migrateTeacherDocument(format, raw)
    if (!migrated.ok) return migrated
    const parsed = format.schema.safeParse(migrated.doc)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      const where = issue && issue.path.length > 0 ? ` (champ ${issue.path.join('.')})` : ''
      return {
        ok: false,
        message: `Fichier de ${noun} invalide${where} : ${issue?.message ?? 'structure inattendue'}.`
      }
    }
    return { ok: true, doc: parsed.data }
  } catch {
    // Filet de sécurité : une incohérence non prévue ne fait jamais planter l'application
    return { ok: false, message: `Le fichier de ${noun} est illisible (structure inattendue).` }
  }
}

/**
 * Sérialisation canonique (clés triées, sans espaces) : base des empreintes. Deux documents
 * égaux donnent toujours le même texte, quel que soit l'ordre d'écriture des clés.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value))
    return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`
  const record = value as RawDocument
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`
}
