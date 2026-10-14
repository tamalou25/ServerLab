/**
 * Cmdlets utilitaires des scripts (v2.7, lot 1) : Select-Object, Group-Object, Sort-Object,
 * Write-Output, Get-Date -Format, Read-Host, exécutables lancés depuis PowerShell.
 *
 * Sources Microsoft Learn (PowerShell 5.1 et .NET), citées à chaque test :
 *  - https://learn.microsoft.com/powershell/module/microsoft.powershell.utility/select-object
 *  - https://learn.microsoft.com/powershell/module/microsoft.powershell.utility/group-object
 *  - https://learn.microsoft.com/powershell/module/microsoft.powershell.utility/write-output
 *  - https://learn.microsoft.com/powershell/module/microsoft.powershell.utility/get-date
 *  - https://learn.microsoft.com/powershell/module/microsoft.powershell.utility/read-host
 *  - https://learn.microsoft.com/dotnet/standard/base-types/custom-date-and-time-format-strings
 *  - https://learn.microsoft.com/dotnet/standard/base-types/standard-date-and-time-format-strings
 */
import { describe, expect, it } from 'vitest'
import { createShellSession, type LabState } from '@engine/index'
import { formatLabDate } from '../../../src/engine/shell/ps/dateformat'
import { LAB_EPOCH_MS } from '../../../src/engine/core/clock'
import { buildReferenceLab } from '../serialization/reference-lab'
import { expectGolden, readCapture } from '../golden/golden'
import { run } from './helpers'

const id = (s: LabState, name: string) => Object.values(s.devices).find((d) => d.name === name)?.id ?? ''

function ps(line: string, answers: string[] = []) {
  const s = buildReferenceLab()
  return run(s, id(s, 'SRV1'), line, {
    session: createShellSession(s, id(s, 'SRV1'), 'powershell'),
    answers
  })
}

function out(line: string): string[] {
  const r = ps(line)
  if (r.errors) throw new Error(r.errors)
  return r.text.split('\n')
}

/** Sortie sans les lignes vides de début et de fin (les extraits de Learn ne les montrent pas). */
function trimmed(line: string): string[] {
  const lines = out(line)
  while (lines[0] === '') lines.shift()
  while (lines.at(-1) === '') lines.pop()
  return lines
}

describe('Select-Object', () => {
  it('-First, -Last, -Skip, -Unique (exemples 4 et 5)', () => {
    expect(out('1..10 | Select-Object -First 3')).toEqual(['1', '2', '3'])
    expect(out('1..10 | Select-Object -Last 2')).toEqual(['9', '10'])
    expect(out('1..5 | Select-Object -Skip 3')).toEqual(['4', '5'])
    // « "a","b","c","a","a","a" | Select-Object -Unique → a b c »
    expect(out('"a","b","c","a","a","a" | Select-Object -Unique')).toEqual(['a', 'b', 'c'])
    // « "a","a","b","c" | Select-Object -First 2 -Unique → a »
    expect(out('"a","a","b","c" | Select-Object -First 2 -Unique')).toEqual(['a'])
  })

  it('-ExpandProperty : valeurs de la propriété ; propriété absente → erreur (texte FR à vérifier)', () => {
    expect(out('Get-ADUser -Filter "Name -like \'J*\'" | Select-Object -ExpandProperty Name')).toEqual([
      'Jean Dupont'
    ])
    expect(ps('Get-ADUser -Filter * | Select-Object -ExpandProperty Inexistante').errors).toContain(
      'La propriété « Inexistante » est introuvable.'
    )
  })

  it('propriétés calculées @{Label=…; Expression={…}} (exemple 12, golden)', () => {
    const capture = readCapture('ps/select-object-calculated')
    expectGolden(trimmed(capture.command), 'ps/select-object-calculated')
  })

  it('bloc de script en propriété : le texte du bloc sert de nom (exemple 11)', () => {
    const lines = out('1,2 | Select-Object -Property {$_ * 10}')
    expect(lines[1]).toBe('$_ * 10')
    expect(lines).toContain('     10')
  })
})

describe('Group-Object', () => {
  it('-NoElement, bloc de script, ordre d’apparition (exemple 10, golden)', () => {
    const capture = readCapture('ps/group-object-noelement')
    expectGolden(trimmed(capture.command), 'ps/group-object-noelement')
  })

  it('colonnes Count / Name (25) / Group, énumération limitée à 4 éléments (exemple 2)', () => {
    // « Count Name                      Group » ; «    10 0                         {2, 4, 6, 8...} »
    const lines = trimmed('1..20 | Group-Object -Property {$_ % 2}')
    expect(lines[0]).toBe('Count Name                      Group')
    expect(lines[1]).toBe('----- ----                      -----')
    expect(lines).toContain('   10 0                         {2, 4, 6, 8...}')
    expect(lines).toContain('   10 1                         {1, 3, 5, 7...}')
  })

  it('propriété nommée, objets de groupe réutilisables', () => {
    expect(out('(Get-ADUser -Filter * | Group-Object -Property Enabled).Count')).toEqual(['2'])
    expect(
      out(
        'Get-ADUser -Filter * | Group-Object Enabled | Where-Object { $_.Name -eq "True" } | % { $_.Count }'
      )
    ).toEqual(['2'])
  })
})

