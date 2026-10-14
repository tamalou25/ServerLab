/**
 * Outils en ligne de commande (ipconfig, ping…) utilisables depuis les deux consoles.
 */
import type { ExecContext } from '../context'
import type { HelpEntry } from '../cmd/help'

export interface ToolDef {
  /** Nom de l'exécutable (sans .exe). */
  name: string
  synopsis: string
  /** Options proposées par la complétion Tab. */
  switches?: string[]
  /** L'outil affiche lui-même son aide `/?` (sinon : message honnête de cmd/help.ts). */
  handlesHelp?: boolean
  /** Syntaxe Microsoft Learn affichée par `/?` (cmd/help.ts). */
  help?: HelpEntry
  available?: (ctx: ExecContext) => boolean
  run: (ctx: ExecContext, args: string[]) => void
}
