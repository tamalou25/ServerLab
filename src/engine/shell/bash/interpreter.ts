/**
 * Console bash simulée des postes Linux (Ubuntu) : découpage façon shell (guillemets simples et
 * doubles, échappement), listes ; && ||, préfixe sudo (droits root), tube vers grep, commandes intégrées (cd,
 * pwd, echo, clear, exit, help) puis commandes du système de base et des modules de rôles.
 * Les outils affichent leurs messages d'origine, non traduits (locale C).
 */
import { CommandFailure, type ExecContext } from '../context'
import { leaveSu, sudoPrefix } from './accounts'
import { errnoText, linesToText, putFile, readLocal, underMount, writeError } from './filetools'
import {
  actor,
  bashUser,
  canTraverse,
  cloneFiles,
  commitFiles,
  hasPerm,
  homeDir,
  linuxFiles,
  resolvePath
} from './linuxfs'
import type { ToolDef } from '../tools/types'
import {
  isUnsimulated,
  unsimulatedMessage,
  unsimulatedOptionMessage,
  unsimulatedSyntaxMessage
} from '../unsimulated'

/** Découpe une commande façon bash ; null si un guillemet n'est pas refermé. */
export function splitBashArgs(line: string): string[] | null {
  const args: string[] = []
  let current = ''
  let has = false
  let quote: '"' | "'" | null = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < line.length) current += line[++i]
      else current += c
    } else if (c === '"' || c === "'") {
      quote = c
      has = true
    } else if (c === '\\' && i + 1 < line.length) {
      current += line[++i]
      has = true
    } else if (c === ' ' || c === '\t') {
      if (has) args.push(current)
      current = ''
      has = false
    } else {
      current += c
      has = true
    }
  }
  if (quote) return null
  if (has) args.push(current)
  return args
}

/** Découpe sur les tubes `|` hors guillemets et hors échappement. */
function splitPipes(line: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote: string | null = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < line.length) {
        current += c + line[++i]
        continue
      }
    } else if (c === '"' || c === "'") quote = c
    else if (c === '\\' && i + 1 < line.length) {
      current += c + line[++i]
      continue
    } else if (c === '|') {
      parts.push(current)
      current = ''
      continue
    }
    current += c
  }
  parts.push(current)
  return parts
}

/** Opérateur de liste : `;` toujours, `&&` si succès, `||` si échec (associativité gauche). */
type ListOp = ';' | '&&' | '||'

interface ListItem {
  /** Opérateur qui précède ce pipeline (null pour le premier). */
  op: ListOp | null
  text: string
}

/** Mots réservés ou constructions de script que la console ne simule pas (début de commande). */
const RESERVED_WORDS = [
  'for',
  'while',
  'until',
  'if',
  'case',
  'select',
  'function',
  'then',
  'else',
  'elif',
  'fi',
  'do',
  'done',
  'esac',
  '{',
  '}',
  '[['
]

/**
 * Découpe une ligne en pipelines reliés par `;`, `&&` et `||` hors guillemets (bash(1), « Lists of
 * Commands »). Toute construction non simulée donne une erreur explicite plutôt qu'une sortie fausse.
 */
