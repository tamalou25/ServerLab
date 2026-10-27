/**
 * Flux de texte d'un terminal, façon `echo` / `fgets` des scripts de la console pfSense : le texte écrit
 * s'ajoute à la ligne courante, un saut de ligne la termine, et la saisie demande l'invite en cours
 * (la ligne partielle). Les scripts d'origine (rc.initial.*) sont ainsi transcrits tels quels,
 * y compris leurs lignes vides.
 */
import { CommandFailure, type ExecContext } from '../context'

export class PfTerm {
  /** Ligne en cours d'écriture (sans saut de ligne final). */
  private partial = ''

  constructor(readonly ctx: ExecContext) {}

  /** Écrit du texte ; chaque `\n` termine une ligne. */
  echo(text: string): void {
    const parts = (this.partial + text).split('\n')
    this.partial = parts.pop() ?? ''
    for (const line of parts) this.ctx.output.push({ text: line, kind: 'out' })
  }

  /** Message sur sa propre ligne (avertissement ou erreur du simulateur). */
  note(text: string, kind: 'error' | 'warning' = 'warning'): void {
    this.flush()
    this.ctx.write(text, kind)
  }

  /** Lit une ligne : la ligne partielle sert d'invite (l'exécution est rejouée avec la réponse). */
  read(): string {
    const prompt = this.partial
    this.partial = ''
    return this.ctx.ask(prompt)
  }

  /** Termine la ligne partielle éventuelle (fin d'une commande). */
  flush(): void {
    if (this.partial !== '') {
      this.ctx.output.push({ text: this.partial, kind: 'out' })
      this.partial = ''
    }
  }

  /** Applique un résultat du moteur ou remonte l'erreur métier. */
  fail(message: string, code = 'PfConsole'): never {
    throw new CommandFailure(message, code)
  }
}

/** Remplissage à droite (printf `%-Ns`). */
export const padEnd = (text: string, width: number): string => text.padEnd(width, ' ')
/** Remplissage à gauche (printf `%Ns`). */
export const padStart = (text: string, width: number): string => text.padStart(width, ' ')
