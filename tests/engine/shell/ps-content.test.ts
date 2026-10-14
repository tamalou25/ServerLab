/**
 * Cmdlets de contenu et d'éléments (Windows PowerShell 5.1) sur le système de fichiers simulé.
 * Comportements sourcés (Microsoft Learn, ?view=powershell-5.1) : Set-Content (une ligne par valeur,
 * -NoNewline), Get-Content (-TotalCount/-Head, -Tail, -Raw), Out-File (sortie mise en forme, UTF-16
 * par défaut, -Append), Test-Path (-PathType Container/Leaf), Copy-Item, Rename-Item.
 */
import { describe, expect, it } from 'vitest'
import { findNode, type LabState, type ServerDevice } from '@engine/index'
import { buildReferenceLab } from '../serialization/reference-lab'
import { run, type RunResult } from './helpers'

const id = (s: LabState, name: string) => Object.values(s.devices).find((d) => d.name === name)?.id ?? ''
const node = (s: LabState, path: string) => findNode((s.devices[id(s, 'SRV1')] as ServerDevice).storage, path)

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

describe('PowerShell : contenu des fichiers', () => {
  it('Set-Content, Add-Content, Get-Content (-TotalCount, -Tail, -Raw)', () => {
    const ps = new Console(buildReferenceLab())
    expect(ps.run("Set-Content -Path C:\\Scripts\\a.txt -Value 'un','deux'").errors).toBe('')
    expect(node(ps.state, 'C:\\Scripts\\a.txt')?.content).toBe('un\r\ndeux\r\n')
    ps.run("Add-Content C:\\Scripts\\a.txt 'trois'")
    expect(ps.run('Get-Content C:\\Scripts\\a.txt').text.trim().split('\n')).toEqual(['un', 'deux', 'trois'])
    expect(ps.run('Get-Content C:\\Scripts\\a.txt -TotalCount 1').text.trim()).toBe('un')
    expect(ps.run('Get-Content C:\\Scripts\\a.txt -Head 2').text.trim().split('\n')).toEqual(['un', 'deux'])
    expect(ps.run('Get-Content C:\\Scripts\\a.txt -Tail 1').text.trim()).toBe('trois')
    ps.run("Set-Content C:\\Scripts\\b.txt -Value 'x' -NoNewline")
    ps.run("Add-Content C:\\Scripts\\b.txt -Value 'y' -NoNewline")
    expect(node(ps.state, 'C:\\Scripts\\b.txt')?.content).toBe('xy')
    expect(ps.run('Get-Content C:\\Scripts\\b.txt -Raw').text.trim()).toBe('xy')
    // Contenu du lab de référence (CSV)
    expect(ps.run('gc C:\\Scripts\\users.csv').text).toContain('Dupont;Jean')
    // Pipeline vers Set-Content
    ps.run("'p1','p2' | Set-Content C:\\Scripts\\c.txt")
    expect(node(ps.state, 'C:\\Scripts\\c.txt')?.content).toBe('p1\r\np2\r\n')
  })

  it('Out-File : sortie mise en forme, UTF-16 par défaut, -Append, -NoClobber', () => {
    const ps = new Console(buildReferenceLab())
    ps.run("'bonjour' | Out-File C:\\Scripts\\o.txt")
    expect(node(ps.state, 'C:\\Scripts\\o.txt')).toMatchObject({ content: 'bonjour\r\n', size: 2 + 9 * 2 })
    ps.run("'suite' | Out-File -FilePath C:\\Scripts\\o.txt -Append")
    expect(node(ps.state, 'C:\\Scripts\\o.txt')?.content).toBe('bonjour\r\nsuite\r\n')
    expect(ps.run("'x' | Out-File C:\\Scripts\\o.txt -NoClobber").errors).not.toBe('')
    ps.run('Get-SmbShare | Out-File C:\\Scripts\\shares.txt -Encoding UTF8')
    expect(node(ps.state, 'C:\\Scripts\\shares.txt')?.content).toContain('Name')
  })

  it('Test-Path, Get-Item, Copy-Item, Rename-Item, Remove-Item', () => {
    const ps = new Console(buildReferenceLab())
    expect(ps.run('Test-Path C:\\Scripts\\users.csv').text.trim()).toBe('True')
    expect(ps.run('Test-Path C:\\Absent').text.trim()).toBe('False')
    expect(ps.run('Test-Path C:\\Scripts -PathType Leaf').text.trim()).toBe('False')
    expect(ps.run('Test-Path C:\\Scripts -PathType Container').text.trim()).toBe('True')
    const item = ps.run('Get-Item C:\\Scripts\\users.csv').text
    expect(item).toContain('Répertoire : C:\\Scripts')
    expect(item).toMatch(/-a----\s+\S+\s+\S+\s+25 users\.csv/)
    expect(ps.run('(Get-Item C:\\Scripts\\users.csv).Length').text.trim()).toBe('25')
    expect(ps.run('Get-Item C:\\Absent').errors).toContain('Impossible de trouver le chemin d’accès')

    ps.run('Copy-Item C:\\Scripts\\users.csv C:\\Scripts\\copie.csv')
    expect(node(ps.state, 'C:\\Scripts\\copie.csv')?.content).toBe(
      node(ps.state, 'C:\\Scripts\\users.csv')?.content
    )
    ps.run('New-Item C:\\Archive -ItemType Directory')
    ps.run('Copy-Item C:\\Scripts\\users.csv -Destination C:\\Archive')
    expect(node(ps.state, 'C:\\Archive\\users.csv')?.size).toBe(25)
    ps.run('Copy-Item C:\\Scripts C:\\Archive\\Scripts -Recurse')
    expect(node(ps.state, 'C:\\Archive\\Scripts\\copie.csv')).toBeTruthy()

    ps.run('Rename-Item C:\\Scripts\\copie.csv -NewName renomme.csv')
    expect(node(ps.state, 'C:\\Scripts\\copie.csv')).toBeUndefined()
    expect(node(ps.state, 'C:\\Scripts\\renomme.csv')).toBeTruthy()
    expect(ps.run('Rename-Item C:\\Absent.txt x.txt').errors).toContain(
      'Impossible de trouver le chemin d’accès'
    )
    ps.run('Remove-Item C:\\Scripts\\renomme.csv')
    expect(node(ps.state, 'C:\\Scripts\\renomme.csv')).toBeUndefined()
    // New-Item -Value écrit le contenu
    ps.run("New-Item C:\\Scripts\\n.txt -ItemType File -Value 'abc'")
    expect(ps.run('Get-Content C:\\Scripts\\n.txt').text.trim()).toBe('abc')
  })

  it('paramètre réel non simulé : message honnête', () => {
    const ps = new Console(buildReferenceLab())
    expect(ps.run('Get-Content C:\\Scripts\\users.csv -Wait').errors).toContain(
      'Le paramètre « -Wait » de Get-Content existe réellement mais n’est pas simulé dans ServerLab.'
    )
  })
})
