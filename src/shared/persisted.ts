/**
 * Schémas zod des données lues par le process principal : préférences (settings.json), fichiers
 * récents (recent.json) et messages IPC venant du renderer. Un contenu invalide n'interrompt
 * jamais l'application : il est remplacé par les valeurs par défaut, entrée par entrée.
 * (Fichier séparé de ipc.ts : le preload n'embarque pas zod.)
 */
import { z } from 'zod'
import type { LanguagePreference, MenuState, RecentFile, ThemePreference } from './ipc'

/** Nombre maximal de fichiers récents mémorisés. */
export const MAX_RECENT = 10
/** Tailles maximales acceptées pour les fichiers de préférences (protection contre un fichier aberrant). */
export const MAX_SETTINGS_BYTES = 64 * 1024
export const MAX_RECENT_BYTES = 1024 * 1024

/** JSON du texte, ou undefined s'il est trop long ou illisible. */
export function readJson(text: string, maxLength: number): unknown {
  if (text.length > maxLength) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

// --- Préférences ------------------------------------------------------------------------------

const ThemePreferenceSchema = z.enum(['system', 'dark', 'light'] satisfies ThemePreference[])
const LanguagePreferenceSchema = z.enum(['system', 'fr', 'en'] satisfies LanguagePreference[])

/**
 * Valeur invalide → valeur par défaut (les autres préférences sont conservées). Thème : « Système »
 * par défaut ; un choix explicite déjà enregistré (sombre ou clair) est conservé. Langue : celle du
 * système par défaut. Écran d'accueil et tutoriel proposés au démarrage par défaut.
 */
export const SettingsSchema = z.object({
  theme: ThemePreferenceSchema.catch('system'),
  language: LanguagePreferenceSchema.catch('system'),
  showHomeOnStartup: z.boolean().catch(true),
  showTutorialOnStartup: z.boolean().catch(true),
  /** Mode enseignant (Affichage > Mode enseignant) : désactivé par défaut. */
  teacherMode: z.boolean().catch(false)
})

export type Settings = z.infer<typeof SettingsSchema>

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  language: 'system',
  showHomeOnStartup: true,
  showTutorialOnStartup: true,
  teacherMode: false
}

/** Préférences lues depuis le contenu de settings.json (défauts si absent ou invalide). */
export function parseSettings(text: string): Settings {
  const parsed = SettingsSchema.safeParse(readJson(text, MAX_SETTINGS_BYTES))
  return parsed.success ? parsed.data : { ...DEFAULT_SETTINGS }
}

// --- Fichiers récents -------------------------------------------------------------------------

export const RecentFileSchema = z.object({
  path: z.string().min(1).max(4096),
  name: z.string().min(1).max(260),
  openedAt: z.string().max(64)
}) satisfies z.ZodType<RecentFile>

/** Fichiers récents lus depuis recent.json : les entrées invalides sont écartées une à une. */
export function parseRecentFiles(text: string): RecentFile[] {
  const raw = readJson(text, MAX_RECENT_BYTES)
  if (!Array.isArray(raw)) return []
  return raw
    .flatMap((entry) => {
      const parsed = RecentFileSchema.safeParse(entry)
      return parsed.success ? [parsed.data] : []
    })
    .slice(0, MAX_RECENT)
}

// --- Messages IPC du renderer -----------------------------------------------------------------

/** Longueur maximale d'un libellé de menu reçu du renderer. */
export const MAX_MENU_LABEL = 120

export const MenuStateSchema = z.object({
  mode: z.enum(['realtime', 'simulation']),
  showPortLabels: z.boolean(),
  showProperties: z.boolean(),
  showMinimap: z.boolean(),
  undoLabel: z.string().max(MAX_MENU_LABEL).nullable(),
  redoLabel: z.string().max(MAX_MENU_LABEL).nullable()
}) satisfies z.ZodType<MenuState>

export const DocStateSchema = z.object({
  name: z.string().max(200),
  dirty: z.boolean()
})