export function parseCommandList(line: string): { items: ListItem[] } | { error: string } {
  const unsupported = (what: string) => ({ error: unsimulatedSyntaxMessage(what) })
  const items: ListItem[] = []
  let current = ''
  let op: ListOp | null = null
  let quote: '"' | "'" | null = null
  const push = (next: ListOp) => {
    items.push({ op, text: current })
    current = ''
    op = next
  }
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string
    const two = line.slice(i, i + 2)
    if (quote === "'") {
      if (c === "'") quote = null
    } else if (quote === '"') {
      if (c === '"') quote = null
      else if (c === '\\' && i + 1 < line.length) {
        current += c + line[++i]
        continue
      } else if (c === '`') return unsupported('`commande`')
      else if (two === '$(') return unsupported('$(commande)')
    } else if (c === '"' || c === "'") quote = c
    else if (c === '\\' && i + 1 < line.length) {
      current += c + line[++i]
      continue
    } else if (c === '`') return unsupported('`commande`')
    else if (two === '$(') return unsupported('$(commande)')
    else if (two === '<<') return unsupported('<< (document en ligne)')
    else if (c === '(' || c === ')') return unsupported('( ) (sous-shell)')
    else if (two === '&&' || two === '||') {
      push(two)
      i++
      continue
    } else if (c === '&') return unsupported('& (arrière-plan)')
    else if (c === ';') {
      if (line[i + 1] === ';') return unsupported(';; (fin de cas)')
      push(';')
      continue
    }
    current += c
  }
  if (quote) return { error: 'bash: unexpected EOF while looking for matching quote' }
  items.push({ op, text: current })
  // Commandes vides : « && b », « a && && b », « a && » (bash attend la suite) ; « a ; » reste valable
  for (const [i, item] of items.entries()) {
    if (item.text.trim() !== '' || items.length === 1) continue
    const last = i === items.length - 1
    if (last && item.op === ';') continue
    const token = i === 0 ? (items[1]?.op as string) : last ? 'newline' : (items[i + 1]?.op as string)
    return { error: `bash: syntax error near unexpected token \`${token}'` }
  }
  for (const item of items)
    for (const stage of splitPipes(item.text)) {
      const word = stage.trim().split(/\s+/)[0] ?? ''
      if (RESERVED_WORDS.includes(word)) return unsupported(word)
    }
  return { items: items.filter((it) => it.text.trim() !== '') }
}

/** Remplace `$?` (statut de la commande précédente) hors guillemets simples et hors échappement. */
function expandStatus(text: string, status: number): string {
  let out = ''
  let quote: string | null = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string
    if (quote === "'") {
      if (c === "'") quote = null
    } else if (c === '\\' && i + 1 < text.length) {
      out += c + text[++i]
      continue
    } else if (c === '"') quote = quote === '"' ? null : '"'
    else if (c === "'" && quote === null) quote = "'"
    else if (c === '$' && text[i + 1] === '?') {
      out += String(status)
      i++
      continue
    }
    out += c
  }
  return out
}

export { homeDir, resolvePath }

/** Invite bash : etudiant@LNX1:~/docs$ (root : #). */
export function bashPrompt(ctx: { host: string; user: string; cwd: string }): string {
  const home = ctx.user === 'root' ? '/root' : `/home/${ctx.user}`
  const where =
    ctx.cwd === home ? '~' : ctx.cwd.startsWith(`${home}/`) ? `~${ctx.cwd.slice(home.length)}` : ctx.cwd
  return `${ctx.user}@${ctx.host}:${where}${ctx.user === 'root' ? '#' : '$'} `
}

/** Dossier local existant (arborescence simulée ou point de montage). */
export function isLocalDir(ctx: ExecContext, path: string): boolean {
  return linuxFiles(ctx)[path]?.type === 'dir' || underMount(ctx, path)
}

export const BASH_BUILTINS = ['cd', 'pwd', 'echo', 'clear', 'exit', 'help', 'sudo'] as const

