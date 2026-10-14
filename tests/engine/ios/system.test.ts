/**
 * Administration du système IOS (lot 4a) : horloge, NTP, exec-timeout, terminal length, show
 * running-config interface, show interfaces description, show history, show users, show protocols,
 * show privilege, show hosts. Sources Cisco en commentaire de chaque test.
 */
import { describe, expect, it } from 'vitest'
import { router } from './helpers'

const NOT_SIMULATED = (name: string) =>
  `% « ${name} » est une fonction réelle d’IOS qui n’est pas simulée dans ServerLab.`

describe('show running-config interface', () => {
  // https://www.cisco.com/c/en/us/td/docs/ios/fundamentals/command/reference/cf_book/cf_s1.html
  it('affiche la seule section de l’interface, calculée depuis l’état', () => {
    const c = router()
    c.lines('en', 'conf t', 'int g0/0', 'description LAN', 'ip address 10.0.0.1 255.255.255.0', 'end')
    const body = [
      '!',
      'interface GigabitEthernet0/0',
      ' description LAN',
      ' ip address 10.0.0.1 255.255.255.0',
      ' shutdown',
      ' duplex auto',
      ' speed auto',
      'end'
    ]
    const bytes = body.reduce((n, l) => n + l.length + 1, 0)
    expect(c.run('show running-config interface g0/0')).toEqual([
      'Building configuration...',
      '',
      `Current configuration : ${bytes} bytes`,
      ...body
    ])
  })

  it('interface inexistante : marqueur ^ sous le nom', () => {
    const c = router()
    c.run('en')
    expect(c.run('show running-config interface g0/9')).toEqual([
      `${' '.repeat(33)}^`,
      "% Invalid input detected at '^' marker.",
      ''
    ])
  })

  it('mode utilisateur : commande refusée', () => {
    const c = router()
    expect(c.run('show running-config interface g0/0')[1]).toBe("% Invalid input detected at '^' marker.")
  })
})

describe('sauvegarde et reload', () => {
  it('write memory puis show startup-config ; erase + reload repart des valeurs d’usine', () => {
    const c = router()
    c.lines('en', 'conf t', 'hostname R9', 'end', 'write memory')
    expect(c.run('show startup-config')).toContain('hostname R9')
    c.run('erase startup-config', [''])
    expect(c.run('show startup-config')).toEqual(['startup-config is not present'])
  })

  it('reload revient à la configuration sauvegardée', () => {
    const c = router()
    c.lines('en', 'conf t', 'int g0/0', 'description SAUVE', 'end')
    c.run('copy running-config startup-config', [''])
    c.lines('conf t', 'int g0/0', 'description PERDUE', 'end')
    c.run('reload', ['no', ''])
    c.run('en')
    expect(c.run('show interfaces description')[1]).toContain('SAUVE')
  })
})

describe('horloge', () => {
  // https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/bsm/configuration/15-mt/bsm-15-mt-book/bsm-time-calendar-set.html
  it('show clock : heure non fiable (*) avant clock set, au format IOS', () => {
    const c = router()
    expect(c.run('show clock')).toEqual(['*08:00:00.000 UTC Mon Jan 5 2026'])
    c.run('en')
    expect(c.run('show clock detail')).toEqual([
      '*08:00:00.000 UTC Mon Jan 5 2026',
      'Time source is hardware calendar'
    ])
  })

  it('clock set (jour mois ou mois jour) puis clock timezone', () => {
    const c = router()
    c.lines('en', 'clock set 12:12:12 1 january 2011')
    expect(c.run('show clock')).toEqual(['12:12:12.000 UTC Sat Jan 1 2011'])
    c.run('clock set 18:38:21 Jan 4 2011')
    expect(c.run('show clock')).toEqual(['18:38:21.000 UTC Tue Jan 4 2011'])
    c.lines('conf t', 'clock timezone CET 1', 'end')
    expect(c.run('show clock')).toEqual(['19:38:21.000 CET Tue Jan 4 2011'])
    expect(c.run('show running-config')).toContain('clock timezone CET 1')
    c.lines('conf t', 'clock timezone PST -8 30', 'end')
    expect(c.run('show running-config')).toContain('clock timezone PST -8 30')
    c.lines('conf t', 'no clock timezone', 'end')
    expect(c.run('show running-config').some((l) => l.startsWith('clock timezone'))).toBe(false)
  })

  it('clock set : heure invalide refusée sous le jeton, mode de configuration refusé', () => {
    const c = router()
    c.run('en')
    expect(c.run('clock set 25:00:00 1 jan 2020')).toEqual([
      '             ^',
      "% Invalid input detected at '^' marker.",
      ''
    ])
    expect(c.run('clock set 10:00:00')).toEqual(['% Incomplete command.', ''])
    c.run('conf t')
    expect(c.run('clock set 10:00:00 1 jan 2020')[1]).toBe("% Invalid input detected at '^' marker.")
  })

  it('ntp server : ligne de running-config, retrait par no', () => {
    const c = router()
    c.lines('en', 'conf t', 'ntp server 192.168.13.57', 'ntp server 192.168.11.58', 'end')
    const run = c.run('show running-config')
    expect(run).toContain('ntp server 192.168.13.57')
    expect(run).toContain('ntp server 192.168.11.58')
    c.lines('conf t', 'no ntp server 192.168.13.57', 'end')
    expect(c.run('show running-config')).not.toContain('ntp server 192.168.13.57')
  })
})

