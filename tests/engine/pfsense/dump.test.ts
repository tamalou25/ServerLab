/**
 * Écrit les captures docs/captures/pfsense/*.txt depuis les scénarios (WRITE_CAPTURES=1). Ne refuse pas
 * d'écraser : à n'utiliser qu'après relecture de la sortie contre les sources citées dans l'en-tête.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { it } from 'vitest'
import { CAPTURES_DIR } from '../golden/golden'
import { SCENARIOS } from './scenarios'

it.skipIf(!process.env.WRITE_CAPTURES)('écrit les captures', () => {
  const dir = join(CAPTURES_DIR, 'pfsense')
  mkdirSync(dir, { recursive: true })
  for (const [name, sc] of Object.entries(SCENARIOS))
    writeFileSync(
      join(dir, `${name}.txt`),
      `# Source: ${sc.source}\n# Commande: ${sc.command}\n${sc.run().join('\n')}\n`
    )
})
