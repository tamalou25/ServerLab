/**
 * Services système vus depuis les consoles : `net start` / `net stop`.
 *
 * Learn (net start, https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-xp/bb490713(v=technet.10)) :
 * sans paramètre, liste des services en cours d'exécution ; avec un nom, démarre le service.
 * net stop (bb490715) : arrête un service.
 * ServerLab ne modélise pas l'état démarré / arrêté des services : la liste est dérivée des rôles
 * installés (roles/registry.ts, `hostServices`) et tous sont considérés démarrés ; l'arrêt n'est
 * pas simulé (message honnête). Libellés français à vérifier (docs/fidelite.md, Lot 3).
 */
import { hostServices, type HostService } from '../../roles/registry'
import type { ExecContext } from '../context'

/** Services de l'ordinateur de la console. */
export function consoleServices(ctx: ExecContext): HostService[] {
  const host = ctx.host
  const dc = Object.values(ctx.state.domains).some((d) => d.controllers.includes(ctx.deviceId))
  return hostServices(host.host.features, dc)
}

/** Service par nom court ou nom affiché (insensible à la casse). */
export function findService(ctx: ExecContext, name: string): HostService | undefined {
  const lower = name.toLowerCase()
  return consoleServices(ctx).find((s) => s.name.toLowerCase() === lower || s.display.toLowerCase() === lower)
}

function helpMsg(ctx: ExecContext, message: string, code: number): void {
  ctx.writeLines(
    [message, '', `Vous obtiendrez une aide supplémentaire en entrant NET HELPMSG ${code}.`, ''],
    'error'
  )
}

export function netStart(ctx: ExecContext, args: string[]): void {
  const name = args.filter((a) => !a.startsWith('/')).join(' ')
  if (name === '') {
    ctx.writeLines([
      'Ces services Windows sont démarrés :',
      '',
      ...consoleServices(ctx).map((s) => `   ${s.display}`),
      '',
      'La commande s’est terminée correctement.',
      ''
    ])
    return
  }
  if (!findService(ctx, name)) helpMsg(ctx, 'Le nom de service n’est pas valide.', 2185)
  else helpMsg(ctx, 'Le service demandé a déjà été démarré.', 2182)
}

export function netStop(ctx: ExecContext, args: string[]): void {
  const name = args.filter((a) => !a.startsWith('/')).join(' ')
  if (name === '') {
    ctx.write('La syntaxe de cette commande est :\n\nNET STOP\nservice', 'error')
    return
  }
  if (!findService(ctx, name)) {
    helpMsg(ctx, 'Le nom de service n’est pas valide.', 2185)
    return
  }
  ctx.write(
    'L’arrêt d’un service n’est pas simulé dans ServerLab (l’état démarré / arrêté des services n’est pas modélisé).',
    'error'
  )
}
