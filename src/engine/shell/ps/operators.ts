/**
 * Opérateurs du PowerShell simulé, sur des valeurs déjà évaluées (fonctions pures).
 *
 * Sources Microsoft Learn (PowerShell 5.1) :
 *  - about_Arithmetic_Operators : + - * / %, conversion vers le type de l'opérande de gauche,
 *    concaténation de chaînes, de tableaux et de tables de hachage, répétition par *.
 *  - about_Comparison_Operators : opérande de gauche collection → éléments correspondants.
 *  - about_Operators : opérateur de plage .., opérateur de format -f, opérateur d'index [ ].
 *  - about_Quoting_Rules : une collection convertie en chaîne sépare ses éléments par un espace.
 */
import { psError, type PsError } from './errors'
import { compare } from './expression'
import { flatten, getProp, isPsObject, psObject, psEquals, psToString, type PsValue } from './values'

/** Nombre maximal d'éléments produits par une plage ou d'itérations d'une boucle simulée. */
export const MAX_ITERATIONS = 10_000

/** Nom .NET d'une valeur, pour les messages d'erreur. */
export function typeName(v: PsValue): string {
  if (v === null) return 'null'
  if (typeof v === 'string') return 'System.String'
  if (typeof v === 'number') return Number.isInteger(v) ? 'System.Int32' : 'System.Double'
  if (typeof v === 'boolean') return 'System.Boolean'
  if (Array.isArray(v)) return 'System.Object[]'
  switch (v.kind) {
    case 'object':
      return v.typeName
    case 'secure':
      return 'System.Security.SecureString'
    case 'credential':
      return 'System.Management.Automation.PSCredential'
    case 'script':
      return 'System.Management.Automation.ScriptBlock'
  }
}

/** Conversion d'une valeur en chaîne dans une chaîne développée (collections : éléments séparés par un espace). */
export function interpolate(v: PsValue): string {
  return Array.isArray(v) ? flatten(v).map(interpolate).join(' ') : psToString(v)
}

function isHashtable(v: PsValue): boolean {
  return isPsObject(v) && v.typeName === 'System.Collections.Hashtable'
}

/** Erreur de conversion d'une chaîne en nombre (about_Arithmetic_Operators : 16 + "file"). */
function castError(value: PsValue, target: string): PsError {
  return psError(
    `Impossible de convertir la valeur « ${psToString(value)} » en type « ${target} ». Erreur : « Le format de la chaîne d’entrée est incorrect. »`,
    'InvalidArgument',
    'InvalidCastFromStringToInteger',
    undefined,
    'RuntimeException'
  )
}

/** Opérateur non défini pour ce type (méthode op_Addition, op_Subtraction… introuvable). */
function noOperator(left: PsValue, method: string): PsError {
  return psError(
    `Échec de l’appel de la méthode, car [${typeName(left)}] ne contient pas de méthode nommée « ${method} ».`,
    'InvalidOperation',
    'MethodNotFound',
    undefined,
    'RuntimeException'
  )
}

/** Valeur numérique d'un opérande (chaîne numérique, booléen, $null → 0). */
export function toNumber(v: PsValue, target = 'System.Int32'): number {
  if (typeof v === 'number') return v
  if (v === null) return 0
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'string') {
    const text = v.trim()
    if (text === '') return 0
    if (/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(text)) return Number(text)
    throw castError(v, target)
  }
  throw castError(v, target)
}

const METHODS: Record<string, string> = {
  '+': 'op_Addition',
  '-': 'op_Subtraction',
  '*': 'op_Multiply',
  '/': 'op_Division',
  '%': 'op_Modulus'
}

/** Division par zéro (exception .NET DivideByZeroException). */
function divideByZero(): PsError {
  return psError(
    'Tentative de division par zéro.',
    'NotSpecified',
    'RuntimeException',
    undefined,
    'RuntimeException'
  )
}

/** Répétition d'une chaîne ou d'un tableau (« "!" * 3 », « @("!") * 4 »). */
function repeatCount(right: PsValue): number {
  const n = Math.round(toNumber(right))
  if (n < 0 || n > MAX_ITERATIONS)
    throw psError(
      `Le nombre de répétitions doit être compris entre 0 et ${MAX_ITERATIONS} dans ServerLab.`,
      'InvalidOperation',
      'RepeatCountOutOfRange'
    )
  return n
}

