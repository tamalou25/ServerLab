/**
 * Tests « golden » des consoles (v2.7) : la sortie simulée est comparée, ligne par ligne,
 * à une sortie réelle sourcée rangée dans `docs/captures/<console>/<commande>.txt`.
 *
 * Format d'une capture :
 *   # Source: <URL Microsoft Learn / Cisco, ou « capture Gary, VM WS2022 FR, AAAA-MM-JJ »>
 *   # Commande: <ligne tapée>
 *   <sortie brute, au caractère près>
 *
 * Seules les valeurs dynamiques sont normalisées, et explicitement : l'appelant liste les jetons
 * (`{date}`, `{guid}`…) à remplacer dans les deux sorties avant la comparaison.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const CAPTURES_DIR = resolve(__dirname, '../../../docs/captures')
export const CONSOLES = ['cmd', 'ps', 'ios'] as const
export type Console = (typeof CONSOLES)[number]

/** Valeurs dynamiques normalisables (jamais implicites). */
export const TOKENS = {
  date: /\b\d{2}\/\d{2}\/\d{4}( \d{2}:\d{2}(:\d{2})?)?\b/g,
  guid: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  mac: /\b[0-9a-f]{2}([-:])[0-9a-f]{2}(\1[0-9a-f]{2}){4}\b|\b[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}\b/gi,
  sid: /\bS-1-5(-\d+)+\b/g
} as const
export type Token = keyof typeof TOKENS

export interface Capture {
  source: string
  command: string
  lines: string[]
}

/** Lit une capture (`cmd/ipconfig`) ; l'en-tête `# Source:` est obligatoire. */
export function readCapture(name: string): Capture {
  const raw = readFileSync(join(CAPTURES_DIR, `${name}.txt`), 'utf8').replace(/\r\n/g, '\n')
  return parseCapture(raw, name)
}

export function parseCapture(raw: string, name = 'capture'): Capture {
  const all = raw.split('\n')
  const source = /^# Source: (.+)$/.exec(all[0] ?? '')?.[1]?.trim()
  const command = /^# Commande: (.+)$/.exec(all[1] ?? '')?.[1]?.trim()
  if (!source) throw new Error(`${name} : en-tête « # Source: » manquant`)
  if (!command) throw new Error(`${name} : en-tête « # Commande: » manquant`)
  const lines = all.slice(2)
  // Le saut de ligne final de l'éditeur n'est pas une ligne de sortie.
  if (lines.at(-1) === '') lines.pop()
  return { source, command, lines }
}

export function normalize(lines: string[], tokens: readonly Token[]): string[] {
  return lines.map((l) => tokens.reduce((acc, t) => acc.replace(TOKENS[t], `{${t}}`), l))
}

/**
 * Compare ligne par ligne ; renvoie la liste des écarts (vide = identique).
 * Les espaces de fin de ligne comptent : la fidélité est au caractère près.
 */
export function diffLines(actual: string[], expected: string[]): string[] {
  const out: string[] = []
  const n = Math.max(actual.length, expected.length)
  for (let i = 0; i < n; i++) {
    const a = actual[i]
    const e = expected[i]
    if (a !== e) {
      out.push(`ligne ${i + 1}\n  attendu : ${JSON.stringify(e)}\n  obtenu  : ${JSON.stringify(a)}`)
    }
  }
  return out
}

/** Échoue avec un diff lisible si la sortie simulée diffère de la capture. */
export function expectGolden(output: string | string[], name: string, tokens: readonly Token[] = []): void {
  const expected = normalize(readCapture(name).lines, tokens)
  const actualLines = typeof output === 'string' ? output.replace(/\r\n/g, '\n').split('\n') : output
  if (typeof output === 'string' && actualLines.at(-1) === '') actualLines.pop()
  const diff = diffLines(normalize(actualLines, tokens), expected)
  if (diff.length > 0) throw new Error(`Sortie différente de ${name}.txt :\n${diff.join('\n')}`)
}

/** Toutes les captures présentes (`cmd/ipconfig`…). */
export function listCaptures(): string[] {
  return CONSOLES.flatMap((c) => {
    const dir = join(CAPTURES_DIR, c)
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((f) => f.endsWith('.txt'))
      .map((f) => `${c}/${f.slice(0, -4)}`)
  })
}
