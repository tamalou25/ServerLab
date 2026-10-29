/**
 * Point d'entrée des consoles : création de session, invite, exécution d'une ligne.
 */
import { DEFAULT_LOCAL_USER, LINUX_USER } from '../model/factory'
import { isLinuxHost } from '../model/host'
import type { LabState } from '../model/schema'
import { shellCatalog } from './catalog'
import { bashPrompt, executeBash } from './bash/interpreter'
import { executeCmd } from './cmd/interpreter'
import { CommandFailure } from './context'
import { CmdContext, executePowerShell } from './ps/interpreter'
import { executeIos, iosPrompt, IOS_BANNER } from '../ios/cli'
import { isIosDevice } from '../ios/device'
import { applyTraceEffects } from '../ios/registry'
import { isPfsenseDevice, pfsenseBanner, pfsensePrompt, runPfsenseLine } from './pfsense'
import { NeedInput, type ShellKind, type ShellResult, type ShellSession } from './types'

function sessionUser(state: LabState, deviceId: string): string {
  const d = state.devices[deviceId]
  if (!d || (d.kind !== 'server' && d.kind !== 'client')) return 'Administrateur'
  return d.host.session?.user ?? DEFAULT_LOCAL_USER[d.kind]
}

/** Poste Linux (Ubuntu simulé) : console bash uniquement. */
export function isLinuxDeviceId(state: LabState, deviceId: string): boolean {
  return isLinuxHost(state.devices[deviceId])
}

export function createShellSession(state: LabState, deviceId: string, kind: ShellKind): ShellSession {
  if (isIosDevice(state, deviceId)) return { deviceId, stack: ['ios'], cwd: '', variables: {} }
  if (isPfsenseDevice(state, deviceId))
    return { deviceId, stack: ['pfsense'], cwd: '', variables: {}, pfsense: { mode: 'menu' } }
  if (isLinuxDeviceId(state, deviceId))
    return { deviceId, stack: ['bash'], cwd: `/home/${sessionUser(state, deviceId)}`, variables: {} }
  return { deviceId, stack: [kind], cwd: `C:\\Users\\${sessionUser(state, deviceId)}`, variables: {} }
}

/** Interpréteur actif de la session. */
export function activeShell(session: ShellSession): ShellKind {
  return session.stack[session.stack.length - 1] ?? 'cmd'
}

/** Invite affichée avant la saisie (bash : utilisateur et nom du poste, lus dans l'état). */
export function shellPrompt(session: ShellSession, state?: LabState): string {
  const kind = activeShell(session)
  if (kind === 'ios') return iosPrompt(session, state)
  if (kind === 'pfsense') return pfsensePrompt(session, state)
  if (kind === 'bash') {
    const d = state?.devices[session.deviceId]
    const host = d?.name ?? 'ubuntu'
    const su = session.variables['USER']
    const user =
      typeof su === 'string' && su !== ''
        ? su
        : d && (d.kind === 'client' || d.kind === 'server')
          ? (d.host.session?.user ?? LINUX_USER)
          : LINUX_USER
    return bashPrompt({ host, user, cwd: session.cwd })
  }
  return kind === 'powershell' ? `PS ${session.cwd}> ` : `${session.cwd}>`
}

/** Message de l'invite de commandes désactivée par stratégie de groupe. */
export const CMD_DISABLED_LINES = [
  'L’invite de commandes a été désactivée par votre administrateur.',
  '',
  'Appuyez sur une touche pour continuer...'
]

/** L'invite de commandes est-elle interdite à l'utilisateur de la session (stratégie de groupe) ? */
export function cmdDisabledByPolicy(state: LabState, deviceId: string): boolean {
  const d = state.devices[deviceId]
  return (
    !!d && (d.kind === 'server' || d.kind === 'client') && d.host.policy.user?.settings.noCmd === 'Enabled'
  )
}

/** Texte d'accueil d'une nouvelle console. */
export function shellBanner(kind: ShellKind, state?: LabState, deviceId?: string): string[] {
  if (kind === 'ios') return IOS_BANNER
  if (kind === 'pfsense') return state && deviceId ? pfsenseBanner(state, deviceId) : []
  if (kind === 'bash') {
    const d = state && deviceId ? state.devices[deviceId] : undefined
    const system =
      d?.kind === 'server'
        ? d.host.linux?.distro === 'ubuntu2404'
          ? 'Ubuntu 24.04 LTS'
          : 'Debian GNU/Linux 12'
        : 'Ubuntu 22.04 LTS'
    return [
      `${system} (simulé) — ServerLab`,
      'Tapez help pour la liste des commandes simulées (sorties d’origine, en anglais).',
      ''
    ]
  }
  return kind === 'powershell'
    ? [
        'PowerShell (simulé) — ServerLab',
        'Tapez Get-Command pour la liste des commandes, Get-Help <commande> pour l’aide.',
        ''
      ]
    : ['Invite de commandes (simulée) — ServerLab', 'Tapez help pour la liste des commandes.', '']
}

/**
 * Exécute une ligne de commande.
 * `answers` : réponses déjà fournies aux saisies interactives (la ligne est rejouée à l'identique).
 */
export function executeLine(
  state: LabState,
  session: ShellSession,
  line: string,
  answers: string[] = []
): ShellResult {
  const base = { trace: null, clear: false, prompt: null, exit: false }
  const device = state.devices[session.deviceId]
  if (!device || !device.powered) {
    return { ...base, state, session, output: [{ text: 'L’ordinateur est éteint.', kind: 'error' }] }
  }
  if (activeShell(session) === 'ios') return executeIos(state, session, line, answers)
  const ctx = new CmdContext(state, session, answers, shellCatalog(), line)
  try {
    const kind = activeShell(session)
    if (kind === 'pfsense') {
      runPfsenseLine(ctx, line)
    } else if (kind === 'bash') {
      executeBash(ctx, line, shellCatalog().bashTools)
    } else if (kind === 'powershell') {
      if (line.trim().toLowerCase() === 'exit') {
        if (session.stack.length > 1) ctx.session = { ...session, stack: session.stack.slice(0, -1) }
        else ctx.exit = true
      } else {
        executePowerShell(ctx, line)
      }
    } else if (cmdDisabledByPolicy(state, session.deviceId)) {
      ctx.writeLines(CMD_DISABLED_LINES.slice(0, 1))
    } else {
      executeCmd(ctx, line, shellCatalog().tools)
    }
  } catch (e) {
    if (e instanceof NeedInput) {
      return { ...base, state, session, output: ctx.output, prompt: e.prompt }
    }
    if (e instanceof CommandFailure) {
      ctx.write(e.message, 'error')
    } else {
      throw e
    }
  }
  const trace = ctx.mergedTrace(line.trim())
  return {
    // Effets durables des paquets échangés (traductions NAT, compteurs d'ACL des équipements IOS)
    state: applyTraceEffects(ctx.state, trace),
    session: ctx.session,
    output: ctx.output,
    trace,
    clear: ctx.clear,
    prompt: null,
    exit: ctx.exit
  }
}