describe('lignes et terminal', () => {
  it('exec-timeout : affiché sous la ligne, valeur d’usine 10 0 absente', () => {
    const c = router()
    c.lines('en', 'conf t', 'line con 0', 'exec-timeout 0 0', 'end')
    const run = c.run('show running-config')
    expect(run[run.indexOf('line con 0') + 1]).toBe(' exec-timeout 0 0')
    c.lines('conf t', 'line vty 0 4', 'exec-timeout 5', 'end')
    expect(c.run('show running-config')).toContain(' exec-timeout 5 0')
    c.lines('conf t', 'line con 0', 'exec-timeout 10 0', 'end')
    expect(c.run('show running-config')).not.toContain(' exec-timeout 0 0')
  })

  it('terminal length 0 accepté sans sortie ; valeur hors bornes refusée', () => {
    const c = router()
    expect(c.run('terminal length 0')).toEqual([])
    expect(c.session.ios?.length).toBe(0)
    expect(c.run('terminal length 600')[1]).toBe("% Invalid input detected at '^' marker.")
  })

  // https://www.cisco.com/c/en/us/td/docs/ios/fundamentals/command/reference/cf_book/cf_s2.html
  it('show history : commandes d’exec de la session (pas celles de la configuration), la dernière comprise', () => {
    const c = router()
    c.lines('en', 'show clock', 'conf t', 'hostname R2', 'end')
    expect(c.run('show history')).toEqual(['  en', '  show clock', '  conf t', '  show history'])
  })

  // https://www.cisco.com/c/en/us/td/docs/ios/fundamentals/command/reference/cf_book/cf_s5.html
  it('show users : ligne console active', () => {
    expect(router().run('show users')).toEqual([
      '    Line       User       Host(s)              Idle       Location',
      '*  0 con 0                idle                 00:00:00 '
    ])
  })

  // https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/sec_usr_cfg/configuration/15-mt/sec-usr-cfg-15-mt-book/sec-cfg-sec-4cli.html
  it('show privilege : 1 en mode utilisateur, 15 en mode privilégié', () => {
    const c = router()
    expect(c.run('show privilege')).toEqual(['Current privilege level is 1'])
    c.run('en')
    expect(c.run('show privilege')).toEqual(['Current privilege level is 15'])
  })

  it('show flash: et show line : non simulés', () => {
    const c = router()
    expect(c.run('show flash:')).toEqual([NOT_SIMULATED('show flash:')])
    expect(c.run('show line')).toEqual([NOT_SIMULATED('show line')])
  })
})

describe('show interfaces description, show protocols, show hosts', () => {
  // https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/interface/command/ir-cr-book/ir-s4.html
  it('show interfaces description : état calculé et description', () => {
    const c = router()
    c.lines('en', 'conf t', 'int g0/0', 'description Vers LAN', 'end')
    expect(c.run('show interfaces description')).toEqual([
      'Interface Status         Protocol Description',
      'Gi0/0     admin down     down     Vers LAN',
      'Gi0/1     admin down     down     '
    ])
    c.lines('conf t', 'int g0/0', 'no shutdown', 'end')
    expect(c.run('show interfaces description')[1]).toBe('Gi0/0     down           down     Vers LAN')
  })

  // https://www.cisco.com/c/en/us/td/docs/ios/fundamentals/command/reference/cf_book/cf_s4.html
  it('show protocols : routage IP et adresses', () => {
    const c = router()
    c.lines('en', 'conf t', 'int g0/0', 'ip address 10.4.9.14 255.255.255.0', 'end')
    expect(c.run('show protocols')).toEqual([
      'Global values:',
      '  Internet Protocol routing is enabled',
      'GigabitEthernet0/0 is administratively down, line protocol is down',
      '  Internet address is 10.4.9.14/24',
      'GigabitEthernet0/1 is administratively down, line protocol is down'
    ])
  })

  // https://www.cisco.com/c/en/us/td/docs/ios/fundamentals/command/reference/cf_book/cf_s2.html
  it('show hosts : domaine configuré, légende et en-tête', () => {
    const c = router()
    c.lines('en', 'conf t', 'ip domain-name example.com', 'end')
    expect(c.run('show hosts')).toEqual([
      'Default domain is example.com',
      'Name/address lookup uses domain service',
      'Name servers are 255.255.255.255',
      '',
      'Codes: UN - unknown, EX - expired, OK - OK, ?? - revalidate',
      '       temp - temporary, perm - permanent',
      '       NA - Not Applicable None - Not defined',
      '',
      'Host                      Port  Flags      Age Type   Address(es)'
    ])
  })
})
