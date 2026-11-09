/**
 * Rendu des énoncés (blocs analysés par shared/markdown.ts) : titres, paragraphes, listes imbriquées,
 * citations, tableaux, gras et code en ligne. Aucun HTML brut n'est interprété. Texte courant en
 * `text-body` (14 px, 13 px en densité Compact).
 */
import type { ReactNode } from 'react'
import { parseInline, parseMarkdown } from '@shared/markdown'

/** Texte avec **gras** et `code`. */
function inline(text: string): ReactNode[] {
  return parseInline(text).map((part, i) => {
    if (part.kind === 'code')
      return (
        <code key={i} className="rounded-sm bg-surface-2 px-1 font-mono text-dense text-fg">
          {part.text}
        </code>
      )
    if (part.kind === 'strong')
      return (
        <strong key={i} className="font-semibold text-fg">
          {part.text}
        </strong>
      )
    return part.text
  })
}

export function Markdown({ text, className = '' }: { text: string; className?: string }) {
  return (
    <div className={`flex flex-col gap-2.5 text-body text-fg-muted ${className}`}>
      {parseMarkdown(text).map((b, i) => {
        switch (b.kind) {
          case 'heading':
            return b.level === 1 ? (
              <h3 key={i} className="mt-2 text-meta font-semibold tracking-wider text-fg-subtle uppercase">
                {inline(b.text)}
              </h3>
            ) : (
              <h4 key={i} className="mt-1 text-ui font-semibold text-fg">
                {inline(b.text)}
              </h4>
            )
          case 'quote':
            return (
              <p
                key={i}
                className="rounded-r-control border-l-2 border-accent bg-accent-soft px-3 py-1.5 text-dense text-fg"
              >
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
          case 'table':
            return (
              <div key={i} className="overflow-x-auto rounded-panel border border-line">
                <table className="w-full border-collapse text-dense">
                  <thead>
                    <tr className="bg-surface-2 text-left text-meta font-semibold tracking-wider text-fg-subtle uppercase">
                      {b.header.map((h, k) => (
                        <th key={k} className="px-2.5 py-1.5">
                          {inline(h)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((row, r) => (
                      <tr key={r} className="border-t border-line text-fg">
                        {row.map((cell, k) => (
                          <td key={k} className="selectable px-2.5 py-1.5 align-top">
                            {inline(cell)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          default:
            return <p key={i}>{inline(b.text)}</p>
        }
      })}
    </div>
  )
}
