/**
 * Interpréteur PowerShell simulé : exécute les instructions, lie les paramètres,
 * enchaîne le pipeline et met en forme sortie et erreurs.
 */
import type { LabState } from '../../model/schema'
import { CommandFailure, ExecContext } from '../context'
import type { ToolDef } from '../tools/types'
import { NeedInput, type LineKind, type ShellSession } from '../types'
import { formatPsError, PsError, psError, type PsErrorInfo } from './errors'
import {
  arithmetic,
  comparison,
  MAX_ITERATIONS,
  formatOperator,
  indexValue,
  interpolate,
  memberValue,
  negate,
  range,
  toNumber
} from './operators'
import { formatDefault } from './format'
import { ESCAPED_DOLLAR, PsSyntaxError } from './lexer'
import {
  parse,
  type Arg,
  type Control,
  type Element,
  type Expr,
  type Pipeline,
  type Statement
} from './parser'
import { executeCmd } from '../cmd/interpreter'
import { isUnsimulated, iterationLimitMessage, unsimulatedMessage } from '../unsimulated'
import { COMMON_PARAMS, type BoundArgs, type CmdletDef, type ParamDef } from './registry'
import {
  psObject,
  flatten,
  isCredential,
  isPsObject,
  isScript,
  isSecure,
  psToBool,
  psToString,
  wildcardToRegExp,
  type PsScriptBlock,
  type PsValue
} from './values'

/** Catalogue des commandes disponibles pour l'interpréteur. */
export interface CommandCatalog {
  cmdlets: CmdletDef[]
  tools: ToolDef[]
  /** Commandes de la console bash (postes Linux). */
  bashTools: ToolDef[]
}

const TYPE_NAMES: Record<string, string> = {
  string: 'System.String',
  'string[]': 'System.String[]',
  int: 'System.Int32',
  bool: 'System.Boolean',
  switch: 'System.Management.Automation.SwitchParameter',
  secure: 'System.Security.SecureString',
  credential: 'System.Management.Automation.PSCredential',
  script: 'System.Management.Automation.ScriptBlock',
  any: 'System.Object'
}

/** Contexte passé aux cmdlets. */
export class CmdContext extends ExecContext {
  commandName = ''
  /** Confirmation désactivée (-Confirm:$false ou -Force). */
  skipConfirm = false
  /** Objet courant du pipeline ($_). */
  current: PsValue = null
  /** Sortie d'une instruction de contrôle en attente d'affichage (mise en forme groupée). */
  private sink: PsValue[] = []

  constructor(
    state: LabState,
    session: ShellSession,
    answers: string[],
    readonly catalog: CommandCatalog,
    readonly source: string
  ) {
    super(state, session, answers)
  }

  /** Demande de confirmation (ShouldProcess). */
  confirm(target: string, action?: string): boolean {
    if (this.skipConfirm) return true
    this.writeLines([
      '',
      'Confirmer',
      'Voulez-vous vraiment effectuer cette action ?',
      `Opération « ${action ?? this.commandName} » en cours sur la cible « ${target} ».`
    ])
    const answer = this.ask(
      '[O] Oui  [T] Oui pour tout  [N] Non  [U] Non pour tout  [S] Suspendre  [?] Aide (la valeur par défaut est « O ») : '
    )
      .trim()
      .toLowerCase()
    return answer === '' || answer === 'o' || answer === 't'
  }

  /** Valeur d'une variable ($true, $_, $env:…, variables de session). */
  variable(name: string): PsValue {
    const lower = name.toLowerCase()
    if (lower === 'true') return true
    if (lower === 'false') return false
    if (lower === 'null') return null
    if (lower === '_' || lower === 'psitem') return this.current
    if (lower === 'pwd') return this.session.cwd
    if (lower.startsWith('env:')) return this.envVariable(lower.slice(4))
    const key = Object.keys(this.session.variables).find((k) => k.toLowerCase() === lower)
    return key === undefined ? null : (this.session.variables[key] ?? null)
  }

  /** Affecte une variable de session (nom insensible à la casse : la clé existante est réutilisée). */
  setVariable(name: string, value: PsValue): void {
    const lower = name.toLowerCase()
    const key = Object.keys(this.session.variables).find((k) => k.toLowerCase() === lower) ?? name
    this.session = { ...this.session, variables: { ...this.session.variables, [key]: value } }
  }

