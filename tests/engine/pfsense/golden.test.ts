/**
 * Tests golden de la console pfSense (v2.10, #247) : chaque capture de docs/captures/pfsense/ est rejouée
 * sur le laboratoire type et comparée ligne par ligne (seules les adresses MAC sont normalisées).
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CAPTURES_DIR, expectGolden, readCapture } from '../golden/golden'
import { SCENARIOS } from './scenarios'

describe('console pfSense : sorties de référence', () => {
  for (const [name, scenario] of Object.entries(SCENARIOS))
    it(name, () => {
      expect(readCapture(`pfsense/${name}`).command).toBe(scenario.command)
      expectGolden(scenario.run(), `pfsense/${name}`, ['mac'])
    })

  it('chaque capture a son scénario', () => {
    const files = readdirSync(join(CAPTURES_DIR, 'pfsense')).map((f) => f.slice(0, -4))
    expect(files.sort()).toEqual(Object.keys(SCENARIOS).sort())
  })
})
