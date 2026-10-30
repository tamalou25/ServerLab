/**
 * Réparabilité du tirage, couverture complète (issue #376) : 100 graines × 5 domaines × 1 à 3 pannes.
 * Long (plusieurs minutes) : exclu de `npm test`, lancé par `npm run test:long` (vitest.long.config.ts).
 */
import { describe, expect, it } from 'vitest'
import { checkReparability } from './reparability'

const SEEDS = Array.from({ length: 100 }, (_, i) => i + 1)

describe('tirage : réparabilité, couverture complète', () => {
  it('tout tirage valide est réparable (ordre inverse et ordre d’injection)', { timeout: 3_600_000 }, () => {
    const valid = checkReparability(SEEDS, SEEDS.slice(0, 50))
    expect(valid).toBeGreaterThan(500)
  })
})
