/**
 * Rendu Markdown minimal des énoncés de labs : titres, paragraphes, listes (imbriquées),
 * citations, gras et code en ligne. Aucun HTML brut n'est interprété.
 */
import type { ReactNode } from 'react'

/** Texte avec **gras** et `code`. */
function inline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 1)
      return (
        <code key={i} className="rounded-sm bg-surface-2 px-1 font-mono text-dense text-fg">
          {part.slice(1, -1)}
        </code>
      )
    if (part.startsWith('**') && part.endsWith('**') && part.length > 3)
      return (
        <strong key={i} className="font-semibold text-fg">
          {part.slice(2, -2)}
        </strong>
      )
    return part
  })
}

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'list'; ordered: boolean; items: { text: string; depth: number }[] }

function parse(source: string): Block[] {
  const blocks: Block[] = []
  let paragraph: string[] = []
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ kind: 'paragraph', text: paragraph.join(' ') })
    paragraph = []
  }
  for (const raw of source.split('\n')) {
    const line = raw.replace(/\s+$/, '')
    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    const item = /^(\s*)(?:[-*]|\d+\.)\s+(.*)$/.exec(line)
    if (line.trim() === '') flush()
    else if (heading) {
      flush()
      blocks.push({ kind: 'heading', level: heading[1]?.length ?? 1, text: heading[2] ?? '' })
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

export function Markdown({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-2 text-ui leading-relaxed text-fg-muted">
      {parse(text).map((b, i) => {
        switch (b.kind) {
          case 'heading':
            return b.level === 1 ? (
              <h3 key={i} className="mt-1 text-ui font-semibold tracking-wide text-fg uppercase">
                {inline(b.text)}
              </h3>
            ) : (
              <h4 key={i} className="mt-1 text-ui font-semibold text-fg">
                {inline(b.text)}
              </h4>
            )
          case 'quote':
            return (
              <p key={i} className="border-l-2 border-accent bg-accent-soft px-2 py-1 text-dense text-fg">
                {inline(b.text)}
              </p>
            )
          case 'list': {
            const Tag = b.ordered ? 'ol' : 'ul'
            return (
              <Tag key={i} className={`flex flex-col gap-1 pl-5 ${b.ordered ? 'list-decimal' : 'list-disc'}`}>
                {b.items.map((it, j) => (
                  <li
                    key={j}
                    style={{ marginLeft: it.depth * 16 }}
                    className={it.depth > 0 ? 'list-[circle]' : ''}
                  >
                    {inline(it.text)}
                  </li>
                ))}
              </Tag>
            )
          }
          default:
            return <p key={i}>{inline(b.text)}</p>
        }
      })}
    </div>
  )
}
