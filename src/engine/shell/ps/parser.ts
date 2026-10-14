/**
 * Analyse syntaxique : instructions, pipelines, commandes et arguments.
 *
 * Deux modes, comme PowerShell (about_Parsing) : une instruction qui commence par un nombre,
 * une chaîne, une variable ou une parenthèse est lue en **mode expression** (opérateurs
 * arithmétiques, de comparaison, logiques…) ; sinon c'est une commande en **mode argument**.
 */
import { PsSyntaxError, splitExprWord, tokenize, type Token } from './lexer'

/** Opérateurs de comparaison (about_Comparison_Operators) ; le préfixe « i » est accepté. */
export const COMPARISON_OPS = new Set([
  'eq',
  'ne',
  'gt',
  'ge',
  'lt',
  'le',
  'like',
  'notlike',
  'match',
  'notmatch',
  'contains',
  'notcontains',
  'in',
  'notin'
])

/** Opérateurs réels de PowerShell que le simulateur n'évalue pas (message honnête). */
const UNSIMULATED_OPS = new Set([
  'band',
  'bor',
  'bxor',
  'bnot',
  'shl',
  'shr',
  'replace',
  'split',
  'join',
  'is',
  'isnot',
  'as'
])

/** Opérateurs unaires écrits « -nom ». */
const UNARY_PARAMS = new Set(['not', 'bnot', 'split', 'join'])

/** Nom d'opérateur d'un jeton « -nom » (« -ieq » → « eq ») ; `null` si ce n'en est pas un. */
function operatorName(t: Token): string | null {
  if (t.type !== 'param') return null
  const name = t.value.toLowerCase()
  if (name.startsWith('i') && COMPARISON_OPS.has(name.slice(1))) return name.slice(1)
  return name
}

export type Expr =
  | { kind: 'number'; value: number; start: number; end: number }
  | { kind: 'string'; value: string; expandable: boolean; bare: boolean; start: number; end: number }
  | { kind: 'variable'; name: string; members: string[]; start: number; end: number }
  | { kind: 'array'; items: Expr[]; start: number; end: number }
  | {
      kind: 'sub'
      statements: Statement[]
      members: string[]
      /** @( … ) : le résultat est toujours un tableau. */
      array?: boolean
      /** ( … ) : une expression seule y est évaluée comme expression (« ($i++) » renvoie une valeur). */
      paren?: boolean
      start: number
      end: number
    }
  | { kind: 'script'; source: string; start: number; end: number }
  | { kind: 'hash'; entries: { key: string; value: Expr }[]; start: number; end: number }
  | { kind: 'binary'; op: string; left: Expr; right: Expr; start: number; end: number }
  | { kind: 'unary'; op: '-' | '+' | 'not'; operand: Expr; start: number; end: number }
  | { kind: 'index'; target: Expr; index: Expr; start: number; end: number }
  | { kind: 'member'; target: Expr; name: string; start: number; end: number }
  /** ++ / -- sur une variable (about_Assignment_Operators). */
  | { kind: 'incr'; name: string; delta: 1 | -1; prefix: boolean; start: number; end: number }
  /** Construction réelle non simulée : son évaluation affiche un message honnête. */
  | { kind: 'unsupported'; what: string; start: number; end: number }

export type Arg =
  | { kind: 'param'; name: string; inline: Expr | null; text: string; start: number; end: number }
  | { kind: 'value'; expr: Expr; start: number; end: number }

export type Element =
  | { kind: 'command'; name: string; args: Arg[]; start: number; end: number }
  | { kind: 'expr'; expr: Expr; start: number; end: number }

export interface Pipeline {
  elements: Element[]
  start: number
  end: number
}

export interface Statement {
  pipeline: Pipeline
  /** Affectation `$nom = …`. */
  assign: string | null
  /** Opérateur d'affectation composé (+= -= *= /= %=, about_Assignment_Operators). */
  assignOp?: string
  start: number
  end: number
}

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%='])

