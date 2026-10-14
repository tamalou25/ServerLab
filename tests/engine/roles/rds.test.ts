/**
 * Bureau à distance et rôle RDS : connexion tracée (TCP 3389), authentification, autorisation
 * (administrateurs, groupe Utilisateurs du Bureau à distance, groupes de la collection),
 * RemoteApp et évènements 4624 / 4625 de type 10.
 */
import { describe, expect, it } from 'vitest'
import {
  command,
  dispatch,
  evaluateCheck,
  installFeatures,
  rdpConnect,
  rdsServerOf,
  unwrap,
  type AnyCommand,
  type HostDevice,
  type LabState
} from '@engine/index'
import { buildReferenceLab } from '../serialization/reference-lab'
import { run } from '../shell/helpers'

const D = 'lab.local'
const id = (s: LabState, name: string) => Object.values(s.devices).find((d) => d.name === name)?.id ?? ''
const host = (s: LabState, name: string) => s.devices[id(s, name)] as HostDevice

function exec(state: LabState, ...cmds: AnyCommand[]): LabState {
  let s = state
  for (const cmd of cmds) {
    const r = dispatch(s, cmd)
    if (!r.ok) throw new Error(`${cmd.type} : ${r.error.message}`)
    s = r.state
  }
  return s
}

/** Lab de référence + pdurand (hors GG_Compta). */
function lab(): LabState {
  return exec(
    buildReferenceLab(),
    command('adds.addUser', D, {
      name: 'Paul Durand',
      sam: 'pdurand',
      upn: 'pdurand@lab.local',
      path: 'OU=Compta,DC=lab,DC=local',
      password: 'Azerty123!',
      enabled: true
    })
  )
}

const connect = (s: LabState, user: string, password = 'Azerty123!', app?: string) =>
  rdpConnect(s, id(s, 'PC1'), { computer: 'srv1.lab.local', user, password, ...(app ? { app } : {}) })

