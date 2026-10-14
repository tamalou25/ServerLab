/**
 * Types communs aux consoles simulées (PowerShell et Invite de commandes).
 */
import type { LabState } from '../model/schema'
import type { PacketTrace } from '../sim/trace'
import type { PsValue } from './ps/values'
import type { IosSession } from '../ios/cli/types'

/** Interpréteurs : consoles des ordinateurs et console IOS des équipements Cisco. */
export type ShellKind = 'cmd' | 'powershell' | 'bash' | 'ios'

export type LineKind = 'out' | 'error' | 'warning' | 'verbose'

export interface OutputLine {
  text: string
  kind: LineKind
}

/** Session de console (persistée côté interface entre deux commandes). */
export interface ShellSession {
  deviceId: string
  /** Pile des interpréteurs : `powershell` lancé depuis `cmd` revient à `cmd` avec `exit`. */
  stack: ShellKind[]
  cwd: string
  /** Variables PowerShell ($x = …). */
  variables: Record<string, PsValue>
  /**
   * Invite de commandes : variables d'environnement définies par `set` pendant la session
   * (nom tel que saisi → valeur ; null = variable effacée par `set nom=`).
   */
  cmdEnv?: Record<string, string | null>
  /** Console IOS : mode et contexte de configuration. */
  ios?: IosSession
}

/** Saisie demandée à l'utilisateur pendant une commande (mot de passe, confirmation…). */
export interface ShellPrompt {
  message: string
  secure: boolean
}

export interface ShellResult {
  state: LabState
  session: ShellSession
  output: OutputLine[]
  /** Paquets échangés (rejoués en mode Simulation). */
  trace: PacketTrace | null
  /** Effacer l'écran (cls). */
  clear: boolean
  /**
   * Saisie attendue : l'interface affiche l'invite, puis relance la même ligne avec
   * la réponse ajoutée à `answers` (l'exécution est déterministe et rejouée à l'identique).
   */
  prompt: ShellPrompt | null
  /** Fermer la console (exit au niveau le plus haut). */
  exit: boolean
}

/** Erreur « saisie requise » : interrompt l'exécution jusqu'à la réponse de l'utilisateur. */
export class NeedInput extends Error {
  constructor(public readonly prompt: ShellPrompt) {
    super(prompt.message)
    this.name = 'NeedInput'
  }
}

export function out(text: string): OutputLine {
  return { text, kind: 'out' }
}