/** Jetons qui terminent une expression. */
function isTerminator(t: Token): boolean {
  return t.type === 'eof' || t.type === 'semi' || t.type === 'pipe' || t.type === 'rparen'
}

class Parser {
  private pos = 0
  constructor(private readonly tokens: Token[]) {}

  private peek(offset = 0): Token {
    return this.tokens[Math.max(0, Math.min(this.pos + offset, this.tokens.length - 1))] as Token
  }

  private next(): Token {
    const t = this.peek()
    this.pos++
    return t
  }

  /** Jeton courant en mode expression : un mot est redécoupé en opérateurs et opérandes. */
  private epeek(offset = 0): Token {
    for (let k = 0; k <= offset; k++) {
      const index = this.pos + k
      const t = this.tokens[index]
      if (t && t.type === 'word' && !t.split) this.tokens.splice(index, 1, ...splitExprWord(t))
    }
    return this.peek(offset)
  }

  private isOp(t: Token, text: string): boolean {
    return t.type === 'op' && t.text === text
  }

  parseStatements(stop: 'eof' | 'rparen'): Statement[] {
    const statements: Statement[] = []
    while (true) {
      while (this.peek().type === 'semi') this.next()
      const t = this.peek()
      if (t.type === 'eof' || t.type === stop) break
      statements.push(this.parseStatement())
      const after = this.peek()
      if (after.type === 'semi') continue
      if (after.type === 'eof' || after.type === stop) break
      throw new PsSyntaxError(
        `Jeton inattendu « ${after.text} » dans l’expression ou l’instruction.`,
        after.start,
        'UnexpectedToken'
      )
    }
    return statements
  }

  private parseStatement(): Statement {
    const first = this.peek()
    let assign: string | null = null
    let assignOp = '='
    if (first.type === 'variable' && (first.members ?? []).length === 0) {
      const op = this.peek(1).type === 'assign' ? this.peek(1) : this.epeek(1)
      const opText = op.type === 'assign' ? '=' : op.type === 'op' ? op.text : ''
      if (ASSIGN_OPS.has(opText)) {
        assign = first.value
        assignOp = opText
        this.next()
        this.next()
        const t = this.peek()
        if (t.type === 'eof' || t.type === 'semi')
          throw new PsSyntaxError(
            `Expression manquante après « ${opText} ».`,
            t.start,
            'ExpectedValueExpression'
          )
      }
    }
    const pipeline = this.parsePipeline()
    return {
      pipeline,
      assign,
      ...(assign && assignOp !== '=' ? { assignOp } : {}),
      start: first.start,
      end: pipeline.end
    }
  }

  private parsePipeline(): Pipeline {
    const elements: Element[] = [this.parseElement()]
    while (this.peek().type === 'pipe') {
      const pipe = this.next()
      const t = this.peek()
      if (t.type === 'eof' || t.type === 'semi' || t.type === 'rparen')
        throw new PsSyntaxError(
          'Un élément de canal vide n’est pas autorisé.',
          pipe.start,
          'EmptyPipeElement'
        )
      elements.push(this.parseElement())
    }
    const first = elements[0] as Element
    const last = elements[elements.length - 1] as Element
    return { elements, start: first.start, end: last.end }
  }

