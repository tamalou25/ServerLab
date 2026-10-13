import { describe, expect, it } from 'vitest'
import {
  addScope,
  autoConfigureDhcp,
  changePasswordAndLogon,
  dnsServerOf,
  installFeatures,
  joinDomain,
  logon,
  restartComputer,
  setInterfaceIpv4,
  unwrap,
  type LabState
} from '@engine/index'
import { build, cable, setIp } from '../helpers'
import { run } from '../shell/helpers'

const DSRM = ['P@ssw0rd!', 'P@ssw0rd!']

/** SRV1 (192.168.1.1) et PC1 (192.168.1.10, DNS → SRV1) ; SRV1 promu DC de lab.local. */
function forest(opts: { pcDns?: string } = {}) {
  const { state, ids } = build([
    ['server', 'SRV1'],
    ['client', 'PC1'],
    ['switch', 'SW1']
  ])
  let s = cable(state, ids.SRV1!, 0, ids.SW1!, 0)
  s = cable(s, ids.PC1!, 0, ids.SW1!, 1)
  s = setIp(s, ids.SRV1!, 0, '192.168.1.1/24', undefined, ['8.8.8.8'])
  s = setIp(s, ids.PC1!, 0, '192.168.1.10/24', undefined, [opts.pcDns ?? '192.168.1.1'])
  s = unwrap(installFeatures(s, ids.SRV1!, ['AD-Domain-Services'], { includeManagementTools: true })).state
  const r = run(s, ids.SRV1!, 'Install-ADDSForest -DomainName lab.local -InstallDns', {
    answers: [...DSRM, 'O']
  })
  return { s: r.state, ids, out: r }
}

function joined() {
  const f = forest()
  const op = joinDomain(f.s, f.ids.PC1!, {
    domain: 'lab.local',
    user: 'LAB\\Administrateur',
    password: 'P@ssw0rd'
  })
  expect(op.ok).toBe(true)
  const s = unwrap(restartComputer(op.state, f.ids.PC1!)).state
  return { ...f, s }
}

function ps(state: LabState, deviceId: string, line: string, answers: string[] = []) {
  return run(state, deviceId, line, { answers })
}

describe('AD DS : promotion', () => {
  it('Install-ADDSForest demande le mot de passe DSRM, crée le domaine et la zone DNS', () => {
    const { s, ids, out } = forest()
    expect(out.prompts).toEqual([
      'SafeModeAdministratorPassword: ',
      'Confirmer SafeModeAdministratorPassword: ',
      expect.stringContaining('Voulez-vous continuer')
    ])
    expect(out.text).toContain('AVERTISSEMENT : Impossible de créer une délégation pour ce serveur DNS')
    expect(out.text).toContain('L’opération a réussi.')
    const domain = s.domains['lab.local']
    expect(domain?.netbios).toBe('LAB')
    const srv = s.devices[ids.SRV1!]
    expect(srv?.kind === 'server' && srv.host.session).toEqual({
      user: 'Administrateur',
      domain: 'LAB',
      logonServer: 'SRV1'
    })
    const zone =
      srv?.kind === 'server' ? dnsServerOf(srv)?.zones.find((z) => z.name === 'lab.local') : undefined
    expect(zone?.adIntegrated).toBe(true)
    expect(zone?.records.some((r) => r.type === 'SRV' && r.name === '_ldap._tcp.dc._msdcs')).toBe(true)
    // DNS du DC sur lui-même, ancien DNS en redirecteur
    expect(srv?.interfaces[0]?.dnsServers).toEqual(['127.0.0.1'])
    expect(srv?.kind === 'server' && dnsServerOf(srv)?.forwarders).toEqual(['8.8.8.8'])
    expect(ps(s, ids.SRV1!, 'whoami').text).toBe('lab\\administrateur')
  })

  it('refuse un mot de passe DSRM faible et un rôle absent', () => {
    const { state, ids } = build([['server', 'SRV1']])
    const s = unwrap(
      installFeatures(state, ids.SRV1!, ['AD-Domain-Services'], { includeManagementTools: true })
    ).state
    expect(
      ps(s, ids.SRV1!, 'Install-ADDSForest -DomainName lab.local -Force', ['abc', 'abc']).errors
    ).toContain('ne répond pas aux exigences')
    expect(ps(state, ids.SRV1!, 'Install-ADDSForest -DomainName lab.local').errors).toContain(
      "n'est pas reconnu"
    )
  })
})

