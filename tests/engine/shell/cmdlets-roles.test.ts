/**
 * Cmdlets des rôles jamais exercées ailleurs (AD DS, DHCP, DNS, SMB, GPO), sur le lab de référence :
 * sortie attendue et effet sur l'état, identique à l'action de l'interface quand elle existe.
 */
import { describe, expect, it } from 'vitest'
import {
  addExclusion,
  addReservation,
  dhcpServerOf,
  dispatch,
  command,
  dnsServerOf,
  type LabState,
  type ServerDevice
} from '@engine/index'
import { buildReferenceLab } from '../serialization/reference-lab'
import { run, type RunResult } from './helpers'

const id = (s: LabState, name: string) => Object.values(s.devices).find((d) => d.name === name)?.id ?? ''
const server = (s: LabState) => s.devices[id(s, 'SRV1')] as ServerDevice
const domain = (s: LabState) => s.domains['lab.local']!
const SCOPE = '192.168.10.0'

/** Console PowerShell persistante sur un équipement du lab de référence. */
class Console {
  session: RunResult['session'] | undefined
  constructor(
    public state: LabState,
    readonly device: string
  ) {}
  run(line: string, answers: string[] = []): RunResult {
    const r = run(this.state, id(this.state, this.device), line, {
      answers,
      ...(this.session ? { session: this.session } : {})
    })
    this.state = r.state
    this.session = r.session
    return r
  }
}