describe('Bureau à distance', () => {
  it('connexions à distance désactivées : ordinateur distant injoignable', () => {
    const s = lab()
    const r = connect(s, 'LAB\\Administrateur', 'P@ssw0rd')
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/L’accès à distance au serveur n’est pas activé/)
    expect(r.trace.events.some((e) => e.protocol === 'RDP')).toBe(true)
  })

  it('autorisation : administrateurs, puis membres du groupe Utilisateurs du Bureau à distance', () => {
    let s = exec(lab(), command('rds.setRemoteDesktop', id(lab(), 'SRV1'), { enabled: true }))
    const admin = connect(s, 'LAB\\Administrateur', 'P@ssw0rd')
    expect(admin.ok).toBe(true)
    const bad = connect(s, 'LAB\\jdupont', 'faux')
    expect(bad.message).toBe('Vos informations d’identification n’ont pas fonctionné.')
    const denied = connect(s, 'LAB\\jdupont')
    expect(denied.ok).toBe(false)
    expect(denied.message).toMatch(/n’est pas autorisé pour l’ouverture de session à distance/)
    const log = host(denied.state, 'SRV1').host.eventLog
    expect(log.at(-1)).toMatchObject({ eventId: 4625, log: 'Sécurité' })
    expect(log.at(-1)?.message).toContain('Type d’ouverture de session : 10')
    s = exec(denied.state, command('rds.setRemoteDesktop', id(s, 'SRV1'), { users: ['GG_Compta'] }))
    expect(host(s, 'SRV1').host.remoteDesktop.users).toEqual(['LAB\\GG_Compta'])
    const ok = connect(s, 'jdupont@lab.local')
    expect(ok.ok).toBe(true)
    const srv = host(ok.state, 'SRV1')
    expect(srv.host.remoteSessions.map((x) => [x.account, x.from])).toEqual([['LAB\\jdupont', 'PC1']])
    expect(srv.host.eventLog.at(-1)).toMatchObject({ eventId: 4624 })
    expect(srv.host.eventLog.at(-1)?.message).toContain(
      'Type d’ouverture de session : 10 (RemoteInteractive)'
    )
    expect(
      evaluateCheck(ok.state, { type: 'rdpSession', server: 'SRV1', account: 'LAB\\jdupont', opened: true })
    ).toBe(true)
    const unknown = dispatch(s, command('rds.setRemoteDesktop', id(s, 'SRV1'), { users: ['Inconnu'] }))
    expect(!unknown.ok && unknown.error.code).toBe('UnknownAccount')
  })

  it('acceptation (RDS) : seuls les membres des groupes de la collection ouvrent une session', () => {
    let s = lab()
    const srv = id(s, 'SRV1')
    s = unwrap(installFeatures(s, srv, ['RDS-RD-Server'], { includeManagementTools: true })).state
    expect(host(s, 'SRV1').host.remoteDesktop.enabled).toBe(true)
    // pdurand est dans le groupe local, mais la collection décide sur un hôte de session
    s = exec(
      s,
      command('rds.setRemoteDesktop', srv, { users: ['pdurand'] }),
      command('rds.addCollection', srv, { name: 'Bureautique', userGroups: ['LAB\\GG_Compta'] })
    )
    expect(connect(s, 'LAB\\jdupont').ok).toBe(true)
    const refused = connect(s, 'LAB\\pdurand')
    expect(refused.ok).toBe(false)
    expect(
      evaluateCheck(refused.state, {
        type: 'rdpSession',
        server: 'SRV1',
        account: 'LAB\\pdurand',
        opened: false
      })
    ).toBe(true)
    // Collection créée sans groupe : Utilisateurs du domaine, comme l'assistant
    s = exec(s, command('rds.addCollection', srv, { name: 'Tous', userGroups: [] }))
    expect(rdsServerOf(s.devices[srv])!.collections[1]!.userGroups).toEqual(['LAB\\Utilisateurs du domaine'])
    expect(connect(s, 'LAB\\pdurand').ok).toBe(true)
  })

  it('RemoteApp : programme publié accessible aux seuls utilisateurs de la collection', () => {
    let s = lab()
    const srv = id(s, 'SRV1')
    s = unwrap(installFeatures(s, srv, ['RDS-RD-Server'])).state
    s = exec(
      s,
      command('rds.addCollection', srv, { name: 'Applis', userGroups: ['GG_Compta'] }),
      command('rds.addRemoteApp', srv, 'Applis', {
        displayName: 'Calculatrice',
        filePath: 'C:\\Windows\\System32\\calc.exe'
      })
    )
    expect(rdsServerOf(s.devices[srv])!.collections[0]!.remoteApps[0]!.alias).toBe('calc')
    const ok = connect(s, 'LAB\\jdupont', 'Azerty123!', 'calc')
    expect(ok.ok).toBe(true)
    expect(host(ok.state, 'SRV1').host.remoteSessions[0]!.app).toBe('calc')
    expect(connect(s, 'LAB\\jdupont', 'Azerty123!', 'paint').message).toMatch(/n’est pas publié/)
    const badPath = dispatch(
      s,
      command('rds.addRemoteApp', srv, 'Applis', { displayName: 'X', filePath: 'calc' })
    )
    expect(!badPath.ok && badPath.error.code).toBe('InvalidPath')
    expect(
      evaluateCheck(s, {
        type: 'rdsCollection',
        server: 'SRV1',
        name: 'applis',
        group: 'GG_Compta',
        app: 'Calculatrice'
      })
    ).toBe(true)
  })

  it('commandes de l’interface : connexion (échec journalisé sans erreur) et déconnexion', () => {
    let s = exec(lab(), command('rds.setRemoteDesktop', id(lab(), 'SRV1'), { enabled: true }))
    const r = dispatch(
      s,
      command('rds.connect', id(s, 'PC1'), {
        computer: 'SRV1',
        user: 'LAB\\Administrateur',
        password: 'P@ssw0rd'
      })
    )
    expect(r.ok && r.value.ok).toBe(true)
    s = r.ok ? r.state : s
    const sessionId = r.ok ? r.value.sessionId! : 0
    s = exec(s, command('rds.disconnect', id(s, 'SRV1'), sessionId))
    expect(host(s, 'SRV1').host.remoteSessions).toEqual([])
  })

  it('cmdlets : collections, RemoteApp, sessions et groupe local', () => {
    let s = lab()
    const srv = id(s, 'SRV1')
    s = unwrap(installFeatures(s, srv, ['RDS-RD-Server'], { includeManagementTools: true })).state
    s = run(
      s,
      srv,
      'New-RDSessionCollection -CollectionName Bureautique -SessionHost srv1.lab.local -ConnectionBroker srv1.lab.local'
    ).state
    s = run(
      s,
      srv,
      "Set-RDSessionCollectionConfiguration -CollectionName Bureautique -UserGroup 'LAB\\GG_Compta'"
    ).state
    s = run(
      s,
      srv,
      "New-RDRemoteApp -CollectionName Bureautique -DisplayName 'Bloc-notes' -FilePath 'C:\\Windows\\System32\\notepad.exe'"
    ).state
    expect(rdsServerOf(s.devices[srv])!.collections).toEqual([
      {
        name: 'Bureautique',
        description: '',
        userGroups: ['LAB\\GG_Compta'],
        remoteApps: [
          { alias: 'notepad', displayName: 'Bloc-notes', filePath: 'C:\\Windows\\System32\\notepad.exe' }
        ]
      }
    ])
    expect(run(s, srv, 'Get-RDSessionCollection').text).toMatch(/Bureautique\s+1\s+Programmes RemoteApp/)
    expect(run(s, srv, 'Get-RDRemoteApp').text).toContain('notepad')
    s = connect(s, 'LAB\\jdupont').state
    expect(run(s, srv, 'Get-RDUserSession').text).toMatch(/jdupont\s+LAB/)
    s = run(
      s,
      srv,
      "Add-LocalGroupMember -Group 'Utilisateurs du Bureau à distance' -Member 'LAB\\jdupont'"
    ).state
    expect(host(s, 'SRV1').host.remoteDesktop.users).toEqual(['LAB\\jdupont'])
    expect(run(s, srv, "Get-LocalGroupMember 'Utilisateurs du Bureau à distance'").text).toMatch(
      /Utilisateur\s+LAB\\jdupont/
    )
    s = run(
      s,
      srv,
      "Remove-LocalGroupMember -Group 'Utilisateurs du Bureau à distance' -Member jdupont"
    ).state
    expect(host(s, 'SRV1').host.remoteDesktop.users).toEqual([])
    // Contrôleur de domaine : pas de base de comptes locale (Lot 2b)
    expect(run(s, srv, 'Add-LocalGroupMember -Group Administrateurs -Member x').errors).toMatch(
      /n’a pas de base de comptes locale/
    )
    s = run(s, srv, 'Remove-RDRemoteApp -CollectionName Bureautique -Alias notepad').state
    s = run(s, srv, 'Remove-RDSessionCollection -CollectionName Bureautique -Force').state
    expect(rdsServerOf(s.devices[srv])!.collections).toEqual([])
  })
})