  private envVariable(name: string): PsValue {
    const host = this.host
    const user = this.user
    const domainNetbios = host.host.domain ? (host.host.domain.split('.')[0]?.toUpperCase() ?? '') : null
    switch (name) {
      case 'computername':
        return host.name
      case 'username':
        return user.name
      case 'userdomain':
        return user.domain ?? host.name
      case 'userdnsdomain':
        return user.domain && host.host.domain ? host.host.domain.toUpperCase() : null
      case 'logonserver':
        // Contrôleur qui a authentifié la session (nom de l'ordinateur pour un compte local)
        return `\\\\${user.domain ? (host.host.session?.logonServer ?? domainNetbios ?? host.name) : host.name}`
      case 'userprofile':
        return `C:\\Users\\${user.name}`
      case 'systemroot':
      case 'windir':
        return 'C:\\Windows'
      default:
        return null
    }
  }

  /** Ajoute des objets au flux de sortie de la console. */
  emit(values: PsValue[]): void {
    this.sink.push(...values)
  }

  /** Affiche la sortie en attente (avant tout texte écrit directement : Write-Host, invite…). */
  flush(): void {
    if (this.sink.length === 0) return
    const values = this.sink
    this.sink = []
    super.writeLines(formatDefault(values))
  }

  override write(text: string, kind?: LineKind): void {
    this.flush()
    super.write(text, kind)
  }

  override writeLines(lines: string[], kind?: LineKind): void {
    this.flush()
    super.writeLines(lines, kind)
  }

  override ask(message: string, secure = false): string {
    this.flush()
    return super.ask(message, secure)
  }

  /** Exécute un bloc de script avec $_ = `item` (ForEach-Object, Where-Object) ; renvoie sa sortie. */
  invoke(script: PsScriptBlock, item: PsValue): PsValue[] {
    const previous = this.current
    this.current = item
    try {
      return runStatements(this, parse(script.source, script.offset ?? 0), this.source, 'collect')
    } finally {
      this.current = previous
    }
  }

  /** Teste une condition de bloc de script sur un objet ($_). */
  test(script: PsScriptBlock, item: PsValue): boolean {
    const values = this.invoke(script, item)
    return psToBool(values.length === 1 ? (values[0] as PsValue) : values)
  }
}

/** Trouve une cmdlet par nom ou alias (insensible à la casse). */
export function findCmdlet(catalog: CommandCatalog, name: string): CmdletDef | undefined {
  const lower = name.toLowerCase()
  return catalog.cmdlets.find(
    (c) => c.name.toLowerCase() === lower || (c.aliases ?? []).some((a) => a.toLowerCase() === lower)
  )
}

export function findTool(catalog: CommandCatalog, name: string): ToolDef | undefined {
  const lower = name.toLowerCase().replace(/\.exe$/, '')
  return catalog.tools.find((t) => t.name === lower)
}

// ---------------------------------------------------------------------------
// Évaluation des expressions
// ---------------------------------------------------------------------------

/**
 * Développe une chaîne entre guillemets doubles (about_Quoting_Rules) : `$nom`, `${nom}`,
 * `$env:NOM` et `$( … )` sont remplacés ; « $obj.Prop » ne développe que `$obj` (un accès
 * membre demande une sous-expression) ; une collection est rendue éléments séparés d'un espace.
 */
function expandString(ctx: CmdContext, text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const c = text[i] as string
    if (c !== '$') {
      out += c
      i++
      continue
    }
    if (text[i + 1] === '(') {
      let depth = 1
      let j = i + 2
      let quote: string | null = null
      while (j < text.length && depth > 0) {
        const d = text[j]
        if (quote) {
          if (d === quote) quote = null
        } else if (d === '"' || d === "'") quote = d
        else if (d === '(') depth++
        else if (d === ')') depth--
        j++
      }
      const inner = text.slice(i + 2, j - 1)
      out += interpolate(flatten(runStatements(ctx, parse(inner), inner, false)))
      i = j
      continue
    }
    if (text[i + 1] === '{') {
      const close = text.indexOf('}', i + 2)
      if (close > 0) {
        out += interpolate(ctx.variable(text.slice(i + 2, close)))
        i = close + 1
        continue
      }
    }
    const m = /^(env:[A-Za-z0-9_]+|[A-Za-z_][A-Za-z0-9_]*)/.exec(text.slice(i + 1))
    if (m) {
      out += interpolate(ctx.variable(m[0]))
      i += 1 + m[0].length
      continue
    }
    out += '$'
    i++
  }
  return out.split(ESCAPED_DOLLAR).join('$')
}

/** Erreur « construction non simulée » (message honnête, comme les commandes non simulées). */
function notSimulated(what: string, span: { start: number; end: number }): PsError {
  const err = psError(`${what} n’est pas simulé dans ServerLab.`, 'NotImplemented', 'NotSimulated')
  err.span = span
  return err
}