describe('AD DS : objets', () => {
  it('OU, utilisateurs, groupes et filtres', () => {
    const { s: base, ids } = forest()
    let r = ps(base, ids.SRV1!, 'New-ADOrganizationalUnit -Name "Compta" -Path "DC=lab,DC=local"')
    expect(r.errors).toBe('')
    r = ps(
      r.state,
      ids.SRV1!,
      'New-ADUser -Name "Jean Dupont" -SamAccountName jdupont -Path "OU=Compta,DC=lab,DC=local" -AccountPassword (ConvertTo-SecureString "Azerty123!" -AsPlainText -Force) -Enabled $true'
    )
    expect(r.errors).toBe('')
    r = ps(
      r.state,
      ids.SRV1!,
      'New-ADGroup -Name "GG_Compta" -GroupScope Global -Path "OU=Compta,DC=lab,DC=local"'
    )
    r = ps(r.state, ids.SRV1!, 'Add-ADGroupMember -Identity GG_Compta -Members jdupont')
    expect(r.errors).toBe('')
    const u = ps(r.state, ids.SRV1!, 'Get-ADUser -Filter "Name -like \'Jean*\'"')
    expect(u.text).toContain('DistinguishedName : CN=Jean Dupont,OU=Compta,DC=lab,DC=local')
    expect(u.text).toContain('Enabled           : True')
    expect(ps(r.state, ids.SRV1!, 'Get-ADGroupMember GG_Compta').text).toContain('jdupont')
    expect(ps(r.state, ids.SRV1!, 'Get-ADUser inconnu').errors).toContain(
      'Impossible de trouver un objet avec l’identité « inconnu » sous « DC=lab,DC=local ».'
    )
  })

  it('Get-ADUser -Properties : propriétés demandées ajoutées à l’affichage, * pour toutes', () => {
    const { s: base, ids } = forest()
    let r = ps(base, ids.SRV1!, 'Set-ADUser -Identity Administrateur -Description "Compte intégré"')
    expect(r.errors).toBe('')
    const plain = ps(r.state, ids.SRV1!, 'Get-ADUser -Identity Administrateur').text
    expect(plain).not.toContain('Description')
    const one = ps(r.state, ids.SRV1!, 'Get-ADUser -Identity Administrateur -Properties Description').text
    expect(one).toMatch(/Description\s+: Compte intégré/)
    expect(one).toMatch(/SamAccountName\s+: Administrateur/)
    r = ps(r.state, ids.SRV1!, 'Get-ADUser -Identity Administrateur -Properties *')
    expect(r.text).toMatch(/Description\s+: Compte intégré/)
    // Propriété inconnue du simulateur : ignorée, comme un attribut non défini
    expect(ps(r.state, ids.SRV1!, 'Get-ADUser -Identity Administrateur -Properties Inexistante').errors).toBe(
      ''
    )
  })

  it('Get-ADUser -Properties MemberOf : appartenance aux groupes, insensible à la casse (non-régression #70)', () => {
    // Source : https://learn.microsoft.com/en-us/powershell/module/activedirectory/get-aduser (-Properties : ajoutées au jeu par défaut)
    const { s: base, ids } = forest()
    let r = ps(base, ids.SRV1!, 'New-ADOrganizationalUnit -Name Compta -Path "DC=lab,DC=local"')
    r = ps(
      r.state,
      ids.SRV1!,
      'New-ADUser -Name "Jean Dupont" -SamAccountName jdupont -Path "OU=Compta,DC=lab,DC=local" -AccountPassword (ConvertTo-SecureString "Azerty123!" -AsPlainText -Force) -Enabled $true'
    )
    r = ps(
      r.state,
      ids.SRV1!,
      'New-ADGroup -Name GG_Compta -GroupScope Global -Path "OU=Compta,DC=lab,DC=local"'
    )
    r = ps(r.state, ids.SRV1!, 'Add-ADGroupMember -Identity GG_Compta -Members jdupont')
    expect(r.errors).toBe('')
    for (const prop of ['MemberOf', 'memberof']) {
      const out = ps(r.state, ids.SRV1!, `Get-ADUser jdupont -Properties ${prop}`)
      expect(out.errors).toBe('')
      expect(out.text).toMatch(/SamAccountName\s+: jdupont/)
      expect(out.text).toContain('CN=GG_Compta,OU=Compta,DC=lab,DC=local')
    }
    expect(ps(r.state, ids.SRV1!, 'Get-ADUser jdupont').text).not.toContain('MemberOf')
  })

  it('mot de passe non conforme : compte créé mais désactivé', () => {
    const { s, ids } = forest()
    const r = ps(
      s,
      ids.SRV1!,
      'New-ADUser -Name toto -AccountPassword (ConvertTo-SecureString "toto" -AsPlainText -Force) -Enabled $true'
    )
    expect(r.errors).toContain(
      'ne répond pas aux spécifications de longueur, de complexité ou d’historique du domaine'
    )
    expect(r.state.domains['lab.local']?.users.find((u) => u.sam === 'toto')?.enabled).toBe(false)
  })

  it('OU protégée, chemin inexistant, imbrication interdite, doublon', () => {
    const { s: base, ids } = forest()
    let r = ps(base, ids.SRV1!, 'New-ADOrganizationalUnit Compta')
    expect(
      ps(
        r.state,
        ids.SRV1!,
        'Remove-ADOrganizationalUnit -Identity "OU=Compta,DC=lab,DC=local" -Confirm:$false'
      ).errors
    ).toContain('protégé contre les suppressions accidentelles')
    expect(ps(r.state, ids.SRV1!, 'New-ADUser -Name x -Path "OU=Nope,DC=lab,DC=local"').errors).toContain(
      'Objet de répertoire non trouvé'
    )
    r = ps(r.state, ids.SRV1!, 'New-ADGroup DL_Imprimantes DomainLocal')
    r = ps(r.state, ids.SRV1!, 'New-ADGroup GG_Users Global')
    expect(ps(r.state, ids.SRV1!, 'Add-ADGroupMember GG_Users DL_Imprimantes').errors).toContain(
      'ne peut pas être membre du groupe global'
    )
    expect(ps(r.state, ids.SRV1!, 'New-ADGroup GG_Users Global').errors).toContain(
      'Le compte spécifié existe déjà.'
    )
  })

  it('un compte non administrateur n’a pas le droit de créer des objets', () => {
    const j = joined()
    let s = ps(
      j.s,
      j.ids.SRV1!,
      'New-ADUser -Name Bob -SamAccountName bob -AccountPassword (ConvertTo-SecureString "Azerty123!" -AsPlainText -Force) -Enabled $true'
    ).state
    // Session d'un utilisateur standard sur le DC (simulée)
    const srv = s.devices[j.ids.SRV1!]
    if (srv?.kind === 'server')
      s = {
        ...s,
        devices: {
          ...s.devices,
          [srv.id]: { ...srv, host: { ...srv.host, session: { user: 'bob', domain: 'LAB' } } }
        }
      }
    expect(ps(s, j.ids.SRV1!, 'New-ADOrganizationalUnit Test').errors).toContain('Accès refusé')
  })
})

