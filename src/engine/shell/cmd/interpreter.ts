/**
 * Invite de commandes simulée.
 */
import { CommandFailure, type ExecContext } from '../context'
import { changeDirectory } from '../../roles/files/tools'
import type { ToolDef } from '../tools/types'
import { expandCmdVariables } from './env'
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
  'title'
] as const

export function executeCmd(ctx: ExecContext, line: string, tools: ToolDef[]): void {
  // Expansion des %variables% avant le découpage (comme cmd.exe)
  const trimmed = expandCmdVariables(ctx, line.trim())
  if (trimmed === '') return
  const args = splitCmdArgs(trimmed)
  const name = (args[0] ?? '').toLowerCase().replace(/\.exe$/, '')
  const rest = args.slice(1)

  switch (name) {
    case 'cls':
      ctx.clear = true
      return
    case 'echo':
      ctx.write(trimmed.slice(4).trim() || 'ECHO est activé.')
      return
    case 'exit':
      ctx.exit = true
      return
    case 'ver':
      ctx.writeLines(['', 'ServerLab — Invite de commandes simulée [version 1.0]', ''])
      return
    case 'title':
      return
    case 'cd':
    case 'chdir': {
      const target = rest.filter((a) => a.toLowerCase() !== '/d').join(' ')
      if (target === '') ctx.write(ctx.session.cwd)
      else changeDirectory(ctx, target)
      return
    }
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
        `${'CLS'.padEnd(14)}Efface l’écran.`,
        `${'EXIT'.padEnd(14)}Quitte l’invite de commandes.`,
        `${'POWERSHELL'.padEnd(14)}Démarre PowerShell.`,
        ''
      ])
      return
    default:
      break
  }

  const tool = tools.find((t) => t.name === name)
  if (tool && (tool.available?.(ctx) ?? true)) {
    try {
      tool.run(ctx, rest)
    } catch (e) {
      if (e instanceof CommandFailure) ctx.write(e.message, 'error')
      else throw e
    }
    return
  }
  if (isUnsimulated('cmd', name)) {
    ctx.write(unsimulatedMessage('cmd', args[0] ?? name), 'error')
    return
  }
  ctx.writeLines(
    [
      `'${args[0] ?? ''}' n’est pas reconnu en tant que commande interne`,
      'ou externe, un programme exécutable ou un fichier de commandes.'
    ],
    'error'
  )
}