describe('cmdlets AD DS', () => {
  it('lecture : domaine, groupes, unités d’organisation, ordinateurs, appartenance', () => {
    const ps = new Console(buildReferenceLab(), 'SRV1')
    const dom = ps.run('Get-ADDomain').text
    expect(dom).toMatch(/DNSRoot\s+: lab\.local/)
    expect(dom).toMatch(/NetBIOSName\s+: LAB/)
    expect(dom).toMatch(/PDCEmulator\s+: SRV1\.lab\.local/)
    expect(ps.run('Get-ADGroup -Identity GG_Compta').text).toMatch(
      /DistinguishedName : CN=GG_Compta,OU=Compta,DC=lab,DC=local/
    )
    expect(ps.run('Get-ADGroup -Filter * | Measure-Object | Select-Object Count').text).toMatch(
      new RegExp(`\\b${domain(ps.state).groups.length}\\b`)
    )
    const ous = ps.run('Get-ADOrganizationalUnit -Filter *').text
    expect(ous).toContain('OU=Domain Controllers,DC=lab,DC=local')
    expect(ous).toContain('OU=Compta,DC=lab,DC=local')
    const computers = ps.run('Get-ADComputer -Filter *').text
    expect(computers).toContain('CN=SRV1,OU=Domain Controllers,DC=lab,DC=local')
    expect(computers).toContain('CN=PC1,CN=Computers,DC=lab,DC=local')
    expect(computers).toMatch(/SamAccountName\s+: PC1\$/)
    const groups = ps.run('Get-ADPrincipalGroupMembership -Identity jdupont').text
    expect(groups).toContain('Name              : Utilisateurs du domaine')
    expect(groups).toContain('Name              : GG_Compta')
  })

  it('modification : utilisateur, mot de passe, unité, membres, déplacement, suppressions', () => {
    const ps = new Console(buildReferenceLab(), 'SRV1')
    expect(ps.run('Set-ADUser -Identity jdupont -Description Comptable -Enabled $false').errors).toBe('')
    let user = domain(ps.state).users.find((u) => u.sam === 'jdupont')!
    expect(user.enabled).toBe(false)
    expect(ps.run('Set-ADUser -Identity jdupont -Enabled $true -ChangePasswordAtLogon $true').errors).toBe('')
    user = domain(ps.state).users.find((u) => u.sam === 'jdupont')!
    expect(user.enabled).toBe(true)
    expect(user.mustChangePassword).toBe(true)

    const reset = ps.run(
      "Set-ADAccountPassword -Identity jdupont -Reset -NewPassword (ConvertTo-SecureString 'Nouveau123!' -AsPlainText -Force)"
    )
    expect(reset.errors).toBe('')
    expect(domain(ps.state).users.find((u) => u.sam === 'jdupont')?.password).toBe('Nouveau123!')
    // Mot de passe non conforme : refusé, l'ancien est conservé
    const weak = ps.run(
      "Set-ADAccountPassword -Identity jdupont -Reset -NewPassword (ConvertTo-SecureString 'abc' -AsPlainText -Force)"
    )
    expect(weak.errors).not.toBe('')
    expect(domain(ps.state).users.find((u) => u.sam === 'jdupont')?.password).toBe('Nouveau123!')

    ps.run(
      "Set-ADOrganizationalUnit -Identity 'OU=Compta,DC=lab,DC=local' -ProtectedFromAccidentalDeletion $false"
    )
    expect(domain(ps.state).containers.find((c) => c.name === 'Compta')?.protected).toBe(false)

    const removeMember = ps.run('Remove-ADGroupMember -Identity GG_Compta -Members jdupont', ['O'])
    expect(removeMember.prompts).toHaveLength(1)
    const gg = domain(ps.state).groups.find((g) => g.name === 'GG_Compta')!
    expect(gg.members).toEqual([])

    ps.run(
      "Move-ADObject -Identity 'CN=Jean Dupont,OU=Compta,DC=lab,DC=local' -TargetPath 'CN=Users,DC=lab,DC=local'"
    )
    expect(ps.run('Get-ADUser -Identity jdupont').text).toContain('CN=Jean Dupont,CN=Users,DC=lab,DC=local')

    ps.run('Remove-ADGroup -Identity GG_Compta', ['O'])
    expect(domain(ps.state).groups.some((g) => g.name === 'GG_Compta')).toBe(false)
    // Réponse « Non » : rien n'est supprimé
    ps.run('Remove-ADUser -Identity jdupont', ['N'])
    expect(domain(ps.state).users.some((u) => u.sam === 'jdupont')).toBe(true)
    ps.run('Remove-ADUser -Identity jdupont', ['O'])
    expect(domain(ps.state).users.some((u) => u.sam === 'jdupont')).toBe(false)
  })

  it('Remove-Computer : quitte le domaine au redémarrage, comme Propriétés système', () => {
    const lab = buildReferenceLab()
    const dc = server(lab)
    const ps = new Console(lab, 'PC1')
    const r = ps.run(
      'Remove-Computer -UnjoinDomainCredential LAB\\Administrateur -WorkgroupName WORKGROUP -Force',
      [dc.host.localAdminPassword]
    )
    expect(r.text).toContain('après le redémarrage')
    const gui = dispatch(lab, command('adds.leaveDomain', id(lab, 'PC1')))
    if (!gui.ok) throw new Error(gui.error.message)
    const host = (s: LabState) => {
      const pc = s.devices[id(s, 'PC1')]
      return pc?.kind === 'client' ? pc.host : null
    }
    expect(host(ps.state)).toEqual(host(gui.state))
  })
})

