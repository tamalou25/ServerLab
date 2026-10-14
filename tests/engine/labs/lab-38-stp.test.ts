/**
 * Lab 38 « STP et EtherChannel » : départ incomplet (SW3 racine), la solution saisie dans les
 * consoles IOS valide 100 % des critères.
 */
import { describe, expect, it } from 'vitest'
import { buildLabStart, checkLab, parseLab, type LabState } from '@engine/index'
import lab38 from '../../../labs/lab-38-stp-etherchannel.json'
import { IosConsole, type SharedLab } from '../ios/helpers'

const parsed = parseLab(lab38)
if (!parsed.ok) throw new Error(parsed.message)
const lab = parsed.lab
const id = (s: LabState, name: string) => Object.values(s.devices).find((d) => d.name === name)?.id ?? ''

describe('lab-38-stp', () => {
  it('départ : SW3 est racine, aucun critère validé', () => {
    const s = buildLabStart(lab.start)
    expect(checkLab(s, lab).passed).toBe(0)
    const k = new IosConsole(s, id(s, 'SW3'))
    k.run('enable')
    expect(k.run('show spanning-tree')).toContain('             This bridge is the root')
  })

  it('la solution valide 100 % des critères', () => {
    const shared: SharedLab = { state: buildLabStart(lab.start) }
    const open = (name: string) => {
      const k = new IosConsole(shared, id(shared.state, name))
      k.lines('enable', 'configure terminal')
      return k
    }
    const sw1 = open('SW1')
    sw1.run('spanning-tree vlan 1 root primary')
    sw1.lines('interface range gi0/1 - 2', 'channel-group 1 mode active')
    const sw2 = open('SW2')
    sw2.lines('interface range fa0/1 - 2', 'spanning-tree portfast', 'spanning-tree bpduguard enable', 'exit')
    sw2.lines('interface range gi0/1 - 2', 'channel-group 1 mode active')
    const sw3 = open('SW3')
    sw3.lines('interface range fa0/1', 'spanning-tree portfast', 'spanning-tree bpduguard enable')
    expect(sw1.run('do show etherchannel summary').at(-1)).toContain('Po1(SU)')
    const after = checkLab(shared.state, lab)
    expect(after.results.filter((x) => !x.ok).map((x) => x.id)).toEqual([])
    expect(after.passed).toBe(after.total)
  })
})