/** Opérateurs arithmétiques : la méthode dépend du type de l'opérande de gauche. */
export function arithmetic(op: string, left: PsValue, right: PsValue): PsValue {
  // Tableau à gauche : + concatène, * répète
  if (Array.isArray(left)) {
    if (op === '+') return Array.isArray(right) ? [...left, ...right] : [...left, right]
    if (op === '*') {
      const n = repeatCount(right)
      const out: PsValue[] = []
      for (let i = 0; i < n; i++) out.push(...left)
      return out
    }
    throw noOperator(left, METHODS[op] ?? op)
  }
  // Table de hachage : seule l'addition d'une autre table est définie
  if (isHashtable(left) && isPsObject(left)) {
    if (op !== '+') throw noOperator(left, METHODS[op] ?? op)
    if (!isHashtable(right) || !isPsObject(right))
      throw psError(
        'Une table de hachage ne peut être ajoutée qu’à une autre table de hachage.',
        'InvalidOperation',
        'AddHashTableToNonHashTable',
        undefined,
        'RuntimeException'
      )
    const merged: Record<string, PsValue> = { ...left.props }
    for (const [k, v] of Object.entries(right.props)) {
      const existing = Object.keys(merged).find((x) => x.toLowerCase() === k.toLowerCase())
      if (existing !== undefined)
        throw psError(
          `L’élément a déjà été ajouté. Clé du dictionnaire : « ${existing} »  Clé ajoutée : « ${k} »`,
          'NotSpecified',
          'ArgumentException',
          undefined,
          'ArgumentException'
        )
      merged[k] = v
    }
    return psObject('System.Collections.Hashtable', merged)
  }
  // Chaîne à gauche : + concatène, * répète ; - / % convertissent la chaîne en nombre
  if (typeof left === 'string') {
    if (op === '+') return left + interpolate(right)
    if (op === '*') return left.repeat(repeatCount(right))
  }
  if (left === null) {
    // $null + x → x (concaténation avec rien)
    if (op === '+') return right
    if (op === '*') return null
  }
  if (isPsObject(left) || (typeof left === 'object' && left !== null))
    throw noOperator(left, METHODS[op] ?? op)
  const target = typeof left === 'number' && !Number.isInteger(left) ? 'System.Double' : 'System.Int32'
  const a = toNumber(left, target)
  const b = toNumber(right, target)
  switch (op) {
    case '+':
      return a + b
    case '-':
      return a - b
    case '*':
      return a * b
    case '/':
      if (b === 0) throw divideByZero()
      return a / b
    case '%':
      if (b === 0) throw divideByZero()
      return a % b
    default:
      throw noOperator(left, op)
  }
}

/** Négation unaire (« - -6 » → 6, « + '123' » → 123). */
export function negate(op: '-' | '+', v: PsValue): PsValue {
  const n = toNumber(v)
  return op === '-' ? -n : n
}

/** Opérateur de plage : entiers de `from` à `to`, croissants ou décroissants. */
export function range(from: PsValue, to: PsValue): PsValue[] {
  const a = Math.round(toNumber(from))
  const b = Math.round(toNumber(to))
  if (Math.abs(b - a) + 1 > MAX_ITERATIONS)
    throw psError(
      `La plage ${a}..${b} dépasse la limite de ${MAX_ITERATIONS} éléments du simulateur ServerLab.`,
      'InvalidOperation',
      'RangeTooLarge'
    )
  const out: number[] = []
  const step = a <= b ? 1 : -1
  for (let i = a; i !== b + step; i += step) out.push(i)
  return out
}

/** Comparaison ordonnée : l'opérande de droite est converti vers le type de celui de gauche. */
function ordered(op: string, left: PsValue, right: PsValue): boolean {
  let diff: number
  if (typeof left === 'number') diff = left - toNumber(right)
  else diff = psToString(left).localeCompare(psToString(right), 'fr', { sensitivity: 'base' })
  switch (op) {
    case 'gt':
      return diff > 0
    case 'ge':
      return diff >= 0
    case 'lt':
      return diff < 0
    default:
      return diff <= 0
  }
}

/** Opérateurs de comparaison ; une collection à gauche renvoie ses éléments qui vérifient la condition. */
export function comparison(op: string, left: PsValue, right: PsValue): PsValue {
  const test = (l: PsValue): boolean =>
    op === 'gt' || op === 'ge' || op === 'lt' || op === 'le'
      ? ordered(op, l, right)
      : op === 'eq'
        ? psEquals(l, right)
        : compare(op, l, right)
  if (Array.isArray(left) && op !== 'contains' && op !== 'notcontains' && op !== 'in' && op !== 'notin')
    return flatten(left).filter(test)
  return test(left)
}

/** Opérateur d'index : tableau (indices négatifs depuis la fin), chaîne, table de hachage. */
export function indexValue(target: PsValue, index: PsValue): PsValue {
  if (Array.isArray(index)) return flatten(index).map((i) => indexValue(target, i))
  if (isHashtable(target)) return getProp(target, psToString(index))
  const items: PsValue[] | null = Array.isArray(target)
    ? target
    : typeof target === 'string'
      ? [...target]
      : null
  if (items === null) {
    // Objet seul : $x[0] désigne l'objet lui-même
    const i = Math.round(toNumber(index))
    return i === 0 || i === -1 ? target : null
  }
  const i = Math.round(toNumber(index))
  const real = i < 0 ? items.length + i : i
  return real >= 0 && real < items.length ? (items[real] ?? null) : null
}