/** Exécute `f` ; une erreur PowerShell sans portion soulignée reçoit celle de l'expression. */
function withSpan<T>(span: { start: number; end: number }, f: () => T): T {
  try {
    return f()
  } catch (e) {
    if (e instanceof PsError && !e.span) e.span = { start: span.start, end: span.end }
    throw e
  }
}

function evalBinary(ctx: CmdContext, expr: Extract<Expr, { kind: 'binary' }>): PsValue {
  // -and / -or : évaluation court-circuitée (about_Logical_Operators)
  if (expr.op === 'and') return psToBool(evalExpr(ctx, expr.left)) && psToBool(evalExpr(ctx, expr.right))
  if (expr.op === 'or') return psToBool(evalExpr(ctx, expr.left)) || psToBool(evalExpr(ctx, expr.right))
  const left = evalExpr(ctx, expr.left)
  const right = evalExpr(ctx, expr.right)
  return withSpan(expr, () => {
    switch (expr.op) {
      case 'xor':
        return psToBool(left) !== psToBool(right)
      case '..':
        return range(left, right)
      case 'f':
        return formatOperator(left, right)
      case '+':
      case '-':
      case '*':
      case '/':
      case '%':
        return arithmetic(expr.op, left, right)
      default:
        return comparison(expr.op, left, right)
    }
  })
}

export function evalExpr(ctx: CmdContext, expr: Expr): PsValue {
  switch (expr.kind) {
    case 'number':
      return expr.value
    case 'string':
      return expr.expandable ? expandString(ctx, expr.value) : expr.value
    case 'variable': {
      let v = ctx.variable(expr.name)
      for (const m of expr.members) v = memberValue(v, m)
      return v
    }
    case 'array':
      return expr.items.map((i) => evalExpr(ctx, i))
    case 'script':
      return { kind: 'script', source: expr.source, offset: expr.offset ?? expr.start + 1 }
    case 'hash':
      return psObject(
        'System.Collections.Hashtable',
        Object.fromEntries(expr.entries.map((e) => [e.key, evalExpr(ctx, e.value)]))
      )
    case 'sub': {
      const only = expr.statements.length === 1 ? expr.statements[0] : undefined
      const inner =
        only && !only.assign && only.pipeline.elements.length === 1 ? only.pipeline.elements[0] : undefined
      if (expr.paren && inner?.kind === 'expr' && inner.expr.kind === 'incr') {
        let v = evalExpr(ctx, inner.expr)
        for (const m of expr.members) v = memberValue(v, m)
        return v
      }
      const values = flatten(runStatements(ctx, expr.statements, ctx.source, false))
      let v: PsValue = expr.array || values.length !== 1 ? values : (values[0] as PsValue)
      for (const m of expr.members) v = memberValue(v, m)
      return v
    }
    case 'binary':
      return evalBinary(ctx, expr)
    case 'unary': {
      const v = evalExpr(ctx, expr.operand)
      const op = expr.op
      return op === 'not' ? !psToBool(v) : withSpan(expr, () => negate(op, v))
    }
    case 'index': {
      const target = evalExpr(ctx, expr.target)
      const index = evalExpr(ctx, expr.index)
      return withSpan(expr, () => indexValue(target, index))
    }
    case 'member':
      return memberValue(evalExpr(ctx, expr.target), expr.name)
    case 'incr': {
      const before = ctx.variable(expr.name)
      const after = withSpan(expr, () => toNumber(before) + expr.delta)
      ctx.setVariable(expr.name, after)
      return expr.prefix ? after : (before ?? 0)
    }
    case 'unsupported':
      throw notSimulated(expr.what, expr)
  }
}

// ---------------------------------------------------------------------------
// Liaison des paramètres
// ---------------------------------------------------------------------------

interface ResolvedParam {
  def: ParamDef
  common: boolean
}

function resolveParam(def: CmdletDef, name: string): ResolvedParam | 'ambiguous' | null {
  const lower = name.toLowerCase()
  const all = [
    ...def.params.map((p) => ({ def: p, common: false })),
    ...COMMON_PARAMS.map((p) => ({ def: p, common: true }))
  ]
  const exact = all.find(
    (p) => p.def.name.toLowerCase() === lower || (p.def.aliases ?? []).some((a) => a.toLowerCase() === lower)
  )
  if (exact) return exact
  const prefix = all.filter((p) => p.def.name.toLowerCase().startsWith(lower))
  if (prefix.length === 1) return prefix[0] as ResolvedParam
  if (prefix.length > 1) return 'ambiguous'
  return null
}

function bindingError(
  ctx: CmdContext,
  message: string,
  errorId: string,
  span: { start: number; end: number },
  category = 'InvalidArgument'
): PsError {
  void ctx
  const err = psError(message, category, errorId, '', 'ParameterBindingException')
  err.span = span
  return err
}

