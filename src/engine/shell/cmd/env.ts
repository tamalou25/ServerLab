/**
 * Variables d'environnement de l'Invite de commandes simulée.
 *
 * Sources Microsoft Learn :
 * - syntaxe %variable%, insensible à la casse, substitution non récursive :
 *   https://learn.microsoft.com/fr-fr/windows-server/administration/windows-commands/set_1
 *   et https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-xp/bb490954(v=technet.10)
 * - COMPUTERNAME, USERNAME, USERDOMAIN, LOGONSERVER (contrôleur ayant validé l'ouverture de session) :
 *   page bb490954 ci-dessus ;
 * - SystemRoot / windir (chemin typique C:\Windows) :
 *   https://learn.microsoft.com/en-us/windows/deployment/usmt/usmt-recognized-environment-variables
 * Non définies faute de valeur sourcée (restent littérales) : PATH, TEMP, TMP, OS, COMSPEC, PATHEXT…
 */
import type { ExecContext } from '../context'

/** Valeur d'une variable connue du lab, ou undefined (variable inconnue). */
export function cmdEnvValue(ctx: ExecContext, name: string): string | undefined {
  const host = ctx.host
  const user = ctx.user
  switch (name.toLowerCase()) {
    case 'computername':
      return host.name
    case 'username':
      return user.name
    case 'userdomain':
      // Compte local : le « domaine » est le nom de l'ordinateur
      return user.domain ?? host.name
    case 'logonserver': {
      const netbios = host.host.domain ? (host.host.domain.split('.')[0]?.toUpperCase() ?? '') : null
      return `\\\\${user.domain ? (host.host.session?.logonServer ?? netbios ?? host.name) : host.name}`
    }
    case 'systemroot':
    case 'windir':
      return 'C:\\Windows'
    case 'userprofile':
      return `C:\\Users\\${user.name}`
    default:
      return undefined
  }
}

/** Remplace les %variable% connues ; une variable inconnue ou un % isolé reste littéral. */
export function expandCmdVariables(ctx: ExecContext, line: string): string {
  let out = ''
  let i = 0
  while (i < line.length) {
    const c = line[i]!
    if (c === '%') {
      const end = line.indexOf('%', i + 1)
      if (end > i + 1) {
        const value = cmdVariable(ctx, line.slice(i + 1, end))
        if (value !== undefined) {
          out += value
          i = end + 1
          continue
        }
      }
    }
    out += c
    i++
  }
  return out
}

/** Noms des variables du lab, avec la casse affichée par `set`. */
export const CMD_ENV_NAMES = [
  'COMPUTERNAME',
  'LOGONSERVER',
  'SystemRoot',
  'USERDOMAIN',
  'USERNAME',
  'USERPROFILE',
  'windir'
] as const

/** Variable définie par `set` dans la session (clé d'origine), insensible à la casse. */
function sessionKey(ctx: ExecContext, name: string): string | undefined {
  const lower = name.toLowerCase()
  return Object.keys(ctx.session.cmdEnv ?? {}).find((k) => k.toLowerCase() === lower)
}

/** Valeur courante : variable de session (set), sinon variable du lab ; undefined si absente. */
export function cmdVariable(ctx: ExecContext, name: string): string | undefined {
  const key = sessionKey(ctx, name)
  if (key !== undefined) return ctx.session.cmdEnv?.[key] ?? undefined
  return cmdEnvValue(ctx, name)
}

/** Définit (ou efface avec `null`) une variable pour la suite de la session. */
export function setCmdVariable(ctx: ExecContext, name: string, value: string | null): void {
  const env = { ...(ctx.session.cmdEnv ?? {}) }
  const key = sessionKey(ctx, name)
  if (key !== undefined) delete env[key]
  // Le nom garde la casse de la première définition dans le lab (COMPUTERNAME), sinon celle saisie
  const builtin = CMD_ENV_NAMES.find((n) => n.toLowerCase() === name.toLowerCase())
  env[builtin ?? key ?? name] = value
  ctx.session = { ...ctx.session, cmdEnv: env }
}

/** Toutes les variables définies (nom → valeur), triées sans tenir compte de la casse. */
export function cmdVariables(ctx: ExecContext): [string, string][] {
  const names = new Map<string, string>()
  for (const n of CMD_ENV_NAMES) names.set(n.toLowerCase(), n)
  for (const n of Object.keys(ctx.session.cmdEnv ?? {})) names.set(n.toLowerCase(), n)
  return [...names.values()]
    .map((n): [string, string | undefined] => [n, cmdVariable(ctx, n)])
    .filter((e): e is [string, string] => e[1] !== undefined)
    .sort((a, b) => a[0].toLowerCase().localeCompare(b[0].toLowerCase()))
}
