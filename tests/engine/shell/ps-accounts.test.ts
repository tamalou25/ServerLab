/**
 * Comptes locaux, Active Directory et GPO (v2.7, Lot 2b).
 *
 * Sources Microsoft Learn :
 * - LocalAccounts (PowerShell 5.1) : Get-LocalUser (affichage « Name Enabled Description », -SID,
 *   SID -500 = Administrateur), New-LocalUser (-NoPassword, -Password, -FullName, -Description,
 *   -Disabled ; « A user name can contain up to 20 … characters », caractères interdits, nom unique
 *   parmi utilisateurs et groupes), Set-LocalUser (-Description, -Password par le pipeline),
 *   Remove-LocalUser, Get-LocalGroup, New-LocalGroup, Add-LocalGroupMember (comptes locaux et
 *   DOMAINE\groupe), PrincipalSource Local / ActiveDirectory.
 * - ActiveDirectory : Get-ADForest (exemple 4 : liste ApplicationPartitions … UPNSuffixes),
 *   Set-ADGroup (-Description, -GroupScope DomainLocal|Global|Universal ou 0|1|2, -PassThru),
 *   « Understand security groups » (conversions d'étendue), Get/Set-ADDefaultDomainPasswordPolicy
 *   (-LockoutDuration 00:40:00, -LockoutObservationWindow, -ComplexityEnabled, -MinPasswordLength),
 *   New-ADComputer (« does not join a computer to a domain », conteneur par défaut des ordinateurs).
 * - GroupPolicy : Set-GPRegistryValue (exemple 1 : Key, ValueName, Value 900, Type DWORD ; renvoie
 *   la GPO ; -Disable), Get-GPRegistryValue (KeyPath, FullKeyPath, Hive, PolicyState, Value, Type,
 *   ValueName, HasValue), Get-GPOReport (-ReportType Html|Xml, sans -Path : affiché ; -Path : fichier).
 */
import { describe, expect, it } from 'vitest'
import { command, dispatch, type HostDevice, type LabState } from '@engine/index'
import { buildReferenceLab } from '../serialization/reference-lab'
import { run, type RunResult } from './helpers'

const id = (s: LabState, name: string) => Object.values(s.devices).find((d) => d.name === name)?.id ?? ''

class Console {
  constructor(public state: LabState) {}
  run(line: string, on = 'SRV1', shell: 'powershell' | 'cmd' = 'powershell', answers?: string[]): RunResult {
    const r = run(this.state, id(this.state, on), line, { shell, ...(answers ? { answers } : {}) })
    this.state = r.state
    return r
  }
}

const pc2 = (s: LabState) => s.devices[id(s, 'PC2')] as HostDevice

