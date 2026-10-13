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
        const value = cmdEnvValue(ctx, line.slice(i + 1, end))
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