/** Convertit une valeur vers le type attendu par le paramètre. */
function convert(
  ctx: CmdContext,
  p: ParamDef,
  value: PsValue,
  span: { start: number; end: number }
): PsValue {
  const transformError = (detail: string) =>
    bindingError(
      ctx,
      `Impossible de traiter la transformation d’argument sur le paramètre « ${p.name} ». ${detail}`,
      `ParameterArgumentTransformationError`,
      span
    )
  let result: PsValue
  switch (p.type) {
    case 'string':
      if (isSecure(value))
        throw transformError(
          `Impossible de convertir la valeur du type « System.Security.SecureString » en type « System.String ».`
        )
      // Tableau issu de virgules non protégées (OU=x,DC=y) : on le reconstitue
      result = Array.isArray(value) ? flatten(value).map(psToString).join(',') : psToString(value)
      break
    case 'string[]':
      result = (Array.isArray(value) ? flatten(value) : [value]).map(psToString)
      break
    case 'int': {
      const n = typeof value === 'number' ? value : Number(psToString(value))
      if (!Number.isInteger(n))
        throw transformError(
          `Impossible de convertir la valeur « ${psToString(value)} » en type « System.Int32 ». Erreur : « Le format de la chaîne d’entrée est incorrect. »`
        )
      result = n
      break
    }
    case 'bool':
    case 'switch':
      if (typeof value === 'boolean') result = value
      else if (typeof value === 'number') result = value !== 0
      else
        throw bindingError(
          ctx,
          `Impossible de traiter la transformation d’argument sur le paramètre « ${p.name} ». Impossible de convertir la valeur « ${psToString(value)} » en type « ${TYPE_NAMES[p.type]} ». Les paramètres booléens acceptent uniquement des valeurs booléennes et des nombres, tels que $True, $False, 1 ou 0.`,
          'ParameterArgumentTransformationError',
          span
        )
      break
    case 'secure':
      if (!isSecure(value))
        throw transformError(
          `Impossible de convertir la valeur « ${psToString(value)} » du type « System.String » en type « System.Security.SecureString ».`
        )
      result = value
      break
    case 'credential':
      if (isCredential(value)) result = value
      else {
        // Comme la console : un nom d'utilisateur seul déclenche la demande du mot de passe
        const user = psToString(value)
        const password = ctx.ask(`Mot de passe pour l’utilisateur ${user} : `, true)
        result = { kind: 'credential', user, password }
      }
      break
    case 'script':
      result = isScript(value) ? value : { kind: 'script', source: psToString(value) }
      break
    case 'any':
      result = value
      break
  }
  if (p.validateSet) {
    const values = Array.isArray(result) ? result : [result]
    const canonical = values.map((v) => {
      const match = p.validateSet?.find((s) => s.toLowerCase() === psToString(v).toLowerCase())
      if (!match)
        throw bindingError(
          ctx,
          `Impossible de valider l’argument sur le paramètre « ${p.name} ». L’argument « ${psToString(v)} » n’appartient pas au jeu « ${p.validateSet?.join(',')} » spécifié par l’attribut ValidateSet. Indiquez un argument figurant dans le jeu, puis réessayez la commande.`,
          'ParameterArgumentValidationError',
          span
        )
      return match
    })
    result = Array.isArray(result) ? canonical : (canonical[0] ?? null)
  }
  return result
}