describe('LocalAccounts : utilisateurs locaux (poste PC2 en groupe de travail)', () => {
  it('Get-LocalUser : comptes intégrés, affichage Name / Enabled / Description, SID -500', () => {
    const ps = new Console(buildReferenceLab())
    const out = ps.run('Get-LocalUser', 'PC2').text
    expect(out).toMatch(/^Name\s+Enabled\s+Description$/m)
    expect(out).toMatch(/^Administrateur\s+True\s+Compte d’utilisateur d’administration$/m)
    expect(out).toMatch(/^Invité\s+False\s/m)
    expect(ps.run('(Get-LocalUser Administrateur).SID', 'PC2').text.trim()).toMatch(/^S-1-5-21-\d+-\d+-\d+-500$/)
    expect(ps.run('Get-LocalUser Absent', 'PC2').errors).toContain('L’utilisateur Absent est introuvable.')
  })
  it('New-LocalUser -NoPassword (Learn, exemple 1), -Password, état dans le moteur', () => {
    const ps = new Console(buildReferenceLab())
    const out = ps.run("New-LocalUser -Name 'User02' -Description 'Description of this account.' -NoPassword", 'PC2').text
    expect(out).toMatch(/^User02\s+True\s+Description of this account\.$/m)
    ps.run(
      "New-LocalUser jdoe -Password (ConvertTo-SecureString 'Azerty123!' -AsPlainText -Force) -FullName 'John Doe' -Disabled",
      'PC2'
    )
    expect(pc2(ps.state).host.localUsers).toContainEqual(
      expect.objectContaining({ name: 'jdoe', fullName: 'John Doe', enabled: false, password: 'Azerty123!' })
    )
    expect(ps.run('(Get-LocalUser User02).PasswordRequired', 'PC2').text.trim()).toBe('False')
  })
  it('New-LocalUser sans -Password : saisie demandée', () => {
    const ps = new Console(buildReferenceLab())
    const r = ps.run('New-LocalUser invite2', 'PC2', 'powershell', ['Secret1!'])
    expect(r.prompts[0]).toContain('Password')
    expect(pc2(ps.state).host.localUsers[0]?.password).toBe('Secret1!')
  })
  it('règles de nom (Learn) : 20 caractères, caractères interdits, nom déjà utilisé', () => {
    const ps = new Console(buildReferenceLab())
    expect(ps.run('New-LocalUser abcdefghijklmnopqrstu -NoPassword', 'PC2').errors).toContain('20 caractères')
    expect(ps.run("New-LocalUser 'a@b' -NoPassword", 'PC2').errors).toContain('caractère interdit')
    expect(ps.run("New-LocalUser '...' -NoPassword", 'PC2').errors).toContain('points ou d’espaces')
    expect(ps.run('New-LocalUser Administrateurs -NoPassword', 'PC2').errors).toContain('déjà utilisé par un groupe')
    expect(ps.run('New-LocalUser administrateur -NoPassword', 'PC2').errors).toContain('UserExists')
  })
  it('Set-LocalUser (description, mot de passe par le pipeline), Disable/Enable, Remove-LocalUser', () => {
    const ps = new Console(buildReferenceLab())
    ps.run('New-LocalUser Admin07 -NoPassword', 'PC2')
    ps.run('Set-LocalUser -Name "Admin07" -Description "Description of this account."', 'PC2')
    ps.run("Get-LocalUser Admin07 | Set-LocalUser -Password (ConvertTo-SecureString 'N0uveau!' -AsPlainText -Force)", 'PC2')
    expect(pc2(ps.state).host.localUsers[0]).toMatchObject({ description: 'Description of this account.', password: 'N0uveau!' })
    ps.run('Disable-LocalUser Admin07', 'PC2')
    expect(ps.run('(Get-LocalUser Admin07).Enabled', 'PC2').text.trim()).toBe('False')
    ps.run('Enable-LocalUser Admin07', 'PC2')
    // Mot de passe d'Administrateur : celui de la base locale (localAdminPassword)
    ps.run("Set-LocalUser Administrateur -Password (ConvertTo-SecureString 'Adm1n!' -AsPlainText -Force)", 'PC2')
    expect(pc2(ps.state).host.localAdminPassword).toBe('Adm1n!')
    ps.run('Remove-LocalUser -Name Admin07', 'PC2')
    expect(pc2(ps.state).host.localUsers.some((u) => u.name === 'Admin07')).toBe(false)
    expect(ps.run('Remove-LocalUser Invité', 'PC2').errors).toContain('ne peut pas être supprimé')
    expect(ps.run('Remove-LocalUser Absent', 'PC2').errors).toContain('introuvable')
  })
  it('contrôleur de domaine : pas de base locale (message honnête)', () => {
    const ps = new Console(buildReferenceLab())
    expect(ps.run('New-LocalUser x -NoPassword').errors).toContain('n’a pas de base de comptes locale')
  })
})

