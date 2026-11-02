/**
 * Mode enseignant (#405) : chaque lab a une solution officielle testée dans un fichier dont le moteur
 * est instrumenté (`instrumentEngine`) ; la solution y est enregistrée en commandes nommées puis
 * rejouée comme le rendu d'un élève, et doit valider 100 % des critères (voir recorder.ts).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..', '..', '..')

function testFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? testFiles(path) : name.endsWith('.test.ts') ? [path] : []
  })
}

const instrumented = testFiles(join(root, 'tests', 'engine'))
  .map((path) => readFileSync(path, 'utf8'))
  .filter((text) => text.includes('instrumentEngine(importOriginal)'))
  .join('\n')

describe('solutions des labs rejouées par le mode enseignant', () => {
  const labs = readdirSync(join(root, 'labs')).filter((f) => /^lab-\d+.*\.json$/.test(f))

  it('les 59 labs sont présents', () => {
    expect(labs.length).toBeGreaterThanOrEqual(59)
  })

  it.each(labs)('%s : solution testée dans un fichier instrumenté', (file) => {
    const id = file.replace(/\.json$/, '')
    expect(instrumented.includes(id) || instrumented.includes(file)).toBe(true)
  })
})
