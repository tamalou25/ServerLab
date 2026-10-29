/**
 * NTDS et Netlogon (v2.8, chantier A) : un contrôleur de domaine dont l'un de ces services est
 * arrêté ne répond plus aux clients (session de domaine, gpupdate, nltest, jonction). Redémarré,
 * il répond de nouveau ; avec deux contrôleurs, le client utilise celui qui répond.
 */
import { describe, expect, it } from 'vitest'
import {
  addDevice,
  command,
  connect,
  dispatch,
  installFeatures,
  joinDomain,
  logoff,
  logon,
  replicateDirectory,
  restartComputer,
  setInterfaceIpv4,
  setSwitchport,
  unwrap,
  type LabState,
  type ServerDevice
} from '@engine/index'
import { NO_LOGON_SERVERS_MESSAGE } from '../../../src/engine/roles/adds/dcservices'
import { buildReferenceLab } from '../serialization/reference-lab'
import { build, cable, setIp } from '../helpers'
import { expectGolden } from '../golden/golden'
import { run } from '../shell/helpers'

const DSRM = ['P@ssw0rd!', 'P@ssw0rd!']
const CREDENTIALS = { user: 'Administrateur', password: 'P@ssw0rd', domain: 'LAB' }
const SERVICES = ['NTDS', 'Netlogon'] as const

/** SRV1 (contrôleur de lab.local), PC1 (membre) et PC2 (hors domaine), sessions fermées. */
function singleDc() {
  const { state, ids } = build([
    ['server', 'SRV1'],
    ['client', 'PC1'],
    ['client', 'PC2'],
    ['switch', 'SW1']
  ])
  let s = cable(state, ids.SRV1!, 0, ids.SW1!, 0)
  s = cable(s, ids.PC1!, 0, ids.SW1!, 1)
  s = cable(s, ids.PC2!, 0, ids.SW1!, 2)
  s = setIp(s, ids.SRV1!, 0, '192.168.1.1/24', undefined, ['8.8.8.8'])
  s = setIp(s, ids.PC1!, 0, '192.168.1.10/24', undefined, ['192.168.1.1'])
  s = setIp(s, ids.PC2!, 0, '192.168.1.11/24', undefined, ['192.168.1.1'])
  s = unwrap(installFeatures(s, ids.SRV1!, ['AD-Domain-Services'], { includeManagementTools: true })).state
  s = run(s, ids.SRV1!, 'Install-ADDSForest -DomainName lab.local -InstallDns', {
    answers: [...DSRM, 'O']
  }).state
  const op = joinDomain(s, ids.PC1!, {
    domain: 'lab.local',
    user: 'LAB\\Administrateur',
    password: 'P@ssw0rd'
  })
  expect(op.ok).toBe(true)
  s = unwrap(restartComputer(op.state, ids.PC1!)).state
  return { s, ids }
}

const act = (s: LabState, verb: 'stop' | 'start', id: string, service: string): LabState => {
  const r = dispatch(s, command(`service.${verb}`, id, service))
  if (!r.ok) throw new Error(r.error.message)
  return r.state
}
const host = (s: LabState, id: string) => s.devices[id] as ServerDevice
const eventIds = (s: LabState, id: string, eventId: number) =>
  host(s, id).host.eventLog.filter((e) => e.eventId === eventId)
const join2 = (s: LabState, id: string) =>
  joinDomain(s, id, { domain: 'lab.local', user: 'LAB\\Administrateur', password: 'P@ssw0rd' })