describe('LocalAccounts : groupes locaux', () => {
  it('Get-LocalGroup, New-LocalGroup, Add-LocalGroupMember, Get-LocalGroupMember', () => {
    const ps = new Console(buildReferenceLab())
    expect(ps.run('Get-LocalGroup', 'PC2').text).toMatch(/^Administrateurs\s+Les membres du groupe Administrateurs/m)
    expect(ps.run('Get-LocalGroup -Name Administrators', 'PC2').text).toContain('Administrateurs')
    expect(ps.run('New-LocalGroup -Name "SecurityGroup04"', 'PC2').text).toMatch(/^SecurityGroup04/m)
    ps.run('New-LocalUser Admin02 -NoPassword', 'PC2')
    ps.run('Add-LocalGroupMember -Group "Administrators" -Member "Admin02"', 'PC2')
    ps.run('Add-LocalGroupMember -Group SecurityGroup04 -Member Admin02', 'PC2')
    const members = ps.run('Get-LocalGroupMember Administrateurs', 'PC2').text
    expect(members).toMatch(/Utilisateur\s+PC2\\Administrateur\s+Local/)
    expect(members).toMatch(/Utilisateur\s+PC2\\Admin02\s+Local/)
    expect(ps.run('Add-LocalGroupMember Administrateurs -Member Admin02', 'PC2').errors).toContain('déjà membre')
    expect(ps.run('Add-LocalGroupMember Administrateurs -Member Fantome', 'PC2').errors).toContain('introuvable')
    expect(ps.run('Add-LocalGroupMember Inexistant -Member Admin02', 'PC2').errors).toContain('Le groupe Inexistant est introuvable.')
    ps.run('Remove-LocalGroupMember Administrateurs -Member Admin02', 'PC2')
    expect(ps.run('Get-LocalGroupMember Administrateurs', 'PC2').text).not.toContain('Admin02')
  })
  it('poste membre du domaine : DOMAINE\\groupe ajouté (ActiveDirectory) ; Admins du domaine implicite', () => {
    const ps = new Console(buildReferenceLab())
    ps.run('New-ADGroup -Name GG_Support -GroupScope Global')
    ps.run('Add-LocalGroupMember -Group Administrateurs -Member "LAB\\GG_Support"', 'PC1')
    const out = ps.run('Get-LocalGroupMember Administrateurs', 'PC1').text
    expect(out).toMatch(/Groupe\s+LAB\\Admins du domaine\s+ActiveDirectory/)
    expect(out).toMatch(/Groupe\s+LAB\\GG_Support\s+ActiveDirectory/)
  })
  it('compte local créé : authentifié par net use avec son mot de passe ; administrateur si membre', () => {
    const ps = new Console(buildReferenceLab())
    ps.run("New-LocalUser tech -Password (ConvertTo-SecureString 'T3ch!pass' -AsPlainText -Force)", 'PC2')
    ps.run('Add-LocalGroupMember Administrateurs -Member tech', 'PC2')
    // Partage administratif C$ de PC2 ouvert depuis SRV1 avec le compte local
    const ok = ps.run('net use \\\\PC2\\C$ /user:PC2\\tech', 'SRV1', 'cmd', ['T3ch!pass'])
    const bad = ps.run('net use \\\\PC2\\C$ /user:PC2\\tech', 'SRV1', 'cmd', ['mauvais'])
    console.log(ok.text, '|', ok.errors, '|', bad.errors)
  })
  it('commandes nommées de l’interface (local.*) : même état que la console', () => {
    let s = buildReferenceLab()
    const pc = id(s, 'PC2')
    for (const c of [
      command('local.newUser', pc, { name: 'gui', password: 'x' }),
      command('local.newGroup', pc, { name: 'G1' }),
      command('local.addGroupMembers', pc, 'G1', ['gui'])
    ]) {
      const r = dispatch(s, c)
      if (!r.ok) throw new Error(r.error.message)
      s = r.state
    }
    expect(new Console(s).run('Get-LocalGroupMember G1', 'PC2').text).toContain('PC2\\gui')
  })
})