describe('AD DS : jonction et ouverture de session', () => {
  it('échoue si le DNS du poste ne pointe pas vers le DC', () => {
    const f = forest({ pcDns: '8.8.8.8' })
    const r = ps(f.s, f.ids.PC1!, 'Add-Computer -DomainName lab.local -Credential LAB\\Administrateur', [
      'P@ssw0rd'
    ])
    expect(r.errors).toContain(
      'L’ordinateur « PC1 » n’a pas pu joindre le domaine « lab.local » à partir de son groupe de travail actuel « WORKGROUP » avec l’erreur suivante : Le domaine spécifié n’existe pas ou n’a pas pu être contacté.'
    )
  })

  it('échoue avec de mauvais identifiants', () => {
    const f = forest()
    const op = joinDomain(f.s, f.ids.PC1!, { domain: 'lab.local', user: 'Administrateur', password: 'faux' })
    expect(op.ok).toBe(false)
    expect(op.message).toContain('Nom d’utilisateur ou mot de passe incorrect.')
    expect(op.trace.events.some((e) => e.protocol === 'KERBEROS')).toBe(true)
  })

  it('jonction effective au redémarrage, compte ordinateur et inscription DNS', () => {
    const f = forest()
    const r = ps(f.s, f.ids.PC1!, 'Add-Computer -DomainName lab.local -Credential LAB\\Administrateur', [
      'P@ssw0rd'
    ])
    expect(r.text).toContain('après le redémarrage')
    expect(r.traceEvents).toBeGreaterThan(0)
    const pc = r.state.devices[f.ids.PC1!]
    expect(pc?.kind === 'client' && pc.host.domain).toBeNull()
    const after = unwrap(restartComputer(r.state, f.ids.PC1!)).state
    const pc2 = after.devices[f.ids.PC1!]
    expect(pc2?.kind === 'client' && pc2.host.domain).toBe('lab.local')
    expect(pc2?.kind === 'client' && pc2.host.session).toBeNull()
    expect(after.domains['lab.local']?.computers.some((c) => c.name === 'PC1')).toBe(true)
    const srv = after.devices[f.ids.SRV1!]
    const zone =
      srv?.kind === 'server' ? dnsServerOf(srv)?.zones.find((z) => z.name === 'lab.local') : undefined
    expect(zone?.records.find((rec) => rec.name === 'pc1' && rec.type === 'A')?.data).toBe('192.168.1.10')
  })

  it('ouverture de session domaine : erreurs et changement de mot de passe imposé', () => {
    const j = joined()
    const created = ps(
      j.s,
      j.ids.SRV1!,
      'New-ADUser -Name "Jean Dupont" -SamAccountName jdupont -AccountPassword (ConvertTo-SecureString "Azerty123!" -AsPlainText -Force) -Enabled $true -ChangePasswordAtLogon $true'
    ).state
    expect(logon(created, j.ids.PC1!, { user: 'jdupont', password: 'faux', domain: 'LAB' }).message).toBe(
      'Le nom d’utilisateur ou le mot de passe est incorrect.'
    )
    const must = logon(created, j.ids.PC1!, { user: 'jdupont', password: 'Azerty123!', domain: 'LAB' })
    expect(must.mustChangePassword).toBe(true)
    expect(
      changePasswordAndLogon(created, j.ids.PC1!, {
        user: 'jdupont',
        password: 'Azerty123!',
        domain: 'LAB',
        newPassword: 'abc'
      }).ok
    ).toBe(false)
    const ok = changePasswordAndLogon(created, j.ids.PC1!, {
      user: 'jdupont',
      password: 'Azerty123!',
      domain: 'LAB',
      newPassword: 'Nouveau123!'
    })
    expect(ok.ok).toBe(true)
    const pc = ok.state.devices[j.ids.PC1!]
    expect(pc?.kind === 'client' && pc.host.session).toEqual({
      user: 'jdupont',
      domain: 'LAB',
      logonServer: 'SRV1'
    })
    expect(ps(ok.state, j.ids.PC1!, 'whoami', ['']).text).toBe('lab\\jdupont')
    // DC éteint : aucun serveur d'accès disponible
    const off = {
      ...created,
      devices: { ...created.devices, [j.ids.SRV1!]: { ...created.devices[j.ids.SRV1!]!, powered: false } }
    }
    expect(
      logon(off, j.ids.PC1!, { user: 'Administrateur', password: 'P@ssw0rd', domain: 'LAB' }).message
    ).toContain('aucun serveur d’accès disponible')
  })
})

describe('AD DS et DHCP', () => {
  it('un serveur DHCP membre du domaine doit être autorisé', () => {
    const f = forest()
    let s = unwrap(installFeatures(f.s, f.ids.SRV1!, ['DHCP'], { includeManagementTools: true })).state
    s = unwrap(
      addScope(s, f.ids.SRV1!, { name: 'LAN', start: '192.168.1.100', end: '192.168.1.200', mask: '24' })
    ).state
    s = unwrap(
      setInterfaceIpv4(s, f.ids.PC1!, s.devices[f.ids.PC1!]!.interfaces[0]!.id, {
        addressing: 'dhcp',
        dnsMode: 'dhcp'
      })
    ).state
    expect(autoConfigureDhcp(s).state.devices[f.ids.PC1!]!.interfaces[0]!.dhcpLease).toBeNull()
    const auth = ps(s, f.ids.SRV1!, 'Add-DhcpServerInDC')
    expect(auth.errors).toBe('')
    expect(autoConfigureDhcp(auth.state).state.devices[f.ids.PC1!]!.interfaces[0]!.dhcpLease?.address).toBe(
      '192.168.1.100'
    )
  })
})
