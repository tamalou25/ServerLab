/**
 * Liaison par pipeline des cmdlets Active Directory (B2) : un objet AD reçu du pipeline se lie
 * au paramètre -Identity, seul paramètre « Value from pipeline: True » d'après Microsoft Learn
 * (https://learn.microsoft.com/en-us/powershell/module/activedirectory/set-aduser, remove-aduser,
 * remove-adgroup, enable-adaccount, disable-adaccount, unlock-adaccount, set-adaccountpassword,
 * set-adorganizationalunit, remove-adorganizationalunit, add-adgroupmember, remove-adgroupmember,
 * move-adobject). La cmdlet s'exécute une fois par objet reçu, sans invite « Identity: ».
 */
import { describe, expect, it } from 'vitest'
import type { LabState } from '@engine/index'
import { buildReferenceLab } from '../serialization/reference-lab'
import { run, type RunResult } from './helpers'

const id = (s: LabState, name: string) => Object.values(s.devices).find((d) => d.name === name)?.id ?? ''
const domain = (s: LabState) => s.domains['lab.local']!
const user = (s: LabState, sam: string) => domain(s).users.find((u) => u.sam === sam)

class Console {
  session: RunResult['session'] | undefined
  constructor(public state: LabState) {}
  run(line: string, answers: string[] = []): RunResult {
    const r = run(this.state, id(this.state, 'SRV1'), line, {
      answers,
      ...(this.session ? { session: this.session } : {})
    })
    this.state = r.state
    this.session = r.session
    return r
  }
}

/** Lab de référence avec un second utilisateur (mdurand) dans l'OU Compta. */
function lab(): Console {
  const ps = new Console(buildReferenceLab())
  const r = ps.run(
    "New-ADUser -Name 'Marie Durand' -SamAccountName mdurand -Path 'OU=Compta,DC=lab,DC=local' -AccountPassword (ConvertTo-SecureString 'Passw0rd!2024' -AsPlainText -Force) -Enabled $true"
  )
  expect(r.errors).toBe('')
  return ps
}

const BOTH = "Get-ADUser -Filter * -SearchBase 'OU=Compta,DC=lab,DC=local'"

describe('cmdlets AD : -Identity lié par le pipeline', () => {
  it('Set-ADUser : un objet, puis deux objets, sans invite', () => {
    const ps = lab()
    const one = ps.run('Get-ADUser jdupont | Set-ADUser -Description x')
    expect(one.prompts).toEqual([])
    expect(one.errors).toBe('')
    expect(user(ps.state, 'jdupont')?.description).toBe('x')
    expect(user(ps.state, 'mdurand')?.description).not.toBe('x')
    const two = ps.run(`${BOTH} | Set-ADUser -Description Compta`)
    expect(two.prompts).toEqual([])
    expect(user(ps.state, 'jdupont')?.description).toBe('Compta')
    expect(user(ps.state, 'mdurand')?.description).toBe('Compta')
  })

  it('Disable-ADAccount / Enable-ADAccount sur deux objets', () => {
    const ps = lab()
    expect(ps.run(`${BOTH} | Disable-ADAccount`).prompts).toEqual([])
    expect(user(ps.state, 'jdupont')?.enabled).toBe(false)
    expect(user(ps.state, 'mdurand')?.enabled).toBe(false)
    expect(ps.run('Get-ADUser mdurand | Enable-ADAccount').errors).toBe('')
    expect(user(ps.state, 'mdurand')?.enabled).toBe(true)
    expect(user(ps.state, 'jdupont')?.enabled).toBe(false)
  })

  it('Unlock-ADAccount et Set-ADAccountPassword', () => {
    const ps = lab()
    const u = ps.run(`${BOTH} | Unlock-ADAccount`)
    expect(u.prompts).toEqual([])
    expect(u.errors).toBe('')
    const p = ps.run(
      "Get-ADUser mdurand | Set-ADAccountPassword -Reset -NewPassword (ConvertTo-SecureString 'Nouveau123!' -AsPlainText -Force)"
    )
    expect(p.prompts).toEqual([])
    expect(user(ps.state, 'mdurand')?.password).toBe('Nouveau123!')
    expect(user(ps.state, 'jdupont')?.password).not.toBe('Nouveau123!')
  })

  it('Remove-ADUser : chaque objet est confirmé puis supprimé', () => {
    const ps = lab()
    const r = ps.run(`${BOTH} | Remove-ADUser`, ['O', 'O'])
    expect(r.prompts).toHaveLength(2)
    expect(user(ps.state, 'jdupont')).toBeUndefined()
    expect(user(ps.state, 'mdurand')).toBeUndefined()
  })

  it('Add-ADGroupMember / Remove-ADGroupMember : le groupe vient du pipeline', () => {
    const ps = lab()
    expect(ps.run('Get-ADGroup GG_Compta | Add-ADGroupMember -Members mdurand').prompts).toEqual([])
    const gg = () => domain(ps.state).groups.find((g) => g.name === 'GG_Compta')!
    expect(gg().members).toContain(user(ps.state, 'mdurand')!.id)
    const r = ps.run('Get-ADGroup GG_Compta | Remove-ADGroupMember -Members mdurand', ['O'])
    expect(r.prompts).toHaveLength(1)
    expect(gg().members).not.toContain(user(ps.state, 'mdurand')!.id)
  })

  it('Remove-ADGroup, Move-ADObject, Set-/Remove-ADOrganizationalUnit', () => {
    const ps = lab()
    ps.run(`${BOTH} | Move-ADObject -TargetPath 'CN=Users,DC=lab,DC=local'`)
    expect(ps.run('Get-ADUser mdurand').text).toContain('CN=Marie Durand,CN=Users,DC=lab,DC=local')
    expect(ps.run('Get-ADUser jdupont').text).toContain('CN=Jean Dupont,CN=Users,DC=lab,DC=local')
    ps.run('Get-ADGroup GG_Compta | Remove-ADGroup', ['O'])
    expect(domain(ps.state).groups.some((g) => g.name === 'GG_Compta')).toBe(false)
    const ou = "Get-ADOrganizationalUnit -Identity 'OU=Compta,DC=lab,DC=local'"
    const set = ps.run(`${ou} | Set-ADOrganizationalUnit -ProtectedFromAccidentalDeletion $false`)
    expect(set.prompts).toEqual([])
    expect(domain(ps.state).containers.find((c) => c.name === 'Compta')?.protected).toBe(false)
    ps.run(`${ou} | Remove-ADOrganizationalUnit -Recursive`, ['O'])
    expect(domain(ps.state).containers.some((c) => c.name === 'Compta')).toBe(false)
  })

  it('erreurs inchangées : -Identity explicite introuvable, invite sans pipeline', () => {
    const ps = lab()
    const before = new Console(buildReferenceLab()).run('Set-ADUser -Identity inconnu -Description x').errors
    expect(before).not.toBe('')
    expect(ps.run('Set-ADUser -Identity inconnu -Description x').errors).toBe(before)
    expect(ps.run('Set-ADUser -Description x', ['jdupont']).prompts).toContain('Identity: ')
  })
})