describe('Sort-Object, Write-Output', () => {
  it('Sort-Object -Descending, par propriété', () => {
    expect(out('3,1,2 | Sort-Object')).toEqual(['1', '2', '3'])
    expect(out('3,1,2 | Sort-Object -Descending')).toEqual(['3', '2', '1'])
    expect(out('"b","C","a" | Sort-Object')).toEqual(['a', 'b', 'C'])
  })

  it('Write-Output 1,2,3 | Measure-Object → Count : 3 (exemple 3)', () => {
    expect(out('Write-Output 1,2,3 | Measure-Object')).toContain('Count    : 3')
    expect(out('echo "a"')).toEqual(['a'])
  })
})

describe('Get-Date -Format (formats .NET, culture fr-FR, horloge du lab)', () => {
  // 2009-06-15T13:45:30 : date des exemples de la documentation .NET
  const clock = Date.UTC(2009, 5, 15, 13, 45, 30) - LAB_EPOCH_MS

  it('spécificateurs personnalisés : exemples fr-FR de la documentation', () => {
    expect(formatLabDate(clock, 'ddd')).toBe('lun.')
    expect(formatLabDate(clock, 'dddd')).toBe('lundi')
    expect(formatLabDate(clock, 'MMM')).toBe('juin')
    expect(formatLabDate(clock, 'MM')).toBe('06')
    expect(formatLabDate(clock, 'tt')).toBe('')
    expect(formatLabDate(Date.UTC(2009, 5, 15, 13, 45, 9) - LAB_EPOCH_MS, 's ss')).toBe('9 09')
    expect(formatLabDate(clock, 'yyyy-MM-dd HH:mm:ss')).toBe('2009-06-15 13:45:30')
    expect(formatLabDate(clock, "'le' d/M/yy \\à H\\hmm")).toBe('le 15/6/09 à 13h45')
  })

  it('format standard « d » → 15/06/2009 (fr-FR)', () => {
    expect(formatLabDate(clock, 'd')).toBe('15/06/2009')
  })

  it('Get-Date -Format dans la console : temps = state.clock', () => {
    // Le lab de référence démarre le lundi 5 janvier 2026 à 8 h (src/engine/core/clock.ts)
    const s = buildReferenceLab()
    const expected = formatLabDate(s.clock, 'dddd dd/MM/yyyy HH:mm')
    expect(out('Get-Date -Format "dddd dd/MM/yyyy HH:mm"')).toEqual([expected])
    expect(expected).toMatch(/^[a-zé]+ \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/)
  })

  it('fuseau horaire (K, zzz, o) : non simulé, message honnête', () => {
    expect(ps('Get-Date -Format "dddd MM/dd/yyyy HH:mm K"').errors).toContain(
      'n’est pas simulé dans ServerLab'
    )
    expect(ps('Get-Date -Format o').errors).toContain('n’est pas simulé dans ServerLab')
  })
})

describe('Read-Host', () => {
  it('invite « texte: » puis valeur affectée (exemple 1)', () => {
    // « $Age = Read-Host "Please enter your age" » affiche « Please enter your age: »
    const r = ps('$Age = Read-Host "Please enter your age"; "Âge : $Age"', ['42'])
    expect(r.prompts).toEqual(['Please enter your age: '])
    expect(r.text.split('\n').at(-1)).toBe('Âge : 42')
  })

  it('dans une boucle : une invite par itération', () => {
    const r = ps('foreach ($i in 1..2) { $n = Read-Host "Nom $i"; "-> $n" }', ['a', 'b'])
    expect(r.prompts).toEqual(['Nom 1: ', 'Nom 2: '])
    expect(r.text).toContain('-> a')
    expect(r.text).toContain('-> b')
  })
})

describe('exécutables depuis PowerShell', () => {
  it('ipconfig : même sortie que dans cmd, lignes réutilisables dans le pipeline', () => {
    const s = buildReferenceLab()
    const fromCmd = run(s, id(s, 'SRV1'), 'ipconfig', { shell: 'cmd' }).text
    expect(ps('ipconfig').text).toBe(fromCmd)
    const lines = out('$cfg = ipconfig; $cfg.Count')
    expect(Number(lines[0])).toBe(fromCmd.split('\n').length)
    expect(out('ipconfig | Where-Object { $_ -like "*IPv4*" }').length).toBeGreaterThan(0)
  })

  it('cmd /c <commande> : exécutée par l’invite de commandes simulée', () => {
    const s = buildReferenceLab()
    const fromCmd = run(s, id(s, 'SRV1'), 'ipconfig /all', { shell: 'cmd' }).text
    expect(ps('cmd /c ipconfig /all').text).toBe(fromCmd)
    expect(out('cmd /c echo bonjour')).toEqual(['bonjour'])
    expect(ps('cmd').errors).toContain('n’est pas simulé dans ServerLab')
  })
})