function runCommand(ctx: ExecContext, args: string[], tools: ToolDef[]): void {
  let [name = '', ...rest] = args
  let viaSudo = false
  if (name === 'sudo') {
    // Règle /etc/sudoers (groupe sudo) et mot de passe vérifiés ; la commande s'exécute en root
    const next = sudoPrefix(ctx, rest)
    if (next === null) return
    viaSudo = true
    ;[name = '', ...rest] = next
  }
  switch (name) {
    case 'cd': {
      const arg = rest[0] ?? '~'
      const target = resolvePath(ctx, arg)
      const files = linuxFiles(ctx)
      const node = files[target]
      if (!node && !underMount(ctx, target))
        throw new CommandFailure(`bash: cd: ${arg}: No such file or directory`, 'NotFound')
      if (node && node.type !== 'dir')
        throw new CommandFailure(`bash: cd: ${arg}: Not a directory`, 'NotADirectory')
      if (node && !(canTraverse(files, actor(ctx), target) && hasPerm(files, actor(ctx), node, 1)))
        throw new CommandFailure(`bash: cd: ${arg}: Permission denied`, 'AccessDenied')
      ctx.session = { ...ctx.session, cwd: target }
      return
    }
    case 'pwd':
      ctx.write(ctx.session.cwd)
      return
    case 'echo': {
      const noNewline = rest[0] === '-n'
      ctx.write((noNewline ? rest.slice(1) : rest).join(' '))
      return
    }
    case 'clear':
      ctx.clear = true
      return
    case 'exit':
      // Dans une session ouverte par su, exit revient à l'utilisateur précédent
      if (!leaveSu(ctx)) ctx.exit = true
      return
    case 'help':
      ctx.writeLines([
        'Commandes simulées (Ubuntu, sorties d’origine en anglais) :',
        ...[...tools]
          .filter((t) => t.available?.(ctx) ?? true)
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((t) => `  ${t.name.padEnd(12)}${t.synopsis}`),
        `  ${'cd, pwd'.padEnd(12)}Change de dossier, affiche le dossier courant.`,
        `  ${'clear'.padEnd(12)}Efface l’écran.`,
        `  ${'sudo'.padEnd(12)}Exécute une commande avec les droits root.`,
        ''
      ])
      return
    case 'grep':
      // grep motif fichier (hors tube) ; sans fichier, le comportement historique est conservé
      grepFiles(ctx, rest)
      return
    default:
      break
  }
  const tool = tools.find((t) => t.name === name)
  if (!tool || !(tool.available?.(ctx) ?? true)) {
    ctx.status = 127
    ctx.write(
      isUnsimulated('bash', name)
        ? unsimulatedMessage('bash', name)
        : `${viaSudo ? 'sudo: ' : ''}${name}: command not found`,
      'error'
    )
    return
  }
  tool.run(ctx, rest)
}

interface GrepOptions {
  ignore: boolean
  invert: boolean
  count: boolean
  number: boolean
  /** Premier opérande : le motif ; les suivants : les fichiers. */
  operands: string[]
}

/**
 * Options de grep(1) simulées : -i, -v, -c, -n (combinables : -ci, -nv…). Toute autre option réelle
 * est refusée explicitement, jamais ignorée ni traitée comme un motif.
 */
function parseGrepOptions(args: string[]): GrepOptions {
  const o: GrepOptions = { ignore: false, invert: false, count: false, number: false, operands: [] }
  for (const a of args) {
    if (a === '--' || !a.startsWith('-') || a === '-') {
      o.operands.push(a)
      continue
    }
    if (a.startsWith('--')) throw new CommandFailure(unsimulatedOptionMessage('grep', a), 'NotSupported')
    for (const c of a.slice(1)) {
      if (c === 'i') o.ignore = true
      else if (c === 'v') o.invert = true
      else if (c === 'c') o.count = true
      else if (c === 'n') o.number = true
      else throw new CommandFailure(unsimulatedOptionMessage('grep', `-${c}`), 'NotSupported')
    }
  }
  return o
}

/** Applique grep à des lignes : lignes sélectionnées avec leur numéro (base 1). */
function grepSelect(o: GrepOptions, lines: string[]): { n: number; line: string }[] {
  const needle = o.ignore ? (o.operands[0] ?? '').toLowerCase() : (o.operands[0] ?? '')
  const kept: { n: number; line: string }[] = []
  for (const [k, line] of lines.entries()) {
    const hay = o.ignore ? line.toLowerCase() : line
    if (hay.includes(needle) !== o.invert) kept.push({ n: k + 1, line })
  }
  return kept
}

/** Texte d'une sortie grep : compte (-c) ou lignes, préfixées du fichier et du numéro (-n). */
function grepFormat(o: GrepOptions, kept: { n: number; line: string }[], prefix: string): string[] {
  if (o.count) return [`${prefix}${kept.length}`]
  return kept.map((k) => `${prefix}${o.number ? `${k.n}:` : ''}${k.line}`)
}

