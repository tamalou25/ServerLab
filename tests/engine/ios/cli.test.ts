/**
 * Moteur CLI IOS : modes, invites, abréviations, aide, complétion, erreurs, no et do.
 */
import { describe, expect, it } from 'vitest'
import { IOS_CTRL_Z, iosComplete, iosHelp } from '@engine/index'
import { router } from './helpers'

describe('modes et invites', () => {
  it('navigation complète entre les modes', () => {
    const c = router()
    expect(c.prompt).toBe('R1>')
    c.run('enable')
    expect(c.prompt).toBe('R1#')
    expect(c.run('configure terminal')).toEqual([
      'Enter configuration commands, one per line.  End with CNTL/Z.'
    ])
    expect(c.prompt).toBe('R1(config)#')
    c.run('interface GigabitEthernet0/0')
    expect(c.prompt).toBe('R1(config-if)#')
    c.run('exit')
    expect(c.prompt).toBe('R1(config)#')
    c.run('line vty 0 4')
    expect(c.prompt).toBe('R1(config-line)#')
    c.run('exit')
    c.run('line console 0')
    expect(c.prompt).toBe('R1(config-line)#')
    c.run('router ospf 1')
    expect(c.prompt).toBe('R1(config-router)#')
    expect(c.run('end')).toEqual(['%SYS-5-CONFIG_I: Configured from console by console'])
    expect(c.prompt).toBe('R1#')
    c.run('disable')
    expect(c.prompt).toBe('R1>')
  })

  it('sous-interface : créée à l’entrée en configuration, supprimée par no interface', () => {
    const c = router()
    c.lines('en', 'conf t', 'int g0/0.10')
    expect(c.prompt).toBe('R1(config-subif)#')
    const sub = c.state.devices[c.session.deviceId]?.interfaces.find((i) => i.name === 'Gi0/0.10')
    expect(sub?.subinterface).toEqual({ parent: expect.any(String), vlan: null })
    c.lines('exit', 'no interface Gi0/0.10')
    expect(c.state.devices[c.session.deviceId]?.interfaces.map((i) => i.name)).toEqual(['Gi0/0', 'Gi0/1'])
  })

  it('Ctrl+Z et end reviennent en mode privilégié depuis tout sous-mode', () => {
    const c = router()
    c.lines('en', 'conf t', 'int g0/1')
    expect(c.run(IOS_CTRL_Z)).toEqual(['%SYS-5-CONFIG_I: Configured from console by console'])
    expect(c.prompt).toBe('R1#')
    // Ctrl+Z hors configuration : sans effet
    expect(c.run(IOS_CTRL_Z)).toEqual([])
  })

  it('configure seul demande la source (terminal par défaut)', () => {
    const c = router()
    c.run('en')
    expect(() => c.run('configure')).toThrow('Configuring from terminal, memory, or network [terminal]?')
    expect(c.run('configure', [''])).toEqual([
      'Enter configuration commands, one per line.  End with CNTL/Z.'
    ])
    expect(c.prompt).toBe('R1(config)#')
  })

  it('exit en mode privilégié ferme la session console', () => {
    const c = router()
    c.run('enable')
    expect(c.run('exit')).toContain('R1 con0 is now available')
    expect(c.prompt).toBe('R1>')
  })

  it('repli sur la configuration globale depuis un sous-mode', () => {
    const c = router()
    c.lines('en', 'conf t', 'int g0/0')
    c.run('int g0/1')
    expect(c.prompt).toBe('R1(config-if)#')
    c.run('line vty 0 4')
    expect(c.prompt).toBe('R1(config-line)#')
  })

  it('le prompt suit le nom de l’équipement', () => {
    const c = router('c2811')
    expect(c.prompt).toBe('R1>')
  })
})

