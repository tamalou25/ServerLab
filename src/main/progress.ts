/**
 * Progression de l'élève (userData/progress.json) : tentatives terminées (labs réussis, examens,
 * dépannages) lues au démarrage et réécrites de façon atomique. Le contenu est validé par le schéma
 * du moteur (entrées invalides écartées une à une, fichier corrompu → progression vide) ; le renderer
 * n'écrit jamais le fichier lui-même, il envoie des tentatives que le main valide.
 */
import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { addAttempt, serializeProgress, type ProgressAttempt } from '../engine/labs/progress'
import { parseAttempt, parseProgressFile } from '../shared/persisted'
import { writeAtomic } from './atomic'

export class ProgressStore {
  private attempts: ProgressAttempt[] = []

  private get path(): string {
    return join(app.getPath('userData'), 'progress.json')
  }

  async init(): Promise<void> {
    try {
      this.attempts = parseProgressFile(await fs.readFile(this.path, 'utf8'))
    } catch {
      // Fichier absent ou illisible : progression vide, le fichier sera recréé à la première tentative
      this.attempts = []
    }
  }

  list(): ProgressAttempt[] {
    return this.attempts
  }

  /** Tentative reçue du renderer (non fiable) : validée, ajoutée puis enregistrée. */
  async record(value: unknown): Promise<ProgressAttempt[]> {
    const attempt = parseAttempt(value)
    if (!attempt) return this.attempts
    this.attempts = addAttempt(this.attempts, attempt)
    await this.persist()
    return this.attempts
  }

  async reset(): Promise<ProgressAttempt[]> {
    this.attempts = []
    await this.persist()
    return this.attempts
  }

  private async persist(): Promise<void> {
    try {
      await fs.mkdir(dirname(this.path), { recursive: true })
      await writeAtomic(this.path, serializeProgress(this.attempts))
    } catch {
      // Non bloquant : la progression reste en mémoire pour la session
    }
  }
}
