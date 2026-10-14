/**
 * Spanning-tree (lot 5b) : élection du pont racine, rôles et états des ports, root primary /
 * secondary, priority, mode rapid-pvst, portfast (avertissement réel), BPDU Guard (err-disabled).
 *
 * Sources :
 * - https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/15-0_2_se/command/reference/cr2960/cli3.html
 *   (spanning-tree vlan root primary 24576 / secondary 28672, priority par pas de 4096)
 * - https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/15-0_2_se/command/reference/cr2960/cli2.html
 *   (show spanning-tree : Root ID, Bridge ID, sys-id-ext, Role Sts Cost Prio.Nbr Type)
 * - https://www.cisco.com/c/en/us/support/docs/lan-switching/spanning-tree-protocol/28943-170.html (colonnes)
 * - https://www.cisco.com/c/en/us/support/docs/lan-switching/etherchannel/98469-ios-etherchannel.html (portfast)
 * - https://www.cisco.com/c/en/us/support/docs/lan-switching/spanning-tree-protocol/69980-errdisable-recovery.html (BPDU Guard)
 */
import { describe, expect, it } from 'vitest'
import type { LabState } from '@engine/index'
import { add, cable, createLab } from '../helpers'
import { addIos, IosConsole, type SharedLab } from './helpers'

/** Triangle SW1 Fa0/1—Fa0/1 SW2 Fa0/2—Fa0/2 SW3 Fa0/3—Fa0/3 SW1. */
function triangle() {
  const a = addIos(createLab(), 'c2960', 'SW1')
  const b = addIos(a.state, 'c2960', 'SW2')
  const c = addIos(b.state, 'c2960', 'SW3')
  let s: LabState = cable(c.state, a.id, 0, b.id, 0)
  s = cable(s, b.id, 1, c.id, 1)
  s = cable(s, c.id, 2, a.id, 2)
  const lab: SharedLab = { state: s }
  const open = (id: string) => {
    const k = new IosConsole(lab, id)
    k.run('en')
    return k
  }
  return { lab, sw1: open(a.id), sw2: open(b.id), sw3: open(c.id) }
}

const rows = (out: string[]) => out.filter((l) => /^Fa0\/\d /.test(l))
const isRoot = (out: string[]) => out.includes('             This bridge is the root')

describe('show spanning-tree : élection', () => {
  it('une seule racine (plus petite MAC à priorité égale), un port Altn BLK dans le triangle', () => {
    const { sw1, sw2, sw3 } = triangle()
    const outs = [sw1, sw2, sw3].map((k) => k.run('show spanning-tree vlan 1'))
    expect(outs.filter(isRoot)).toHaveLength(1)
    const all = outs.flatMap(rows)
    expect(all.filter((l) => l.includes('Altn BLK'))).toHaveLength(1)
    expect(all.filter((l) => l.includes('Root FWD'))).toHaveLength(2)
    const root = outs.find(isRoot)!
    expect(root.slice(0, 4)).toEqual([
      '',
      'VLAN0001',
      '  Spanning tree enabled protocol ieee',
      '  Root ID    Priority    32769'
    ])
    expect(root).toContain('  Bridge ID  Priority    32769  (priority 32768 sys-id-ext 1)')
    expect(root).toContain('Interface        Role Sts Cost      Prio.Nbr Type')
    expect(rows(root).every((l) => /^Fa0\/\d {12}Desg FWD 19 {8}128\.\d {4}P2p$/.test(l))).toBe(true)
  })

  it('switch non racine : Cost et Port vers la racine', () => {
    const { sw1, sw2, sw3 } = triangle()
    const other = [sw1, sw2, sw3].map((k) => k.run('show spanning-tree vlan 1')).find((o) => !isRoot(o))!
    expect(other).toContain('             Cost        19')
    expect(other.find((l) => l.startsWith('             Port '))).toMatch(
      /^ {13}Port {8}\d \(FastEthernet0\/\d\)$/
    )
  })

  it('root primary : ce switch devient racine (24576 + VLAN)', () => {
    const { sw1, sw2, sw3 } = triangle()
    sw3.lines('conf t', 'spanning-tree vlan 1 root primary', 'end')
    const out = sw3.run('show spanning-tree vlan 1')
    expect(isRoot(out)).toBe(true)
    expect(out).toContain('  Root ID    Priority    24577')
    expect(sw3.run('show running-config')).toContain('spanning-tree vlan 1 priority 24576')
    expect(isRoot(sw1.run('show spanning-tree vlan 1'))).toBe(false)
    // Racine déjà sous 24576 : 4096 de moins que sa priorité
    sw3.lines('conf t', 'spanning-tree vlan 1 priority 20480', 'end')
    sw2.lines('conf t', 'spanning-tree vlan 1 root primary', 'end')
    expect(sw2.run('show running-config')).toContain('spanning-tree vlan 1 priority 16384')
    expect(isRoot(sw2.run('show spanning-tree vlan 1'))).toBe(true)
  })

  it('root secondary : 28672 ; priority ; no rétablit 32768', () => {
    const { sw1 } = triangle()
    sw1.lines('conf t', 'spanning-tree vlan 1 root secondary')
    expect(sw1.run('do show running-config')).toContain('spanning-tree vlan 1 priority 28672')
    sw1.run('spanning-tree vlan 1 priority 4096')
    expect(sw1.run('do show spanning-tree vlan 1')).toContain(
      '  Bridge ID  Priority    4097  (priority 4096 sys-id-ext 1)'
    )
    sw1.run('no spanning-tree vlan 1 priority')
    expect(sw1.run('do show running-config').some((l) => l.startsWith('spanning-tree vlan'))).toBe(false)
  })

  it('priority hors pas de 4096 : marqueur ^ sous la valeur', () => {
    const { sw1 } = triangle()
    sw1.run('conf t')
    expect(sw1.run('spanning-tree vlan 1 priority 1000')).toEqual([
      // invite SW1(config)# (12 caractères) + 30 caractères
      `${' '.repeat(42)}^`,
      "% Invalid input detected at '^' marker.",
      ''
    ])
  })

  it('mode rapid-pvst : protocole rstp et ligne de running-config', () => {
    const { sw1 } = triangle()
    sw1.lines('conf t', 'spanning-tree mode rapid-pvst', 'end')
    expect(sw1.run('show spanning-tree vlan 1')[2]).toBe('  Spanning tree enabled protocol rstp')
    expect(sw1.run('show running-config')).toContain('spanning-tree mode rapid-pvst')
  })

  it('VLAN sans port actif : instance inexistante', () => {
    const { sw1 } = triangle()
    sw1.lines('conf t', 'vlan 50', 'end')
    expect(sw1.run('show spanning-tree vlan 50')).toEqual([
      'Spanning tree instance(s) for vlan 50 does not exist.'
    ])
  })

  it('commande absente du routeur', () => {
    const r = addIos(createLab(), 'c1921', 'R1')
    const k = new IosConsole(r.state, r.id)
    expect(k.lines('en', 'show spanning-tree')[1]).toBe("% Invalid input detected at '^' marker.")
  })
})

