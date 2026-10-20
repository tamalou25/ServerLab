/**
 * Exécution des commandes saisies dans les consoles.
 * Le moteur est la seule source de vérité : une commande renvoie le nouvel état du lab,
 * appliqué immédiatement (Temps réel) ou à la fin de la lecture des paquets (Simulation).
 */
import {
  command,
  createShellSession,
  executeLine,
  IOS_CTRL_Z,
  shellBanner,
  shellPrompt,
  type LabState,
  type ShellKind,
  type ShellResult,
  type ShellSession
} from '@engine/index'
import { useConsoleStore, terminalKey } from '../store/console'
import { useLabStore } from '../store/lab'
import { runNetworkOperation } from './network'
import { observeTrace } from './tutorial'

/** Crée la console si nécessaire. */
export function ensureTerminal(deviceId: string, kind: ShellKind): string {
  useConsoleStore.getState().ensure(deviceId, kind, () => ({
    session: createShellSession(useLabStore.getState().lab, deviceId, kind),
    banner: shellBanner(kind, useLabStore.getState().lab, deviceId)
  }))
  return terminalKey(deviceId, kind)
}

/** Invite affichée (dépend de l'interpréteur actif et du dossier courant). */
export function promptOf(session: ShellSession | null): string {
  return session ? shellPrompt(session, useLabStore.getState().lab) : '> '
}

/** Valide l'état produit par une ligne de console, journalisée comme commande `shell.exec`. */
function commitLine(
  base: LabState,
  result: ShellResult,
  session: ShellSession,
  line: string,
  answers: string[]
): void {
  if (result.state === base) return
  useLabStore.getState().commit({
    command: command('shell.exec', session, line, answers),
    base,
    result: { ok: true, state: result.state, value: result, entry: null }
  })
}

/** Ouvre une nouvelle session dans la console (l'affichage précédent est conservé). */
function restartTerminal(key: string, notice: string): void {
  const store = useConsoleStore.getState()
  const term = store.terminals[key]
  if (!term) return
  store.append(key, [
    { text: '', kind: 'out' },
    { text: notice, kind: 'verbose' },
    ...shellBanner(term.kind, useLabStore.getState().lab, term.deviceId).map((t) => ({
      text: t,
      kind: 'out' as const
    }))
  ])
  store.update(key, {
    session: createShellSession(useLabStore.getState().lab, term.deviceId, term.kind),
    busy: false,
    pending: null
  })
}

/**
 * Les consoles d'un ordinateur repartent sur une nouvelle session quand l'utilisateur connecté
 * change (promotion, ouverture/fermeture de session, redémarrage d'un poste du domaine).
 */
export function restartConsoles(deviceId: string): void {
  for (const term of Object.values(useConsoleStore.getState().terminals)) {
    if (term.deviceId === deviceId) restartTerminal(term.key, '[Session fermée — nouvelle session ouverte]')
  }
}

/** Applique le résultat final d'une commande. */
function finalize(
  key: string,
  result: ShellResult,
  displayed: number,
  base: LabState,
  line: string,
  answers: string[],
  session: ShellSession
): void {
  const store = useConsoleStore.getState()
  let final = result
  // L'état a changé pendant la simulation : on rejoue la commande sur l'état courant
  const current = useLabStore.getState().lab
  if (current !== base && result.state !== base) {
    final = executeLine(current, session, line, answers)
    displayed = 0
    base = current
  }
  // Tutoriel : un ping réussi depuis la console valide l'étape « ping »
  observeTrace(final.trace)
  // La sortie est affichée avant d'appliquer l'état (qui peut rouvrir la session)
  if (final.clear) store.clear(key)
  store.append(key, final.output.slice(displayed))
  const sessionBefore = useConsoleStore.getState().terminals[key]?.session ?? null
  commitLine(base, final, session, line, answers)
  const sessionAfter = useConsoleStore.getState().terminals[key]?.session ?? null
  if (sessionAfter !== sessionBefore) {
    // Nouvelle session ouverte par le changement d'utilisateur : rien d'autre à appliquer
    store.update(key, { busy: false, pending: null })
    return
  }
  if (final.exit) {
    restartTerminal(key, '[Session terminée — nouvelle console]')
    return
  }
  store.update(key, { session: final.session, busy: false, pending: null })
}

function run(
  key: string,
  line: string,
  answers: string[],
  displayed: number,
  base: LabState,
  session: ShellSession
): void {
  const store = useConsoleStore.getState()
  const result = executeLine(base, session, line, answers)
  if (result.prompt) {
    store.append(key, result.output.slice(displayed))
    store.update(key, {
      pending: { prompt: result.prompt, line, answers, displayed: result.output.length, base, session }
    })
    return
  }
  if (result.trace && result.trace.events.length > 0) {
    store.update(key, { busy: true, pending: null })
    runNetworkOperation(result.trace, () => finalize(key, result, displayed, base, line, answers, session))
    return
  }
  finalize(key, result, displayed, base, line, answers, session)
}

/** Traite une saisie : nouvelle commande ou réponse à une invite. */
export function submitConsoleInput(key: string, input: string): void {
  const store = useConsoleStore.getState()
  const term = store.terminals[key]
  if (!term || !term.session || term.busy) return
  if (term.pending) {
    const { prompt, line, answers, displayed, base, session } = term.pending
    store.append(key, [
      { text: `${prompt.message}${prompt.secure ? '*'.repeat(input.length) : input}`, kind: 'input' }
    ])
    run(key, line, [...answers, input], displayed, base, session)
    return
  }
  // Ctrl+Z de la console IOS : affiché « ^Z », absent de l'historique
  const ctrlZ = input === IOS_CTRL_Z
  store.append(key, [{ text: `${promptOf(term.session)}${ctrlZ ? '^Z' : input}`, kind: 'input' }])
  if (!ctrlZ) store.pushHistory(key, input)
  if (input.trim() === '') return
  run(key, input, [], 0, useLabStore.getState().lab, term.session)
}

/** Ctrl+C : annule la saisie interactive en cours. */
export function cancelConsoleInput(key: string, input: string): void {
  const store = useConsoleStore.getState()
  const term = store.terminals[key]
  if (!term) return
  store.append(key, [
    {
      text: `${term.pending ? term.pending.prompt.message : promptOf(term.session)}${input}^C`,
      kind: 'input'
    }
  ])
  store.update(key, { pending: null })
}
