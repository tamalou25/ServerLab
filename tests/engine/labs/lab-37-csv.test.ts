/**
 * Lab 37 « Création d'utilisateurs par CSV » : départ incomplet, la solution (une ligne PowerShell
 * Import-Csv | ForEach-Object { New-ADUser … }) valide 100 % des critères.
 */
import { describe, expect, it, vi } from 'vitest'
import { buildLabStart, checkLab, parseLab, type LabState } from '@engine/index'
import lab37 from '../../../labs/lab-37-csv.json'
import { run } from '../shell/helpers'

// Solution enregistrée en commandes nommées et rejouée comme un rendu (mode enseignant, #405)
vi.mock('@engine/index', async (importOriginal) =>
  (await import('../teacher/recorder')).instrumentEngine(importOriginal)
)

const parsed = parseLab(lab37)
if (!parsed.ok) throw new Error(parsed.message)
const lab = parsed.lab
const id = (s: LabState, name: string) => Object.values(s.devices).find((d) => d.name === name)?.id ?? ''

const LIGNE =
  'Import-Csv C:\\Scripts\\nouveaux.csv -Delimiter \';\' | ForEach-Object { New-ADUser -Name "$($_.Prenom) $($_.Nom)" -SamAccountName $_.Login -Path "OU=$($_.Service),DC=lab,DC=local" -AccountPassword (ConvertTo-SecureString \'P@ssw0rd2024!\' -AsPlainText -Force) -Enabled $true }'

describe('lab-37-csv', () => {
  it('départ : fichier présent, aucun critère validé', () => {
    const s = buildLabStart(lab.start)
    expect(checkLab(s, lab).passed).toBe(0)
    expect(run(s, id(s, 'SRV1'), 'Get-Content C:\\Scripts\\nouveaux.csv').text).toContain(
      'Prenom;Nom;Login;Service'
    )
  })

  it('la solution valide 100 % des critères', () => {
    const s = buildLabStart(lab.start)
    const r = run(s, id(s, 'SRV1'), LIGNE)
    expect(r.errors).toBe('')
    const after = checkLab(r.state, lab)
    expect(after.results.filter((x) => !x.ok).map((x) => x.id)).toEqual([])
    expect(after.passed).toBe(after.total)
  })
})
