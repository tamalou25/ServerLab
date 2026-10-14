/**
 * Invite de commandes simulée.
 *
 * Opérateurs et redirections d'après Microsoft Learn (cmd, rubrique Remarks) :
 * https://learn.microsoft.com/fr-fr/windows-server/administration/windows-commands/cmd
 * - `a & b` : exécute a puis b ;
 * - `a && b` : b seulement si a se termine correctement ;
 * - `a || b` : b seulement si a échoue ;
 * - `a > fichier` : redirige la sortie vers un fichier (`>>` : ajoute à la fin) ;
 * - `&`, `|`, `(`, `)` précédés de `^` ou entre guillemets sont des caractères ordinaires.
 * Les %variables% sont développées une fois pour toute la ligne, avant son découpage
 * (expansion différée désactivée par défaut, page set). Le canal `|` et la redirection d'entrée `<`
 * ne sont pas simulés (message honnête).
 * Une commande « échoue » si elle écrit un message d'erreur : approximation du code de sortie
 * (Learn : 0 ou aucun code en cas de succès), à vérifier pour les commandes qui réussissent
 * partiellement.
 */
import { CommandFailure, type ExecContext } from '../context'
import type { LineKind } from '../types'
import { writeFileContent } from '../../roles/files/actions'
import type { ToolDef } from '../tools/types'
import { shellToken, translatePath } from '../filesystem'
import { expandCmdVariables } from './env'
import { runCd, runCopy, runDriveChange, runMove, runRen, runSet, runType } from './builtins'
import { writeCmdHelp } from './help'
import { isUnsimulated, unsimulatedMessage } from '../unsimulated'

/** Découpe une ligne façon cmd (guillemets doubles). */
export function splitCmdArgs(line: string): string[] {
  const args: string[] = []
  let current = ''
  let quoted = false
  let has = false
  for (const c of line) {
    if (c === '"') {
      quoted = !quoted
      has = true
    } else if ((c === ' ' || c === '\t') && !quoted) {
      if (has) args.push(current)
      current = ''
      has = false
    } else {
      current += c
      has = true
    }
  }
  if (has) args.push(current)
  return args
}

export const CMD_BUILTINS = [
  'cls',
  'echo',
  'exit',
  'ver',
  'help',
  'powershell',
  'cd',
  'chdir',
  'title',
  'set',
  'type',
  'copy',
  'move',
  'ren',
  'rename'
] as const

export type ChainOp = '&' | '&&' | '||' | '|'

export interface ChainPart {
  /** Opérateur qui précède la commande (null pour la première). */
  op: ChainOp | null
  text: string
}

/** Découpe une ligne sur `&`, `&&`, `||`, `|` hors guillemets et hors `^` (échappement conservé). */
export function splitCmdChain(line: string): ChainPart[] {
  const parts: ChainPart[] = []
  let op: ChainOp | null = null
  let current = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string
    if (c === '^' && !quoted && i + 1 < line.length) {
      current += c + (line[i + 1] as string)
      i++
      continue
    }
    if (c === '"') quoted = !quoted
    if (!quoted && (c === '&' || c === '|')) {
      const double = line[i + 1] === c
      parts.push({ op, text: current })
      op = (double ? c + c : c) as ChainOp
      if (double) i++
      current = ''
      continue
    }
    current += c
  }
  parts.push({ op, text: current })
  return parts
}

export interface Redirection {
  stream: 1 | 2
  append: boolean
  /** Fichier cible, ou `&1` (2>&1). */
  target: string
}

/** Retire les redirections d'une commande ; `input` : redirection `<` rencontrée. */
export function parseRedirections(text: string): {
  command: string
  redirections: Redirection[]
  input: boolean
} {
  const redirections: Redirection[] = []
  let command = ''
  let quoted = false
  let input = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string
    if (c === '^' && !quoted && i + 1 < text.length) {
      command += c + (text[i + 1] as string)
      i++
      continue
    }
    if (c === '"') quoted = !quoted
    if (!quoted && c === '<') {
      input = true
      continue
    }
    if (!quoted && c === '>') {
      // Flux : « 2> » ou « 1> » (chiffre isolé juste avant)
      let stream: 1 | 2 = 1
      const prev = command[command.length - 1]
      const before = command[command.length - 2]
      if ((prev === '1' || prev === '2') && (before === undefined || before === ' ' || before === '\t')) {
        stream = prev === '2' ? 2 : 1
        command = command.slice(0, -1)
      }
      let j = i + 1
      const append = text[j] === '>'
      if (append) j++
      while (text[j] === ' ' || text[j] === '\t') j++
      let target = ''
      if (text[j] === '&') {
        target = '&'
        j++
        while (j < text.length && /\d/.test(text[j] as string)) target += text[j++]
      } else if (text[j] === '"') {
        j++
        while (j < text.length && text[j] !== '"') target += text[j++]
        j++
      } else {
        while (j < text.length && !/[\s<>]/.test(text[j] as string)) target += text[j++]
      }
      redirections.push({ stream, append, target })
      i = j - 1
      continue
    }
    command += c
  }
  return { command, redirections, input }
}

