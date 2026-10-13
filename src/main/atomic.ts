/**
 * Écriture atomique d'un fichier (sans dépendance à Electron, donc testable avec Vitest).
 */
import { promises as fs } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/**
 * Écrit dans un fichier temporaire voisin puis le renomme : évite un fichier tronqué en cas de
 * crash. Si le renommage échoue, le temporaire est supprimé et l'erreur relancée.
 */
export async function writeAtomic(path: string, content: string | Uint8Array): Promise<void> {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`)
  try {
    if (typeof content === 'string') await fs.writeFile(tmp, content, 'utf8')
    else await fs.writeFile(tmp, content)
    await fs.rename(tmp, path)
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw e
  }
}