/** grep [-i] [-v] [-c] [-n] motif fichier… (hors tube) ; statut 0/1 (aucune ligne)/2 (erreur). */
function grepFiles(ctx: ExecContext, args: string[]): void {
  const o = parseGrepOptions(args)
  if (o.operands.length === 0) {
    ctx.status = 2
    ctx.write('Usage: grep [OPTION]... PATTERNS [FILE]...', 'error')
    return
  }
  const paths = o.operands.slice(1)
  if (paths.length === 0) {
    // Sans fichier le vrai grep lit l'entrée standard : aucune entrée dans cette console
    ctx.status = 2
    ctx.write(
      'grep: lecture de l’entrée standard non simulée : indiquez un fichier ou utilisez un tube',
      'error'
    )
    return
  }
  let matched = false
  let failed = false
  for (const path of paths) {
    const text = readLocal(ctx, 'grep', path)
    if (text === null) {
      failed = true
      continue
    }
    const lines = text.split('\n')
    // Un fichier terminé par un saut de ligne n'a pas de dernière ligne vide
    if (lines[lines.length - 1] === '') lines.pop()
    const kept = grepSelect(o, lines)
    if (kept.length > 0) matched = true
    ctx.writeLines(grepFormat(o, kept, paths.length > 1 ? `${path}:` : ''))
  }
  ctx.status = failed ? 2 : matched ? 0 : 1
}

/** Filtre de tube : grep [-i] [-v] [-c] [-n] motif ; statut 1 si aucune ligne sélectionnée. */
function applyGrep(ctx: ExecContext, from: number, args: string[]): void {
  const o = parseGrepOptions(args)
  if (o.operands.length === 0) {
    ctx.output.splice(from)
    ctx.status = 2
    ctx.write('Usage: grep [OPTION]... PATTERNS [FILE]...', 'error')
    return
  }
  // Seule la sortie standard passe dans le tube : les erreurs restent affichées
  const tail = ctx.output.splice(from)
  const kept = grepSelect(
    o,
    tail.filter((l) => l.kind === 'out').map((l) => l.text)
  )
  ctx.status = kept.length > 0 ? 0 : 1
  ctx.output.push(...tail.filter((l) => l.kind !== 'out'))
  ctx.writeLines(grepFormat(o, kept, ''))
}

interface Redirect {
  append: boolean
  target: string
}

interface Stage {
  args: string[] | null
  redirect: Redirect | null
  error?: string
}

/** Sépare « commande args > fichier » (ou >>) hors guillemets. */
function parseStage(stage: string): Stage {
  let quote: string | null = null
  let at = -1
  for (let i = 0; i < stage.length; i++) {
    const c = stage[i] as string
    if (quote) {
      if (c === quote) quote = null
    } else if (c === '"' || c === "'") quote = c
    else if (c === '\\') i++
    else if (c === '>') {
      at = i
      break
    }
  }
  if (at < 0) return { args: splitBashArgs(stage.trim()), redirect: null }
  const append = stage[at + 1] === '>'
  const before = splitBashArgs(stage.slice(0, at).trim())
  const after = splitBashArgs(stage.slice(at + (append ? 2 : 1)).trim())
  if (before === null || after === null) return { args: null, redirect: null }
  const [target, ...more] = after
  if (target === undefined)
    return { args: before, redirect: null, error: "bash: syntax error near unexpected token `newline'" }
  return { args: [...before, ...more], redirect: { append, target } }
}

/**
 * Redirection ouverte par le shell AVANT la commande, avec les droits de l'utilisateur connecté (et non
 * ceux de sudo : `sudo echo x >> /etc/f` échoue, il faut `| sudo tee -a`). Renvoie le message d'erreur.
 */
function redirectError(ctx: ExecContext, target: string): string | null {
  const path = resolvePath(ctx, target)
  if (underMount(ctx, path))
    return `bash: ${target}: écriture dans un partage monté non simulée dans ServerLab`
  const err = writeError(linuxFiles(ctx), bashUser(ctx), path)
  return err ? `bash: ${target}: ${errnoText(err)}` : null
}

/** Écrit dans le fichier la sortie standard produite depuis `from`, qui ne s'affiche plus. */
function applyRedirect(ctx: ExecContext, from: number, redirect: Redirect): void {
  const tail = ctx.output.splice(from)
  ctx.output.push(...tail.filter((l) => l.kind !== 'out'))
  const next = cloneFiles(linuxFiles(ctx))
  putFile(
    next,
    resolvePath(ctx, redirect.target),
    linesToText(tail.filter((l) => l.kind === 'out').map((l) => l.text)),
    ctx,
    {
      user: bashUser(ctx),
      clock: ctx.state.clock,
      append: redirect.append
    }
  )
  commitFiles(ctx, next)
}

