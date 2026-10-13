/**
 * Interpréteur PowerShell simulé : exécute les instructions, lie les paramètres,
 * enchaîne le pipeline et met en forme sortie et erreurs.
 */
import type { LabState } from '../../model/schema'
import { CommandFailure, ExecContext } from '../context'
import type { ToolDef } from '../tools/types'
import { NeedInput, type ShellSession } from '../types'
import { formatPsError, PsError, psError, type PsErrorInfo } from './errors'
import { evaluateExpression } from './expression'
import { formatDefault } from './format'
import { PsSyntaxError } from './lexer'
import { parse, type Arg, type Element, type Expr, type Pipeline, type Statement } from './parser'
import { isUnsimulated, unsimulatedMessage } from '../unsimulated'
import { COMMON_PARAMS, type BoundArgs, type CmdletDef, type ParamDef } from './registry'
import {
  psObject,
  flatten,
  getProp,
  isCredential,
  isPsObject,
  isScript,
  isSecure,
  psToBool,
  psToString,
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

  /** Teste une condition de bloc de script sur un objet ($_). */
  test(script: string, item: PsValue): boolean {
    const previous = this.current
    this.current = item
    try {
      return psToBool(
        evaluateExpression(script, {
          variable: (n) => this.variable(n),
          bare: (w) => w
        })
      )
    } finally {
      this.current = previous
    }
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

function expandString(ctx: CmdContext, text: string): string {
  // $(sous-expression), $env:NOM, $nom
  return text
    .replace(/\$\(([^)]*)\)/g, (_m, inner: string) => {
      const values = runStatements(ctx, parse(inner), inner, false)
      return flatten(values).map(psToString).join(' ')
    })
    .replace(/\$(env:[A-Za-z_]+|[A-Za-z_][A-Za-z0-9_]*)/g, (_m, name: string) =>
      psToString(ctx.variable(name))
    )
}

function evalExpr(ctx: CmdContext, expr: Expr): PsValue {
  switch (expr.kind) {
    case 'number':
      return expr.value
    case 'string':
      return expr.expandable ? expandString(ctx, expr.value) : expr.value
    case 'variable': {
      let v = ctx.variable(expr.name)
      for (const m of expr.members) v = getProp(v, m)
      return v
    }
    case 'array':
      return expr.items.map((i) => evalExpr(ctx, i))
    case 'script':
      return { kind: 'script', source: expr.source }
    case 'hash':
      return psObject(
        'System.Collections.Hashtable',
        Object.fromEntries(expr.entries.map((e) => [e.key, evalExpr(ctx, e.value)]))
      )
    case 'sub': {
      const values = flatten(runStatements(ctx, expr.statements, ctx.source, false))
      let v: PsValue = values.length === 1 ? (values[0] as PsValue) : values
      for (const m of expr.members) v = Array.isArray(v) ? v.map((x) => getProp(x, m)) : getProp(v, m)
      return v
    }
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

function runCommand(ctx: CmdContext, el: Extract<Element, { kind: 'command' }>, input: PsValue[]): PsValue[] {
  const def = findCmdlet(ctx.catalog, el.name)
  if (def && (def.available?.(ctx) ?? true)) {
    ctx.commandName = def.name
    const args = bind(ctx, def, el, input.length > 0)
    ctx.skipConfirm = args['Confirm'] === false || args['Force'] === true
    const result = def.run(ctx, args, input)
    return result ? flatten(result) : []
  }
  const tool = findTool(ctx.catalog, el.name)
  if (tool && (tool.available?.(ctx) ?? true)) {
    ctx.commandName = el.name
    const args = el.args.map((a) => {
      if (a.kind === 'param') return a.text
      const v = evalExpr(ctx, a.expr)
      return Array.isArray(v) ? flatten(v).map(psToString).join(',') : psToString(v)
    })
    tool.run(ctx, args)
    return []
  }
  if (isUnsimulated('ps', el.name))
    throw psError(unsimulatedMessage('ps', el.name), 'NotImplemented', 'CommandNotSimulated', el.name)
  throw commandNotFound(el.name, { start: el.start, end: el.start + el.name.length })
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

/** Exécute des instructions ; si `display`, les résultats sont affichés (sinon renvoyés). */
function runStatements(
  ctx: CmdContext,
  statements: Statement[],
  source: string,
  display: boolean
): PsValue[] {
  const collected: PsValue[] = []
  for (const st of statements) {
    if (display) ctx.commandName = ''
    try {
      const values = runPipeline(ctx, st.pipeline)
      if (st.assign) {
        const value: PsValue = values.length === 1 ? (values[0] as PsValue) : values
        ctx.session = { ...ctx.session, variables: { ...ctx.session.variables, [st.assign]: value } }
      } else if (display) {
        ctx.writeLines(formatDefault(values))
      } else {
        collected.push(...values)
      }
    } catch (e) {
      if (!display) throw e
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
