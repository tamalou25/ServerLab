/**
 * Valeurs manipulées par le PowerShell simulé.
 */

export interface PsSecureString {
  kind: 'secure'
  value: string
}

export interface PsView {
  kind: 'table' | 'list'
  props: string[]
  /** Rendu personnalisé de l'affichage par défaut (ex. Get-WindowsFeature), sinon table ou liste. */
  render?: (objects: PsObject[]) => string[]
}

/** Objet PowerShell (propriétés ordonnées, vue d'affichage par défaut). */
export interface PsObject {
  kind: 'object'
  typeName: string
  props: Record<string, PsValue>
  view?: PsView
  /** Représentation texte (ToString) affichée dans une cellule ou une collection. */
  text?: string
}

export interface PsScriptBlock {
  kind: 'script'
  source: string
  /** Position du début du bloc dans la ligne saisie (erreurs soulignées au bon endroit). */
  offset?: number
}

export interface PsCredential {
  kind: 'credential'
  user: string
  password: string
}

export type PsValue =
  null | string | number | boolean | PsSecureString | PsObject | PsScriptBlock | PsCredential | PsValue[]

export function psObject(typeName: string, props: Record<string, PsValue>, view?: PsView): PsObject {
  return view ? { kind: 'object', typeName, props, view } : { kind: 'object', typeName, props }
}

export function isPsObject(v: PsValue): v is PsObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && v.kind === 'object'
}

export function isSecure(v: PsValue): v is PsSecureString {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && v.kind === 'secure'
}

export function isCredential(v: PsValue): v is PsCredential {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && v.kind === 'credential'
}

export function isScript(v: PsValue): v is PsScriptBlock {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && v.kind === 'script'
}

/** Aplatit les tableaux imbriqués (comportement du pipeline). */
export function flatten(values: PsValue[]): PsValue[] {
  const result: PsValue[] = []
  for (const v of values) {
    if (Array.isArray(v)) result.push(...flatten(v))
    else if (v !== null) result.push(v)
  }
  return result
}

/** Représentation texte d'une valeur (comme dans une table ou une chaîne). */
export function psToString(v: PsValue | undefined): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  // Réels : 15 chiffres significatifs, comme System.Double (« 1 / 1.9 » → 0.526315789473684)
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(15)))
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  if (Array.isArray(v)) return `{${v.map(psToString).join(', ')}}`
  switch (v.kind) {
    case 'secure':
      return 'System.Security.SecureString'
    case 'credential':
      return 'System.Management.Automation.PSCredential'
    case 'script':
      return v.source
    case 'object': {
      if (v.text !== undefined) return v.text
      const name = v.props['Name'] ?? v.props['name']
      return name !== undefined ? psToString(name) : v.typeName
    }
  }
}

/** Conversion en booléen (règles PowerShell simplifiées). */
export function psToBool(v: PsValue): boolean {
  if (v === null) return false
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'string') return v.length > 0
  if (Array.isArray(v)) return v.length > 0
  return true
}

/** Lecture d'une propriété (insensible à la casse). */
export function getProp(v: PsValue, name: string): PsValue {
  if (!isPsObject(v)) {
    if (typeof v === 'string' && name.toLowerCase() === 'length') return v.length
    if (Array.isArray(v) && (name.toLowerCase() === 'count' || name.toLowerCase() === 'length'))
      return v.length
    return null
  }
  const lower = name.toLowerCase()
  const key = Object.keys(v.props).find((k) => k.toLowerCase() === lower)
  return key === undefined ? null : (v.props[key] ?? null)
}

/** Comparaison PowerShell (insensible à la casse pour les chaînes). */
export function psEquals(a: PsValue, b: PsValue): boolean {
  if (typeof a === 'boolean' || typeof b === 'boolean') return psToBool(a) === psToBool(b)
  if (typeof a === 'number' && typeof b === 'string') return String(a) === b.trim()
  if (typeof a === 'string' && typeof b === 'number') return a.trim() === String(b)
  return psToString(a).toLowerCase() === psToString(b).toLowerCase()
}

/** Joker PowerShell (-like) : * et ?. */
export function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i')
}

export function psLike(value: PsValue, pattern: PsValue): boolean {
  return wildcardToRegExp(psToString(pattern)).test(psToString(value))
}