describe('cmdlets DHCP', () => {
  it('exclusions et réservations : même état que la console DHCP', () => {
    const lab = buildReferenceLab()
    const srv = id(lab, 'SRV1')
    const ps = new Console(lab, 'SRV1')
    ps.run(
      `Add-DhcpServerv4ExclusionRange -ScopeId ${SCOPE} -StartRange 192.168.10.150 -EndRange 192.168.10.160`
    )
    ps.run(
      `Add-DhcpServerv4Reservation -ScopeId ${SCOPE} -IPAddress 192.168.10.180 -ClientId 00-15-5D-01-02-03 -Name IMP1`
    )
    let gui = addExclusion(lab, srv, SCOPE, '192.168.10.150', '192.168.10.160')
    if (!gui.ok) throw new Error(gui.error.message)
    gui = addReservation(gui.state, srv, SCOPE, {
      ip: '192.168.10.180',
      mac: '00-15-5D-01-02-03',
      name: 'IMP1'
    })
    if (!gui.ok) throw new Error(gui.error.message)
    expect(dhcpServerOf(server(ps.state))?.scopes).toEqual(dhcpServerOf(server(gui.state))?.scopes)

    expect(ps.run(`Get-DhcpServerv4ExclusionRange -ScopeId ${SCOPE}`).text).toMatch(
      /192\.168\.10\.0\s+192\.168\.10\.150\s+192\.168\.10\.160/
    )
    expect(ps.run(`Get-DhcpServerv4Reservation -ScopeId ${SCOPE}`).text).toMatch(
      /192\.168\.10\.180\s+192\.168\.10\.0\s+00-15-5d-01-02-03\s+IMP1/
    )
    ps.run(`Remove-DhcpServerv4Reservation -ScopeId ${SCOPE} -IPAddress 192.168.10.180`)
    expect(dhcpServerOf(server(ps.state))?.scopes[0]?.reservations).toEqual([])
  })

  it('options, autorisation, état et suppression d’étendue', () => {
    const ps = new Console(buildReferenceLab(), 'SRV1')
    const options = ps.run(`Get-DhcpServerv4OptionValue -ScopeId ${SCOPE}`).text
    expect(options).toMatch(/3 Routeur\s+IPv4Address \{192\.168\.10\.254\}/)
    expect(options).toMatch(/15 Nom de domaine DNS String\s+\{lab\.local\}/)
    expect(ps.run('Get-DhcpServerInDC').text).toMatch(/192\.168\.10\.1\s+srv1\.lab\.local/)
    ps.run(`Set-DhcpServerv4Scope -ScopeId ${SCOPE} -State InActive`)
    expect(dhcpServerOf(server(ps.state))?.scopes[0]?.state).toBe('Inactive')
    ps.run(`Remove-DhcpServerv4Scope -ScopeId ${SCOPE} -Force`)
    expect(dhcpServerOf(server(ps.state))?.scopes).toEqual([])
  })
})

describe('cmdlets DNS', () => {
  it('enregistrements, zone inverse et PTR, suppression', () => {
    const ps = new Console(buildReferenceLab(), 'SRV1')
    const records = ps.run('Get-DnsServerResourceRecord -ZoneName lab.local').text
    expect(records).toMatch(/_ldap\._tcp\s+SRV\s+33/)
    expect(records).toMatch(/intranet\s+CNAME\s+5/)
    expect(
      ps.run('Get-DnsServerResourceRecord -ZoneName lab.local -Name intranet -RRType CNAME').text
    ).toMatch(/intranet CNAME\s+5 .*srv1\.lab\.local\./)
    ps.run('Add-DnsServerPrimaryZone -NetworkId 192.168.10.0/24 -ReplicationScope Domain')
    ps.run(
      'Add-DnsServerResourceRecordPtr -ZoneName 10.168.192.in-addr.arpa -Name 20 -PtrDomainName pc2.lab.local'
    )
    expect(ps.run('Get-DnsServerResourceRecord -ZoneName 10.168.192.in-addr.arpa').text).toMatch(
      /20\s+PTR\s+12 .*pc2\.lab\.local\./
    )
    ps.run('Remove-DnsServerResourceRecord -ZoneName lab.local -Name intranet -RRType CNAME -Force')
    const zone = dnsServerOf(server(ps.state))?.zones.find((z) => z.name === 'lab.local')
    expect(zone?.records.some((r) => r.name === 'intranet')).toBe(false)
    ps.run('Remove-DnsServerZone -Name 10.168.192.in-addr.arpa -Force')
    expect(dnsServerOf(server(ps.state))?.zones.map((z) => z.name)).toEqual(['lab.local'])
  })

  it('redirecteurs : ajout, remplacement, lecture ; cache client vidé', () => {
    const ps = new Console(buildReferenceLab(), 'SRV1')
    ps.run('Add-DnsServerForwarder -IPAddress 8.8.8.8')
    expect(dnsServerOf(server(ps.state))?.forwarders).toEqual(['8.8.8.8'])
    ps.run('Set-DnsServerForwarder -IPAddress 1.1.1.1')
    expect(dnsServerOf(server(ps.state))?.forwarders).toEqual(['1.1.1.1'])
    expect(ps.run('Get-DnsServerForwarder').text).toMatch(/IPAddress\s+: \{1\.1\.1\.1\}/)
    const client = new Console(ps.state, 'PC2')
    expect(client.run('Clear-DnsClientCache').errors).toBe('')
  })
})

