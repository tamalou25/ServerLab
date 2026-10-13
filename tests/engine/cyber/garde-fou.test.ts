/**
 * Garde-fou cyber (docs/fidelite.md) : le moteur ne contient aucun code offensif réel ni accès
 * réseau/processus. Toute attaque est simulée de façon abstraite sur l'état.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const RACINE = join(__dirname, '..', '..', '..', 'src', 'engine')

const INTERDITS: RegExp[] = [
  /createHash/i,
  /crypto\.subtle/i,
  /md4/i,
  /ntlm/i,
  /fetch\(/,
  /WebSocket/,
  /XMLHttpRequest/,
  /child_process/
]

function fichiersTs(dir: string): string[] {
  return readdirSync(dir).flatMap((nom) => {
    const chemin = join(dir, nom)
    if (statSync(chemin).isDirectory()) return fichiersTs(chemin)
    return chemin.endsWith('.ts') ? [chemin] : []
  })
}

/** Retire commentaires et chaînes : seuls le code et les identifiants comptent. */
function codeSeul(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g, "''")
}

describe('garde-fou cyber', () => {
  it('aucun primitif de hachage, réseau ou processus dans src/engine', () => {
    const fichiers = fichiersTs(RACINE)
    expect(fichiers.length).toBeGreaterThan(50)
    const violations: string[] = []
    for (const f of fichiers) {
      const code = codeSeul(readFileSync(f, 'utf8'))
      for (const motif of INTERDITS) if (motif.test(code)) violations.push(`${f} : ${motif}`)
    }
    expect(violations).toEqual([])
  })
})