describe('Active Directory', () => {
  it('Get-ADForest : forêt à un domaine (champs de l’exemple 4 de Learn)', () => {
    const ps = new Console(buildReferenceLab())
    const lines = ps.run('Get-ADForest').text.split('\n').filter((l) => l.includes(' : '))
    expect(lines.map((l) => l.split(' : ')[0]?.trim())).toEqual([
      'ApplicationPartitions',
      'CrossForestReferences',
      'DomainNamingMaster',
      'Domains',
      'GlobalCatalogs',
      'Name',
      'PartitionsContainer',
      'RootDomain',
      'SchemaMaster',
      'Sites',
      'SPNSuffixes',
      'UPNSuffixes'
    ])
    const out = lines.join('\n')
    expect(out).toMatch(/ApplicationPartitions\s+: \{DC=ForestDnsZones,DC=lab,DC=local, DC=DomainDnsZones,DC=lab,DC=local\}/)
    expect(out).toMatch(/SchemaMaster\s+: SRV1\.lab\.local/)
    expect(out).toMatch(/Domains\s+: \{lab\.local\}/)
    expect(ps.run('Get-ADForest -Identity autre.local').errors).toContain('ADIdentityNotFoundException')
  })
  it('Set-ADGroup : description, -PassThru, conversions d’étendue (Learn)', () => {
    const ps = new Console(buildReferenceLab())
    ps.run('New-ADGroup -Name AccessControl -GroupScope DomainLocal')
    const out = ps.run('Set-ADGroup -Identity AccessControl -Description "Access Group" -PassThru').text
    expect(out).toMatch(/GroupScope\s+: DomainLocal/)
    expect(ps.state.domains['lab.local']?.groups.find((g) => g.name === 'AccessControl')?.description).toBe('Access Group')
    expect(ps.run('Set-ADGroup AccessControl -GroupScope Global').errors).toContain('convertissez-le d’abord en groupe universel')
    ps.run('Set-ADGroup AccessControl -GroupScope 2')
    ps.run('Set-ADGroup AccessControl -GroupScope Global')
    expect(ps.state.domains['lab.local']?.groups.find((g) => g.name === 'AccessControl')?.scope).toBe('Global')
    // Global membre d'un autre groupe global : pas de conversion en universel
    ps.run('New-ADGroup -Name Parent -GroupScope Global')
    ps.run('Add-ADGroupMember -Identity Parent -Members AccessControl')
    expect(ps.run('Set-ADGroup AccessControl -GroupScope Universal').errors).toContain('membre d’un autre groupe global')
    expect(ps.run('Get-ADGroup -Filter "name -like \'Access*\'" | Set-ADGroup -Description "Pipeline"').errors).toBe('')
    expect(ps.run('Set-ADGroup Absent -Description x').errors).toContain('ADIdentityNotFoundException')
    expect(ps.run('Set-ADGroup AccessControl -ManagedBy x').errors).toContain('n’est pas simulé')
  })
  it('Get/Set-ADDefaultDomainPasswordPolicy : lu et écrit dans la Default Domain Policy', () => {
    const ps = new Console(buildReferenceLab())
    const before = ps.run('Get-ADDefaultDomainPasswordPolicy').text
    expect(before).toMatch(/MinPasswordLength\s+: 7/)
    expect(before).toMatch(/ComplexityEnabled\s+: True/)
    expect(before).toMatch(/DistinguishedName\s+: DC=lab,DC=local/)
    ps.run(
      'Set-ADDefaultDomainPasswordPolicy -Identity lab.local -LockoutDuration 00:40:00 -LockoutObservationWindow 00:20:00 -ComplexityEnabled $True -MinPasswordLength 12 -LockoutThreshold 5'
    )
    const ddp = ps.state.domains['lab.local']?.gpos.find((g) => g.name === 'Default Domain Policy')
    expect(ddp?.computer).toMatchObject({ minPasswordLength: 12, lockoutDuration: 40, lockoutReset: 20, lockoutThreshold: 5 })
    const after = ps.run('Get-ADDefaultDomainPasswordPolicy -Identity LAB').text
    expect(after).toMatch(/LockoutDuration\s+: 00:40:00/)
    expect(after).toMatch(/LockoutObservationWindow\s+: 00:20:00/)
    // Même stratégie vue par net accounts (GPO de domaine)
    expect(ps.run('net accounts', 'SRV1', 'cmd').text).toMatch(/Longueur minimale du mot de passe :\s+12/)
    expect(ps.run('Get-ADDomain | Set-ADDefaultDomainPasswordPolicy -MinPasswordLength 8').errors).toBe('')
    expect(ps.run('Set-ADDefaultDomainPasswordPolicy lab.local -MaxPasswordAge 10.00:00:00').errors).toContain('n’est pas simulé')
    expect(ps.run('Set-ADDefaultDomainPasswordPolicy lab.local -LockoutDuration abc').errors).toContain('TimeSpan')
    expect(ps.run('Set-ADDefaultDomainPasswordPolicy lab.local -MinPasswordLength 40').errors).toContain('entre 0 et 14')
  })
  it('New-ADComputer : compte pré-créé dans CN=Computers ou une OU, repris à la jonction', () => {
    const ps = new Console(buildReferenceLab())
    ps.run('New-ADOrganizationalUnit -Name Serveurs')
    ps.run('New-ADComputer -Name "SRV2" -SamAccountName "SRV2" -Path "OU=Serveurs,DC=lab,DC=local"')
    expect(ps.run('Get-ADComputer SRV2').text).toMatch(/DistinguishedName\s+: CN=SRV2,OU=Serveurs,DC=lab,DC=local/)
    ps.run('New-ADComputer -Name POSTE9')
    expect(ps.run('Get-ADComputer POSTE9').text).toContain('CN=POSTE9,CN=Computers,DC=lab,DC=local')
    expect(ps.run('New-ADComputer -Name POSTE9').errors).toContain('existe déjà')
    expect(ps.run('New-ADComputer -Name X -Path "OU=Absente,DC=lab,DC=local"').errors).toContain('non trouvé')
    const computer = ps.state.domains['lab.local']?.computers.find((c) => c.name === 'POSTE9')
    expect(computer?.deviceId).toBeNull()
  })
})