describe.each(SERVICES)('contrôleur unique : service %s arrêté', (service) => {
  it('arrêt, effet sur le lab, redémarrage, guérison', () => {
    const { s, ids } = singleDc()
    // Avant la panne : session, gpupdate, nltest et jonction fonctionnent
    const opened = logon(s, ids.PC1!, CREDENTIALS)
    expect(opened.ok).toBe(true)
    expect(run(opened.state, ids.PC1!, 'gpupdate', { shell: 'cmd' }).errors).toBe('')
    expect(run(s, ids.PC1!, 'nltest /dsgetdc:lab.local', { shell: 'cmd' }).text).toContain('DC :')

    // Arrêt du service sur le contrôleur (commande nommée, annulable)
    const down = act(opened.state, 'stop', ids.SRV1!, service)

    // 1. Session de domaine refusée, événement NETLOGON 5719 sur le poste
    const loggedOff = logoff(down, ids.PC1!)
    const refused = logon(loggedOff, ids.PC1!, CREDENTIALS)
    expect(refused.ok).toBe(false)
    expect(refused.message).toBe(NO_LOGON_SERVERS_MESSAGE)
    const e5719 = eventIds(refused.state, ids.PC1!, 5719)
    expect(e5719).toHaveLength(1)
    expect(e5719[0]).toMatchObject({ source: 'NETLOGON', level: 'error' })
    expect(e5719[0]!.message).toContain('domaine LAB')

    // 2. gpupdate en échec (événement 1129), nltest en échec, jonction impossible
    const gp = run(down, ids.PC1!, 'gpupdate', { shell: 'cmd' })
    expect(gp.errors).toContain('aucune connectivité réseau vers un contrôleur de domaine')
    expect(eventIds(gp.state, ids.PC1!, 1129).length).toBeGreaterThan(0)
    const nl = run(down, ids.PC1!, 'nltest /dsgetdc:lab.local', { shell: 'cmd' })
    expectGolden(nl.text, 'cmd/nltest-dsgetdc-echec')
    const joined = join2(down, ids.PC2!)
    expect(joined.ok).toBe(false)
    expect(joined.message).toContain('n’a pas pu être contacté')
    const cmdlet = run(down, ids.PC2!, 'Add-Computer -DomainName lab.local -Credential LAB\\Administrateur', {
      answers: ['P@ssw0rd']
    })
    expect(cmdlet.errors).toContain('n’a pas pu être contacté')
    expect(cmdlet.state.devices[ids.PC2!]).toMatchObject({ host: { domain: null } })

    // 4. Redémarrage du service : tout revient (états lus par les commandes service.*)
    const up = act(down, 'start', ids.SRV1!, service)
    expect(logon(logoff(up, ids.PC1!), ids.PC1!, CREDENTIALS).ok).toBe(true)
    expect(run(up, ids.PC1!, 'gpupdate', { shell: 'cmd' }).errors).toBe('')
    expect(run(up, ids.PC1!, 'nltest /dsgetdc:lab.local', { shell: 'cmd' }).text).toContain('DC :')
    expect(join2(up, ids.PC2!).ok).toBe(true)
  })

  it('l’état d’un service arrêté ne touche pas les comptes locaux du contrôleur', () => {
    const { s, ids } = singleDc()
    const down = act(s, 'stop', ids.SRV1!, service)
    // Le poste hors domaine garde sa session locale
    expect(logon(down, ids.PC2!, { user: 'Utilisateur', password: '', domain: 'PC2' }).ok).toBe(true)
  })
})

