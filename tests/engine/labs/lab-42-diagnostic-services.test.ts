/**
 * Lab 42 « Diagnostic de services Windows » : départ cassé (DNS arrêté, LanmanServer arrêté, horloge
 * de PC1 décalée), la solution en PowerShell et cmd valide 100 % des critères ; cas partiels.
 */
import { describe, expect, it } from 'vitest'
import { buildLabStart, checkLab, parseLab, type LabState } from '@engine/index'
import lab42 from '../../../labs/lab-42-diagnostic-services.json'
import { run } from '../shell/helpers'

const parsed = parseLab(lab42)
if (!parsed.ok) throw new Error(parsed.message)
const lab = parsed.lab
const id = (s: LabState, name: string) => Object.values(s.devices).find((d) => d.name === name)?.id ?? ''
const ok = (s: LabState, crit: string) => checkLab(s, lab).results.find((x) => x.id === crit)?.ok

describe('lab-42-diagnostic-services', () => {
  it('départ : aucun critère validé', () => {
    const r = checkLab(buildLabStart(lab.start), lab)
    expect(r.results.filter((x) => x.ok).map((x) => x.id)).toEqual([])
    expect(r.passed).toBe(0)
  })

  it('la solution valide 100 % des critères', () => {
    let s = buildLabStart(lab.start)
    const etapes: [string, string][] = [
      ['SRV1', 'Set-Service -Name DNS -StartupType Automatic'],
      ['SRV1', 'Start-Service -Name DNS'],
      ['SRV2', 'Start-Service -Name LanmanServer'],
      ['PC1', 'w32tm /resync']
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

  it('Set-Date -Adjust remplace la resynchronisation', () => {
    let s = buildLabStart(lab.start)
    s = run(s, id(s, 'PC1'), 'Set-Date -Adjust -0:15:00').state
    expect(ok(s, 'horloge')).toBe(true)
  })

  it('cas partiels : chaque réparation ne valide que ses critères', () => {
    let s = buildLabStart(lab.start)
    s = run(s, id(s, 'SRV1'), 'Start-Service -Name DNS').state
    expect(ok(s, 'dns-demarre')).toBe(true)
    expect(ok(s, 'dns-auto')).toBe(false)
    expect(ok(s, 'resolution')).toBe(true)
    expect(ok(s, 'partage')).toBe(false)
    s = run(s, id(s, 'SRV2'), 'Start-Service -Name LanmanServer').state
    expect(ok(s, 'lanman')).toBe(true)
    expect(ok(s, 'horloge')).toBe(false)
    expect(ok(s, 'partage')).toBe(false)
  })
})
