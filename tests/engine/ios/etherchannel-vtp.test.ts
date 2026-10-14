/**
 * EtherChannel et VTP (lot 5c) : channel-group et négociation calculée (modes compatibles ou non),
 * interface port-channel, show etherchannel summary ; vtp mode, vtp domain, show vtp status.
 *
 * Sources :
 * - https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/15-0_2_se/command/reference/cr2960/cli1.html
 *   (channel-group 1 à 6 ; on seulement avec on ; active/passive ; desirable/auto)
 * - https://www.cisco.com/c/en/us/support/docs/lan-switching/etherchannel/98469-ios-etherchannel.html
 *   (Creating a port-channel interface Port-channel 1, show etherchannel summary)
 * - https://www.cisco.com/c/en/us/support/docs/lan-switching/vtp/98154-conf-vlan.html
 *   (show vtp status, Changing VTP domain name, Setting device to VTP Client mode for VLANS.)
 */
import { describe, expect, it } from 'vitest'
import type { LabState } from '@engine/index'
import { cable, createLab } from '../helpers'
import { addIos, IosConsole, type SharedLab } from './helpers'

/** SW1 Gi0/1-2 ↔ SW2 Gi0/1-2 (deux câbles). */
function pair() {
  const a = addIos(createLab(), 'c2960', 'SW1')
  const b = addIos(a.state, 'c2960', 'SW2')
  let s: LabState = cable(b.state, a.id, 24, b.id, 24)
  s = cable(s, a.id, 25, b.id, 25)
  const lab: SharedLab = { state: s }
  const open = (id: string) => {
    const k = new IosConsole(lab, id)
    k.lines('en', 'conf t')
    return k
  }
  return { sw1: open(a.id), sw2: open(b.id) }
}

const summaryRow = (k: IosConsole) => k.run('do show etherchannel summary').at(-1)

describe('EtherChannel', () => {
  it('channel-group : création de Port-channel 1 annoncée une fois', () => {
    const { sw1 } = pair()
    sw1.run('interface range gi0/1 - 2')
    expect(sw1.run('channel-group 1 mode active')).toEqual([
      '',
      'Creating a port-channel interface Port-channel 1',
      ''
    ])
    expect(sw1.run('channel-group 1 mode active')).toEqual([])
    const run = sw1.run('do show running-config')
    expect(run).toContain('interface Port-channel1')
    expect(run).toContain(' channel-group 1 mode active')
  })

  it('LACP active / passive : canal formé (SU, P)', () => {
    const { sw1, sw2 } = pair()
    sw1.lines('interface range gi0/1 - 2', 'channel-group 1 mode active')
    sw2.lines('interface range gi0/1 - 2', 'channel-group 1 mode passive')
    const out = sw1.run('do show etherchannel summary')
    expect(out.slice(0, 2)).toEqual([
      'Flags:  D - down        P - in port-channel',
      '        I - stand-alone s - suspended'
    ])
    expect(out).toContain('Number of channel-groups in use: 1')
    expect(out).toContain('Number of aggregators:           1')
    expect(out).toContain('Group  Port-channel  Protocol    Ports')
    expect(out.at(-1)).toBe('1      Po1(SU)         LACP      Gi0/1(P) Gi0/2(P)')
  })

  it('modes incompatibles : pas de canal (SD, I)', () => {
    const cases: [string, string][] = [
      ['passive', 'passive'],
      ['auto', 'auto'],
      ['active', 'desirable'],
      ['on', 'active']
    ]
    for (const [m1, m2] of cases) {
      const { sw1, sw2 } = pair()
      sw1.lines('interface range gi0/1 - 2', `channel-group 1 mode ${m1}`)
      sw2.lines('interface range gi0/1 - 2', `channel-group 1 mode ${m2}`)
      expect(summaryRow(sw1), `${m1}/${m2}`).toMatch(/^1 {6}Po1\(SD\) .*Gi0\/1\(I\) Gi0\/2\(I\)$/)
    }
  })

  it('PAgP desirable / auto et on / on : canal formé', () => {
    const cases: [string, string, string][] = [
      ['desirable', 'auto', 'PAgP'],
      ['on', 'on', '-']
    ]
    for (const [m1, m2, proto] of cases) {
      const { sw1, sw2 } = pair()
      sw1.lines('interface range gi0/1 - 2', `channel-group 2 mode ${m1}`)
      sw2.lines('interface range gi0/1 - 2', `channel-group 2 mode ${m2}`)
      expect(summaryRow(sw1)).toBe(`2      Po2(SU)         ${proto.padEnd(10)}Gi0/1(P) Gi0/2(P)`)
    }
  })

  it('port coupé : D ; no channel-group retire le port', () => {
    const { sw1, sw2 } = pair()
    sw1.lines('interface range gi0/1 - 2', 'channel-group 1 mode on')
    sw2.lines('interface range gi0/1 - 2', 'channel-group 1 mode on')
    sw1.lines('interface gi0/2', 'shutdown')
    expect(summaryRow(sw1)).toBe('1      Po1(SU)         -         Gi0/1(P) Gi0/2(D)')
    sw1.run('no channel-group')
    expect(summaryRow(sw1)).toBe('1      Po1(SU)         -         Gi0/1(P)')
  })

  it('interface port-channel : configuration appliquée aux membres', () => {
    const { sw1 } = pair()
    sw1.lines('interface range gi0/1 - 2', 'channel-group 1 mode active', 'exit')
    sw1.run('interface port-channel 1')
    expect(sw1.prompt).toBe('SW1(config-if)#')
    sw1.run('switchport mode trunk')
    const run = sw1.run('do show running-config')
    const po = run.indexOf('interface Port-channel1')
    expect(run[po + 1]).toBe(' switchport mode trunk')
    const gi = run.indexOf('interface GigabitEthernet0/2')
    expect(run.slice(gi + 1, gi + 3)).toEqual([' switchport mode trunk', ' channel-group 1 mode active'])
    sw1.lines('exit', 'no interface port-channel 1')
    expect(sw1.run('do show running-config')).not.toContain('interface Port-channel1')
  })

  it('groupe hors 1-6 : marqueur ^', () => {
    const { sw1 } = pair()
    sw1.run('interface gi0/1')
    expect(sw1.run('channel-group 7 mode on')[1]).toBe("% Invalid input detected at '^' marker.")
  })
})

