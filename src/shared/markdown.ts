/**
 * Analyse Markdown minimale des énoncés de labs et de sujets (pure, testée) : titres, paragraphes,
 * listes imbriquées, citations, tableaux, gras et code en ligne. Aucun HTML brut n'est interprété :
 * le rendu (components/labs/Markdown.tsx) construit des éléments React depuis ces blocs.
 */

export type Inline =
  { kind: 'text'; text: string } | { kind: 'code'; text: string } | { kind: 'strong'; text: string }

export type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'list'; ordered: boolean; items: { text: string; depth: number }[] }
  | { kind: 'table'; header: string[]; rows: string[][] }

/** Texte avec **gras** et `code`. */
export function parseInline(text: string): Inline[] {
  return text
    .split(/(`[^`]+`|\*\*[^*]+\*\*)/g)
    .filter((part) => part !== '')
    .map((part) => {
      if (part.startsWith('`') && part.endsWith('`') && part.length > 1)
        return { kind: 'code', text: part.slice(1, -1) }
      if (part.startsWith('**') && part.endsWith('**') && part.length > 3)
        return { kind: 'strong', text: part.slice(2, -2) }
      return { kind: 'text', text: part }
    })
}

/** Ligne de tableau « | a | b | » → cellules (barres extérieures facultatives). */
function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())
}

const SEPARATOR = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/
const TABLE_LINE = /^\s*\|.*\|\s*$/

export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = []
  let paragraph: string[] = []
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ kind: 'paragraph', text: paragraph.join(' ') })
    paragraph = []
  }
  const lines = source.split('\n').map((raw) => raw.replace(/\s+$/, ''))
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    const item = /^(\s*)(?:[-*]|\d+\.)\s+(.*)$/.exec(line)
    const next = lines[i + 1]
    if (line.trim() === '') flush()
    else if (heading) {
      flush()
      blocks.push({ kind: 'heading', level: heading[1]?.length ?? 1, text: heading[2] ?? '' })
    } else if (TABLE_LINE.test(line) && next !== undefined && SEPARATOR.test(next)) {
      // Tableau : en-tête, séparateur, puis lignes « | … | » contiguës
      flush()
      const header = cells(line)
      const rows: string[][] = []
      let j = i + 2
      while (j < lines.length && TABLE_LINE.test(lines[j]!)) {
        const row = cells(lines[j]!)
        // Lignes alignées sur l'en-tête (cellules manquantes vides, surplus ignoré)
        rows.push(header.map((_, k) => row[k] ?? ''))
        j++
      }
      blocks.push({ kind: 'table', header, rows })
      i = j - 1
    } else if (line.startsWith('>')) {
      flush()
      blocks.push({ kind: 'quote', text: line.replace(/^>\s?/, '') })
    } else if (item) {
      flush()
      const ordered = /^\s*\d+\./.test(line)
      const entry = { text: item[2] ?? '', depth: Math.floor((item[1]?.length ?? 0) / 2) }
      const last = blocks[blocks.length - 1]
      if (last?.kind === 'list' && (entry.depth > 0 || last.ordered === ordered)) last.items.push(entry)
      else blocks.push({ kind: 'list', ordered, items: [entry] })
    } else paragraph.push(line.trim())
  }
  flush()
  return blocks
}