describe('portfast et BPDU Guard', () => {
  it('portfast : avertissement réel, running-config, Type P2p Edge', () => {
    const r = addIos(createLab(), 'c2960', 'SW1')
    const pc = add(r.state, 'client')
    const k = new IosConsole(cable(pc.state, pc.id, 0, r.id, 0), r.id)
    k.lines('en', 'conf t', 'int fa0/1')
    expect(k.run('spanning-tree portfast')).toEqual([
      '%Warning: portfast should only be enabled on ports connected to a single',
      ' host. Connecting hubs, concentrators, switches, bridges, etc... to this',
      ' interface  when portfast is enabled, can cause temporary bridging loops.',
      ' Use with CAUTION',
      '',
      '%Portfast has been configured on FastEthernet0/1 but will only',
      ' have effect when the interface is in a non-trunking mode.'
    ])
    expect(k.run('do show running-config')).toContain(' spanning-tree portfast')
    expect(k.run('do show spanning-tree vlan 1').find((l) => l.startsWith('Fa0/1'))).toMatch(/P2p Edge$/)
  })

  it('bpduguard : port vers un switch err-disabled, messages %SPANTREE et %PM', () => {
    const { sw1, sw2 } = triangle()
    sw1.lines('conf t', 'int fa0/1')
    const out = sw1.run('spanning-tree bpduguard enable')
    expect(out).toEqual([
      '%SPANTREE-2-BLOCK_BPDUGUARD: Received BPDU on port FastEthernet0/1 with BPDU Guard enabled. Disabling port.',
      '%PM-4-ERR_DISABLE: bpduguard error detected on Fa0/1, putting Fa0/1 in err-disable state',
      '%LINEPROTO-5-UPDOWN: Line protocol on Interface FastEthernet0/1, changed state to down',
      '%LINK-3-UPDOWN: Interface FastEthernet0/1, changed state to down'
    ])
    expect(sw1.run('do show interfaces status')[2]).toMatch(/^Fa0\/1 {22}err-disabled/)
    expect(sw2.run('show spanning-tree vlan 1').some((l) => l.startsWith('Fa0/1'))).toBe(false)
  })

  it('bpduguard vers un poste : aucun effet', () => {
    const r = addIos(createLab(), 'c2960', 'SW1')
    const pc = add(r.state, 'client')
    const k = new IosConsole(cable(pc.state, pc.id, 0, r.id, 0), r.id)
    k.lines('en', 'conf t', 'int fa0/1')
    expect(k.run('spanning-tree bpduguard enable')).toEqual([])
    expect(k.run('do show running-config')).toContain(' spanning-tree bpduguard enable')
  })
})
