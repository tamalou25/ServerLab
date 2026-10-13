/**
 * Configuration de base IOS : hostname, secret, bannière, interfaces, show, sauvegarde, reload,
 * ping et traceroute (moteur réseau existant).
 */
import { describe, expect, it } from 'vitest'
import { connect, unwrap, type LabState } from '@engine/index'
import { createLab } from '../helpers'
import { addIos, IosConsole, router } from './helpers'

/** Deux routeurs reliés Gi0/0 ↔ Gi0/0. */
function twoRouters(): { r1: IosConsole; r2: IosConsole; sync: (from: IosConsole) => void } {
  const a = addIos(createLab(), 'c1921')
  const b = addIos(a.state, 'c1921')
  const s = unwrap(
    connect(
      b.state,
      { deviceId: a.id, ifaceId: b.state.devices[a.id]?.interfaces[0]?.id ?? '' },
      { deviceId: b.id, ifaceId: b.state.devices[b.id]?.interfaces[0]?.id ?? '' }
    )
  ).state
  const r1 = new IosConsole(s, a.id)
  const r2 = new IosConsole(s, b.id)
  // Les deux consoles partagent le même lab : recopie l'état après une commande
  const sync = (from: IosConsole) => {
    for (const c of [r1, r2]) c.state = from.state
  }
  return { r1, r2, sync }
}

const iface = (state: LabState, deviceId: string, name: string) =>
  state.devices[deviceId]?.interfaces.find((i) => i.name === name)

describe('configuration globale', () => {
  it('hostname change le nom et le prompt', () => {
    const c = router()
    c.lines('en', 'conf t', 'hostname Paris-R1')
    expect(c.prompt).toBe('Paris-R1(config)#')
    expect(c.state.devices[c.session.deviceId]?.name).toBe('Paris-R1')
    expect(c.run('hostname 1@b')).toEqual(['% Hostname contains one or more illegal characters.'])
  })

  it('enable secret : mot de passe demandé, 3 essais', () => {
    const c = router()
    c.lines('en', 'conf t', 'enable secret cisco', 'end', 'disable')
    expect(() => c.run('enable')).toThrow('Password:')
    expect(c.run('enable', ['x', 'y', 'z'])).toEqual(['% Bad secrets', ''])
    expect(c.prompt).toBe('R1>')
    c.run('enable', ['x', 'cisco'])
    expect(c.prompt).toBe('R1#')
    expect(c.run('show running-config').some((l) => /^enable secret 5 \$1\$\S{4}\$\S{22}$/.test(l))).toBe(
      true
    )
  })

  it('banner motd sur une ligne ou plusieurs', () => {
    const c = router()
    c.lines('en', 'conf t', 'banner motd #Acces reserve#')
    expect(c.lines('end', 'show running-config')).toContain('banner motd ^CAcces reserve^C')
    c.lines('conf t')
    expect(() => c.run('banner motd %')).toThrow()
    c.run('banner motd %', ['Ligne 1', 'Ligne 2%'])
    expect(
      c.state.devices[c.session.deviceId]?.kind === 'router' && c.state.devices[c.session.deviceId]
    ).toBeTruthy()
    c.lines('end')
    expect(c.run('exit')).toEqual(expect.arrayContaining(['Ligne 1', 'Ligne 2']))
  })

  it('no ip domain-lookup : plus de résolution des mots inconnus', () => {
    const c = router()
    c.lines('en', 'conf t', 'no ip domain-lookup', 'end')
    expect(c.run('bonjour')).toEqual([
      'Translating "bonjour"',
      '% Unknown command or computer name, or unable to find computer address'
    ])
    expect(c.run('show running-config')).toContain('no ip domain lookup')
  })
})