describe('VTP', () => {
  it('show vtp status d’usine : serveur, domaine vide, VLAN existants calculés', () => {
    const { sw1 } = pair()
    sw1.run('vlan 10')
    const out = sw1.run('do show vtp status')
    expect(out.slice(0, 5)).toEqual([
      'VTP Version capable             : 1 to 3',
      'VTP version running             : 1',
      'VTP Domain Name                 :',
      'VTP Pruning Mode                : Disabled',
      'VTP Traps Generation            : Disabled'
    ])
    expect(out).toContain('VTP Operating Mode                : Server')
    expect(out).toContain('Number of existing VLANs          : 6')
    expect(out.find((l) => l.startsWith('MD5 digest'))).toMatch(/^MD5 digest {24}: (0x[0-9A-F]{2} ){8}$/)
  })

  it('vtp domain et vtp mode : messages réels et état', () => {
    const { sw1 } = pair()
    expect(sw1.run('vtp domain LAB')).toEqual(['Changing VTP domain name from NULL to LAB'])
    expect(sw1.run('vtp domain SIO')).toEqual(['Changing VTP domain name from LAB to SIO'])
    expect(sw1.run('vtp mode client')).toEqual(['Setting device to VTP Client mode for VLANS.'])
    const out = sw1.run('do show vtp status')
    expect(out).toContain('VTP Domain Name                 : SIO')
    expect(out).toContain('VTP Operating Mode                : Client')
    sw1.run('vtp mode transparent')
    expect(sw1.run('do show vtp status')).toContain('VTP Operating Mode                : Transparent')
  })

  it('absent du routeur', () => {
    const r = addIos(createLab(), 'c1921', 'R1')
    const k = new IosConsole(r.state, r.id)
    expect(k.lines('en', 'show vtp status')[1]).toBe("% Invalid input detected at '^' marker.")
  })
})
