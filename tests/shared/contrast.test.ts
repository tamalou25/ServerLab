/**
 * Contrastes des design tokens (styles.css) : texte lisible (WCAG AA, 4,5:1) dans les deux thèmes
 * pour les paires utilisées par l'interface (audit U-03, U-04).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(join(__dirname, '../../src/renderer/src/styles.css'), 'utf8')

/** Tokens `--sl-*` d'un bloc de thème (premier bloc dont le sélecteur contient `selector`). */
function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(selector)
  const block = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start))
  return Object.fromEntries(
    [...block.matchAll(/--sl-([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1]!, m[2]!])
  )
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

/** [texte, fond] : texte secondaire sur les fonds courants, libellés des boutons pleins. */
const PAIRS: [string, string][] = [
  ['fg-subtle', 'app'],
  ['fg-subtle', 'panel'],
  ['fg-subtle', 'surface'],
  ['fg-subtle', 'surface-2'],
  ['fg-subtle', 'surface-3'],
  ['fg-muted', 'panel'],
  ['fg-muted', 'surface-2'],
  ['on-accent', 'accent'],
  ['on-accent', 'accent-hover'],
  ['on-danger', 'danger'],
  // Libellé posé sur la teinte de chaque catégorie d'équipement (audit X-01)
  ...['server', 'client', 'switch', 'router', 'cloud', 'firewall'].map((k): [string, string] => [
    'on-kind',
    `kind-${k}`
  ])
]

describe.each([
  ['sombre', ":root,\n[data-theme='dark']"],
  ['clair', "[data-theme='light'] {"]
])('contrastes du thème %s', (_name, selector) => {
  const t = tokens(selector)
  it.each(PAIRS)('%s sur %s ≥ 4,5:1', (fg, bg) => {
    expect(t[fg], fg).toBeDefined()
    expect(t[bg], bg).toBeDefined()
    expect(contrast(t[fg]!, t[bg]!)).toBeGreaterThanOrEqual(4.5)
  })
})