describe('cmdlets SMB', () => {
  it('partage : accorder, bloquer, lire, supprimer', () => {
    const ps = new Console(buildReferenceLab(), 'SRV1')
    ps.run('New-Item -Path C:\\Partages -ItemType Directory')
    ps.run("New-SmbShare -Name Partages -Path C:\\Partages -FullAccess 'Tout le monde'")
    ps.run('Grant-SmbShareAccess -Name Partages -AccountName LAB\\GG_Compta -AccessRight Change -Force')
    ps.run('Block-SmbShareAccess -Name Partages -AccountName LAB\\jdupont -Force')
    const access = ps.run('Get-SmbShareAccess -Name Partages').text
    expect(access).toMatch(/LAB\\GG_Compta Allow\s+Change/)
    expect(access).toMatch(/LAB\\jdupont\s+Deny\s+Full/)
    ps.run('Remove-SmbShare -Name Partages -Force')
    expect(server(ps.state).storage.shares.some((s) => s.name === 'Partages')).toBe(false)
  })

  it('lecteur réseau : New-SmbMapping, Get-SmbMapping, Remove-SmbMapping', () => {
    const ps = new Console(buildReferenceLab(), 'SRV1')
    ps.run('New-Item -Path C:\\Commun -ItemType Directory')
    ps.run("New-SmbShare -Name Commun -Path C:\\Commun -FullAccess 'Tout le monde'")
    const logon = dispatch(
      ps.state,
      command('adds.logon', id(ps.state, 'PC1'), { user: 'jdupont', password: 'Azerty123!', domain: 'LAB' })
    )
    if (!logon.ok) throw new Error(logon.error.message)
    const pc = new Console(logon.state, 'PC1')
    expect(pc.run('New-SmbMapping -LocalPath P: -RemotePath \\\\SRV1\\Commun').errors).toBe('')
    expect(pc.run('Get-SmbMapping').text).toMatch(/P:\s+\\\\SRV1\\Commun/)
    expect(pc.run('Remove-SmbMapping -LocalPath P: -Force').errors).toBe('')
    expect(pc.run('Get-SmbMapping').text.trim()).toBe('')
    // Lecteur absent : erreur réaliste
    expect(pc.run('Remove-SmbMapping -LocalPath P: -Force').errors).toContain(
      'La connexion réseau n’existe pas.'
    )
  })
})

describe('cmdlets GPO', () => {
  it('Rename-GPO renomme ; Invoke-GPUpdate distant signalé comme non simulé', () => {
    const ps = new Console(buildReferenceLab(), 'SRV1')
    ps.run('New-GPO -Name Test')
    expect(ps.run('Rename-GPO -Name Test -TargetName Test2').text).toMatch(/DisplayName\s+: Test2/)
    expect(domain(ps.state).gpos.map((g) => g.name)).toContain('Test2')
    expect(ps.run('Invoke-GPUpdate -Computer PC1 -Force').errors).toContain('n’est pas simulée')
  })
})

describe('fidélité Get-DnsServerResourceRecord (F-03)', () => {
  it('affiche le TTL réel de l’enregistrement au format hh:mm:ss', () => {
    const ps = new Console(buildReferenceLab(), 'SRV1')
    const zone = dnsServerOf(server(ps.state))?.zones.find((z) => z.name === 'lab.local')
    const rec = zone?.records.find((r) => r.name === 'intranet')
    expect(rec).toBeDefined()
    const ttl = rec!.ttl
    const hms = [Math.floor(ttl / 3600), Math.floor((ttl % 3600) / 60), ttl % 60]
      .map((n) => String(n).padStart(2, '0'))
      .join(':')
    const out = ps.run('Get-DnsServerResourceRecord -ZoneName lab.local -Name intranet -RRType CNAME').text
    expect(out).toContain(hms)
  })
})