/** Retire les `^` d'échappement hors guillemets (`^^` → `^`). */
export function unescapeCaret(text: string): string {
  let out = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string
    if (c === '"') quoted = !quoted
    if (c === '^' && !quoted && i + 1 < text.length) {
      out += text[i + 1] as string
      i++
      continue
    }
    out += c
  }
  return out
}

export function executeCmd(ctx: ExecContext, line: string, tools: ToolDef[]): void {
  // Expansion des %variables% avant le découpage (comme cmd.exe)
  const expanded = expandCmdVariables(ctx, line.trim())
  if (expanded === '') return
  const chain = splitCmdChain(expanded)
  if (chain.some((p) => p.op === '|')) {
    ctx.write('Le canal (|) de l’invite de commandes n’est pas simulé dans ServerLab.', 'error')
    return
  }
  // Commande manquante autour de && ou || (libellé à vérifier) ; un & final est sans effet
  if (
    chain.some(
      (p, i) =>
        p.text.trim() === '' &&
        (i === 0 || p.op === '&&' || p.op === '||' || chain[i + 1]?.op === '&&' || chain[i + 1]?.op === '||')
    )
  ) {
    ctx.write('La syntaxe de la commande n’est pas correcte.', 'error')
    return
  }
  let ok = true
  for (const part of chain.filter((p) => p.text.trim() !== '')) {
    if (ctx.exit) break
    if (part.op === '&&' && !ok) continue
    if (part.op === '||' && ok) continue
    ok = runRedirected(ctx, part.text.trim(), tools)
  }
}

/** Exécute une commande avec ses redirections ; vrai si elle n'a écrit aucune erreur. */
function runRedirected(ctx: ExecContext, text: string, tools: ToolDef[]): boolean {
  const { command, redirections, input } = parseRedirections(text)
  if (input) {
    ctx.write('La redirection d’entrée (<) n’est pas simulée dans ServerLab.', 'error')
    return false
  }
  if (
    redirections.some(
      (r) => r.target === '' || (r.target.startsWith('&') && r.target !== '&1' && r.target !== '&2')
    )
  ) {
    ctx.write('La syntaxe de la commande n’est pas correcte.', 'error')
    return false
  }
  const start = ctx.output.length
  runSimple(ctx, unescapeCaret(command.trim()), tools)
  const produced = ctx.output.splice(start)
  const failed = produced.some((l) => l.kind === 'error')
  if (redirections.length === 0) {
    ctx.output.push(...produced)
    return !failed
  }
  // Destination de chaque flux (la dernière redirection d'un flux l'emporte)
  const out = [...redirections].reverse().find((r) => r.stream === 1)
  const err = [...redirections].reverse().find((r) => r.stream === 2)
  const errTarget = err?.target === '&1' ? out : err
  const files = new Map<Redirection, string[]>()
  for (const r of [out, errTarget]) if (r && !files.has(r)) files.set(r, [])
  for (const l of produced) {
    const dest = l.kind === 'error' ? errTarget : out
    if (dest) files.get(dest)?.push(l.text)
    else ctx.output.push(l)
  }
  let writeOk = true
  for (const [r, lines] of files) writeOk = writeRedirection(ctx, r, lines) && writeOk
  return !failed && writeOk
}