describe('interfaces', () => {
  it('routeur neuf : interfaces administrativement coupées', () => {
    const c = router()
    c.run('en')
    expect(c.run('show ip interface brief')).toEqual([
      'Interface              IP-Address      OK? Method Status                Protocol',
      'GigabitEthernet0/0     unassigned      YES unset  administratively down down',
      'GigabitEthernet0/1     unassigned      YES unset  administratively down down'
    ])
  })

  it('no shutdown câblé : up/up ; sans câble : down/down', () => {
    const { r1, r2, sync } = twoRouters()
    r2.lines('en', 'conf t', 'int g0/0')
    // Côté R2 encore coupé : R1 reste down
    r1.lines('en', 'conf t', 'int g0/0', 'ip address 10.0.0.1 255.255.255.252')
    expect(r1.run('no shutdown')).toEqual([
      '%LINK-3-UPDOWN: Interface GigabitEthernet0/0, changed state to down'
    ])
    sync(r1)
    expect(r2.run('no shutdown')).toEqual([
      '%LINK-3-UPDOWN: Interface GigabitEthernet0/0, changed state to up',
      '%LINEPROTO-5-UPDOWN: Line protocol on Interface GigabitEthernet0/0, changed state to up'
    ])
    sync(r2)
    expect(r1.run('do show ip interface brief')[1]).toBe(
      'GigabitEthernet0/0     10.0.0.1        YES manual up                    up'
    )
    expect(r1.run('shutdown')).toEqual([
      '%LINK-5-CHANGED: Interface GigabitEthernet0/0, changed state to administratively down',
      '%LINEPROTO-5-UPDOWN: Line protocol on Interface GigabitEthernet0/0, changed state to down'
    ])
  })

  it('ip address : masque invalide, adresse réseau, chevauchement', () => {
    const c = router()
    c.lines('en', 'conf t', 'int g0/0')
    expect(c.run('ip address 10.0.0.1 255.0.255.0')).toEqual(['Bad mask 0xFF00FF00 for address 10.0.0.1'])
    expect(c.run('ip address 192.168.1.0 255.255.255.0')).toEqual(['Bad mask /24 for address 192.168.1.0'])
    c.run('ip address 192.168.1.1 255.255.255.0')
    c.run('int g0/1')
    expect(c.run('ip address 192.168.1.2 255.255.255.0')).toEqual([
      '% 192.168.1.0 overlaps with GigabitEthernet0/0'
    ])
    c.run('int g0/0')
    c.run('no ip address')
    expect(iface(c.state, c.session.deviceId, 'Gi0/0')?.address).toBeNull()
  })

  it('sous-interface sans encapsulation : ip address refusée', () => {
    const c = router()
    c.lines('en', 'conf t', 'int g0/0.10')
    expect(c.run('ip address 10.0.10.1 255.255.255.0')[0]).toBe(
      '% Configuring IP routing on a LAN subinterface is only allowed if that'
    )
  })

  it('port de switch : pas de commande ip address', () => {
    const s = addIos(createLab(), 'c2960')
    const c = new IosConsole(s.state, s.id)
    c.lines('en', 'conf t', 'int fa0/1')
    expect(c.run('ip address 10.0.0.1 255.0.0.0')[1]).toBe("% Invalid input detected at '^' marker.")
  })

  it('description et show interfaces', () => {
    const c = router()
    c.lines('en', 'conf t', 'int g0/1', 'description Vers le LAN', 'end')
    const out = c.run('show interfaces g0/1')
    expect(out[0]).toBe('GigabitEthernet0/1 is administratively down, line protocol is down')
    expect(out[1]).toMatch(
      /^ {2}Hardware is CN Gigabit Ethernet, address is [0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}/
    )
    expect(out).toContain('  Description: Vers le LAN')
    expect(c.run('show running-config')).toContain(' description Vers le LAN')
  })
})

