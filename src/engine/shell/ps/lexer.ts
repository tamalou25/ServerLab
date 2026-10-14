/**
 * Analyse lexicale du PowerShell simulé.
 */

export type TokenType =
  | 'word'
  | 'string'
  | 'number'
  | 'param'
  | 'variable'
  | 'pipe'
  | 'semi'
  | 'comma'
  | 'lparen'
  | 'rparen'
  | 'atparen'
  | 'dollarparen'
  | 'op'
  | 'hash'
  | 'script'
  | 'assign'
  | 'eof'

export interface Token {
  type: TokenType
  /** Texte brut tel que saisi. */
  text: string
  /** Valeur interprétée (contenu d'une chaîne, nom de paramètre, nom de variable…). */
  value: string
  start: number
  end: number
  /** Chaîne entre guillemets doubles (développement des variables). */
  expandable?: boolean
  /** Paramètre écrit -Nom:valeur : valeur collée. */
  inlineValue?: string
  /** Pour une variable : chemin de propriétés ($user.Name → ['Name']). */
  members?: string[]
  /** Mot déjà redécoupé en mode expression (voir `splitExprWord`). */
  split?: boolean
  /** Bloc de script : position du premier caractère de `value` dans la source. */
  valueStart?: number
}

/**
 * Caractère privé qui remplace un « `$ » échappé dans une chaîne entre guillemets doubles :
 * le développement des variables le laisse tel quel puis le rend en « $ » (about_Quoting_Rules).
 */
export const ESCAPED_DOLLAR = '\uE000'

export class PsSyntaxError extends Error {
  constructor(
    message: string,
    public readonly position: number,
    public readonly errorId: string
  ) {
    super(message)
    this.name = 'PsSyntaxError'
  }
}

const WORD_STOP = new Set([' ', '\t', '|', ';', ',', '(', ')', '{', '}', '\n'])

function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= '0' && c <= '9'
}

function isLetter(c: string | undefined): boolean {
  return c !== undefined && /[A-Za-zÀ-ÿ_?]/.test(c)
}

/** Position qui suit la parenthèse fermante d'une sous-expression commencée en `from`. */
function subExpressionEnd(source: string, from: number): number {
  let depth = 1
  let j = from
  let quote: string | null = null
  while (j < source.length && depth > 0) {
    const d = source[j]
    if (quote) {
      if (d === quote) quote = null
    } else if (d === '"' || d === "'") quote = d
    else if (d === '(') depth++
    else if (d === ')') depth--
    j++
  }
  return j
}

/** Opérateurs reconnus à l'intérieur d'un mot en mode expression (le plus long d'abord). */
const EXPR_OPS = [
  '++',
  '--',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '..',
  '+',
  '-',
  '*',
  '/',
  '%',
  '!',
  '[',
  ']',
  '.',
  '='
]

/**
 * Redécoupe un mot en mode expression (about_Parsing : « 2+3 », « $i++ », « 1..10 »,
 * « [0] » sont des opérateurs et des opérandes, pas un argument nu).
 */
