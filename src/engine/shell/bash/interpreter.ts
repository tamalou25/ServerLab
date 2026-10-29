/**
 * Console bash simulée des postes Linux (Ubuntu) : découpage façon shell (guillemets simples et
 * doubles, échappement), préfixe sudo (droits root), tube vers grep, commandes intégrées (cd,
 * pwd, echo, clear, exit, help) puis commandes du système de base et des modules de rôles.
 * Les outils affichent leurs messages d'origine, non traduits (locale C).
 */
import { CommandFailure, type ExecContext } from '../context'
import { leaveSu, sudoPrefix } from './accounts'
import { errnoText, linesToText, putFile, underMount, writeError } from './filetools'
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
import { isUnsimulated, unsimulatedMessage } from '../unsimulated'

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

/** Découpe sur les tubes `|` hors guillemets. */
function splitPipes(line: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote: string | null = null
  for (const c of line) {
    if (quote) {
      if (c === quote) quote = null
    } else if (c === '"' || c === "'") quote = c
    else if (c === '|') {
      parts.push(current)
      current = ''
      continue
    }
    current += c
  }
  parts.push(current)
  return parts
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
    default:
      break
  }
  const tool = tools.find((t) => t.name === name)
  if (!tool || !(tool.available?.(ctx) ?? true)) {
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

/** Filtre de tube : grep [-i] [-v] motif. */
function applyGrep(ctx: ExecContext, from: number, args: string[]): void {
  const flags = args.filter((a) => a.startsWith('-')).join('')
  const pattern = args.find((a) => !a.startsWith('-'))
  if (pattern === undefined) {
    ctx.output.splice(from)
    ctx.write('Usage: grep [OPTION]... PATTERNS [FILE]...', 'error')
    return
  }
  const ignore = flags.includes('i')
  const invert = flags.includes('v')
  const needle = ignore ? pattern.toLowerCase() : pattern
  // Seule la sortie standard passe dans le tube : les erreurs restent affichées
  const kept = ctx.output.slice(from).filter((l) => {
    if (l.kind !== 'out') return true
    const hay = ignore ? l.text.toLowerCase() : l.text
    return hay.includes(needle) !== invert
  })
  ctx.output.splice(from, ctx.output.length - from, ...kept)
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

export function executeBash(ctx: ExecContext, line: string, tools: ToolDef[]): void {
  const trimmed = line.trim()
  if (trimmed === '' || trimmed.startsWith('#')) return
  const stages = splitPipes(trimmed)
  // Début de la sortie de l'étape précédente (le tube la transmet à l'étape suivante)
  let previous = ctx.output.length
  for (const [i, text] of stages.entries()) {
    const stage = parseStage(text)
    if (stage.error) {
      ctx.write(stage.error, 'error')
      return
    }
    if (stage.args === null) {
      ctx.write('bash: unexpected EOF while looking for matching quote', 'error')
      return
    }
    const args = stage.args
    if (args.length === 0) {
      if (i === 0) return
      ctx.write("bash: syntax error near unexpected token `|'", 'error')
      return
    }
    if (stage.redirect) {
      const denied = redirectError(ctx, stage.redirect.target)
      if (denied) {
        ctx.write(denied, 'error')
        return
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
        if (e instanceof CommandFailure) ctx.write(e.message, 'error')
        else throw e
      }
    }
    if (stage.redirect) applyRedirect(ctx, region, stage.redirect)
    previous = region
  }
  ctx.stdin = null
}

const EN_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Date au format ctime (« Mon Jan  5 08:00:00 2026 ») à partir de l'horloge du lab. */
export function ctimeDate(clock: number, epoch: number): string {
  const d = new Date(epoch + clock)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${EN_DAYS[d.getUTCDay()]} ${EN_MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, ' ')} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${d.getUTCFullYear()}`
}
