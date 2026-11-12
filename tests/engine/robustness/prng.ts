/** Utilitaires communs des tests de robustesse : PRNG à graine fixe (jamais Math.random) et chargement des labs. */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildLabState, parseLab, type LabDefinition, type LabState } from '@engine/index'

/** mulberry32 : mêmes valeurs à chaque exécution pour une graine donnée. */
export function prng(seed: number) {
  let a = seed | 0
  const next = (): number => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int: (n: number): number => Math.floor(next() * n),
    pick<T>(items: readonly T[]): T {
      return items[Math.floor(next() * items.length)] as T
    }
  }
}
export type Rng = ReturnType<typeof prng>

const LABS_DIR = join(__dirname, '../../../labs')

export interface LoadedLab {
  file: string
  def: LabDefinition
  state: LabState
}

let cache: LoadedLab[] | null = null

/** Tous les labs du dossier labs/, avec leur état de départ (chargés une seule fois). */
export function loadAllLabs(): LoadedLab[] {
  if (cache) return cache
  const out: LoadedLab[] = []
  for (const file of readdirSync(LABS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()) {
    const parsed = parseLab(JSON.parse(readFileSync(join(LABS_DIR, file), 'utf8')))
    if (!parsed.ok) throw new Error(`${file} : ${parsed.message}`)
    out.push({ file, def: parsed.lab, state: buildLabState(parsed.lab) })
  }
  cache = out
  return out
}
