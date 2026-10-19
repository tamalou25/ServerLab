/**
 * `sc failure` et `sc qfailure` : options de récupération d'un service (v2.8, #224).
 *
 * Syntaxe d'après Microsoft Learn (SC, « sc failure » / « sc qfailure », section Windows XP de la
 * bibliothèque TechNet, https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-xp/bb490995(v=technet.10)) :
 * - `sc [ServerName] failure [ServiceName] [reset= ErrorFreePeriod] [reboot= BroadcastMessage]
 *   [command= CommandLine] [actions= FailureActionsAndDelayTime]` ; actions valides : run, restart,
 *   reboot, séparées par « / » avec leur délai en millisecondes ; `reset=` et `actions=` vont
 *   ensemble ; `actions= ""` ne prévoit aucune action ; sans espace après le signe égal,
 *   l'opération échoue.
 * - `sc qfailure` affiche SERVICE_NAME, RESET_PERIOD, REBOOT_MESSAGE, COMMAND_LINE, FAILURE_ACTIONS.
 * - `reset=` : durée en secondes sans échec après laquelle le compteur revient à 0 (Win32,
 *   SERVICE_FAILURE_ACTIONS : INFINITE = jamais).
 * La mise en page de `sc qfailure` (étiquettes, « RESTART -- Delay = … milliseconds. ») et les
 * libellés français ne sont pas publiés sur Learn : docs/fidelite.md, « À vérifier (v2.8 — services) ».
 */
import type { ServiceRecovery, ServiceRecoveryActionType } from '../../model/schema'
import {
  serviceRecovery,
  setServiceRecovery,
  type ServiceInfo,
  type ServiceRecoveryPatch
} from '../../services/hostservices'
import type { ExecContext } from '../context'

/** Valeur Win32 INFINITE (jamais remettre le compteur d'échecs à zéro). */
const INFINITE = 4294967295

const ACTION_LABEL: Record<ServiceRecoveryActionType, string> = {
  restart: 'RESTART',
  reboot: 'REBOOT',
  run: 'RUN PROCESS'
}

/** Erreur 87 (Learn, codes d'erreur système : « The parameter is incorrect. »). */
function invalidParameter(ctx: ExecContext): void {
  ctx.write('[SC] ChangeServiceConfig2 échec(s) 87 :\n\nParamètre incorrect.', 'error')
}

/** Actions `type/délai[/type/délai…]` ; `undefined` si la syntaxe est invalide. */
function parseActions(text: string): ServiceRecovery['actions'] | undefined {
  if (text === '') return []
  const parts = text.split('/')
  if (parts.length % 2 !== 0) return undefined
  const actions: ServiceRecovery['actions'] = []
  for (let i = 0; i < parts.length; i += 2) {
    const type = (parts[i] ?? '').toLowerCase()
    const delay = parts[i + 1] ?? ''
    if (type !== 'run' && type !== 'restart' && type !== 'reboot') return undefined
    if (!/^\d+$/.test(delay)) return undefined
    actions.push({ type, delayMs: Number(delay) })
  }
  return actions
}

/**
 * `sc failure <service> [reset= …] [reboot= …] [command= …] [actions= …]`. `raw` : options avec la
 * casse saisie (message et commande) ; `extra` : arguments sans signe égal (opération invalide).
 */
export function scFailure(
  ctx: ExecContext,
  service: ServiceInfo,
  raw: ReadonlyMap<string, string>,
  extra: number
): void {
  const unknown = [...raw.keys()].filter((k) => !['reset', 'reboot', 'command', 'actions'].includes(k))
  if (extra > 0 || unknown.length > 0) return invalidParameter(ctx)
  const patch: ServiceRecoveryPatch = {}
  const reset = raw.get('reset')
  const actions = raw.get('actions')
  // Learn : reset= et actions= s'utilisent ensemble
  if ((reset === undefined) !== (actions === undefined)) return invalidParameter(ctx)
  if (reset !== undefined) {
    if (reset.toLowerCase() === 'infinite') patch.resetSeconds = INFINITE
    else if (/^\d+$/.test(reset)) patch.resetSeconds = Number(reset)
    else return invalidParameter(ctx)
  }
  if (actions !== undefined) {
    const parsed = parseActions(actions)
    if (!parsed) return invalidParameter(ctx)
    patch.actions = parsed
  }
  const reboot = raw.get('reboot')
  if (reboot !== undefined) patch.rebootMessage = reboot
  const command = raw.get('command')
  if (command !== undefined) patch.command = command
  ctx.apply(setServiceRecovery(ctx.state, ctx.deviceId, service.name, patch))
  ctx.writeLines(['[SC] ChangeServiceConfig2 réussite(s)', ''])
}

/** `sc qfailure <service>` : options de récupération calculées depuis l'état du service. */
export function scQfailure(ctx: ExecContext, service: ServiceInfo): void {
  const r = serviceRecovery(service)
  const pad = ' '.repeat(39)
  const lines = r.actions.map((a) => `${ACTION_LABEL[a.type]} -- Delay = ${a.delayMs} milliseconds.`)
  // Pas d'espace en fin de ligne quand la valeur est vide
  ctx.writeLines([
    '[SC] QueryServiceConfig2 réussite(s)',
    '',
    `NOM_SERVICE: ${service.name}`,
    `        RESET_PERIOD (in seconds)    : ${r.resetSeconds === INFINITE ? 'INFINITE' : r.resetSeconds}`,
    `        REBOOT_MESSAGE               : ${r.rebootMessage}`.trimEnd(),
    `        COMMAND_LINE                 : ${r.command}`.trimEnd(),
    `        FAILURE_ACTIONS              : ${lines[0] ?? ''}`.trimEnd(),
    ...lines.slice(1).map((l) => `${pad}${l}`),
    ''
  ])
}
