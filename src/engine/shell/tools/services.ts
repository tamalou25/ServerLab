/**
 * Services système vus depuis les consoles : `net start` / `net stop`.
 *
 * Learn (net start, https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-xp/bb490713(v=technet.10)) :
 * sans paramètre, liste des services en cours d'exécution ; avec un nom, démarre le service.
 * net stop (bb490715) : arrête un service ; « You cannot stop or pause the DHCP Client service » ;
 * « Stopping the Server service prevents users from gaining access to the computer's shared
 * resources ».
 * L'état démarré / arrêté et le type de démarrage sont ceux du moteur (services/hostservices.ts,
 * v2.7 Lot 2a) : les mêmes que Get-Service / Stop-Service. Libellés français à vérifier
 * (docs/fidelite.md, « À vérifier (Lot 2) »).
 */
import {
  computerServices,
  findComputerService,
  startService,
  stopService,
  type ServiceInfo
} from '../../services/hostservices'
import type { ExecContext } from '../context'

/** Services de l'ordinateur de la console, avec leur état. */
export function consoleServices(ctx: ExecContext): ServiceInfo[] {
  return computerServices(ctx.state, ctx.deviceId)
}

/** Service par nom court ou nom affiché (insensible à la casse). */
export function findService(ctx: ExecContext, name: string): ServiceInfo | undefined {
  return findComputerService(ctx.state, ctx.deviceId, name)
}

function helpMsg(ctx: ExecContext, message: string, code: number): void {
  ctx.writeLines(
    [message, '', `Vous obtiendrez une aide supplémentaire en entrant NET HELPMSG ${code}.`, ''],
    'error'
  )
}

/** Nom du service : arguments hors options (un nom avec espaces arrive en un seul argument entre guillemets). */
const serviceArg = (args: string[]) => args.filter((a) => !a.startsWith('/')).join(' ')

export function netStart(ctx: ExecContext, args: string[]): void {
  const name = serviceArg(args)
  if (name === '') {
    ctx.writeLines([
      'Ces services Windows sont démarrés :',
      '',
      ...consoleServices(ctx)
        .filter((s) => s.status === 'Running')
        .map((s) => `   ${s.display}`),
      '',
      'La commande s’est terminée correctement.',
      ''
    ])
    return
  }
  const s = findService(ctx, name)
  if (!s) return helpMsg(ctx, 'Le nom de service n’est pas valide.', 2185)
  if (s.status === 'Running') return helpMsg(ctx, 'Le service demandé a déjà été démarré.', 2182)
  if (s.startType === 'Disabled') {
    ctx.writeLines(
      [
        'Erreur système 1058.',
        '',
        'Le service ne peut pas être démarré, soit parce qu’il a été désactivé, soit parce qu’il n’a pas de périphériques activés qui lui sont associés.',
        ''
      ],
      'error'
    )
    return
  }
  ctx.apply(startService(ctx.state, ctx.deviceId, s.name))
  ctx.writeLines([`Le service ${s.display} démarre.`, `Le service ${s.display} a démarré.`, ''])
}

export function netStop(ctx: ExecContext, args: string[]): void {
  const name = serviceArg(args)
  if (name === '') {
    ctx.write('La syntaxe de cette commande est :\n\nNET STOP\nservice', 'error')
    return
  }
  const s = findService(ctx, name)
  if (!s) return helpMsg(ctx, 'Le nom de service n’est pas valide.', 2185)
  if (s.status === 'Stopped') return helpMsg(ctx, `Le service ${s.display} n’est pas démarré.`, 3521)
  // Learn (net stop) : le service Client DHCP ne peut pas être arrêté
  if (!s.canStop)
    return helpMsg(ctx, 'Le service demandé ne peut pas être contrôlé dans son état actuel.', 2191)
  ctx.apply(stopService(ctx.state, ctx.deviceId, s.name))
  ctx.writeLines([`Le service ${s.display} s’arrête.`, `Le service ${s.display} a été arrêté.`, ''])
}
