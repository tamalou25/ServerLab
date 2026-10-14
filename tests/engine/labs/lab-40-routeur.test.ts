/**
 * Lab 40 « Routage dynamique RIPv2 et administration du routeur » : départ sans routage, la
 * solution saisie dans les consoles IOS valide 100 % des critères.
 */
import { describe, expect, it } from 'vitest'
import { buildLabStart, checkLab, parseLab, type LabState } from '@engine/index'
import lab40 from '../../../labs/lab-40-routeur-rip.json'
import { IosConsole, type SharedLab } from '../ios/helpers'

const parsed = parseLab(lab40)
if (!parsed.ok) throw new Error(parsed.message)
const lab = parsed.lab
const id = (s: LabState, name: string) => Object.values(s.devices).find((d) => d.name === name)?.id ?? ''

describe('lab-40-routeur', () => {
  it('départ : aucun critère validé', () => {
    expect(checkLab(buildLabStart(lab.start), lab).passed).toBe(0)
  })

  it('la solution valide 100 % des critères', () => {
    const shared: SharedLab = { state: buildLabStart(lab.start) }
    const open = (name: string) => {
      const k = new IosConsole(shared, id(shared.state, name))
      k.lines('enable', 'configure terminal')
      return k
    }
    const rip = (k: IosConsole, ...lines: string[]) =>
      k.lines('router rip', 'version 2', 'no auto-summary', ...lines, 'end', 'configure terminal')
    const r1 = open('R1')
    rip(r1, 'network 172.16.0.0', 'network 10.0.0.0', 'passive-interface g0/0')
    rip(open('R2'), 'network 10.0.0.0')
    rip(open('R3'), 'network 192.168.3.0', 'network 10.0.0.0', 'passive-interface g0/1')
    r1.lines('ntp server 192.168.100.10', 'clock timezone CET 1', 'end', 'write memory')
    const after = checkLab(shared.state, lab)
    expect(after.results.filter((x) => !x.ok).map((x) => x.id)).toEqual([])
    expect(after.passed).toBe(after.total)
  })
})