function bind(
  ctx: CmdContext,
  def: CmdletDef,
  el: Extract<Element, { kind: 'command' }>,
  hasInput: boolean
): BoundArgs {
  const bound: BoundArgs = {}
  const spans: Record<string, { start: number; end: number }> = {}
  const positional: { value: PsValue; span: { start: number; end: number } }[] = []
  const args = el.args
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as Arg
    if (arg.kind === 'value') {
      positional.push({ value: evalExpr(ctx, arg.expr), span: arg })
      continue
    }
    const resolved = resolveParam(def, arg.name)
    if (resolved === 'ambiguous') {
      const candidates = def.params
        .filter((p) => p.name.toLowerCase().startsWith(arg.name.toLowerCase()))
        .map((p) => `-${p.name}`)
      throw bindingError(
        ctx,
        `Impossible de traiter le paramètre, car le nom de paramètre « ${arg.name} » est ambigu. Correspondances possibles : ${candidates.join(' ')}.`,
        'AmbiguousParameter',
        arg
      )
    }
    if (!resolved)
      throw bindingError(
        ctx,
        `Impossible de trouver un paramètre correspondant au nom « ${arg.name} ».`,
        'NamedParameterNotFound',
        arg
      )
    const p = resolved.def
    if (p.name in bound)
      throw bindingError(
        ctx,
        `Impossible de lier le paramètre, car le paramètre « ${p.name} » est spécifié plusieurs fois. Pour fournir plusieurs valeurs à des paramètres qui peuvent accepter plusieurs valeurs, utilisez la syntaxe de tableau.`,
        'ParameterAlreadyBound',
        arg
      )
    let value: PsValue
    if (p.type === 'switch') {
      value = arg.inline ? evalExpr(ctx, arg.inline) : true
    } else if (arg.inline) {
      value = evalExpr(ctx, arg.inline)
    } else {
      const next = args[i + 1]
      if (!next || next.kind === 'param')
        throw bindingError(
          ctx,
          `Argument manquant pour le paramètre « ${p.name} ». Spécifiez un paramètre de type « ${TYPE_NAMES[p.type]} » et réessayez.`,
          'MissingArgument',
          arg
        )
      value = evalExpr(ctx, next.expr)
      i++
    }
    bound[p.name] = convert(ctx, p, value, arg)
    spans[p.name] = arg
  }

  // Paramètres positionnels
  const byPosition = def.params
    .filter((p) => p.position !== undefined)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
  for (const item of positional) {
    const target = byPosition.find((p) => !(p.name in bound))
    if (!target)
      throw bindingError(
        ctx,
        `Impossible de trouver un paramètre positionnel acceptant l’argument « ${psToString(item.value)} ».`,
        'PositionalParameterNotFound',
        item.span
      )
    bound[target.name] = convert(ctx, target, item.value, item.span)
  }

  // Paramètres obligatoires manquants : la console les demande, comme PowerShell
  let header = false
  for (const p of def.params) {
    if (!p.mandatory || p.name in bound || (p.pipeline && hasInput)) continue
    if (!header) {
      ctx.writeLines([
        `applet de commande ${def.name} à la position 1 du pipeline de la commande`,
        'Fournissez des valeurs pour les paramètres suivants :'
      ])
      header = true
    }
    const secure = p.type === 'secure'
    const answer = ctx.ask(`${p.name}: `, secure)
    if (secure && p.confirm) {
      const again = ctx.ask(`Confirmer ${p.name}: `, true)
      if (again !== answer)
        throw psError('Les mots de passe ne correspondent pas.', 'InvalidArgument', 'PasswordMismatch')
    }
    if (answer.trim() === '' && !secure)
      throw bindingError(
        ctx,
        `Impossible de lier l’argument au paramètre « ${p.name} », car il s’agit d’une chaîne vide.`,
        'ParameterArgumentValidationErrorEmptyStringNotAllowed',
        el,
        'InvalidData'
      )
    const raw: PsValue = secure
      ? { kind: 'secure', value: answer }
      : p.type === 'string[]'
        ? answer.split(',').map((s) => s.trim())
        : answer
    bound[p.name] = p.type === 'credential' ? convert(ctx, p, answer, el) : convert(ctx, p, raw, el)
  }
  return bound
}

// ---------------------------------------------------------------------------
// Exécution
// ---------------------------------------------------------------------------

function commandNotFound(name: string, span: { start: number; end: number }): PsError {
  const err = psError(
    `Le terme «${name}» n'est pas reconnu comme nom d'applet de commande, fonction, fichier de script ou programme exécutable. Vérifiez l'orthographe du nom, ou si un chemin d'accès existe, vérifiez que le chemin d'accès est correct et réessayez.`,
    'ObjectNotFound',
    'CommandNotFoundException',
    name,
    'CommandNotFoundException'
  )
  err.span = span
  err.command = name
  return err
}

/**
 * Valeur liée depuis le pipeline : un objet AD (ADUser, ADGroup…) se désigne par son
 * nom unique, comme le fait l'identité d'un objet Active Directory reçu par valeur.
 */
function pipelineIdentity(item: PsValue): PsValue {
  if (isPsObject(item)) {
    const dn = item.props['DistinguishedName']
    if (dn !== undefined && dn !== null) return dn
  }
  return item
}

