/**
 * Filtres de sortie IOS : | include, | exclude, | begin, | section, | count et abréviations.
 *
 * Sources :
 * - https://www.cisco.com/c/en/us/td/docs/ios/fundamentals/command/reference/cf_book/cf_s1.html
 *   (show | begin, | exclude, | include, | section [include | exclude] ; include par défaut)
 * - https://www.cisco.com/c/en/us/td/docs/ios/fundamentals/configuration/guide/12_2sr/cf_12_2sr_book/cf_cli-basics.html
 *   (expressions régulières : sensibles à la casse, `_`, ^, $, [ ], parenthèses)
 * - https://www.cisco.com/c/en/us/td/docs/security/asa/asa-cli-reference/A-H/asa-command-ref-A-H/cli-usage.html
 *   (format « Number of lines which match regexp = N »)
 */
import { describe, expect, it } from 'vitest'
import { iosRegex } from '@engine/ios/cli/filter'
import { router } from './helpers'

function r1() {
  const c = router()
  c.lines('en', 'conf t', 'int g0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'end')
  return c
}

const CARET = (col: number): string[] => [
  `${' '.repeat(col)}^`,
  "% Invalid input detected at '^' marker.",
  ''
]

describe('filtres de sortie', () => {
  it('| include : lignes calculées depuis l’état du lab', () => {
    const c = r1()
    const brief = c.run('show ip interface brief')
    expect(c.run('show ip interface brief | include 10.0.0.1')).toEqual(
      brief.filter((l) => l.includes('10.0.0.1'))
    )
    expect(c.run('show ip interface brief | include 10.0.0.1')).toHaveLength(1)
  })

  it('abréviations i, inc, e, b, s, c', () => {
    const c = r1()
    const inc = c.run('show running-config | include interface')
    expect(inc).toEqual(['interface GigabitEthernet0/0', 'interface GigabitEthernet0/1'])
    expect(c.run('sh run | i interface')).toEqual(inc)
    expect(c.run('sh run | inc interface')).toEqual(inc)
    expect(c.run('sh run | e !').some((l) => l === '!')).toBe(false)
    expect(c.run('sh run | b ^line')).toEqual([
      'line con 0',
      'line aux 0',
      'line vty 0 4',
      ' login',
      '!',
      'end'
    ])
    expect(c.run('sh run | s vty')).toEqual(['line vty 0 4', ' login'])
    expect(c.run('sh run | c interface')).toEqual(['Number of lines which match regexp = 2'])
  })

  it('| exclude et sensibilité à la casse', () => {
    const c = r1()
    expect(c.run('show running-config | include INTERFACE')).toEqual([])
    expect(c.run('show running-config | exclude ^ ').every((l) => !l.startsWith(' '))).toBe(true)
  })

  it('| section : bloc indenté de chaque ligne correspondante ; include par défaut, exclude', () => {
    const c = r1()
    const sec = c.run('show running-config | section interface')
    expect(sec).toEqual([
      'interface GigabitEthernet0/0',
      ' ip address 10.0.0.1 255.255.255.0',
      ' duplex auto',
      ' speed auto',
      'interface GigabitEthernet0/1',
      ' no ip address',
      ' shutdown',
      ' duplex auto',
      ' speed auto'
    ])
    expect(c.run('show running-config | section include interface')).toEqual(sec)
    const ex = c.run('show running-config | section exclude interface')
    expect(ex.some((l) => l.includes('interface') || l === ' speed auto')).toBe(false)
    expect(ex).toContain('hostname R1')
  })

  it('| count sans expression : toutes les lignes', () => {
    const c = r1()
    const all = c.run('show running-config').length
    expect(c.run('show running-config | count')).toEqual([`Number of lines which match regexp = ${all}`])
  })

  it('do show … | … depuis un mode de configuration', () => {
    const c = r1()
    c.lines('conf t', 'int g0/1')
    expect(c.run('do show running-config | include hostname')).toEqual(['hostname R1'])
    expect(c.prompt).toBe('R1(config-if)#')
  })

  it('| begin : rien si aucune ligne ne correspond', () => {
    expect(r1().run('show running-config | begin zzz')).toEqual([])
  })

  it('filtre inconnu : ^ sous le mot', () => {
    expect(r1().run('show running-config | foo')).toEqual(CARET('R1#show running-config | '.length))
  })

  it('expression manquante : % Incomplete command.', () => {
    expect(r1().run('show running-config | include')).toEqual(['% Incomplete command.', ''])
  })

  it('commande invalide avant le | : ^ sous le mot fautif', () => {
    expect(r1().run('show runx | include a')).toEqual(CARET('R1#show '.length))
  })

  it('filtres réels non simulés (tee, redirect…) : message honnête', () => {
    expect(r1().run('show running-config | tee flash:x')).toEqual([
      '% « tee » est une fonction réelle d’IOS qui n’est pas simulée dans ServerLab.'
    ])
  })

  it('| hors show : caractère ordinaire (description)', () => {
    const c = r1()
    c.lines('conf t', 'int g0/1', 'description A | B', 'end')
    expect(c.run('show running-config | include description')).toEqual([' description A | B'])
  })
})

describe('expressions régulières IOS', () => {
  it('_ : espace, virgule, accolade, parenthèse, début ou fin', () => {
    const re = iosRegex('_1300_')
    expect(re.test('{1300 ')).toBe(true)
    expect(re.test('as 1300')).toBe(true)
    expect(re.test('21300')).toBe(false)
    expect(re.test('13000')).toBe(false)
    expect(iosRegex('a\\_b').test('a_b')).toBe(true)
  })

  it('( is ) : espaces littéraux, classes et ancres', () => {
    expect(iosRegex('( is )').test('Ethernet0 is up')).toBe(true)
    expect(iosRegex('( is )').test('disconnect')).toBe(false)
    expect(iosRegex('[Oo]utput').test('Output')).toBe(true)
    expect(iosRegex('^con').test('console')).toBe(true)
  })
})
