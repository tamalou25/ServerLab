/**
 * Mise en forme de la sortie (équivalent d'Out-Default : tables et listes).
 */
import { enumValue, flatten, isPsObject, psToString, type PsObject, type PsValue } from './values'

/** Propriétés affichées par défaut pour un objet. */
function defaultProps(obj: PsObject): string[] {
  return obj.view?.props ?? Object.keys(obj.props)
}

function cell(v: PsValue): string {
  return psToString(v).replace(/\n/g, ' ')
}

/** Formate des objets en table (style PowerShell 5.1). */
export function formatTable(objects: PsObject[], props?: string[]): string[] {
  const first = objects[0]
  if (!first) return []
  const columns = props ?? defaultProps(first)
  const rows = objects.map((o) => columns.map((c) => cell(lookup(o, c))))
  const numeric = columns.map((_, ci) =>
    objects.every((o) => typeof lookup(o, columns[ci] as string) === 'number')
  )
  const widths = columns.map((c, ci) =>
    Math.min(60, Math.max(c.length, ...rows.map((r) => (r[ci] ?? '').length)))
  )
  const pad = (text: string, ci: number) => {
    const w = widths[ci] as number
    const t = text.length > w ? `${text.slice(0, w - 3)}...` : text
    return numeric[ci] ? t.padStart(w) : t.padEnd(w)
  }
  const lines = ['']
  lines.push(
    columns
      .map((c, ci) => pad(c, ci))
      .join(' ')
      .trimEnd()
  )
  lines.push(
    columns
      .map((c, ci) => pad('-'.repeat(c.length), ci))
      .join(' ')
      .trimEnd()
  )
  for (const r of rows)
    lines.push(
      r
        .map((v, ci) => pad(v, ci))
        .join(' ')
        .trimEnd()
    )
  lines.push('')
  return lines
}

/** Formate des objets en liste « Propriété : valeur ». */
export function formatList(objects: PsObject[], props?: string[] | '*'): string[] {
  const lines: string[] = ['']
  for (const o of objects) {
    const keys = props === '*' ? Object.keys(o.props) : (props ?? defaultProps(o))
    const width = Math.max(...keys.map((k) => k.length))
    for (const k of keys) lines.push(`${k.padEnd(width)} : ${cell(lookup(o, k))}`)
    lines.push('')
  }
  return lines
}

function lookup(o: PsObject, name: string): PsValue {
  const lower = name.toLowerCase()
  const key = Object.keys(o.props).find((k) => k.toLowerCase() === lower)
  return key === undefined ? null : (o.props[key] ?? null)
}

/** Sortie par défaut d'une suite de valeurs. */
export function formatDefault(values: PsValue[]): string[] {
  const items = flatten(values)
  const lines: string[] = []
  let i = 0
  while (i < items.length) {
    const item = items[i] as PsValue
    // Valeur d'énumération : affichée par son nom (« Running »)
    if (enumValue(item) !== null) {
      lines.push(psToString(item))
      i++
    } else if (isPsObject(item)) {
      // Regroupe les objets consécutifs de même type
      const group: PsObject[] = [item]
      let j = i + 1
      while (j < items.length) {
        const next = items[j] as PsValue
        if (!isPsObject(next) || next.typeName !== item.typeName) break
        group.push(next)
        j++
      }
      const render = item.view?.render
      if (render) {
        lines.push(...render(group))
        i = j
        continue
      }
      const kind = item.view?.kind ?? (defaultProps(item).length <= 4 ? 'table' : 'list')
      lines.push(...(kind === 'table' ? formatTable(group) : formatList(group)))
      i = j
    } else if (typeof item === 'number' && !Number.isInteger(item)) {
      // Affichage console : ToString() dans la culture courante fr-FR, virgule décimale
      // (about_Quoting_Rules, « Culture settings affect string interpretation »)
      lines.push(psToString(item).replace('.', ','))
      i++
    } else {
      lines.push(...psToString(item).split('\n'))
      i++
    }
  }
  return lines
}
