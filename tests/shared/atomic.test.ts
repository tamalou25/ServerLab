/** Écriture atomique : contenu, absence de temporaire, nettoyage en cas d'échec du renommage. */
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeAtomic } from '../../src/main/atomic'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'serverlab-atomic-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('writeAtomic', () => {
  it('écrit le contenu sans laisser de .tmp', async () => {
    const cible = join(dir, 'a.json')
    await writeAtomic(cible, 'bonjour é')
    expect(await readFile(cible, 'utf8')).toBe('bonjour é')
    await writeAtomic(cible, new Uint8Array([1, 2, 3]))
    expect([...(await readFile(cible))]).toEqual([1, 2, 3])
    expect(await readdir(dir)).toEqual(['a.json'])
  })

  it('supprime le .tmp et relance l’erreur si le renommage échoue', async () => {
    const cible = join(dir, 'dossier')
    await mkdir(cible)
    await expect(writeAtomic(cible, 'x')).rejects.toBeInstanceOf(Error)
    expect(await readdir(dir)).toEqual(['dossier'])
  })
})