function runCommand(ctx: CmdContext, el: Extract<Element, { kind: 'command' }>, input: PsValue[]): PsValue[] {
  const def = findCmdlet(ctx.catalog, el.name)
  if (def && (def.available?.(ctx) ?? true)) {
    ctx.commandName = def.name
    const args = bind(ctx, def, el, input.length > 0)
    ctx.skipConfirm = args['Confirm'] === false || args['Force'] === true
    // Liaison ByValue (« Value from pipeline: True ») d'un paramètre typé non lié :
    // la cmdlet s'exécute une fois par objet reçu, le paramètre valant cet objet.
    // Les paramètres de type 'any' reçoivent toujours l'entrée via `input`.
    const byValue = def.params.find((p) => p.pipeline && p.type !== 'any' && !(p.name in args))
    if (byValue && input.length > 0) {
      const out: PsValue[] = []
      for (const item of input) {
        const bound = { ...args, [byValue.name]: convert(ctx, byValue, pipelineIdentity(item), el) }
        const result = def.run(ctx, bound, [])
        if (result) out.push(...flatten(result))
      }
      return out
    }
    const result = def.run(ctx, args, input)
    return result ? flatten(result) : []
  }
  const nativeArgs = () =>
    el.args.map((a) => {
      if (a.kind === 'param') return a.text
      const v = evalExpr(ctx, a.expr)
      return Array.isArray(v) ? flatten(v).map(psToString).join(',') : psToString(v)
    })
  const tool = findTool(ctx.catalog, el.name)
  if (tool && (tool.available?.(ctx) ?? true)) {
    ctx.commandName = el.name
    const args = nativeArgs()
    return captureNative(ctx, () => tool.run(ctx, args))
  }
  if (el.name.toLowerCase().replace(/\.exe$/, '') === 'cmd') {
    // cmd /c <commande> : exécutée par l'invite de commandes simulée, sortie renvoyée en texte
    const args = nativeArgs()
    const c = args.findIndex((a) => a.toLowerCase() === '/c')
    if (c < 0)
      throw notSimulated(
        'L’invite de commandes interactive lancée depuis PowerShell (utilisez cmd /c <commande>)',
        el
      )
    const line = args
      .slice(c + 1)
      .map((a) => (/\s/.test(a) ? `"${a}"` : a))
      .join(' ')
    ctx.commandName = 'cmd'
    return captureNative(ctx, () => executeCmd(ctx, line, ctx.catalog.tools))
  }
  if (isUnsimulated('ps', el.name))
    throw psError(unsimulatedMessage('ps', el.name), 'NotImplemented', 'CommandNotSimulated', el.name)
  throw commandNotFound(el.name, { start: el.start, end: el.start + el.name.length })
}

/**
 * Exécutable lancé depuis PowerShell (ipconfig, ping, cmd /c …) : sa sortie standard devient des
 * chaînes, une par ligne, que le pipeline peut filtrer ou affecter (commandes
 * natives, about_Pipelines) ; les lignes d'erreur restent affichées telles quelles.
 */
function captureNative(ctx: CmdContext, run: () => void): PsValue[] {
  ctx.flush()
  const start = ctx.output.length
  run()
  const lines = ctx.output.splice(start)
  const values: string[] = []
  for (const line of lines) {
    if (line.kind === 'out') values.push(line.text)
    else ctx.output.push(line)
  }
  return values
}

function runPipeline(ctx: CmdContext, pipeline: Pipeline): PsValue[] {
  let values: PsValue[] = []
  pipeline.elements.forEach((el, index) => {
    if (el.kind === 'expr') {
      if (index > 0) {
        const err = psError(
          'Les expressions ne sont autorisées qu’en tant que premier élément d’un pipeline.',
          'ParserError',
          'ExpressionsMustBeFirstInPipeline'
        )
        err.span = el
        throw err
      }
      const v = evalExpr(ctx, el.expr)
      values = Array.isArray(v) ? flatten(v) : v === null ? [] : [v]
    } else {
      values = runCommand(ctx, el, values)
    }
  })
  return values
}

/**
 * Mode d'exécution d'une suite d'instructions :
 *  - `display` : instructions saisies à l'invite, sortie mise en forme et affichée ;
 *  - `stream`  : corps d'une instruction de contrôle affichée, sortie envoyée au flux de la console
 *                (une erreur arrête l'instruction en cours, pas la boucle) ;
 *  - `collect` : sous-expression ou bloc de script, sortie renvoyée, erreurs propagées.
 */
type RunMode = 'display' | 'stream' | 'collect'

/** break / continue (about_Break, about_Continue) : remonte jusqu'à la boucle ou au switch. */
class LoopSignal extends Error {
  constructor(readonly kind: 'break' | 'continue') {
    super(kind)
  }
}

/** Limite d'itérations du simulateur atteinte : arrête toute l'instruction de premier niveau. */
class IterationLimit extends PsError {}

function iterationLimit(keyword: string, st: Statement): IterationLimit {
  const err = new IterationLimit({
    message: iterationLimitMessage(keyword, MAX_ITERATIONS),
    category: 'NotImplemented',
    errorId: 'IterationLimitReached'
  })
  err.span = { start: st.start, end: st.end }
  return err
}