describe('running-config et startup-config', () => {
  it('show running-config généré depuis l’état', () => {
    const c = router()
    c.lines('en', 'conf t', 'int g0/0', 'ip address 192.168.1.1 255.255.255.0', 'no shut', 'end')
    const out = c.run('show running-config')
    expect(out.slice(0, 2)).toEqual(['Building configuration...', ''])
    expect(out[2]).toMatch(/^Current configuration : \d+ bytes$/)
    const at = out.indexOf('interface GigabitEthernet0/0')
    expect(out.slice(at, at + 5)).toEqual([
      'interface GigabitEthernet0/0',
      ' ip address 192.168.1.1 255.255.255.0',
      ' duplex auto',
      ' speed auto',
      '!'
    ])
    expect(out).toContain(' shutdown')
    expect(out).toContain('hostname R1')
    expect(out[out.length - 1]).toBe('end')
  })

  it('reload sans sauvegarde perd la configuration', () => {
    const c = router()
    c.lines('en', 'conf t', 'int g0/0', 'ip address 192.168.1.1 255.255.255.0', 'no shut', 'end')
    const out = c.run('reload', ['no', ''])
    expect(out).toContain('Press RETURN to get started!')
    expect(c.prompt).toBe('R1>')
    expect(iface(c.state, c.session.deviceId, 'Gi0/0')).toMatchObject({ address: null, enabled: false })
  })

  it('copy running-config startup-config puis reload restaure la configuration', () => {
    const c = router()
    c.lines('en')
    expect(c.run('show startup-config')).toEqual(['startup-config is not present'])
    c.lines(
      'conf t',
      'int g0/0.10',
      'exit',
      'int g0/0',
      'ip address 192.168.1.1 255.255.255.0',
      'no shut',
      'end'
    )
    expect(c.run('copy running-config startup-config', [''])).toEqual(['Building configuration...', '[OK]'])
    expect(c.run('show startup-config')[0]).toMatch(/^Using \d+ out of 262136 bytes$/)
    c.lines('conf t', 'int g0/0', 'no ip address', 'end')
    c.run('reload', ['no', ''])
    expect(iface(c.state, c.session.deviceId, 'Gi0/0')).toMatchObject({
      address: '192.168.1.1',
      enabled: true
    })
    expect(iface(c.state, c.session.deviceId, 'Gi0/0.10')?.subinterface?.vlan).toBeNull()
    // Rien de modifié : reload ne demande plus de sauvegarde
    c.run('en')
    expect(() => c.run('reload')).toThrow('Proceed with reload? [confirm]')
  })

  it('write memory, erase startup-config ; reload propose de sauvegarder', () => {
    const c = router()
    c.lines('en', 'conf t', 'hostname R9', 'end')
    expect(c.run('write memory')).toEqual(['Building configuration...', '[OK]'])
    expect(c.run('erase startup-config', [''])).toEqual(['[OK]', 'Erase of nvram: complete'])
    expect(c.run('show startup-config')).toEqual(['startup-config is not present'])
    expect(c.run('reload', ['peut-être', 'yes', ''])).toEqual(
      expect.arrayContaining(["% Please answer 'yes' or 'no'.", 'Building configuration...', '[OK]'])
    )
    expect(c.state.devices[c.session.deviceId]?.name).toBe('R9')
  })
})

describe('ping, traceroute, show version', () => {
  it('ping entre deux routeurs : !!!!! ; adresse injoignable : .....', () => {
    const { r1, r2, sync } = twoRouters()
    r1.lines('en', 'conf t', 'int g0/0', 'ip address 10.0.0.1 255.255.255.252', 'no shut', 'end')
    sync(r1)
    r2.lines('en', 'conf t', 'int g0/0', 'ip address 10.0.0.2 255.255.255.252', 'no shut', 'end')
    sync(r2)
    const ok = r1.run('ping 10.0.0.2')
    expect(ok.slice(0, 3)).toEqual([
      'Type escape sequence to abort.',
      'Sending 5, 100-byte ICMP Echos to 10.0.0.2, timeout is 2 seconds:',
      '!!!!!'
    ])
    expect(ok[3]).toMatch(
      /^Success rate is 100 percent \(5\/5\), round-trip min\/avg\/max = \d+\/\d+\/\d+ ms$/
    )
    const ko = r1.run('ping 10.0.0.3')
    expect(ko[2]).toBe('.....')
    expect(ko[3]).toBe('Success rate is 0 percent (0/5)')
    const trace = r1.run('traceroute 10.0.0.2')
    expect(trace.slice(0, 3)).toEqual([
      'Type escape sequence to abort.',
      'Tracing the route to 10.0.0.2',
      'VRF info: (vrf in name/id, vrf out name/id)'
    ])
    expect(trace[3]).toMatch(/^ {2}1 10\.0\.0\.2 \d+ msec \d+ msec \d+ msec$/)
    expect(r1.run('ping serveur')).toEqual([
      'Translating "serveur"...domain server (255.255.255.255)',
      '% Unrecognized host or address, or protocol not running.',
      ''
    ])
  })

  it('traceroute sans aucun saut : lignes * jusqu’à 4 sauts (F-05, I13)', () => {
    const { r1 } = twoRouters()
    const out = r1.run('traceroute 10.9.9.9')
    expect(out).toContain('  1  *  *  *')
    expect(out).toContain('  4  *  *  *')
    expect(out.filter((l) => /^ +\d+ {2}\* {2}\* {2}\*$/.test(l))).toHaveLength(4)
  })

  it('show version selon le modèle', () => {
    const c = router('c2811')
    expect(c.run('show version')[0]).toContain('2800 Software (C2800NM-ADVIPSERVICESK9-M)')
    expect(c.run('show version')).toContain('2 FastEthernet interfaces')
  })
})
