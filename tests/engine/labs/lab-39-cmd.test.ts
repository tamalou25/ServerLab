/**
 * Lab 39 « Administration en ligne de commande (CMD) » : départ incomplet, la solution saisie dans
 * la console cmd (net user / net group / dsadd / redirection / dcdiag) valide 100 % des critères.
 */
import { describe, expect, it } from 'vitest'
import { buildLabStart, checkLab, parseLab, type LabState } from '@engine/index'
import lab39 from '../../../labs/lab-39-cmd.json'
import { run } from '../shell/helpers'

const parsed = parseLab(lab39)
if (!parsed.ok) throw new Error(parsed.message)
const lab = parsed.lab
const id = (s: LabState, name: string) => Object.values(s.devices).find((d) => d.name === name)?.id ?? ''

const LIGNES = [
  'net user jdupont P@ssw0rd2024! /add /domain',
  'net group Techniciens jdupont /add /domain',
  'dsadd user "CN=Paul Roux,OU=Informatique,DC=lab,DC=local" -samid proux -pwd P@ssw0rd2024! -disabled no',
  'ipconfig /all > C:\\Rapports\\ip.txt',
  'dcdiag'
]

describe('lab-39-cmd', () => {
  it('départ : dossier présent, aucun critère validé', () => {
    const s = buildLabStart(lab.start)
    expect(checkLab(s, lab).passed).toBe(0)
  })

  it('la solution en cmd valide 100 % des critères', () => {
    let s = buildLabStart(lab.start)
    const dc = id(s, 'SRV1')
    for (const ligne of LIGNES) {
      const r = run(s, dc, ligne, { shell: 'cmd' })
      expect(r.errors, ligne).toBe('')
      s = r.state
    }
    const after = checkLab(s, lab)
    expect(after.results.filter((x) => !x.ok).map((x) => x.id)).toEqual([])
    expect(after.passed).toBe(after.total)
  })

  it('fileExists : exige le texte demandé dans le contenu', () => {
    const s = buildLabStart(lab.start)
    const critere = (contains: string) => ({
      ...lab,
      criteria: [
        {
          id: 'f',
          label: 'f',
          hint: 'indice',
          hints: [],
          check: { type: 'fileExists', server: 'SRV1', path: 'C:\\Rapports\\lisezmoi.txt', contains }
        }
      ]
    })
    expect(checkLab(s, critere('introuvable')).passed).toBe(0)
    expect(checkLab(s, critere('RAPPORTS')).passed).toBe(1)
  })
})
