/**
 * Console du pare-feu pfSense CE 2.7 (v2.10, #247) : menu numéroté (0 à 16) puis, par l'option 8, shell
 * FreeBSD limité. Interpréteur indépendant de PowerShell, cmd, bash et IOS, branché dans `shell/exec.ts`.
 */
import type { PfDevice } from '../../net/pf'
import type { LabState } from '../../model/schema'
import type { ExecContext } from '../context'
import type { ShellSession } from '../types'
import { MENU_PROMPT, menuScreen, runMenuOption } from './menu'
import { runShellLine, shellPromptText } from './shell'
import { PfTerm } from './term'

export { PFSENSE_RELEASE } from './nettools'
export { filterLogLines, FILTER_LOG_PATH } from './filterlog'
export { pfRuleset } from './ruleset'

const isFirewall = (state: LabState, deviceId: string): boolean =>
  state.devices[deviceId]?.kind === 'firewall'

/** Vrai si l'équipement est un pare-feu pfSense (sa console est celle de pfSense). */
export const isPfsenseDevice = isFirewall

/** Mode courant de la console : menu numéroté ou shell. */
export const pfsenseMode = (session: ShellSession): 'menu' | 'shell' => session.pfsense?.mode ?? 'menu'

/** Invite : « Enter an option: » au menu, invite de tcsh dans le shell. */
export function pfsensePrompt(session: ShellSession, state?: LabState): string {
  const device = state?.devices[session.deviceId]
  if (pfsenseMode(session) === 'menu' || !device || device.kind !== 'firewall') return MENU_PROMPT
  return shellPromptText(device as PfDevice)
}

/** Texte affiché à l'ouverture de la console : bannière puis menu (rc.banner et rc.initial). */
export function pfsenseBanner(state: LabState, deviceId: string): string[] {
  const device = state.devices[deviceId]
  return device?.kind === 'firewall' ? menuScreen(device as PfDevice) : []
}

/** Exécute une ligne saisie à l'invite (option du menu ou commande du shell). */
export function runPfsenseLine(ctx: ExecContext, line: string): void {
  const t = new PfTerm(ctx)
  if (pfsenseMode(ctx.session) === 'menu') runMenuOption(ctx, t, line.trim())
  else runShellLine(ctx, t, line)
  t.flush()
}
