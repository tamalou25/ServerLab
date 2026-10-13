/**
 * B8 (v2.7) : « logging synchronous » en config-line (console et vty).
 * Référence (bloc line de la running-config, indentation d'un espace) :
 * https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/sec_conn_dmvpn/configuration/xe-16-9/sec-conn-dmvpn-xe-16-9-book/sec-conn-dmvpn-dmvpn.html
 * (« line con 0 / logging synchronous / line aux 0 / line vty 0 4 »). Ordre relatif à
 * password / login : à vérifier (aucun exemple Cisco ne combine les trois).
 */
import { describe, expect, it } from 'vitest'
import { router } from './helpers'

const lineSection = (run: string[]): string[] => {
  const start = run.indexOf('line con 0')
  const end = run.indexOf('end', start)
  return run.slice(start, end)
}

describe('logging synchronous', () => {
  it('accepté sur line con 0, affiché sous le bloc comme dans l’exemple Cisco', () => {
    const c = router()
    c.lines('enable', 'configure terminal', 'line con 0')
    expect(c.run('logging synchronous')).toEqual([])
    c.run('end')
    expect(lineSection(c.run('show running-config')).slice(0, 4)).toEqual([
      'line con 0',
      ' logging synchronous',
      'line aux 0',
      'line vty 0 4'
    ])
  })

  it('accepté sur les vty ; « no logging synchronous » le retire', () => {
    const c = router()
    c.lines('enable', 'configure terminal', 'line vty 0 4', 'logging synchronous', 'end')
    expect(c.run('show running-config')).toContain(' logging synchronous')
    c.lines('configure terminal', 'line vty 0 4', 'no logging synchronous', 'end')
    expect(c.run('show running-config')).not.toContain(' logging synchronous')
  })

  it('mot-clé erroné : « ^ » sous « synchronus »', () => {
    const c = router()
    c.lines('enable', 'configure terminal', 'line con 0')
    const prompt = c.prompt
    const line = 'logging synchronus'
    const out = c.run(line)
    expect(out[0]).toBe(`${' '.repeat(prompt.length + line.indexOf('synchronus'))}^`)
    expect(out[1]).toBe("% Invalid input detected at '^' marker.")
  })
})
