/**
 * B7 (v2.7) : mot-clé final « log » / « log-input » des entrées d'ACL.
 * Sorties de référence (lignes reprises telles quelles des pages Cisco) :
 * - show access-list : « 70 permit ip host 10.3.3.3 any log »
 *   https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/sec_data_acl/configuration/15-mt/sec-data-acl-15-mt-book/sec-acl-seq-num.html
 * - running-config : « access-list 1 deny 172.30.0.0 0.0.255.255 log »,
 *   « access-list 2 permit 172.27.3.4 log »
 *   https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/sec_data_acl/configuration/15-mt/sec-data-acl-15-mt-book/sec-create-ip-apply.html
 */
import { describe, expect, it } from 'vitest'
import { router } from './helpers'

describe('ACL : journalisation (log, log-input)', () => {
  it('étendue nommée : « log » accepté, affiché comme dans show access-list Cisco', () => {
    const c = router()
    c.lines('enable', 'configure terminal', 'ip access-list extended 150')
    expect(c.run('70 permit ip host 10.3.3.3 any log')).toEqual([])
    c.lines('end')
    expect(c.run('show access-lists 150')).toEqual([
      'Extended IP access list 150',
      '    70 permit ip host 10.3.3.3 any log'
    ])
  })

  it('« deny ip any any log » (numérotée) : stockée et réécrite dans la running-config', () => {
    const c = router()
    c.lines('enable', 'configure terminal')
    expect(c.run('access-list 110 deny ip any any log')).toEqual([])
    c.run('access-list 110 permit tcp any host 10.0.0.1 eq 80 log-input')
    c.run('end')
    const run = c.run('show running-config')
    expect(run).toContain('access-list 110 deny ip any any log')
    expect(run).toContain('access-list 110 permit tcp any host 10.0.0.1 eq www log-input')
    expect(c.run('show access-lists')).toEqual([
      'Extended IP access list 110',
      '    10 deny ip any any log',
      '    20 permit tcp any host 10.0.0.1 eq www log-input'
    ])
  })

  it('standard : « log » accepté, lignes de running-config identiques à l’exemple Cisco', () => {
    const c = router()
    c.lines(
      'enable',
      'configure terminal',
      'access-list 1 permit 172.25.0.0 0.0.255.255 log',
      'access-list 1 deny 172.30.0.0 0.0.255.255 log',
      'access-list 2 permit 172.27.3.4 log',
      'end'
    )
    const run = c.run('show running-config')
    for (const line of [
      'access-list 1 permit 172.25.0.0 0.0.255.255 log',
      'access-list 1 deny 172.30.0.0 0.0.255.255 log',
      'access-list 2 permit 172.27.3.4 log'
    ])
      expect(run).toContain(line)
  })

  it('standard : « log-input » refusé (option des listes étendues uniquement)', () => {
    const c = router()
    c.lines('enable', 'configure terminal')
    expect(c.run('access-list 1 permit any log-input').at(-2)).toBe("% Invalid input detected at '^' marker.")
  })

  it('« no » retire l’entrée journalisée', () => {
    const c = router()
    c.lines('enable', 'configure terminal', 'ip access-list extended WEB', 'deny ip any any log')
    c.run('no deny ip any any log')
    c.run('end')
    expect(c.run('show access-lists WEB')).toEqual(['Extended IP access list WEB'])
  })

  it('mot-clé erroné : « ^ » sous le premier caractère de « logg »', () => {
    const c = router()
    c.lines('enable', 'configure terminal')
    const prompt = c.prompt
    const line = 'access-list 110 deny ip any any logg'
    const out = c.run(line)
    expect(out[0]).toBe(`${' '.repeat(prompt.length + line.indexOf('logg'))}^`)
    expect(out[1]).toBe("% Invalid input detected at '^' marker.")
  })
})
