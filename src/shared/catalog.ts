/**
 * Catalogue des exercices : recherche et filtres purs, fondés uniquement sur les métadonnées réelles
 * d'un lab (titre, résumé, difficulté, durée annoncée) et sur deux ensembles fournis par l'appelant
 * (labs du parcours, labs déjà réussis). Aucune catégorie n'est déduite du texte des titres.
 */

export type CatalogDifficulty = 'Débutant' | 'Intermédiaire' | 'Avancé'

/** Tranches de durée annoncée : jusqu'à 25 min, de 30 à 40 min, 45 min et plus. */
export type CatalogDuration = 'short' | 'medium' | 'long'

export type CatalogStatus = 'done' | 'todo'

export interface CatalogEntry {
  id: string
  title: string
  summary: string
  difficulty: CatalogDifficulty
  /** Durée annoncée par le lab (ex. « 25 min »). */
  duration: string
}

export interface CatalogFilters {
  query: string
  difficulty: CatalogDifficulty | null
  duration: CatalogDuration | null
  /** Seulement les exercices réutilisés par le parcours. */
  pathwayOnly: boolean
  /** Déjà réussi au moins une fois, ou jamais réussi (d'après la progression enregistrée). */
  status: CatalogStatus | null
}

export const EMPTY_FILTERS: CatalogFilters = {
  query: '',
  difficulty: null,
  duration: null,
  pathwayOnly: false,
  status: null
}

export interface CatalogContext {
  pathwayLabIds: ReadonlySet<string>
  succeededLabIds: ReadonlySet<string>
}

/** Minutes annoncées par un lab (null si la durée ne commence pas par un nombre). */
export function labMinutes(duration: string): number | null {
  const match = /\d+/.exec(duration)
  return match ? Number(match[0]) : null
}

export function durationBucket(duration: string): CatalogDuration | null {
  const minutes = labMinutes(duration)
  if (minutes === null) return null
  return minutes <= 25 ? 'short' : minutes <= 40 ? 'medium' : 'long'
}

/** Minuscules sans accents ni apostrophes typographiques : « Étendue » se trouve en tapant « etendue ». */
export function normalizeSearch(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’‘]/g, "'").toLowerCase().trim()
}

/** Nombre de filtres actifs (la recherche compte pour un). */
export function activeFilterCount(filters: CatalogFilters): number {
  return (
    (normalizeSearch(filters.query) ? 1 : 0) +
    (filters.difficulty ? 1 : 0) +
    (filters.duration ? 1 : 0) +
    (filters.pathwayOnly ? 1 : 0) +
    (filters.status ? 1 : 0)
  )
}

/** Exercices retenus, dans l'ordre du catalogue. Tous les mots de la recherche doivent être présents. */
export function filterCatalog<T extends CatalogEntry>(
  labs: readonly T[],
  filters: CatalogFilters,
  context: CatalogContext
): T[] {
  const words = normalizeSearch(filters.query).split(/\s+/).filter(Boolean)
  return labs.filter((lab) => {
    if (filters.difficulty && lab.difficulty !== filters.difficulty) return false
    if (filters.duration && durationBucket(lab.duration) !== filters.duration) return false
    if (filters.pathwayOnly && !context.pathwayLabIds.has(lab.id)) return false
    if (filters.status === 'done' && !context.succeededLabIds.has(lab.id)) return false
    if (filters.status === 'todo' && context.succeededLabIds.has(lab.id)) return false
    if (words.length === 0) return true
    const haystack = normalizeSearch(`${lab.id} ${lab.title} ${lab.summary}`)
    return words.every((word) => haystack.includes(word))
  })
}
