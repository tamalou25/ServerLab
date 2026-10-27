// Usage : node scripts/contrast-tokens.mjs src/renderer/src/styles.css (échec si un ratio est insuffisant)
// Calcule les ratios de contraste des tokens v2 (lus dans styles.css) : texte ≥ 4,5, éléments graphiques ≥ 3.
import fs from 'node:fs'
const css = fs.readFileSync(process.argv[2], 'utf8')
const block = (sel) => {
  const i = css.indexOf(sel)
  const j = css.indexOf('}', i)
  const o = {}
  for (const m of css.slice(i, j).matchAll(/--sl-([\w-]+):\s*(#[0-9a-f]{6})/g)) o[m[1]] = m[2]
  return o
}
const L = (h) => {
  const c = [1, 3, 5]
    .map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}
const r = (a, b) => {
  const [x, y] = [L(a), L(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}
const rows = []
let fail = 0
for (const [th, sel] of [
  ['sombre', ":root,\n[data-theme='dark']"],
  ['clair', "[data-theme='light'] {"]
]) {
  const t = block(sel)
  const chk = (fg, bgs, min) => {
    const v = bgs.map((b) => r(t[fg], t[b]))
    const ok = v.every((x) => x >= min)
    if (!ok) fail++
    rows.push(
      `| ${th} | ${fg} \`${t[fg]}\` | ${bgs.map((b, i) => `${b} ${v[i].toFixed(2)}`).join(' · ')} | ${min} | ${ok ? '✅' : '❌'} |`
    )
  }
  for (const f of [
    'fg',
    'fg-muted',
    'fg-subtle',
    'accent-text',
    'ok-text',
    'warn-text',
    'danger-text',
    'info-text'
  ])
    chk(f, ['panel', 'surface', 'surface-2', 'canvas'], 4.5)
  chk('on-accent', ['accent', 'accent-hover'], 4.5)
  chk('on-danger', ['danger'], 4.5)
  for (const f of ['ok', 'warn', 'danger', 'idle', 'focus']) chk(f, ['panel', 'canvas'], 3)
}
console.log('| Thème | Token | Fond : ratio | Min | |\n|---|---|---|---|---|\n' + rows.join('\n'))
process.exit(fail ? 1 : 0)