/** Accès membre ; sur une collection, énumère le membre de chaque élément (PowerShell 3.0+). */
export function memberValue(target: PsValue, name: string): PsValue {
  const lower = name.toLowerCase()
  if (Array.isArray(target) && lower !== 'count' && lower !== 'length')
    return flatten(target).map((x) => memberValue(x, name))
  return getProp(target, name)
}

// ---------------------------------------------------------------------------
// Opérateur de format -f (mise en forme composite .NET, culture fr-FR)
// ---------------------------------------------------------------------------

/** Séparateur des milliers de la culture fr-FR (espace insécable, .NET Framework). */
const GROUP = ' '

/** Nombre au format de la culture fr-FR (virgule décimale). */
export function frenchNumber(n: number): string {
  return psToString(n).replace('.', ',')
}

function grouped(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, GROUP)
}

function formatNumber(n: number, spec: string): string {
  const letter = spec[0] ?? ''
  const digits = spec.length > 1 ? Number(spec.slice(1)) : NaN
  if (/^0+$/.test(spec)) {
    // Spécificateur personnalisé « 0 » : complète par des zéros (about_Operators)
    const rounded = Math.round(Math.abs(n))
    return `${n < 0 && rounded !== 0 ? '-' : ''}${String(rounded).padStart(spec.length, '0')}`
  }
  if (spec.length > 1 && Number.isNaN(digits)) return unsupportedFormat(spec)
  switch (letter) {
    case 'N':
    case 'n': {
      const fixed = Math.abs(n).toFixed(Number.isNaN(digits) ? 2 : digits)
      const [int, dec] = fixed.split('.')
      return `${n < 0 ? '-' : ''}${grouped(int ?? '0')}${dec ? `,${dec}` : ''}`
    }
    case 'F':
    case 'f':
      return n.toFixed(Number.isNaN(digits) ? 2 : digits).replace('.', ',')
    case 'D':
    case 'd': {
      if (!Number.isInteger(n))
        throw psError(
          'Erreur lors de la mise en forme d’une chaîne : Le format spécifié n’est pas valide.',
          'InvalidOperation',
          'FormatError'
        )
      const abs = String(Math.abs(n)).padStart(Number.isNaN(digits) ? 0 : digits, '0')
      return `${n < 0 ? '-' : ''}${abs}`
    }
    case 'X':
    case 'x': {
      const hex = Math.trunc(n)
        .toString(16)
        .padStart(Number.isNaN(digits) ? 0 : digits, '0')
      return letter === 'X' ? hex.toUpperCase() : hex
    }
    default:
      return unsupportedFormat(spec)
  }
}

function unsupportedFormat(spec: string): never {
  throw psError(
    `Le format « ${spec} » de l’opérateur -f n’est pas simulé dans ServerLab (formats pris en charge : N, F, D, X, 0…).`,
    'NotImplemented',
    'FormatNotSimulated'
  )
}

function formatItem(v: PsValue, spec: string | undefined): string {
  if (typeof v === 'number') return spec ? formatNumber(v, spec) : frenchNumber(v)
  // Les chaînes ne sont pas mises en forme : le spécificateur est ignoré
  return interpolate(v)
}

/** "{0} {1,-10} {2:N}" -f 1,"hello",3.14159 */
export function formatOperator(format: PsValue, args: PsValue): string {
  const fmt = psToString(format)
  const list = Array.isArray(args) ? args : [args]
  let out = ''
  let i = 0
  while (i < fmt.length) {
    const c = fmt[i] as string
    if (c === '{' && fmt[i + 1] === '{') {
      out += '{'
      i += 2
      continue
    }
    if (c === '}' && fmt[i + 1] === '}') {
      out += '}'
      i += 2
      continue
    }
    if (c === '{') {
      const close = fmt.indexOf('}', i)
      const m = close > 0 ? /^(\d+)\s*(?:,\s*(-?\d+))?(?::(.*))?$/.exec(fmt.slice(i + 1, close)) : null
      if (!m) throw formatError()
      const index = Number(m[1])
      if (index >= list.length)
        throw psError(
          'Erreur lors de la mise en forme d’une chaîne : L’index (de base zéro) doit être supérieur ou égal à zéro et inférieur à la taille de la liste des arguments.',
          'InvalidOperation',
          'FormatError'
        )
      let text = formatItem(list[index] ?? null, m[3])
      const align = m[2] ? Number(m[2]) : 0
      text = align < 0 ? text.padEnd(-align) : text.padStart(align)
      out += text
      i = close + 1
      continue
    }
    if (c === '}') throw formatError()
    out += c
    i++
  }
  return out
}

function formatError(): PsError {
  return psError(
    'Erreur lors de la mise en forme d’une chaîne : La chaîne d’entrée n’était pas au format correct.',
    'InvalidOperation',
    'FormatError'
  )
}