  /** Vrai si l'instruction commence en mode expression (« 2+3 », « 1..5 », « !$x », « -not »). */
  private startsExpression(t: Token): boolean {
    if (t.type === 'param') return UNARY_PARAMS.has(operatorName(t) ?? '')
    if (t.type !== 'word') return true
    return /^[0-9!+[]/.test(t.text) || /^-[^A-Za-z]/.test(t.text) || t.text === '-'
  }

  private parseElement(): Element {
    const t = this.peek()
    if (this.startsExpression(t)) {
      const expr = this.parseExpression()
      const after = this.epeek()
      if (!isTerminator(after))
        throw new PsSyntaxError(
          `Jeton inattendu « ${after.text} » dans l’expression ou l’instruction.`,
          after.start,
          'UnexpectedToken'
        )
      return { kind: 'expr', expr, start: expr.start, end: expr.end }
    }
    if (t.type === 'word') {
      this.next()
      const args: Arg[] = []
      let end = t.end
      while (true) {
        const a = this.peek()
        if (isTerminator(a)) break
        if (a.type === 'param') {
          this.next()
          let inline: Expr | null = null
          if (a.inlineValue !== undefined) {
            const sub = tokenize(a.inlineValue)
            const first = sub[0]
            if (first && first.type === 'variable') {
              inline = {
                kind: 'variable',
                name: first.value,
                members: first.members ?? [],
                start: a.start,
                end: a.end
              }
            } else if (first && first.type === 'number') {
              inline = { kind: 'number', value: Number(first.value), start: a.start, end: a.end }
            } else {
              inline = {
                kind: 'string',
                value: a.inlineValue,
                expandable: false,
                bare: true,
                start: a.start,
                end: a.end
              }
            }
          }
          args.push({ kind: 'param', name: a.value, inline, text: a.text, start: a.start, end: a.end })
          end = a.end
        } else {
          const expr = this.parseValue()
          args.push({ kind: 'value', expr, start: expr.start, end: expr.end })
          end = expr.end
        }
      }
      return { kind: 'command', name: t.value, args, start: t.start, end }
    }
    throw new PsSyntaxError(
      `Jeton inattendu « ${t.text} » dans l’expression ou l’instruction.`,
      t.start,
      'UnexpectedToken'
    )
  }

  // -------------------------------------------------------------------------
  // Mode expression, du moins au plus prioritaire (about_Operator_Precedence) :
  // -and -or -xor · comparaisons · + - · * / % · - unaire · -f · .. · ! -not · , · [ ] . ++ --
  // Opérateurs de même priorité : évalués de gauche à droite.
  // -------------------------------------------------------------------------

  parseExpression(): Expr {
    let left = this.parseComparison()
    for (;;) {
      const t = this.epeek()
      const name = operatorName(t)
      if (name !== 'and' && name !== 'or' && name !== 'xor') return left
      this.next()
      const right = this.operand(t, () => this.parseComparison())
      left = { kind: 'binary', op: name, left, right, start: left.start, end: right.end }
    }
  }

  /** Opérande obligatoire après un opérateur. */
  private operand(op: Token, parse: () => Expr): Expr {
    const t = this.epeek()
    if (
      isTerminator(t) ||
      t.type === 'comma' ||
      (t.type === 'param' && !UNARY_PARAMS.has(operatorName(t) ?? ''))
    )
      throw new PsSyntaxError(
        `Expression manquante après l’opérateur « ${op.text} ».`,
        t.start,
        'ExpectedValueExpression'
      )
    return parse()
  }

  private parseComparison(): Expr {
    let left = this.parseAdditive()
    for (;;) {
      const t = this.epeek()
      const name = operatorName(t)
      if (name === null) return left
      if (UNSIMULATED_OPS.has(name)) {
        this.next()
        const right = this.operand(t, () => this.parseAdditive())
        left = { kind: 'unsupported', what: `L’opérateur « ${t.text} »`, start: left.start, end: right.end }
        continue
      }
      if (!COMPARISON_OPS.has(name)) return left
      this.next()
      const right = this.operand(t, () => this.parseAdditive())
      left = { kind: 'binary', op: name, left, right, start: left.start, end: right.end }
    }
  }

  private parseAdditive(): Expr {
    let left = this.parseMultiplicative()
    for (;;) {
      const t = this.epeek()
      if (this.isOp(t, '+') || this.isOp(t, '-')) {
        this.next()
        const right = this.operand(t, () => this.parseMultiplicative())
        left = { kind: 'binary', op: t.text, left, right, start: left.start, end: right.end }
        continue
      }
      // « 5 -3 » : le lexeur a lu un nombre négatif ; après un opérande, c'est une soustraction
      if (t.type === 'number' && t.text.startsWith('-')) {
        this.next()
        const value: Expr = { kind: 'number', value: -Number(t.value), start: t.start + 1, end: t.end }
        const right = this.parseMultiplicativeFrom(value)
        left = { kind: 'binary', op: '-', left, right, start: left.start, end: right.end }
        continue
      }
      return left
    }
  }

  private parseMultiplicative(): Expr {
    return this.parseMultiplicativeFrom(this.parseUnary())
  }

  private parseMultiplicativeFrom(first: Expr): Expr {
    let left = first
    for (;;) {
      const t = this.epeek()
      if (!this.isOp(t, '*') && !this.isOp(t, '/') && !this.isOp(t, '%')) return left
      this.next()
      const right = this.operand(t, () => this.parseUnary())
      left = { kind: 'binary', op: t.text, left, right, start: left.start, end: right.end }
    }
  }

  private parseUnary(): Expr {
    const t = this.epeek()
    if (this.isOp(t, '-') || this.isOp(t, '+')) {
      this.next()
      const operand = this.operand(t, () => this.parseUnary())
      return { kind: 'unary', op: t.text as '-' | '+', operand, start: t.start, end: operand.end }
    }
    return this.parseFormat()
  }

  private parseFormat(): Expr {
    let left = this.parseRange()
    for (;;) {
      const t = this.epeek()
      if (operatorName(t) !== 'f') return left
      this.next()
      const right = this.operand(t, () => this.parseRange())
      left = { kind: 'binary', op: 'f', left, right, start: left.start, end: right.end }
    }
  }

  private parseRange(): Expr {
    const left = this.parseNot()
    const t = this.epeek()
    if (!this.isOp(t, '..')) return left
    this.next()
    const right = this.operand(t, () => this.parseNot())
    return { kind: 'binary', op: '..', left, right, start: left.start, end: right.end }
  }

  private parseNot(): Expr {
    const t = this.epeek()
    const name = operatorName(t)
    if (this.isOp(t, '!') || name === 'not') {
      this.next()
      const operand = this.operand(t, () => this.parseNot())
      return { kind: 'unary', op: 'not', operand, start: t.start, end: operand.end }
    }
    if (name !== null && UNARY_PARAMS.has(name)) {
      this.next()
      const operand = this.operand(t, () => this.parseNot())
      return { kind: 'unsupported', what: `L’opérateur « ${t.text} »`, start: t.start, end: operand.end }
    }
    return this.parseComma()
  }

  /** Opérateur virgule : construit un tableau (plus prioritaire que l'arithmétique). */
  private parseComma(): Expr {
    const first = this.parsePostfix()
    if (this.epeek().type !== 'comma') return first
    const items = [first]
    while (this.epeek().type === 'comma') {
      const comma = this.next()
      items.push(this.operand(comma, () => this.parsePostfix()))
    }
    const last = items[items.length - 1] as Expr
    return { kind: 'array', items, start: first.start, end: last.end }
  }

  /** Opérande suivi d'accès collés : [index], .Membre, ++ / --. */
  private parsePostfix(): Expr {
    let expr = this.parseExprPrimary()
    for (;;) {
      const t = this.epeek()
      if (t.start !== expr.end) return expr
      if (this.isOp(t, '[')) {
        this.next()
        const index = this.parseExpression()
        const close = this.epeek()
        if (!this.isOp(close, ']'))
          throw new PsSyntaxError(
            'Crochet fermant « ] » manquant dans l’expression d’index.',
            close.start,
            'MissingEndSquareBracket'
          )
        this.next()
        expr = { kind: 'index', target: expr, index, start: expr.start, end: close.end }
        continue
      }
      if (this.isOp(t, '.') && this.epeek(1).type === 'word') {
        this.next()
        const name = this.next()
        expr = { kind: 'member', target: expr, name: name.text, start: expr.start, end: name.end }
        continue
      }
      if (
        t.type === 'lparen' &&
        (expr.kind === 'member' || (expr.kind === 'variable' && expr.members.length > 0))
      ) {
        // Appel de méthode .NET ($s.ToUpper()) : non simulé
        const name = expr.kind === 'member' ? expr.name : (expr.members[expr.members.length - 1] as string)
        const call = this.parseExprPrimary()
        expr = {
          kind: 'unsupported',
          what: `L’appel de méthode « ${name}() »`,
          start: expr.start,
          end: call.end
        }
        continue
      }
      if (
        (this.isOp(t, '++') || this.isOp(t, '--')) &&
        expr.kind === 'variable' &&
        expr.members.length === 0
      ) {
        this.next()
        const delta = t.text === '++' ? 1 : -1
        expr = { kind: 'incr', name: expr.name, delta, prefix: false, start: expr.start, end: t.end }
        continue
      }
      return expr
    }
  }

  private parseExprPrimary(): Expr {
    const t = this.epeek()
    if (this.isOp(t, '++') || this.isOp(t, '--')) {
      this.next()
      const v = this.epeek()
      if (v.type !== 'variable')
        throw new PsSyntaxError(
          `Expression manquante après l’opérateur « ${t.text} ».`,
          v.start,
          'ExpectedValueExpression'
        )
      this.next()
      const delta = t.text === '++' ? 1 : -1
      return { kind: 'incr', name: v.value, delta, prefix: true, start: t.start, end: v.end }
    }
    if (this.isOp(t, '[')) {
      // Littéral de type ([int], [datetime]…) : conversions non simulées
      this.next()
      let end = t.end
      while (this.epeek().type !== 'eof' && !this.isOp(this.peek(), ']')) end = this.next().end
      if (this.isOp(this.peek(), ']')) end = this.next().end
      // Opérande converti collé au type ([int]"5")
      if (this.epeek().start === end && !isTerminator(this.peek())) end = this.parsePostfix().end
      return { kind: 'unsupported', what: 'La conversion de type « [type] »', start: t.start, end }
    }
    if (t.type === 'lparen' || t.type === 'atparen' || t.type === 'dollarparen') {
      this.next()
      const statements = this.parseStatements('rparen')
      const close = this.peek()
      if (close.type !== 'rparen')
        throw new PsSyntaxError(
          'Parenthèse fermante « ) » manquante dans l’expression.',
          close.start,
          'MissingEndParenthesisInExpression'
        )
      this.next()
      if (t.type === 'atparen' && statements.length === 0)
        return { kind: 'array', items: [], start: t.start, end: close.end }
      return {
        kind: 'sub',
        statements,
        members: [],
        ...(t.type === 'atparen' ? { array: true } : t.type === 'lparen' ? { paren: true } : {}),
        start: t.start,
        end: close.end
      }
    }
    if (t.type === 'word' || t.type === 'op' || t.type === 'param' || t.type === 'assign')
      throw new PsSyntaxError(
        `Jeton inattendu « ${t.text} » dans l’expression ou l’instruction.`,
        t.start,
        'UnexpectedToken'
      )
    return this.parsePrimary()
  }

  // -------------------------------------------------------------------------
  // Mode argument
  // -------------------------------------------------------------------------

  /** Valeur éventuellement suivie de virgules (tableau). */
  private parseValue(): Expr {
    const first = this.parsePrimary()
    if (this.peek().type !== 'comma') return first
    const items = [first]
    while (this.peek().type === 'comma') {
      const comma = this.next()
      const t = this.peek()
      if (isTerminator(t))
        throw new PsSyntaxError(
          'Expression manquante après « , » dans la liste de paramètres.',
          comma.start,
          'MissingExpressionAfterToken'
        )
      items.push(this.parsePrimary())
    }
    const last = items[items.length - 1] as Expr
    return { kind: 'array', items, start: first.start, end: last.end }
  }

  private parsePrimary(): Expr {
    const t = this.next()
    switch (t.type) {
      case 'number':
        return { kind: 'number', value: Number(t.value), start: t.start, end: t.end }
      case 'string':
        return {
          kind: 'string',
          value: t.value,
          expandable: !!t.expandable,
          bare: false,
          start: t.start,
          end: t.end
        }
      case 'word':
      case 'op':
        return { kind: 'string', value: t.value, expandable: false, bare: true, start: t.start, end: t.end }
      case 'variable':
        return { kind: 'variable', name: t.value, members: t.members ?? [], start: t.start, end: t.end }
      case 'script':
        return { kind: 'script', source: t.value, start: t.start, end: t.end }
      case 'hash':
        return { kind: 'hash', entries: parseHashEntries(t.value, t.start), start: t.start, end: t.end }
      case 'lparen':
      case 'dollarparen':
      case 'atparen': {
        const statements = this.parseStatements('rparen')
        const close = this.peek()
        if (close.type !== 'rparen')
          throw new PsSyntaxError(
            'Parenthèse fermante « ) » manquante dans l’expression.',
            close.start,
            'MissingEndParenthesisInExpression'
          )
        this.next()
        // Accès membre collé : (expression).Propriété
        const members: string[] = []
        let end = close.end
        while (this.peek().type === 'word' && this.peek().start === end && this.peek().text.startsWith('.')) {
          const m = this.next()
          members.push(...m.text.split('.').filter((x) => x.length > 0))
          end = m.end
        }
        if (t.type === 'atparen' && statements.length === 0)
          return { kind: 'array', items: [], start: t.start, end }
        return {
          kind: 'sub',
          statements,
          members,
          ...(t.type === 'atparen' ? { array: true } : t.type === 'lparen' ? { paren: true } : {}),
          start: t.start,
          end
        }
      }
      default:
        throw new PsSyntaxError(
          t.type === 'eof'
            ? 'Expression manquante.'
            : `Jeton inattendu « ${t.text} » dans l’expression ou l’instruction.`,
          t.start,
          t.type === 'eof' ? 'ExpectedExpression' : 'UnexpectedToken'
        )
    }
  }
}

/** Découpe le contenu d'une table de hachage en entrées « clé = valeur » (séparées par ; ou retour). */
function parseHashEntries(source: string, offset: number): { key: string; value: Expr }[] {
  const parts: string[] = []
  let current = ''
  let quote: string | null = null
  let depth = 0
  for (const c of source) {
    if (quote) {
      if (c === quote) quote = null
    } else if (c === '"' || c === "'") quote = c
    else if (c === '(' || c === '{') depth++
    else if (c === ')' || c === '}') depth--
    else if ((c === ';' || c === '\n') && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += c
  }
  parts.push(current)
  return parts
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => {
      const eq = p.indexOf('=')
      if (eq <= 0)
        throw new PsSyntaxError(
          'Signe égal (=) manquant après la clé dans le littéral de hachage.',
          offset,
          'MissingEqualsInHashLiteral'
        )
      const key = p
        .slice(0, eq)
        .trim()
        .replace(/^['"]|['"]$/g, '')
      const statements = parse(p.slice(eq + 1))
      const element = statements[0]?.pipeline.elements[0]
      if (!element || element.kind !== 'expr')
        throw new PsSyntaxError(
          'Expression manquante dans le littéral de hachage.',
          offset,
          'MissingHashValue'
        )
      return { key, value: element.expr }
    })
}

export function parse(source: string): Statement[] {
  const parser = new Parser(tokenize(source))
  return parser.parseStatements('eof')
}