describe('abréviations et erreurs', () => {
  it('abréviations non ambiguës', () => {
    const c = router()
    c.lines('en', 'conf t', 'int g0/0')
    expect(c.prompt).toBe('R1(config-if)#')
    c.lines('end', 'conf t', 'int gi 0/1')
    expect(c.prompt).toBe('R1(config-if)#')
    // 2811 : ports FastEthernet
    const r = router('c2811')
    r.lines('en', 'conf t', 'int fa0/1')
    expect(r.prompt).toBe('R1(config-if)#')
  })

  it('% Invalid input detected : marqueur sous le jeton fautif', () => {
    const c = router()
    c.lines('en', 'conf t')
    // R1(config)# = 11 caractères ; « g0/9 » commence à la colonne 10 de la ligne
    expect(c.run('interface g0/9')).toEqual([
      `${' '.repeat(11 + 10)}^`,
      "% Invalid input detected at '^' marker.",
      ''
    ])
    expect(c.prompt).toBe('R1(config)#')
  })

  it('% Incomplete command.', () => {
    const c = router()
    c.lines('en', 'conf t')
    expect(c.run('interface')).toEqual(['% Incomplete command.', ''])
    expect(c.run('line vty')).toEqual(['% Incomplete command.', ''])
  })

  it('% Ambiguous command', () => {
    const c = router()
    expect(c.run('e')).toEqual(['% Ambiguous command: "e"'])
    c.run('en')
    expect(c.lines('conf t', 'l')).toEqual([`% Incomplete command.`, ''])
  })

  it('mot inconnu en mode utilisateur ou privilégié : tentative Telnet', () => {
    const c = router()
    c.run('enable')
    expect(c.run('bonjour')).toEqual([
      'Translating "bonjour"...domain server (255.255.255.255)',
      '% Unknown command or computer name, or unable to find computer address'
    ])
  })

  it('commande d’un autre mode refusée', () => {
    const c = router()
    // configure n'existe qu'en mode privilégié
    expect(c.run('configure terminal')[1]).toBe(
      '% Unknown command or computer name, or unable to find computer address'
    )
    expect(c.prompt).toBe('R1>')
  })

  it('no sur une interface physique refusé', () => {
    const c = router()
    c.lines('en', 'conf t')
    expect(c.run('no interface g0/0')).toEqual(['% Removal of physical interfaces is not permitted'])
  })
})

describe('aide ? et complétion Tab', () => {
  it('« ? » liste les commandes du mode, avec leur aide', () => {
    const c = router()
    expect(iosHelp(c.state, c.session, '')).toEqual([
      '  enable      Turn on privileged commands',
      '  exit        Exit from the EXEC',
      '  ping        Send echo messages',
      '  show        Show running system information',
      '  traceroute  Trace route to destination'
    ])
    c.run('en')
    expect(iosHelp(c.state, c.session, 'configure ')).toEqual([
      '  terminal  Configure from the terminal',
      '  <cr>'
    ])
    expect(iosHelp(c.state, c.session, 'configure terminal ')).toEqual(['  <cr>'])
  })

  it('« mot? » liste les mots-clés qui commencent ainsi', () => {
    const c = router()
    c.run('en')
    expect(iosHelp(c.state, c.session, 'e')).toEqual(['enable  erase  exit  '])
    expect(iosHelp(c.state, c.session, 'zz')).toEqual(['% Unrecognized command'])
  })

  it('aide des arguments : types d’interface, bornes', () => {
    const c = router()
    c.lines('en', 'conf t')
    expect(iosHelp(c.state, c.session, 'interface ')).toEqual([
      '  range            interface range command',
      '  GigabitEthernet  GigabitEthernet IEEE 802.3z'
    ])
    expect(iosHelp(c.state, c.session, 'router ospf ')).toEqual(['  <1-65535>  Process ID'])
    // « no ? » : les commandes de configuration globale qui ont une forme négative
    const no = iosHelp(c.state, c.session, 'no ').map((l) => l.trim().split(/\s+/)[0])
    expect(no).toEqual(expect.arrayContaining(['banner', 'enable', 'interface', 'ip', 'router']))
    expect(no).not.toContain('show')
  })

  it('Tab complète un mot sans ambiguïté', () => {
    const c = router()
    c.run('en')
    expect(iosComplete(c.state, c.session, 'conf')).toEqual({ start: 0, word: 'configure ' })
    expect(iosComplete(c.state, c.session, 'configure t')).toEqual({ start: 10, word: 'terminal ' })
    expect(iosComplete(c.state, c.session, 'e')).toBeNull()
    c.run('conf t')
    expect(iosComplete(c.state, c.session, 'int Gig')).toEqual({ start: 4, word: 'GigabitEthernet ' })
  })
})

describe('do depuis la configuration', () => {
  it('do est proposé dans les modes de configuration, pas en exec', () => {
    const c = router()
    c.run('en')
    expect(iosHelp(c.state, c.session, 'd')).toEqual(['disable  '])
    c.run('conf t')
    expect(iosHelp(c.state, c.session, 'd')).toEqual(['do  '])
    // Les commandes de navigation ne passent pas par do
    expect(c.run('do enable')).toEqual([
      `${' '.repeat(11 + 3)}^`,
      "% Invalid input detected at '^' marker.",
      ''
    ])
  })
})
