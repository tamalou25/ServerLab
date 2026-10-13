/**
 * Lab 36 « Fidélité des consoles » : départ incomplet, la solution (commandes saisies comme un
 * élève : pipeline PowerShell, ACL journalisée, logging synchronous) valide 100 % des critères.
 */
import { describe, expect, it } from 'vitest'
import { buildLabStart, checkLab, parseLab, runIosScript, type LabState } from '@engine/index'
import lab36 from '../../../labs/lab-36-fidelite-consoles.json'
import { run } from '../shell/helpers'

const parsed = parseLab(lab36)
if (!parsed.ok) throw new Error(parsed.message)
const lab = parsed.lab
const id = (s: LabState, name: string) => Object.values(s.devices).find((d) => d.name === name)?.id ?? ''

describe('lab-36-fidelite-consoles', () => {
  it('départ : aucun critère validé', () => {
    expect(checkLab(buildLabStart(lab.start), lab).passed).toBe(0)
  })

  it('la solution valide 100 % des critères', () => {
    let s = buildLabStart(lab.start)
    const srv = id(s, 'SRV1')
    s = run(s, srv, 'Install-WindowsFeature -Name DHCP').state
    s = run(s, srv, 'Get-ADUser -Identity ancien.employe | Disable-ADAccount').state
    s = runIosScript(s, id(s, 'R1'), [
      'enable',
      'configure terminal',
      'ip access-list extended BLOQUE',
      'deny ip any any log',
      'exit',
      'line console 0',
      'logging synchronous',
      'end'
    ])
    const after = checkLab(s, lab)
    expect(after.results.filter((r) => !r.ok).map((r) => r.id)).toEqual([])
    expect(after.passed).toBe(after.total)
  })
})