/** Valeur d'une condition : la sortie de l'instruction, convertie en booléen. */
function condition(ctx: CmdContext, st: Statement): boolean {
  const values = runStatements(ctx, [st], ctx.source, 'collect')
  return psToBool(values.length === 1 ? (values[0] as PsValue) : values)
}

/** Corps d'une boucle : renvoie `false` si un break l'a interrompue. */
function loopBody(ctx: CmdContext, body: Statement[], mode: RunMode, out: PsValue[]): boolean {
  try {
    out.push(...runStatements(ctx, body, ctx.source, mode))
    return true
  } catch (e) {
    if (e instanceof LoopSignal) return e.kind === 'continue'
    throw e
  }
}

/** Bloc d'action d'un switch : indique si un break ou un continue l'a interrompu. */
function clauseBody(
  ctx: CmdContext,
  body: Statement[],
  mode: RunMode,
  out: PsValue[]
): 'ok' | 'break' | 'continue' {
  try {
    out.push(...runStatements(ctx, body, ctx.source, mode))
    return 'ok'
  } catch (e) {
    if (e instanceof LoopSignal) return e.kind
    throw e
  }
}

/** Correspondance d'une clause de switch (valeurs converties en chaînes, about_Switch). */
function switchMatches(
  ctx: CmdContext,
  ctl: Extract<Control, { kind: 'switch' }>,
  match: Expr,
  item: PsValue
): boolean {
  if (match.kind === 'script')
    return ctx.test({ kind: 'script', source: match.source, offset: match.offset }, item)
  const pattern = psToString(evalExpr(ctx, match))
  const value = psToString(item)
  switch (ctl.mode) {
    case 'wildcard': {
      const re = wildcardToRegExp(pattern)
      return new RegExp(re.source, ctl.caseSensitive ? '' : 'i').test(value)
    }
    case 'regex': {
      // $Matches reçoit les groupes de la correspondance (about_Switch, about_Automatic_Variables)
      const m = new RegExp(pattern, ctl.caseSensitive ? '' : 'i').exec(value)
      if (m)
        ctx.setVariable(
          'Matches',
          psObject(
            'System.Collections.Hashtable',
            Object.fromEntries(m.map((g, i) => [String(i), g ?? null]))
          )
        )
      return m !== null
    }
    default:
      return ctl.caseSensitive ? value === pattern : value.toLowerCase() === pattern.toLowerCase()
  }
}

function runControl(ctx: CmdContext, st: Statement, ctl: Control, mode: RunMode): PsValue[] {
  const out: PsValue[] = []
  switch (ctl.kind) {
    case 'break':
    case 'continue':
      throw new LoopSignal(ctl.kind)
    case 'if': {
      for (const clause of ctl.clauses) {
        if (condition(ctx, clause.condition)) return runStatements(ctx, clause.body, ctx.source, mode)
      }
      return ctl.otherwise ? runStatements(ctx, ctl.otherwise, ctx.source, mode) : []
    }
    case 'foreach': {
      // La collection est évaluée une fois ; $null ne produit aucune itération (about_Foreach)
      const items = flatten(runStatements(ctx, [ctl.collection], ctx.source, 'collect'))
      if (items.length > MAX_ITERATIONS) throw iterationLimit('foreach', st)
      for (const item of items) {
        ctx.setVariable(ctl.variable, item)
        if (!loopBody(ctx, ctl.body, mode, out)) break
      }
      return out
    }
    case 'for': {
      if (ctl.init) runStatements(ctx, [ctl.init], ctx.source, 'collect')
      let count = 0
      while (!ctl.condition || condition(ctx, ctl.condition)) {
        if (++count > MAX_ITERATIONS) throw iterationLimit('for', st)
        if (!loopBody(ctx, ctl.body, mode, out)) break
        if (ctl.repeat) runStatements(ctx, [ctl.repeat], ctx.source, 'collect')
      }
      return out
    }
    case 'while': {
      let count = 0
      while (condition(ctx, ctl.condition)) {
        if (++count > MAX_ITERATIONS) throw iterationLimit('while', st)
        if (!loopBody(ctx, ctl.body, mode, out)) break
      }
      return out
    }
    case 'switch': {
      // Une collection est traitée élément par élément ; toutes les clauses sont testées (about_Switch)
      const values = runStatements(ctx, [ctl.subject], ctx.source, 'collect')
      const items = values.length === 0 ? [null] : flatten(values)
      const previous = ctx.current
      try {
        for (const item of items) {
          ctx.current = item
          let matched = false
          let signal: 'ok' | 'break' | 'continue' = 'ok'
          for (const clause of ctl.clauses) {
            if (clause.match === null || !switchMatches(ctx, ctl, clause.match, item)) continue
            matched = true
            signal = clauseBody(ctx, clause.body, mode, out)
            if (signal !== 'ok') break
          }
          if (!matched) {
            const fallback = ctl.clauses.find((c) => c.match === null)
            if (fallback) signal = clauseBody(ctx, fallback.body, mode, out)
          }
          // break quitte le switch, continue passe à la valeur suivante
          if (signal === 'break') break
        }
      } finally {
        ctx.current = previous
      }
      return out
    }
  }
}

