import { describe, expect, it } from 'vitest'
import { parseInline, parseMarkdown } from '@shared/markdown'

describe('parseMarkdown', () => {
  it('titres, paragraphes sur plusieurs lignes, citations et listes imbriquées', () => {
    const blocks = parseMarkdown(
      '# Contexte\n\nLigne 1\nligne 2\n\n> Astuce\n\n1. un\n2. deux\n  - sous\n- autre'
    )
    expect(blocks).toEqual([
      { kind: 'heading', level: 1, text: 'Contexte' },
      { kind: 'paragraph', text: 'Ligne 1 ligne 2' },
      { kind: 'quote', text: 'Astuce' },
      {
        kind: 'list',
        ordered: true,
        items: [
          { text: 'un', depth: 0 },
          { text: 'deux', depth: 0 },
          { text: 'sous', depth: 1 }
        ]
      },
      { kind: 'list', ordered: false, items: [{ text: 'autre', depth: 0 }] }
    ])
  })

  it('tableau : en-tête, séparateur, lignes alignées sur l’en-tête (lab 28)', () => {
    const blocks = parseMarkdown(
      '| Équipement | Interface | Adresse |\n| --- | :---: | ---: |\n| R1 | Gi0/0 | 192.168.10.254/24 |\n| PC1 | Ethernet0 |\n\nSuite.'
    )
    expect(blocks).toEqual([
      {
        kind: 'table',
        header: ['Équipement', 'Interface', 'Adresse'],
        rows: [
          ['R1', 'Gi0/0', '192.168.10.254/24'],
          ['PC1', 'Ethernet0', '']
        ]
      },
      { kind: 'paragraph', text: 'Suite.' }
    ])
  })

  it('une ligne à barres sans séparateur reste un paragraphe ; aucun HTML interprété', () => {
    expect(parseMarkdown('| a | b |\nsuite')).toEqual([{ kind: 'paragraph', text: '| a | b | suite' }])
    expect(parseMarkdown('<b>x</b>')).toEqual([{ kind: 'paragraph', text: '<b>x</b>' }])
  })

  it('gras et code en ligne', () => {
    expect(parseInline('Tapez `ping` sur **PC1**.')).toEqual([
      { kind: 'text', text: 'Tapez ' },
      { kind: 'code', text: 'ping' },
      { kind: 'text', text: ' sur ' },
      { kind: 'strong', text: 'PC1' },
      { kind: 'text', text: '.' }
    ])
  })
})