/** Lab de référence + SRV2 (site Lyon) promu second contrôleur, PC3 (site Lyon) membre du domaine. */
function twoDcs() {
  const D = 'lab.local'
  const id = (s: LabState, name: string) => Object.values(s.devices).find((d) => d.name === name)?.id ?? ''
  let s = buildReferenceLab()
  const sw = id(s, 'SW1')
  for (const [kind, name] of [
    ['server', 'SRV2'],
    ['client', 'PC3']
  ] as const)
    s = unwrap(addDevice(s, { kind, position: { x: 500, y: 300 }, name })).state
  const port = (i: number) => s.devices[sw]!.interfaces[i]!.id
  s = unwrap(setSwitchport(s, sw, port(6), { mode: 'access', accessVlan: 20 })).state
  for (const [name, p] of [
    ['SRV2', 4],
    ['PC3', 6]
  ] as const)
    s = unwrap(
      connect(
        s,
        { deviceId: id(s, name), ifaceId: s.devices[id(s, name)]!.interfaces[0]!.id },
        { deviceId: sw, ifaceId: port(p) }
      )
    ).state
  for (const [name, address] of [
    ['SRV2', '192.168.20.1'],
    ['PC3', '192.168.20.10']
  ] as const)
    s = unwrap(
      setInterfaceIpv4(s, id(s, name), s.devices[id(s, name)]!.interfaces[0]!.id, {
        addressing: 'static',
        address,
        mask: '24',
        gateway: '192.168.20.254',
        dnsServers: ['192.168.10.1']
      })
    ).state
  for (const cmd of [
    command('adds.renameSite', D, 'Default-First-Site-Name', 'Paris'),
    command('adds.newSite', D, { name: 'Lyon' }),
    command('adds.newSubnet', D, { prefix: '192.168.10.0/24', site: 'Paris' }),
    command('adds.newSubnet', D, { prefix: '192.168.20.0/24', site: 'Lyon' }),
    command('adds.newSiteLink', D, { name: 'Paris-Lyon', sites: ['Paris', 'Lyon'], cost: 100, interval: 15 })
  ])
    s = unwrap(dispatch(s, cmd)).state
  s = unwrap(
    installFeatures(s, id(s, 'SRV2'), ['AD-Domain-Services'], { includeManagementTools: true })
  ).state
  const password = (s.devices[id(s, 'SRV1')] as ServerDevice).host.localAdminPassword
  const promo = dispatch(
    s,
    command('adds.installDomainController', id(s, 'SRV2'), {
      domainName: D,
      user: 'LAB\\Administrateur',
      password,
      safeModePassword: 'P@ssw0rd!'
    })
  )
  if (!promo.ok || !promo.value.success) throw new Error('promotion de SRV2 impossible')
  s = replicateDirectory(promo.state).state
  const pc3 = id(s, 'PC3')
  const joined = joinDomain(s, pc3, { domain: D, user: 'LAB\\Administrateur', password })
  if (!joined.ok) throw new Error(joined.message)
  s = unwrap(restartComputer(joined.state, pc3)).state
  return { s, srv1: id(s, 'SRV1'), srv2: id(s, 'SRV2'), pc3, password }
}

describe.each(SERVICES)('deux contrôleurs : service %s arrêté', (service) => {
  it('la session réussit tant qu’un contrôleur répond, échoue quand aucun ne répond, guérit au redémarrage', () => {
    const { s, srv1, srv2, pc3, password } = twoDcs()
    const creds = { user: 'Administrateur', password, domain: 'LAB' }
    // Le DC de son site (SRV2) est en panne : SRV1 répond
    const oneDown = act(s, 'stop', srv2, service)
    const viaSrv1 = logon(oneDown, pc3, creds)
    expect(viaSrv1.ok).toBe(true)
    expect(host(viaSrv1.state, pc3).host.session?.logonServer).toBe('SRV1')
    expect(run(oneDown, pc3, 'nltest /dsgetdc:lab.local', { shell: 'cmd' }).text).toContain('SRV1.lab.local')
    // L’autre contrôleur en panne : SRV2 répond
    const otherDown = act(s, 'stop', srv1, service)
    const viaSrv2 = logon(otherDown, pc3, creds)
    expect(viaSrv2.ok).toBe(true)
    expect(host(viaSrv2.state, pc3).host.session?.logonServer).toBe('SRV2')
    // Les deux en panne : plus aucun serveur d'ouverture de session
    const bothDown = act(oneDown, 'stop', srv1, service)
    const refused = logon(bothDown, pc3, creds)
    expect(refused.ok).toBe(false)
    expect(refused.message).toBe(NO_LOGON_SERVERS_MESSAGE)
    expect(eventIds(refused.state, pc3, 5719)).toHaveLength(1)
    expect(run(bothDown, pc3, 'gpupdate', { shell: 'cmd' }).errors).toContain('aucune connectivité')
    // Un seul redémarré : la session redevient possible, sur ce contrôleur
    const healed = logon(act(bothDown, 'start', srv2, service), pc3, creds)
    expect(healed.ok).toBe(true)
    expect(host(healed.state, pc3).host.session?.logonServer).toBe('SRV2')
  })
})
