/**
 * Filtres de sortie IOS (`show … | include|exclude|begin|section|count <regexp>`), appliqués aux
 * lignes produites par la commande, avec les expressions régulières IOS.
 *
 * Sources Cisco :
 * - « Using the Cisco IOS Command-Line Interface », Searching and Filtering CLI Output
 *   (https://www.cisco.com/c/en/us/td/docs/ios/fundamentals/configuration/guide/12_2sr/cf_12_2sr_book/cf_cli-basics.html)
 * - Configuration Fundamentals Command Reference : show | begin, | exclude, | include, | section
 *   (https://www.cisco.com/c/en/us/td/docs/ios/fundamentals/command/reference/cf_book/cf_s1.html)
 * - Format de `| count` : « Number of lines which match regexp = N »
 *   (https://www.cisco.com/c/en/us/td/docs/security/asa/asa-cli-reference/A-H/asa-command-ref-A-H/cli-usage.html)
 */
import type { Token } from './parser'

/** Mots-clés après `|` (aide IOS 15) ; ceux sans action ne sont pas simulés. */
const MODIFIERS = [
  'append',
  'begin',
  'count',
  'exclude',
  'format',
  'include',
  'redirect',
  'section',
  'tee'
] as const
type Modifier = (typeof MODIFIERS)[number]
const SIMULATED = ['begin', 'count', 'exclude', 'include', 'section'] as const
type Simulated = (typeof SIMULATED)[number]
const isSimulated = (m: Modifier): m is Simulated => (SIMULATED as readonly string[]).includes(m)

export interface OutputFilter {
  kind: Simulated
  /** section exclude : sections dont l'en-tête correspond retirées. */
  negate: boolean
  regex: RegExp | null
}

export type FilterParse =
  | { kind: 'ok'; filter: OutputFilter }
  /** Jeton invalide (index dans `tokens`, à partir du mot-clé). */
  | { kind: 'invalid'; index: number }
  | { kind: 'incomplete' }
  | { kind: 'unsimulated'; name: Modifier }

/**
 * Expression régulière IOS → JavaScript. Seule différence de syntaxe : `_` (virgule, accolade,
 * parenthèse, espace, début ou fin de chaîne) ; `\_` reste un souligné littéral.
 */
export function iosRegex(pattern: string): RegExp {
  let out = ''
  let inClass = false
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string
    if (c === '\\' && i + 1 < pattern.length) {
      const next = pattern[++i] as string
      out += next === '_' ? '_' : `\\${next}`
    } else if (c === '[') {
      inClass = true
      out += c
    } else if (c === ']') {
      inClass = false
      out += c
    } else if (c === '_' && !inClass) out += '(?:^|$|[,{}() ])'
    else out += c
  }
  try {
    return new RegExp(out)
  } catch {
    // Expression mal formée : comparée comme texte littéral (comportement IOS à vérifier)
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  }
}

/** Mot-clé IOS abrégé (`i`, `inc`, `e`, `b`, `s`, `c`) : préfixe non ambigu. */
function matchWord<T extends string>(words: readonly T[], text: string): T | null {
  const lower = text.toLowerCase()
  const found = words.filter((w) => w.startsWith(lower))
  return found.length === 1 ? (found[0] as T) : null
}

/** Texte de l'expression : le reste de la ligne à partir du jeton (espaces internes compris). */
function rest(line: string, tokens: readonly Token[], index: number): string | null {
  const token = tokens[index]
  return token ? line.slice(token.start).trimEnd() : null
}

/** Analyse le filtre (tokens à partir du mot-clé qui suit `|`). */
export function parseFilter(line: string, tokens: readonly Token[], start: number): FilterParse {
  const word = tokens[start]
  if (!word) return { kind: 'incomplete' }
  const modifier = matchWord(MODIFIERS, word.text)
  if (!modifier) return { kind: 'invalid', index: start }
  if (!isSimulated(modifier)) return { kind: 'unsimulated', name: modifier }
  if (modifier === 'section') {
    // section [include | exclude] regexp (include par défaut)
    const next = tokens[start + 1]
    const sub = next ? matchWord(['include', 'exclude'] as const, next.text) : null
    const text = rest(line, tokens, sub ? start + 2 : start + 1)
    if (text === null) return { kind: 'incomplete' }
    return { kind: 'ok', filter: { kind: 'section', negate: sub === 'exclude', regex: iosRegex(text) } }
  }
  const text = rest(line, tokens, start + 1)
  // count : expression facultative (toutes les lignes comptées)
  if (text === null && modifier !== 'count') return { kind: 'incomplete' }
  return {
    kind: 'ok',
    filter: { kind: modifier, negate: false, regex: text === null ? null : iosRegex(text) }
  }
}

const indent = (l: string): number => l.length - l.trimStart().length

/** Applique le filtre aux lignes de sortie de la commande. */
export function applyFilter(lines: readonly string[], filter: OutputFilter): string[] {
  const test = (l: string): boolean => (filter.regex ? filter.regex.test(l) : true)
  switch (filter.kind) {
    case 'include':
      return lines.filter(test)
    case 'exclude':
      return lines.filter((l) => !test(l))
    case 'begin': {
      const first = lines.findIndex(test)
      return first < 0 ? [] : lines.slice(first)
    }
    case 'count':
      return [`Number of lines which match regexp = ${lines.filter(test).length}`]
    case 'section': {
      // Ligne correspondante et lignes plus indentées qui la suivent (entrées associées)
      const out: string[] = []
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] as string
        let end = i + 1
        while (end < lines.length && indent(lines[end] as string) > indent(line)) end++
        if (!filter.negate && test(line)) {
          out.push(...lines.slice(i, end))
          i = end - 1
        } else if (filter.negate) {
          if (test(line)) i = end - 1
          else out.push(line)
        }
      }
      return out
    }
  }
}
