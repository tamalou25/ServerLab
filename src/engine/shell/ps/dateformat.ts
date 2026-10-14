/**
 * Mise en forme d'une date de l'horloge du lab par une chaîne de format .NET (Get-Date -Format),
 * culture fr-FR. Fonction pure : le temps vient de `state.clock`, jamais de l'horloge système.
 *
 * Sources Microsoft Learn :
 *  - Custom date and time format strings :
 *    https://learn.microsoft.com/dotnet/standard/base-types/custom-date-and-time-format-strings
 *    (« ddd » → « lun. », « dddd » → « lundi », « MMM » → « juin », « tt » → vide en fr-FR ;
 *    « / » et « : » sont les séparateurs de la culture ; '…', "…", \x et % littéraux)
 *  - Standard date and time format strings :
 *    https://learn.microsoft.com/dotnet/standard/base-types/standard-date-and-time-format-strings
 *    (« d » → « 15/06/2009 » en fr-FR ; un format standard est un alias d'un format personnalisé)
 */
import { clockParts } from '../../core/clock'
import { psError } from './errors'

const DAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi']
const DAYS_ABBR = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.']
const MONTHS = [
  'janvier',
  'février',
  'mars',
  'avril',
  'mai',
  'juin',
  'juillet',
  'août',
  'septembre',
  'octobre',
  'novembre',
  'décembre'
]
const MONTHS_ABBR = [
  'janv.',
  'févr.',
  'mars',
  'avr.',
  'mai',
  'juin',
  'juil.',
  'août',
  'sept.',
  'oct.',
  'nov.',
  'déc.'
]

/** Formats standard (un caractère) : modèles de la culture fr-FR. */
const STANDARD: Record<string, string> = {
  d: 'dd/MM/yyyy',
  D: 'dddd d MMMM yyyy',
  t: 'HH:mm',
  T: 'HH:mm:ss',
  f: 'dddd d MMMM yyyy HH:mm',
  F: 'dddd d MMMM yyyy HH:mm:ss',
  g: 'dd/MM/yyyy HH:mm',
  G: 'dd/MM/yyyy HH:mm:ss',
  M: 'd MMMM',
  m: 'd MMMM',
  Y: 'MMMM yyyy',
  y: 'MMMM yyyy',
  // Modèles invariants
  s: "yyyy'-'MM'-'dd'T'HH':'mm':'ss"
}

function notSimulated(spec: string): never {
  throw psError(
    `Le spécificateur de format de date « ${spec} » n’est pas simulé dans ServerLab (fuseau horaire, ère : l’horloge du lab n’en a pas).`,
    'NotImplemented',
    'DateFormatNotSimulated'
  )
}

/** Date de l'horloge du lab mise en forme selon `format` (.NET, culture fr-FR). */
export function formatLabDate(clock: number, format: string): string {
  if (format.length === 1) {
    const pattern = STANDARD[format]
    if (pattern) return formatLabDate(clock, pattern)
    if ('oOuUrRK'.includes(format)) notSimulated(format)
    throw psError(
      'Le format de la chaîne d’entrée est incorrect.',
      'InvalidArgument',
      'FormatException',
      undefined,
      'FormatException'
    )
  }
  const t = clockParts(clock)
  const ms = (((clock % 1000) + 1000) % 1000) | 0
  const p = (n: number, w: number) => String(n).padStart(w, '0')
  let out = ''
  let i = 0
  while (i < format.length) {
    const c = format[i] as string
    // Littéraux : chaîne entre apostrophes ou guillemets, caractère échappé
    if (c === "'" || c === '"') {
      const close = format.indexOf(c, i + 1)
      const end = close < 0 ? format.length : close
      out += format.slice(i + 1, end)
      i = end + 1
      continue
    }
    if (c === '\\') {
      out += format[i + 1] ?? ''
      i += 2
      continue
    }
    if (c === '%') {
      i++
      continue
    }
    let n = 1
    while (format[i + n] === c) n++
    i += n
    switch (c) {
      case 'd':
        out += n === 1 ? String(t.date) : n === 2 ? p(t.date, 2) : n === 3 ? DAYS_ABBR[t.day] : DAYS[t.day]
        break
      case 'M':
        out +=
          n === 1
            ? String(t.month + 1)
            : n === 2
              ? p(t.month + 1, 2)
              : n === 3
                ? MONTHS_ABBR[t.month]
                : MONTHS[t.month]
        break
      case 'y':
        out += n === 1 ? String(t.year % 100) : n === 2 ? p(t.year % 100, 2) : p(t.year, n)
        break
      case 'H':
        out += n === 1 ? String(t.h) : p(t.h, 2)
        break
      case 'h': {
        const h12 = t.h % 12 === 0 ? 12 : t.h % 12
        out += n === 1 ? String(h12) : p(h12, 2)
        break
      }
      case 'm':
        out += n === 1 ? String(t.m) : p(t.m, 2)
        break
      case 's':
        out += n === 1 ? String(t.s) : p(t.s, 2)
        break
      case 'f':
      case 'F': {
        const digits = p(ms, 3).padEnd(n, '0').slice(0, n)
        out += c === 'F' ? digits.replace(/0+$/, '') : digits
        break
      }
      case 't':
        // Indicateur AM/PM : vide en fr-FR
        break
      case 'g':
      case 'z':
      case 'K':
        notSimulated(c.repeat(n))
        break
      case '/':
        out += '/'.repeat(n)
        break
      case ':':
        out += ':'.repeat(n)
        break
      default:
        out += c.repeat(n)
    }
  }
  return out
}