/** Nombre de lignes d'erreur déjà écrites (un échec ajoute au moins une ligne d'erreur). */
function errorCount(ctx: ExecContext): number {
  return ctx.output.filter((l) => l.kind === 'error').length
}

/**
 * Exécute un pipeline (étapes reliées par `|`) et renvoie son statut de sortie : celui de la dernière
 * étape. Une étape qui n'a pas fixé `ctx.status` réussit (0) sauf si elle a écrit une erreur (1).
 */
function runPipeline(ctx: ExecContext, trimmed: string, tools: ToolDef[]): number {
  const stages = splitPipes(trimmed)
  // Début de la sortie de l'étape précédente (le tube la transmet à l'étape suivante)
  let previous = ctx.output.length
  let status = 0
  for (const [i, text] of stages.entries()) {
    const errorsBefore = errorCount(ctx)
    ctx.status = null
    const stage = parseStage(text)
    if (stage.error) {
      ctx.write(stage.error, 'error')
      return 2
    }
    if (stage.args === null) {
      ctx.write('bash: unexpected EOF while looking for matching quote', 'error')
      return 2
    }
    const args = stage.args
    if (args.length === 0) {
      if (i === 0 && stages.length === 1) return 0
      ctx.write("bash: syntax error near unexpected token `|'", 'error')
      return 2
    }
    if (stage.redirect) {
      const denied = redirectError(ctx, stage.redirect.target)
      if (denied) {
        ctx.write(denied, 'error')
        return 1
      }
    }
    ctx.root = bashUser(ctx) === 'root'
    ctx.stdin = null
    let region: number
    if (i > 0 && args[0] === 'grep') {
      applyGrep(ctx, previous, args.slice(1))
      region = previous
    } else {
      if (i > 0) {
        // Les erreurs restent à l'écran ; seule la sortie standard alimente l'étape suivante
        const tail = ctx.output.splice(previous)
        ctx.stdin = tail.filter((l) => l.kind === 'out').map((l) => l.text)
        ctx.output.push(...tail.filter((l) => l.kind !== 'out'))
      }
      region = ctx.output.length
      try {
        runCommand(ctx, args, tools)
      } catch (e) {
        if (e instanceof CommandFailure) {
          ctx.write(e.message, 'error')
          ctx.status ??= 1
        } else throw e
      }
    }
    if (stage.redirect) applyRedirect(ctx, region, stage.redirect)
    previous = region
    status = ctx.status ?? (errorCount(ctx) > errorsBefore ? 1 : 0)
  }
  ctx.stdin = null
  return status
}

/**
 * Exécute une ligne : liste de pipelines reliés par `;`, `&&`, `||` évaluée de gauche à droite
 * (bash(1), « Lists of Commands »). Le tube lie plus fort que ces opérateurs.
 */
export function executeBash(ctx: ExecContext, line: string, tools: ToolDef[]): void {
  const trimmed = line.trim()
  if (trimmed === '' || trimmed.startsWith('#')) return
  const parsed = parseCommandList(trimmed)
  if ('error' in parsed) {
    ctx.write(parsed.error, 'error')
    ctx.status = 2
    return
  }
  let status = 0
  for (const item of parsed.items) {
    if (item.op === '&&' && status !== 0) continue
    if (item.op === '||' && status === 0) continue
    status = runPipeline(ctx, expandStatus(item.text, status).trim(), tools)
    if (ctx.exit) break
  }
  ctx.status = status
}

const EN_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Date au format ctime (« Mon Jan  5 08:00:00 2026 ») à partir de l'horloge du lab. */
export function ctimeDate(clock: number, epoch: number): string {
  const d = new Date(epoch + clock)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${EN_DAYS[d.getUTCDay()]} ${EN_MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, ' ')} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${d.getUTCFullYear()}`
}
