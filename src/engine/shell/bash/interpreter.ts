/**
 * Console bash simulée des postes Linux (Ubuntu) : découpage façon shell (guillemets simples et
 * doubles, échappement), préfixe sudo (droits root), tube vers grep, commandes intégrées (cd,
 * pwd, echo, clear, exit, help) puis commandes du système de base et des modules de rôles.
 * Les outils affichent leurs messages d'origine, non traduits (locale C).
 */
import { LINUX_USER } from '../../model/factory'
import { CommandFailure, type ExecContext } from '../context'
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

/** Dossier personnel de l'utilisateur de la session. */
export function homeDir(ctx: ExecContext): string {
  return `/home/${ctx.host.host.session?.user ?? LINUX_USER}`
}

/** Chemin absolu normalisé (., .., ~). */
export function resolvePath(ctx: ExecContext, path: string): string {
  const home = homeDir(ctx)
  const expanded = path === '~' ? home : path.startsWith('~/') ? `${home}${path.slice(1)}` : path
  const absolute = expanded.startsWith('/') ? expanded : `${ctx.session.cwd.replace(/\/$/, '')}/${expanded}`
  const parts: string[] = []
  for (const part of absolute.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

/** Invite bash : etudiant@LNX1:~/docs$ (root : #). */
export function bashPrompt(ctx: { host: string; user: string; cwd: string }): string {
  const home = `/home/${ctx.user}`
  const where =
    ctx.cwd === home ? '~' : ctx.cwd.startsWith(`${home}/`) ? `~${ctx.cwd.slice(home.length)}` : ctx.cwd
  return `${ctx.user}@${ctx.host}:${where}$ `
}

/** Dossiers locaux simulés (les autres chemins n'existent pas). */
export function isLocalDir(ctx: ExecContext, path: string): boolean {
  if (['/', '/home', '/mnt', '/media', '/etc', '/tmp', homeDir(ctx)].includes(path)) return true
  return ctx.host.host.mounts.some((m) => path === m.target || path.startsWith(`${m.target}/`))
}

export const BASH_BUILTINS = ['cd', 'pwd', 'echo', 'clear', 'exit', 'help', 'sudo'] as const

function runCommand(ctx: ExecContext, args: string[], tools: ToolDef[]): void {
  let [name = '', ...rest] = args
  if (name === 'sudo') {
    // Session de l'administrateur du poste : sudo ne redemande pas le mot de passe (simplification)
    if (rest.length === 0) {
      ctx.writeLines(['usage: sudo command'], 'error')
      return
    }
    ctx.root = true
    ;[name = '', ...rest] = rest
  }
  switch (name) {
    case 'cd': {
      const target = resolvePath(ctx, rest[0] ?? '~')
      if (!isLocalDir(ctx, target))
        throw new CommandFailure(`bash: cd: ${rest[0]}: No such file or directory`, 'NotFound')
      ctx.session = { ...ctx.session, cwd: target }
      return
    }
    case 'pwd':
      ctx.write(ctx.session.cwd)
      return
    case 'echo':
      ctx.write(rest.join(' '))
      return
    case 'clear':
      ctx.clear = true
      return
    case 'exit':
      ctx.exit = true
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
      isUnsimulated('bash', name) ? unsimulatedMessage('bash', name) : `${name}: command not found`,
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

export function executeBash(ctx: ExecContext, line: string, tools: ToolDef[]): void {
  const trimmed = line.trim()
  if (trimmed === '' || trimmed.startsWith('#')) return
  const [first = '', ...filters] = splitPipes(trimmed)
  const args = splitBashArgs(first.trim())
  if (args === null) {
    ctx.write('bash: unexpected EOF while looking for matching quote', 'error')
    return
  }
  if (args.length === 0) return
  const start = ctx.output.length
  try {
    runCommand(ctx, args, tools)
  } catch (e) {
    if (e instanceof CommandFailure) ctx.write(e.message, 'error')
    else throw e
  }
  for (const filter of filters) {
    const fargs = splitBashArgs(filter.trim()) ?? []
    if (fargs[0] !== 'grep') {
      ctx.write(`${fargs[0] ?? ''}: tube non simulé (seul grep est disponible après |)`, 'error')
      return
    }
    applyGrep(ctx, start, fargs.slice(1))
  }
}

const EN_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Date au format ctime (« Mon Jan  5 08:00:00 2026 ») à partir de l'horloge du lab. */
export function ctimeDate(clock: number, epoch: number): string {
  const d = new Date(epoch + clock)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${EN_DAYS[d.getUTCDay()]} ${EN_MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, ' ')} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${d.getUTCFullYear()}`
}
