/**
 * Corbeille Active Directory (restauration d'un utilisateur supprimé avec ses appartenances) et
 * Sauvegarde Windows Server (planification, sauvegarde unique, historique, récupération).
 */
import { describe, expect, it } from 'vitest'
import {
  backupOf,
  command,
  dispatch,
  domainToken,
  evaluateCheck,
  findNode,
  installFeatures,
  setOuProtection,
  unwrap,
  type AnyCommand,
  type LabState,
  type ServerDevice
} from '@engine/index'
import { buildReferenceLab } from '../serialization/reference-lab'
import { run } from '../shell/helpers'

const D = 'lab.local'
const id = (s: LabState, name: string) => Object.values(s.devices).find((d) => d.name === name)?.id ?? ''
const server = (s: LabState) => s.devices[id(s, 'SRV1')] as ServerDevice

function exec(state: LabState, ...cmds: AnyCommand[]): LabState {
  let s = state
  for (const cmd of cmds) {
    const r = dispatch(s, cmd)
    if (!r.ok) throw new Error(`${cmd.type} : ${r.error.message}`)
    s = r.state
  }
  return s
}

const user = (s: LabState, sam: string) => s.domains[D]!.users.find((u) => u.sam === sam)
const gg = (s: LabState) => s.domains[D]!.groups.find((g) => g.name === 'GG_Compta')!

