/**
 * Session de la console IOS : mode courant et invite.
 */
import type { LabState } from '../../model/schema'
import type { ShellSession } from '../../shell/types'
import type { IosMode, IosSession } from './types'

/** Suffixe de l'invite selon le mode (R1>, R1#, R1(config-if)#…). */
const MODE_PROMPT: Record<IosMode, string> = {
  user: '>',
  exec: '#',
  config: '(config)#',
  'config-if': '(config-if)#',
  'config-if-range': '(config-if-range)#',
  'config-subif': '(config-subif)#',
  'config-line': '(config-line)#',
  'config-router': '(config-router)#',
  'config-vlan': '(config-vlan)#',
  'dhcp-config': '(dhcp-config)#',
  'config-std-nacl': '(config-std-nacl)#',
  'config-ext-nacl': '(config-ext-nacl)#'
}

/** État IOS de la session (mode utilisateur à l'ouverture). */
export function iosSessionOf(session: ShellSession): IosSession {
  return session.ios ?? { mode: 'user' }
}

/** Invite IOS : nom d'hôte suivi du mode. */
export function iosPrompt(session: ShellSession, state?: LabState): string {
  const name = state?.devices[session.deviceId]?.name ?? 'Router'
  return `${name}${MODE_PROMPT[iosSessionOf(session).mode]}`
}

/** Texte affiché à l'ouverture de la console (ligne console après le démarrage). */
export const IOS_BANNER = ['', 'Press RETURN to get started!', '']
