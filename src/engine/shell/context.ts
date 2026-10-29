/**
 * Contexte d'exécution partagé par les deux consoles :
 * état du lab, sortie, traces de paquets et saisies interactives rejouables.
 */
import type { EngineResult } from '../core/result'
import { DEFAULT_LOCAL_USER } from '../model/factory'
import type { Device, HostDevice, LabState } from '../model/schema'
import { concatTraces, type PacketTrace } from '../sim/trace'
import { NeedInput, type LineKind, type OutputLine, type ShellSession } from './types'

/** Erreur métier remontée par une commande (le shell la met en forme). */
export class CommandFailure extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly category = 'InvalidOperation',
    public readonly target?: string
  ) {
    super(message)
    this.name = 'CommandFailure'
  }
}

export class ExecContext {
  readonly output: OutputLine[] = []
  readonly traces: PacketTrace[] = []
  clear = false
  exit = false
  /** Console bash : commande lancée avec sudo (droits root). */
  root = false
  /** Console bash : sortie standard de l'étape précédente d'un tube (null = aucune). */
  stdin: string[] | null = null
  private answerIndex = 0

  constructor(
    public state: LabState,
    public session: ShellSession,
    private readonly answers: string[]
  ) {}

  get deviceId(): string {
    return this.session.deviceId
  }

  get device(): Device {
    const d = this.state.devices[this.session.deviceId]
    if (!d) throw new CommandFailure('L’ordinateur n’existe plus dans la topologie.', 'DeviceNotFound')
    return d
  }

  /** Serveur ou poste exécutant la console. */
  get host(): HostDevice {
    const d = this.device
    if (d.kind !== 'server' && d.kind !== 'client')
      throw new CommandFailure('Console indisponible sur cet équipement.', 'NotSupported')
    return d
  }

  /** Utilisateur de la session (nom affiché par whoami). */
  get user(): { name: string; domain: string | null } {
    const session = this.host.host.session
    if (session) return { name: session.user, domain: session.domain }
    return { name: DEFAULT_LOCAL_USER[this.host.kind], domain: null }
  }

  write(text: string, kind: LineKind = 'out'): void {
    for (const line of text.split('\n')) this.output.push({ text: line, kind })
  }

  writeLines(lines: string[], kind: LineKind = 'out'): void {
    for (const line of lines) this.output.push({ text: line, kind })
  }

  warn(text: string): void {
    this.write(`AVERTISSEMENT : ${text}`, 'warning')
  }

  /**
   * Demande une saisie. Si la réponse n'est pas encore connue, l'exécution est suspendue :
   * l'interface rejouera la ligne avec la réponse fournie.
   */
  ask(message: string, secure = false): string {
    if (this.answerIndex < this.answers.length) {
      const answer = this.answers[this.answerIndex] as string
      this.answerIndex++
      return answer
    }
    throw new NeedInput({ message, secure })
  }

  /** Applique un résultat du moteur ou lève l'erreur métier correspondante. */
  apply<T>(result: EngineResult<T>): T {
    if (!result.ok) throw new CommandFailure(result.error.message, result.error.code)
    this.state = result.state
    return result.value
  }

  addTrace(trace: PacketTrace): void {
    if (trace.events.length > 0) this.traces.push(trace)
  }

  /** Fusionne les traces de la ligne de commande en une seule (pas décalés). */
  mergedTrace(title: string): PacketTrace | null {
    if (this.traces.length === 0) return null
    if (this.traces.length === 1) return this.traces[0] as PacketTrace
    return concatTraces(title, this.traces)
  }
}