/** Écrit les lignes redirigées dans le fichier (CRLF, ANSI) ; `nul` les ignore. */
function writeRedirection(ctx: ExecContext, r: Redirection, lines: string[]): boolean {
  if (r.target.toLowerCase() === 'nul') return true
  const t = translatePath(ctx, r.target)
  const fail = (message: string, kind: LineKind = 'error') => {
    ctx.write(message, kind)
    return false
  }
  if (!t.ok) return fail(t.error)
  const text = lines.map((l) => `${l}\r\n`).join('')
  const result = writeFileContent(ctx.state, t.target.server.id, t.target.localPath, text, shellToken(ctx), {
    append: r.append,
    encoding: 'Default',
    ...(t.target.share ? { share: t.target.share.name } : {})
  })
  if (!result.ok)
    return fail(
      result.error.code === 'AccessDenied'
        ? 'Accès refusé.'
        : result.error.code === 'PathNotFound'
          ? 'Le chemin d’accès spécifié est introuvable.'
          : result.error.message
    )
  ctx.state = result.state
  return true
}

/** Exécute une commande simple (sans opérateur ni redirection). */
function runSimple(ctx: ExecContext, text: string, tools: ToolDef[]): void {
  if (text === '') return
  const args = splitCmdArgs(text)
  const raw = args[0] ?? ''
  const name = raw.toLowerCase().replace(/\.exe$/, '')
  const rest = args.slice(1)
  const tool = tools.find((t) => t.name === name && (t.available?.(ctx) ?? true))

  // « commande /? » : aide de l'outil s'il en a une, sinon message honnête (cmd/help.ts)
  if (rest[0] === '/?' && name !== 'echo' && !tool?.handlesHelp) {
    if (tool || (CMD_BUILTINS as readonly string[]).includes(name)) {
      writeCmdHelp(ctx, raw, tool?.help)
      return
    }
  }

  if (/^[a-z]:$/i.test(text)) {
    runDriveChange(ctx, text)
    return
  }

  switch (name) {
    case 'cls':
      ctx.clear = true
      return
    case 'echo':
      ctx.write(text.slice(4).trim() || 'ECHO est activé.')
      return
    case 'exit':
      ctx.exit = true
      return
    case 'ver':
      ctx.writeLines(['', 'ServerLab — Invite de commandes simulée [version 1.0]', ''])
      return
    case 'title':
      return
    case 'set':
      runSet(ctx, text.slice(3))
      return
    case 'type':
      runType(ctx, rest)
      return
    case 'copy':
      runCopy(ctx, rest)
      return
    case 'move':
      runMove(ctx, rest)
      return
    case 'ren':
    case 'rename':
      runRen(ctx, rest)
      return
    case 'cd':
    case 'chdir':
      runCd(ctx, rest)
      return
    case 'powershell':
    case 'pwsh':
      ctx.session = { ...ctx.session, stack: [...ctx.session.stack, 'powershell'] }
      ctx.writeLines([
        'PowerShell (simulé) — ServerLab',
        'Tapez Get-Command pour afficher les commandes disponibles.',
        ''
      ])
      return
    case 'help':
      ctx.writeLines([
        'Pour plus d’informations sur une commande, tapez commande /?',
        ...[...tools]
          .filter((t) => t.available?.(ctx) ?? true)
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((t) => `${t.name.toUpperCase().padEnd(14)}${t.synopsis}`),
        `${'CD'.padEnd(14)}Affiche ou change le répertoire actif.`,
        `${'CLS'.padEnd(14)}Efface l’écran.`,
        `${'COPY'.padEnd(14)}Copie un fichier.`,
        `${'EXIT'.padEnd(14)}Quitte l’invite de commandes.`,
        `${'MOVE'.padEnd(14)}Déplace ou renomme un fichier ou un dossier.`,
        `${'POWERSHELL'.padEnd(14)}Démarre PowerShell.`,
        `${'REN'.padEnd(14)}Renomme un fichier ou un dossier.`,
        `${'SET'.padEnd(14)}Affiche, définit ou supprime des variables d’environnement.`,
        `${'TYPE'.padEnd(14)}Affiche le contenu d’un fichier texte.`,
        ''
      ])
      return
    default:
      break
  }

  if (tool) {
    try {
      tool.run(ctx, rest)
    } catch (e) {
      if (e instanceof CommandFailure) ctx.write(e.message, 'error')
      else throw e
    }
    return
  }
  if (isUnsimulated('cmd', name)) {
    ctx.write(unsimulatedMessage('cmd', raw || name), 'error')
    return
  }
  ctx.writeLines(
    [
      `'${raw}' n’est pas reconnu en tant que commande interne`,
      'ou externe, un programme exécutable ou un fichier de commandes.'
    ],
    'error'
  )
}
