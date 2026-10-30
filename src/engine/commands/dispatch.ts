/**
 * Point d'entrée unique des modifications : `dispatch(state, commande)` exécute la commande et
 * renvoie, en plus du résultat habituel, l'entrée de journal (libellé, heure simulée, patches et
 * inverses). L'annuler/rétablir applique ces patches : aucun inverse n'est écrit à la main.
 */
import type { EngineResult } from '../core/result'
import type { LabState } from '../model/schema'
import {
  commandDefinitions,
  isCommandType,
  type AnyCommand,
  type Command,
  type CommandDef,
  type CommandType,
  type CommandValue
} from './catalog'
import { diffStates, type Patch } from './patches'

/** Entrée du journal des commandes (sérialisable). */
export interface JournalEntry {
  type: string
  args: unknown[]
  label: string
  /** Horloge simulée du lab au moment de la commande (ms). */
  time: number
  patches: Patch[]
  inversePatches: Patch[]
}

export type DispatchResult<T> = EngineResult<T> & {
  /** Entrée de journal, ou null si la commande a échoué ou n'a rien modifié. */
  entry: JournalEntry | null
}

function definition(type: string): CommandDef<unknown[], unknown> | undefined {
  return isCommandType(type) ? (commandDefinitions()[type] as CommandDef<unknown[], unknown>) : undefined
}

/** Libellé français d'une commande (évalué sur l'état d'avant). */
export function commandLabel(state: LabState, command: AnyCommand & { label?: string }): string {
  if (command.label) return command.label
  const def = definition(command.type)
  return def ? def.label(state, ...command.args) : command.type
}

/** Entrée de journal pour un résultat déjà calculé sur `base` (fin de lecture en mode Simulation). */
export function journalEntry(
  base: LabState,
  next: LabState,
  command: AnyCommand & { label?: string }
): JournalEntry | null {
  if (next === base) return null
  const { patches, inversePatches } = diffStates(base, next)
  return {
    type: command.type,
    args: command.args,
    label: commandLabel(base, command),
    time: base.clock,
    patches,
    inversePatches
  }
}

/** Exécute une commande du catalogue. */
export function dispatch<K extends CommandType>(
  state: LabState,
  command: Command<K>
): DispatchResult<CommandValue<K>>
export function dispatch(state: LabState, command: AnyCommand & { label?: string }): DispatchResult<unknown>
export function dispatch(state: LabState, command: AnyCommand & { label?: string }): DispatchResult<unknown> {
  const def = definition(command.type)
  if (!def)
    return {
      ok: false,
      error: { code: 'UnknownCommand', message: `Commande inconnue : ${command.type}.` },
      entry: null
    }
  const result = def.run(state, ...command.args)
  if (!result.ok) return { ...result, entry: null }
  return { ...result, entry: journalEntry(state, result.state, command) }
}

/**
 * Exécute une commande SANS construire l'entrée de journal : même décision et même état que
 * `dispatch`, sans le calcul des patches (différence profonde de deux états, coûteuse). Pour les
 * appelants qui n'enregistrent rien (essais de réparation du tirage des pannes, par exemple).
 */
export function execute(state: LabState, command: AnyCommand): EngineResult<unknown> {
  const def = definition(command.type)
  if (!def)
    return { ok: false, error: { code: 'UnknownCommand', message: `Commande inconnue : ${command.type}.` } }
  return def.run(state, ...command.args)
}

/**
 * Rejoue une suite de commandes depuis un état initial (déterministe : même suite = même état).
 * S'arrête à la première commande en échec.
 */
export function replay(
  initial: LabState,
  commands: readonly (AnyCommand & { label?: string })[]
): EngineResult<JournalEntry[]> {
  let state = initial
  const entries: JournalEntry[] = []
  for (const command of commands) {
    const result = dispatch(state, command)
    if (!result.ok) return result
    state = result.state
    if (result.entry) entries.push(result.entry)
  }
  return { ok: true, state, value: entries }
}
