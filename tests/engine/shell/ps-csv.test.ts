/**
 * Import-Csv / Export-Csv (Windows PowerShell 5.1) sur le système de fichiers simulé.
 * Sources : https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/export-csv?view=powershell-5.1
 * (#TYPE par défaut avant PowerShell 6.0, valeurs entre guillemets, -Append sans en-tête) et
 * https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/import-csv?view=powershell-5.1
 * (en-têtes = propriétés, -Header, en-tête vide → H1).
 */
import { describe, expect, it } from 'vitest'
import { findNode, type LabState, type ServerDevice } from '@engine/index'
import { fromCsv } from '../../../src/engine/roles/files/csv'
import { buildReferenceLab } from '../serialization/reference-lab'
import { run, type RunResult } from './helpers'

const id = (s: LabState, name: string) => Object.values(s.devices).find((d) => d.name === name)?.id ?? ''
const content = (s: LabState, path: string) =>
  findNode((s.devices[id(s, 'SRV1')] as ServerDevice).storage, path)?.content

class Console {
  session: RunResult['session'] | undefined
  constructor(public state: LabState) {}
  run(line: string): RunResult {
    const r = run(this.state, id(this.state, 'SRV1'), line, this.session ? { session: this.session } : {})
    this.state = r.state
    this.session = r.session
    return r
  }
}

describe('PowerShell : CSV', () => {
  it('Import-Csv -Delimiter ";" : un objet par ligne, propriétés = en-têtes', () => {
    const ps = new Console(buildReferenceLab())
    const out = ps.run("Import-Csv -Path C:\\Scripts\\users.csv -Delimiter ';'")
    expect(out.errors).toBe('')
    expect(out.text).toMatch(/Nom\s+Prenom/)
    expect(out.text).toMatch(/Dupont\s+Jean/)
    expect(ps.run("Import-Csv C:\\Scripts\\users.csv -Delimiter ';' | Select-Object Prenom").text).toContain(
      'Jean'
    )
  })

  it('Export-Csv : #TYPE par défaut (5.1), -NoTypeInformation, -Append, aller-retour', () => {
    const ps = new Console(buildReferenceLab())
    ps.run("Import-Csv C:\\Scripts\\users.csv -Delimiter ';' | Export-Csv C:\\Scripts\\t.csv")
    expect(content(ps.state, 'C:\\Scripts\\t.csv')).toBe(
      '#TYPE System.Management.Automation.PSCustomObject\r\n"Nom","Prenom"\r\n"Dupont","Jean"\r\n'
    )
    ps.run(
      "Import-Csv C:\\Scripts\\users.csv -Delimiter ';' | Export-Csv C:\\Scripts\\n.csv -NoTypeInformation -Delimiter ';' -Encoding UTF8"
    )
    expect(content(ps.state, 'C:\\Scripts\\n.csv')).toBe('"Nom";"Prenom"\r\n"Dupont";"Jean"\r\n')
    ps.run(
      "Import-Csv C:\\Scripts\\users.csv -Delimiter ';' | Export-Csv C:\\Scripts\\n.csv -NoTypeInformation -Delimiter ';' -Append"
    )
    expect(content(ps.state, 'C:\\Scripts\\n.csv')).toBe(
      '"Nom";"Prenom"\r\n"Dupont";"Jean"\r\n"Dupont";"Jean"\r\n'
    )
    // Aller-retour : le fichier avec #TYPE se relit
    const back = ps.run('Import-Csv C:\\Scripts\\t.csv').text
    expect(back).toMatch(/Dupont\s+Jean/)
    expect(back).not.toContain('#TYPE')
  })

  it('analyse : guillemets, délimiteur protégé, -Header, en-tête vide → H1', () => {
    const [o] = fromCsv('a,b\r\n"x, y","il dit ""oui"""\r\n', ',')
    expect(o?.props).toEqual({ a: 'x, y', b: 'il dit "oui"' })
    const rows = fromCsv('1,2,3\n', ',', ['A', 'B'])
    expect(rows[0]?.props).toEqual({ A: '1', B: '2' })
    expect(fromCsv('ProjectID,,Completed\n13,Redmond,True\n', ',')[0]?.props).toEqual({
      ProjectID: '13',
      H1: 'Redmond',
      Completed: 'True'
    })
  })

  it('Import-Csv : fichier introuvable', () => {
    const ps = new Console(buildReferenceLab())
    expect(ps.run('Import-Csv C:\\Absent.csv').errors).toContain('Impossible de trouver le chemin d’accès')
  })
})