describe('GroupPolicy : registre et rapports', () => {
  it('Set-GPRegistryValue (Learn, exemple 1) : renvoie la GPO ; Get-GPRegistryValue la restitue', () => {
    const ps = new Console(buildReferenceLab())
    ps.run('New-GPO -Name TestGPO')
    const set = ps.run(
      "Set-GPRegistryValue -Name 'TestGPO' -Key 'HKCU\\Software\\Policies\\Microsoft\\Windows\\Control Panel\\Desktop' -ValueName 'ScreenSaveTimeOut' -Value 900 -Type 'DWORD'"
    ).text
    expect(set).toMatch(/DisplayName\s+: TestGPO/)
    expect(set).toMatch(/UserVersion\s+: AD Version: 1, SysVol Version: 1/)
    const get = ps.run(
      "Get-GPRegistryValue -Name TestGPO -Key 'HKEY_CURRENT_USER\\Software\\Policies\\Microsoft\\Windows\\Control Panel\\Desktop' -ValueName ScreenSaveTimeOut"
    ).text
    expect(get).toMatch(/KeyPath\s+: Software\\Policies\\Microsoft\\Windows\\Control Panel\\Desktop/)
    expect(get).toMatch(/FullKeyPath\s+: HKEY_CURRENT_USER\\Software/)
    expect(get).toMatch(/Hive\s+: CurrentUser/)
    expect(get).toMatch(/PolicyState\s+: Set/)
    expect(get).toMatch(/Value\s+: 900/)
    expect(get).toMatch(/Type\s+: DWord/)
    // Clé parente : les sous-clés sont renvoyées ; -Disable : PolicyState Delete
    ps.run("Set-GPRegistryValue -Name TestGPO -Key 'HKCU\\Software\\Policies\\Microsoft\\Windows\\Control Panel\\Desktop' -ValueName ScreenSaveTimeOut -Disable")
    expect(ps.run("Get-GPRegistryValue -Name TestGPO -Key 'HKCU\\Software\\Policies\\Microsoft'").text).toMatch(/PolicyState\s+: Delete/)
  })
  it('valeurs reliées aux paramètres simulés (NoRun) ; erreurs', () => {
    const ps = new Console(buildReferenceLab())
    ps.run('New-GPO -Name Restrictions')
    ps.run("Set-GPRegistryValue -Name Restrictions -Key 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer' -ValueName NoRun -Value 1 -Type DWord")
    expect(ps.state.domains['lab.local']?.gpos.find((g) => g.name === 'Restrictions')?.user.noRun).toBe('Enabled')
    expect(ps.run("Set-GPRegistryValue -Name Restrictions -Key 'HKCR\\x' -ValueName a -Value 1 -Type DWord").errors).toContain('HKLM')
    expect(ps.run("Set-GPRegistryValue -Name Restrictions -Key 'HKLM\\Software\\X' -ValueName a,b -Value 1,2 -Type DWord").errors).toContain('String et ExpandString')
    expect(ps.run("Set-GPRegistryValue -Name Restrictions -Key 'HKLM\\Software\\X' -ValueName a -Value abc -Type DWord").errors).toContain('n’est pas valide')
    expect(ps.run("Get-GPRegistryValue -Name Restrictions -Key 'HKLM\\Software\\Rien'").errors).toContain('n’est pas configurée')
    expect(ps.run("Set-GPRegistryValue -Name Absente -Key 'HKLM\\Software\\X' -ValueName a -Value 1 -Type DWord").errors).toContain('introuvable')
  })
  it('Get-GPOReport -ReportType Xml / Html : affiché, ou écrit avec -Path', () => {
    const ps = new Console(buildReferenceLab())
    const xml = ps.run("Get-GPOReport -Name 'Default Domain Policy' -ReportType Xml").text
    expect(xml).toContain('<?xml version="1.0" encoding="utf-16"?>')
    expect(xml).toContain('<Name>Default Domain Policy</Name>')
    expect(xml).toContain('<Identifier>{31B2F340-016D-11D2-945F-00C04FB984F9}</Identifier>')
    expect(xml).toMatch(/<SOMPath>lab\.local<\/SOMPath>/)
    expect(xml).toMatch(/<Setting [^>]*>7 caractère/)
    const html = ps.run("Get-GPOReport -Name 'Default Domain Policy' -ReportType HTML").text
    expect(html).toContain('<h1>Default Domain Policy</h1>')
    expect(html).toContain('<h2>Filtrage de sécurité</h2>')
    ps.run("Get-GPOReport -Name 'Default Domain Policy' -ReportType HTML -Path C:\\Scripts\\ddp.html")
    expect(ps.run('Get-Content C:\\Scripts\\ddp.html').text).toContain('<h1>Default Domain Policy</h1>')
    expect(ps.run('Get-GPOReport -All -ReportType Xml').text.match(/<GPO /g)?.length).toBe(2)
    expect(ps.run('Get-GPOReport -Name X -ReportType Pdf').errors).not.toBe('')
  })
})