export function splitExprWord(tok: Token): Token[] {
  const s = tok.text
  const out: Token[] = []
  let i = 0
  while (i < s.length) {
    const at = tok.start + i
    const rest = s.slice(i)
    if (rest[0] === '$') {
      const sub = tokenize(rest)[0] as Token
      if (sub.type === 'variable' && sub.end > 0) {
        out.push({ ...sub, start: sub.start + at, end: sub.end + at })
        i += sub.end
        continue
      }
    }
    const num = /^\d+(\.\d+)?/.exec(rest)
    if (num) {
      out.push({ type: 'number', text: num[0], value: num[0], start: at, end: at + num[0].length })
      i += num[0].length
      continue
    }
    const op = EXPR_OPS.find((o) => rest.startsWith(o))
    if (op) {
      out.push({ type: 'op', text: op, value: op, start: at, end: at + op.length, split: true })
      i += op.length
      continue
    }
    const ident = /^[A-Za-zÀ-ÿ_][A-Za-z0-9À-ÿ_]*/.exec(rest)
    const text = ident ? ident[0] : (rest[0] as string)
    out.push({ type: 'word', text, value: text, start: at, end: at + text.length, split: true })
    i += text.length
  }
  return out
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  const n = source.length

  while (i < n) {
    const c = source[i] as string
    if (c === ' ' || c === '\t' || c === '\r') {
      i++
      continue
    }
    if (c === '\n') {
      // Retour à la ligne : séparateur d'instructions (script sur plusieurs lignes)
      tokens.push({ type: 'semi', text: '\n', value: '\n', start: i, end: ++i })
      continue
    }
    if (c === '#') {
      // Commentaire jusqu'à la fin de la ligne
      while (i < n && source[i] !== '\n') i++
      continue
    }
    const start = i

    if (c === '|') {
      tokens.push({ type: 'pipe', text: c, value: c, start, end: ++i })
      continue
    }
    if (c === ';') {
      tokens.push({ type: 'semi', text: c, value: c, start, end: ++i })
      continue
    }
    if (c === ',') {
      tokens.push({ type: 'comma', text: c, value: c, start, end: ++i })
      continue
    }
    if (c === '(') {
      tokens.push({ type: 'lparen', text: c, value: c, start, end: ++i })
      continue
    }
    if (c === ')') {
      tokens.push({ type: 'rparen', text: c, value: c, start, end: ++i })
      continue
    }
    if (c === '$' && source[i + 1] === '(') {
      // Sous-expression $( … ) (about_Operators)
      i += 2
      tokens.push({ type: 'dollarparen', text: '$(', value: '$(', start, end: i })
      continue
    }
    if (c === '$' && source[i + 1] === '{') {
      // ${nom} : nom de variable délimité par des accolades (about_Quoting_Rules)
      const close = source.indexOf('}', i + 2)
      if (close > 0) {
        tokens.push({
          type: 'variable',
          text: source.slice(i, close + 1),
          value: source.slice(i + 2, close),
          start,
          end: close + 1,
          members: []
        })
        i = close + 1
        continue
      }
    }
    if (c === '@' && source[i + 1] === '(') {
      i += 2
      tokens.push({ type: 'atparen', text: '@(', value: '@(', start, end: i })
      continue
    }
    if (c === '{' || (c === '@' && source[i + 1] === '{')) {
      // Bloc de script (ou table de hachage @{ … }) : contenu brut jusqu'à l'accolade fermante
      const hash = c === '@'
      if (hash) i++
      let depth = 1
      let j = i + 1
      let quote: string | null = null
      while (j < n && depth > 0) {
        const d = source[j]
        if (quote) {
          if (d === quote) quote = null
        } else if (d === '"' || d === "'") quote = d
        else if (d === '{') depth++
        else if (d === '}') depth--
        j++
      }
      if (depth > 0)
        throw new PsSyntaxError(
          'Accolade fermante « } » manquante dans le bloc d’instructions.',
          start,
          'MissingEndCurlyBrace'
        )
      tokens.push({
        type: hash ? 'hash' : 'script',
        text: source.slice(start, j),
        value: source.slice(i + 1, j - 1).trim(),
        valueStart:
          i + 1 + (source.slice(i + 1, j - 1).length - source.slice(i + 1, j - 1).trimStart().length),
        start,
        end: j
      })
      i = j
      continue
    }
    if (c === '}')
      throw new PsSyntaxError(
        'Jeton inattendu « } » dans l’expression ou l’instruction.',
        start,
        'UnexpectedToken'
      )

    if (c === "'" || c === '"' || c === '‘' || c === '’' || c === '“' || c === '”') {
      const double = c === '"' || c === '“' || c === '”'
      const closers = double ? ['"', '“', '”'] : ["'", '‘', '’']
      let j = i + 1
      let value = ''
      let closed = false
      while (j < n) {
        const d = source[j] as string
        if (double && d === '`' && j + 1 < n) {
          // Caractères spéciaux (about_Special_Characters) ; « `$ » reste littéral
          const next = source[j + 1] as string
          value +=
            next === 'n'
              ? '\n'
              : next === 't'
                ? '\t'
                : next === 'r'
                  ? '\r'
                  : next === '0'
                    ? '\0'
                    : next === '$'
                      ? ESCAPED_DOLLAR
                      : next
          j += 2
          continue
        }
        if (double && d === '$' && source[j + 1] === '(') {
          // Sous-expression dans la chaîne : copiée telle quelle jusqu'à la parenthèse fermante,
          // guillemets imbriqués compris (« "Total : $($a + "x")" »)
          const close = subExpressionEnd(source, j + 2)
          value += source.slice(j, close)
          j = close
          continue
        }
        if (closers.includes(d)) {
          // Guillemet doublé = guillemet littéral
          if (source[j + 1] !== undefined && closers.includes(source[j + 1] as string)) {
            value += d
            j += 2
            continue
          }
          closed = true
          j++
          break
        }
        value += d
        j++
      }
      if (!closed)
        throw new PsSyntaxError(
          `Le terminateur ${double ? '"' : "'"} est manquant dans la chaîne.`,
          start,
          'TerminatorExpectedAtEndOfString'
        )
      tokens.push({ type: 'string', text: source.slice(start, j), value, start, end: j, expandable: double })
      i = j
      continue
    }

    if (c === '$') {
      let j = i + 1
      // $env:NOM, $_, $nom
      while (j < n && /[A-Za-z0-9_:?]/.test(source[j] as string)) j++
      const name = source.slice(i + 1, j)
      const members: string[] = []
      while (source[j] === '.' && isLetter(source[j + 1])) {
        let k = j + 1
        while (k < n && /[A-Za-z0-9_]/.test(source[k] as string)) k++
        members.push(source.slice(j + 1, k))
        j = k
      }
      tokens.push({ type: 'variable', text: source.slice(start, j), value: name, start, end: j, members })
      i = j
      continue
    }

    if (c === '=' && source[i + 1] !== '=') {
      tokens.push({ type: 'assign', text: '=', value: '=', start, end: ++i })
      continue
    }

    // Mot : nom de commande, argument nu, paramètre ou nombre
    let j = i
    while (j < n && !WORD_STOP.has(source[j] as string)) {
      if ((source[j] === '"' || source[j] === "'") && j > i) break
      j++
    }
    const text = source.slice(i, j)
    i = j
    if (text.startsWith('-') && isLetter(text[1])) {
      const colon = text.indexOf(':')
      if (colon > 0) {
        tokens.push({
          type: 'param',
          text,
          value: text.slice(1, colon),
          start,
          end: j,
          inlineValue: text.slice(colon + 1)
        })
      } else {
        tokens.push({ type: 'param', text, value: text.slice(1), start, end: j })
      }
    } else if (/^-?\d+(\.\d+)?$/.test(text) && (isDigit(text[0]) || isDigit(text[1]))) {
      tokens.push({ type: 'number', text, value: text, start, end: j })
    } else {
      tokens.push({ type: 'word', text, value: text, start, end: j })
    }
  }
  tokens.push({ type: 'eof', text: '', value: '', start: n, end: n })
  return tokens
}