describe('Corbeille Active Directory', () => {
  it('sans Corbeille : un utilisateur supprimé n’est pas restaurable', () => {
    let s = buildReferenceLab()
    const jd = user(s, 'jdupont')!
    s = exec(s, command('adds.removeObject', D, jd.id))
    expect(s.domains[D]!.deletedObjects).toEqual([])
    const r = dispatch(s, command('adds.restoreDeleted', D, jd.id))
    expect(!r.ok && r.error.code).toBe('NotFound')
  })

  it('acceptation : un utilisateur AD supprimé est restaurable (attributs et groupes)', () => {
    let s = exec(buildReferenceLab(), command('adds.enableRecycleBin', D))
    const jd = user(s, 'jdupont')!
    s = exec(s, command('adds.removeObject', D, jd.id))
    expect(user(s, 'jdupont')).toBeUndefined()
    expect(gg(s).members).not.toContain(jd.id)
    s = exec(s, command('adds.restoreDeleted', D, jd.id))
    expect(user(s, 'jdupont')).toEqual(jd)
    expect(gg(s).members).toContain(jd.id)
    expect(s.domains[D]!.deletedObjects).toEqual([])
    // Le compte restauré ouvre une session avec son mot de passe d'origine
    const logon = dispatch(
      s,
      command('adds.logon', id(s, 'PC1'), { user: 'jdupont', password: 'Azerty123!', domain: 'LAB' })
    )
    expect(logon.ok && logon.value.success).toBe(true)
    const twice = dispatch(s, command('adds.enableRecycleBin', D))
    expect(!twice.ok && twice.error.code).toBe('AlreadyEnabled')
    expect(evaluateCheck(s, { type: 'adRecycleBin', domain: 'lab.local' })).toBe(true)
  })

  it('critère adObjectRestored : exige une restauration depuis la Corbeille, pas un compte recréé', () => {
    const check = { type: 'adObjectRestored', domain: 'lab.local', name: 'jdupont' } as const
    let s = exec(buildReferenceLab(), command('adds.enableRecycleBin', D))
    const srv = id(s, 'SRV1')
    // Compte présent dès le départ : rien n'a été restauré
    expect(evaluateCheck(s, check)).toBe(false)
    // Supprimé puis recréé à la main : refusé
    const recreated = run(
      run(s, srv, 'Remove-ADUser -Identity jdupont -Confirm:$false').state,
      srv,
      'New-ADUser -Name "Jean Dupont" -SamAccountName jdupont'
    ).state
    expect(user(recreated, 'jdupont')).toBeDefined()
    expect(evaluateCheck(recreated, check)).toBe(false)
    // Restauré depuis la Corbeille : validé, événement tracé sur le contrôleur de domaine
    const jd = user(s, 'jdupont')!
    s = exec(s, command('adds.removeObject', D, jd.id), command('adds.restoreDeleted', D, jd.id))
    expect(evaluateCheck(s, check)).toBe(true)
    expect(server(s).host.eventLog.some((e) => e.eventId === 5138 && e.account === 'LAB\\jdupont')).toBe(true)
  })

  it('OU supprimée avec son contenu : le parent d’abord, puis l’utilisateur', () => {
    let s = exec(buildReferenceLab(), command('adds.enableRecycleBin', D))
    const ou = s.domains[D]!.containers.find((c) => c.name === 'Compta')!
    const jd = user(s, 'jdupont')!
    s = unwrap(setOuProtection(s, D, ou.id, false)).state
    s = exec(s, command('adds.removeObject', D, ou.id, true))
    const orphan = dispatch(s, command('adds.restoreDeleted', D, jd.id))
    expect(!orphan.ok && orphan.error.code).toBe('ParentDeleted')
    s = exec(s, command('adds.restoreDeleted', D, ou.id), command('adds.restoreDeleted', D, jd.id))
    expect(user(s, 'jdupont')?.parentId).toBe(ou.id)
  })

  it('cmdlets : Enable-ADOptionalFeature, Get-ADObject -IncludeDeletedObjects, Restore-ADObject', () => {
    let s = buildReferenceLab()
    const srv = id(s, 'SRV1')
    s = run(
      s,
      srv,
      "Enable-ADOptionalFeature -Identity 'Recycle Bin Feature' -Scope ForestOrConfigurationSet -Target lab.local -Confirm:$false"
    ).state
    expect(run(s, srv, 'Get-ADOptionalFeature -Filter *').text).toMatch(/EnabledScopes\s+: \{CN=Partitions/)
    s = run(s, srv, 'Remove-ADUser -Identity jdupont -Confirm:$false').state
    const listed = run(
      s,
      srv,
      'Get-ADObject -Filter \'isDeleted -eq $true -and Name -like "Jean*"\' -IncludeDeletedObjects'
    )
    expect(listed.text).toMatch(/Deleted\s+: True/)
    expect(listed.text).toContain('CN=Deleted Objects,DC=lab,DC=local')
    s = run(
      s,
      srv,
      'Get-ADObject -Filter \'SamAccountName -eq "jdupont"\' -IncludeDeletedObjects | Restore-ADObject'
    ).state
    expect(user(s, 'jdupont')).toBeDefined()
    expect(run(s, srv, 'Get-ADObject -Filter * -IncludeDeletedObjects').text.trim()).toBe('')
  })
})

describe('Sauvegarde Windows Server', () => {
  function lab(): LabState {
    let s = buildReferenceLab()
    const srv = id(s, 'SRV1')
    s = unwrap(installFeatures(s, srv, ['Windows-Server-Backup'])).state
    const admin = domainToken(s.domains[D]!, 'Administrateur')!
    return exec(
      s,
      command('files.createItem', srv, 'C:\\Compta\\2026', 'folder', admin, { parents: true }),
      command('files.createItem', srv, 'C:\\Compta\\2026\\budget.xlsx', 'file', admin, { size: 2048 })
    )
  }

  it('planification : éléments existants, destination hors du volume sauvegardé, heure valide', () => {
    let s = lab()
    const srv = id(s, 'SRV1')
    const badItem = dispatch(
      s,
      command('backup.setPolicy', srv, { items: ['C:\\Absent'], target: 'E:', time: '21:00' })
    )
    expect(!badItem.ok && badItem.error.code).toBe('PathNotFound')
    const sameVolume = dispatch(
      s,
      command('backup.setPolicy', srv, { items: ['C:\\Compta'], target: 'C:', time: '21:00' })
    )
    expect(!sameVolume.ok && sameVolume.error.code).toBe('InvalidTarget')
    const badTime = dispatch(
      s,
      command('backup.setPolicy', srv, { items: ['C:\\Compta'], target: 'E:', time: '25:00' })
    )
    expect(!badTime.ok && badTime.error.code).toBe('InvalidTime')
    s = exec(
      s,
      command('backup.setPolicy', srv, {
        items: ['c:\\compta\\'],
        systemState: true,
        target: 'e:',
        time: '21:00'
      })
    )
    expect(backupOf(server(s))!.policy).toEqual({
      items: ['C:\\Compta'],
      systemState: true,
      target: 'E:',
      time: '21:00'
    })
    expect(
      evaluateCheck(s, { type: 'backupPolicy', server: 'SRV1', item: 'C:\\Compta\\2026', systemState: true })
    ).toBe(true)
  })

  it('sauvegarde puis récupération d’un fichier supprimé ; copie quand l’original existe', () => {
    let s = lab()
    const srv = id(s, 'SRV1')
    s = exec(s, command('backup.setPolicy', srv, { items: ['C:\\Compta'], target: 'E:', time: '21:00' }))
    const r = dispatch(s, command('backup.start', srv, null))
    if (!r.ok) throw new Error(r.error.message)
    s = r.state
    const version = r.value
    expect(backupOf(server(s))!.sets[0]!.entries.map((e) => e.path)).toEqual([
      'C:\\Compta',
      'C:\\Compta\\2026',
      'C:\\Compta\\2026\\budget.xlsx'
    ])
    const admin = domainToken(s.domains[D]!, 'Administrateur')!
    s = exec(s, command('files.removeItem', srv, 'C:\\Compta\\2026', admin, { recurse: true }))
    expect(findNode(server(s).storage, 'C:\\Compta\\2026\\budget.xlsx')).toBeUndefined()
    s = exec(s, command('backup.recover', srv, version, 'C:\\Compta\\2026', 'CreateCopy'))
    expect(findNode(server(s).storage, 'C:\\Compta\\2026\\budget.xlsx')?.size).toBe(2048)
    // L'original existe : une copie est créée
    s = exec(s, command('backup.recover', srv, version, 'C:\\Compta\\2026\\budget.xlsx', 'CreateCopy'))
    expect(findNode(server(s).storage, 'C:\\Compta\\2026\\Copie de budget.xlsx')).toBeTruthy()
    const missing = dispatch(s, command('backup.recover', srv, version, 'C:\\Autre', 'Overwrite'))
    expect(!missing.ok && missing.error.code).toBe('ItemNotFound')
    expect(
      evaluateCheck(s, { type: 'backupSet', server: 'SRV1', item: 'C:\\Compta\\2026\\budget.xlsx' })
    ).toBe(true)
  })

  it('wbadmin : sauvegarde unique, versions, récupération, planification', () => {
    let s = lab()
    const srv = id(s, 'SRV1')
    let r = run(s, srv, 'wbadmin start backup -backupTarget:E: -include:C:\\Compta -systemState -quiet', {
      shell: 'cmd'
    })
    expect(r.text).toContain('Opération de sauvegarde réussie.')
    s = r.state
    const version = backupOf(server(s))!.sets[0]!.version
    expect(run(s, srv, 'wbadmin get versions', { shell: 'cmd' }).text).toContain(
      `Identificateur de version : ${version}`
    )
    const admin = domainToken(s.domains[D]!, 'Administrateur')!
    s = exec(s, command('files.removeItem', srv, 'C:\\Compta\\2026\\budget.xlsx', admin, {}))
    r = run(
      s,
      srv,
      `wbadmin start recovery -version:${version} -itemType:File -items:C:\\Compta\\2026\\budget.xlsx -overwrite:Overwrite -quiet`,
      { shell: 'cmd' }
    )
    expect(r.text).toContain('1 élément(s) récupéré(s).')
    s = r.state
    expect(findNode(server(s).storage, 'C:\\Compta\\2026\\budget.xlsx')).toBeTruthy()
    s = run(s, srv, 'wbadmin enable backup -addtarget:E: -schedule:22:30 -include:C:\\Compta -quiet', {
      shell: 'cmd'
    }).state
    expect(backupOf(server(s))!.policy?.time).toBe('22:30')
    expect(
      run(s, srv, 'wbadmin start backup -backupTarget:C: -include:C:\\Compta', { shell: 'cmd' }).errors
    ).toMatch(/ERREUR/)
  })
})
