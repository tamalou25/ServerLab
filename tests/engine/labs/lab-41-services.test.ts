/**
 * Lab 41 « Services et comptes locaux en PowerShell » : départ avec DNS arrêté, la solution saisie
 * en PowerShell valide 100 % des critères ; les critères `serviceState` et `localAccount` sont testés.
 */
import { describe, expect, it } from 'vitest'
import { buildLabStart, checkLab, parseLab, type LabState } from '@engine/index'
import lab41 from '../../../labs/lab-41-services-comptes.json'
import { run } from '../shell/helpers'

const parsed = parseLab(lab41)
if (!parsed.ok) throw new Error(parsed.message)
const lab = parsed.lab
const id = (s: LabState, name: string) => Object.values(s.devices).find((d) => d.name === name)?.id ?? ''

describe('lab-41-services', () => {
  it('départ : DNS arrêté, résolution cassée, aucun critère validé', () => {
    const r = checkLab(buildLabStart(lab.start), lab)
    expect(r.results.find((x) => x.id === 'dns-demarre')?.ok).toBe(false)
    expect(r.results.find((x) => x.id === 'resolution')?.ok).toBe(false)
    expect(r.passed).toBe(0)
  })

  it('la solution en PowerShell valide 100 % des critères', () => {
    let s = buildLabStart(lab.start)
    const etapes: [string, string][] = [
      ['SRV1', 'Set-Service -Name DNS -StartupType Automatic'],
      ['SRV1', 'Start-Service -Name DNS'],
      [
        'SRV2',
        'New-LocalUser -Name adminlocal -Password (ConvertTo-SecureString "P@ssw0rd2024!" -AsPlainText -Force)'
      ],
      ['SRV2', 'Add-LocalGroupMember -Group Administrateurs -Member adminlocal']
    ]
    for (const [srv, ligne] of etapes) {
      const r = run(s, id(s, srv), ligne)
      expect(r.errors, ligne).toBe('')
      s = r.state
    }
    const after = checkLab(s, lab)
    expect(after.results.filter((x) => !x.ok).map((x) => x.id)).toEqual([])
    expect(after.passed).toBe(after.total)
  })

  it('le démarrage automatique seul ne suffit pas, le compte seul non plus', () => {
    let s = buildLabStart(lab.start)
    s = run(s, id(s, 'SRV1'), 'Set-Service -Name DNS -StartupType Automatic').state
    s = run(s, id(s, 'SRV2'), 'New-LocalUser -Name adminlocal -NoPassword').state
    const r = checkLab(s, lab).results
    expect(r.find((x) => x.id === 'dns-auto')?.ok).toBe(true)
    expect(r.find((x) => x.id === 'dns-demarre')?.ok).toBe(false)
    expect(r.find((x) => x.id === 'compte-local')?.ok).toBe(true)
    expect(r.find((x) => x.id === 'compte-admin')?.ok).toBe(false)
  })
})