function runStatement(ctx: CmdContext, st: Statement, mode: RunMode): PsValue[] {
  if (st.control) return runControl(ctx, st, st.control, mode === 'collect' ? 'collect' : 'stream')
  const single = st.pipeline.elements.length === 1 ? st.pipeline.elements[0] : undefined
  if (st.assign) {
    // Une expression seule est affectée telle quelle (@(5) reste un tableau) ;
    // un pipeline renvoie un objet ou un tableau d'objets
    let value: PsValue
    if (single?.kind === 'expr') value = evalExpr(ctx, single.expr)
    else {
      const values = runPipeline(ctx, st.pipeline)
      value = values.length === 1 ? (values[0] as PsValue) : values
    }
    if (st.assignOp) {
      const op = st.assignOp.slice(0, 1)
      const current = ctx.variable(st.assign)
      value = withSpan(st.pipeline, () => arithmetic(op, current, value))
    }
    ctx.setVariable(st.assign, value)
    return []
  }
  // « $i++ » seul est une instruction sans sortie (about_Assignment_Operators)
  if (single?.kind === 'expr' && single.expr.kind === 'incr') {
    evalExpr(ctx, single.expr)
    return []
  }
  return runPipeline(ctx, st.pipeline)
}

/** Exécute des instructions ; `true` : affichées à l'invite, `false` : sortie renvoyée. */
function runStatements(
  ctx: CmdContext,
  statements: Statement[],
  source: string,
  modeOrDisplay: RunMode | boolean
): PsValue[] {
  const mode: RunMode =
    modeOrDisplay === true ? 'display' : modeOrDisplay === false ? 'collect' : modeOrDisplay
  const collected: PsValue[] = []
  for (const st of statements) {
    if (mode === 'display') ctx.commandName = ''
    try {
      const values = runStatement(ctx, st, mode)
      if (mode === 'collect') collected.push(...values)
      else ctx.emit(values)
      if (mode === 'display') ctx.flush()
    } catch (e) {
      if (mode === 'collect' || e instanceof NeedInput) throw e
      if (e instanceof LoopSignal) {
        if (mode === 'stream') throw e
        // break / continue hors d'une boucle : la suite de la ligne n'est pas exécutée
        ctx.flush()
        break
      }
      if (e instanceof IterationLimit && mode === 'stream') throw e
      ctx.flush()
      reportError(ctx, e, source, st)
    }
  }
  return collected
}

function reportError(ctx: CmdContext, e: unknown, source: string, st: Statement): void {
  if (e instanceof NeedInput) throw e
  let info: PsErrorInfo
  let span: { start: number; end: number } = st.pipeline
  let command: string | null = ctx.commandName || null
  if (e instanceof PsError) {
    info = e.info
    if (e.span) span = e.span
    if (e.command) command = e.command
  } else if (e instanceof CommandFailure) {
    info = {
      message: e.message,
      category: e.category,
      errorId: e.code,
      exception: 'InvalidOperationException',
      ...(e.target !== undefined ? { target: e.target } : {})
    }
  } else if (e instanceof PsSyntaxError) {
    ctx.writeLines(formatParseError(source, e), 'error')
    return
  } else {
    throw e
  }
  ctx.writeLines(formatPsError(info, source, span, command), 'error')
}

function formatParseError(source: string, e: PsSyntaxError): string[] {
  return [
    `Au caractère Ligne:1 : ${e.position + 1}`,
    `+ ${source}`,
    `+ ${' '.repeat(e.position)}~`,
    e.message,
    '    + CategoryInfo          : ParserError: (:) [], ParentContainsErrorRecordException',
    `    + FullyQualifiedErrorId : ${e.errorId}`,
    ''
  ]
}

/** Exécute une ligne PowerShell. */
export function executePowerShell(ctx: CmdContext, line: string): void {
  let statements: Statement[]
  try {
    statements = parse(line)
  } catch (e) {
    if (e instanceof PsSyntaxError) {
      ctx.writeLines(formatParseError(line, e), 'error')
      return
    }
    throw e
  }
  runStatements(ctx, statements, line, true)
}

export { isPsObject }
