/**
 * Catalogue des commandes : chaque commande nommée (système de base et modules de rôles) est
 * exécutée par `dispatch` avec les arguments que lui passe l'interface, sur le lab de référence.
 * Pour chacune : succès, libellé français lisible (évalué sur l'état d'avant), entrée de journal
 * dont les patches inverses ramènent exactement à l'état d'avant, .slab rouvert identique. Un dernier test exige que toute
 * commande du catalogue soit couverte ici : une commande ajoutée sans test le fait échouer.
 */
import { describe, expect, it } from 'vitest'
import {
  adcsOf,
  applyStatePatches,
  batch,
  command,
  commandDefinitions,
  createShellSession,
  dhcpServerOf,
  dispatch,
  domainToken,
  localToken,
  parseSlab,
  serializeSlab,
  sessionToken,
  type AnyCommand,
  type AccessToken,
  type LabState
} from '@engine/index'
import { buildReferenceLab } from '../serialization/reference-lab'

const DOMAIN = 'lab.local'
const COMPTA = 'OU=Compta,DC=lab,DC=local'

/** Exécute les commandes une à une en vérifiant libellé, journal et inverse. */
class Runner {
  readonly covered = new Set<string>()
  constructor(public state: LabState) {}

  id(name: string): string {
    const found = Object.values(this.state.devices).find((d) => d.name === name)
    if (!found) throw new Error(`équipement ${name} absent`)
    return found.id
  }

  iface(name: string, index = 0): string {
    return this.state.devices[this.id(name)]?.interfaces[index]?.id ?? ''
  }

  /** Jeton de l'Administrateur du domaine (consoles du DC). */
  admin(): AccessToken {
    const domain = this.state.domains[DOMAIN]
    const token = domain ? domainToken(domain, 'Administrateur') : null
    if (!token) throw new Error('jeton administrateur absent')
    return token
  }

  run<T = unknown>(cmd: AnyCommand, expectChange = true): T {
    const before = this.state
    const r = dispatch(before, cmd)
    if (!r.ok) throw new Error(`${cmd.type} : ${r.error.message}`)
    this.covered.add(cmd.type)
    if (cmd.type === 'batch') for (const sub of cmd.args[0] as AnyCommand[]) this.covered.add(sub.type)
    if (expectChange) {
      expect(r.entry, `${cmd.type} : entrée de journal`).not.toBeNull()
      const entry = r.entry!
      expect(entry.label, `${cmd.type} : libellé`).toMatch(/^\S/)
      expect(entry.label, `${cmd.type} : libellé complet`).not.toMatch(/undefined|null|NaN|\[object/)
      expect(entry.label, `${cmd.type} : libellé lisible`).not.toBe(cmd.type)
      // Inverse calculé par immer : retour exact à l'état d'avant, puis à l'état d'après
      const undone = applyStatePatches(r.state, entry.inversePatches)
      expect(undone, `${cmd.type} : annuler`).toEqual(before)
      expect(applyStatePatches(undone, entry.patches), `${cmd.type} : rétablir`).toEqual(r.state)
      // Enregistrer puis rouvrir le .slab redonne exactement le même lab
      const reopened = parseSlab(
        serializeSlab(r.state, { savedAt: '2026-10-06T12:00:00.000Z', appVersion: '2.0.0' })
      )
      if (!reopened.ok) throw new Error(`${cmd.type} : réouverture impossible (${reopened.message})`)
      expect(reopened.doc.lab, `${cmd.type} : réouverture`).toEqual(r.state)
    }
    this.state = r.state
    return r.value as T
  }
}

function runner(): Runner {
  return new Runner(buildReferenceLab())
}

describe('catalogue des commandes', () => {
  const covered = new Set<string>()
  const done = (r: Runner) => r.covered.forEach((t) => covered.add(t))

  it('topologie : ajout, renommage, déplacements, alimentation, câbles, copie, suppression', () => {
    const r = runner()
    r.run(command('topology.addDevice', { kind: 'client', position: { x: 600, y: 0 } }))
    r.run(command('topology.renameDevice', r.id('PC3'), 'PC9'))
    r.run(command('topology.moveDevice', r.id('PC9'), { x: 650, y: 20 }))
    r.run(command('topology.moveDevices', [{ id: r.id('PC9'), position: { x: 700, y: 40 } }]))
    r.run(command('topology.setPower', r.id('PC9'), false))
    r.run(command('topology.setPower', r.id('PC9'), true))
    const linkId = r.run<string>(
      command(
        'topology.connect',
        { deviceId: r.id('PC9'), ifaceId: r.iface('PC9') },
        { deviceId: r.id('SW1'), ifaceId: r.iface('SW1', 6) }
      )
    )
    expect(r.state.links[linkId]).toBeDefined()
    r.run(command('topology.disconnect', linkId))
    r.run(command('topology.addServerInterface', r.id('SRV1')))
    const pc9 = r.state.devices[r.id('PC9')]!
    const copies = r.run<string[]>(
      command('topology.duplicateDevices', { devices: [pc9], links: [] }, { x: 40, y: 40 })
    )
    expect(copies).toHaveLength(1)
    r.run(command('topology.removeDevices', [...copies, r.id('PC9')]))
    expect(Object.values(r.state.devices).map((d) => d.name)).not.toContain('PC9')
    done(r)
  })

  it('réseau et système : carte, IPv4, routes, redémarrage, renommage, journal, fonctionnalités', () => {
    const r = runner()
    r.run(command('net.setInterfaceEnabled', r.id('PC2'), r.iface('PC2'), false))
    r.run(command('net.setInterfaceEnabled', r.id('PC2'), r.iface('PC2'), true))
    r.run(
      command('net.setInterfaceIpv4', r.id('PC2'), r.iface('PC2'), {
        addressing: 'static',
        address: '192.168.10.30',
        mask: '24',
        gateway: '192.168.10.254',
        dnsServers: ['192.168.10.1']
      })
    )
    r.run(
      command('net.addStaticRoute', r.id('R1'), { network: '10.0.0.0', mask: '8', nextHop: '192.168.10.1' })
    )
    r.run(command('net.removeStaticRoute', r.id('R1'), 0))
    // Le nouveau nom s'applique au redémarrage
    const pc2 = r.id('PC2')
    r.run(command('system.renameComputer', pc2, 'POSTE2'))
    r.run(command('system.restartComputer', pc2))
    expect(r.state.devices[pc2]?.name).toBe('POSTE2')
    r.run(command('system.clearEventLog', r.id('SRV1'), 'Système'))
    // Services (v2.7, Lot 2a)
    r.run(command('service.stop', r.id('SRV1'), 'DNS'))
    r.run(command('service.start', r.id('SRV1'), 'DNS'))
    r.run(command('service.setStartType', r.id('SRV1'), 'Kdc', 'Manual'))
    r.run(command('service.restart', r.id('SRV1'), 'Kdc'))
    r.run(command('service.setFailure', r.id('SRV1'), 'DNS', 'invalidConfig'))
    r.run(command('service.clearFailure', r.id('SRV1'), 'DNS'))
    r.run(
      command('service.setRecovery', r.id('SRV1'), 'DNS', {
        resetSeconds: 86400,
        actions: [{ type: 'restart', delayMs: 60000 }]
      })
    )
    // Mode panne (v2.8) : indice d'un dépannage en cours (champ facultatif posé pour le test)
    r.state = {
      ...r.state,
      troubleshooting: { seed: 1, faults: [{ id: 'net.wrong-mask', params: {}, hintsUsed: 0 }] }
    }
    r.run(command('troubleshoot.useHint', 'net.wrong-mask'))
    // Horloge par ordinateur (v2.8) : le service Temps Windows de PC2 est démarré par défaut
    r.run(command('host.setClock', r.id('POSTE2'), 600))
    r.run(command('host.resyncClock', r.id('POSTE2')))
    // Base de comptes locale de PC2 (Lot 2b)
    r.run(command('local.newUser', r.id('POSTE2'), { name: 'u1', password: 'x' }))
    r.run(command('local.setUser', r.id('POSTE2'), 'u1', { description: 'd' }))
    r.run(command('local.newGroup', r.id('POSTE2'), { name: 'G1' }))
    r.run(command('local.addGroupMembers', r.id('POSTE2'), 'G1', ['u1']))
    r.run(command('local.removeGroupMembers', r.id('POSTE2'), 'G1', ['u1']))
    r.run(command('local.removeUser', r.id('POSTE2'), 'u1'))
    r.run(command('system.installFeatures', r.id('SRV1'), ['FS-FileServer']))
    r.run(command('system.uninstallFeatures', r.id('SRV1'), ['FS-FileServer']))
    done(r)
  })

  it('VLAN : base du switch, ports d’accès et trunk, sous-interfaces', () => {
    const r = runner()
    const sw = r.id('SW1')
    r.run(command('net.addVlan', sw, 30, 'RH'))
    r.run(command('net.renameVlan', sw, 30, 'Ressources'))
    r.run(command('net.setSwitchport', sw, r.iface('SW1', 5), { mode: 'access', accessVlan: 30 }))
    r.run(command('net.setSwitchport', sw, r.iface('SW1', 3), { mode: 'trunk', allowedVlans: [1, 20, 30] }))
    r.run(command('net.removeVlan', sw, 30))
    const sub = r.run<string>(command('net.addSubinterface', r.id('R1'), r.iface('R1'), 30))
    r.run(command('net.setHelperAddresses', r.id('R1'), sub, ['192.168.10.1']))
    r.run(command('net.removeSubinterface', r.id('R1'), sub))
    done(r)
  })

  it('pare-feu : profils, catégorie du réseau, règles', () => {
    const r = runner()
    const srv = r.id('SRV1')
    r.run(command('firewall.setProfile', srv, ['Domain', 'Public'], { enabled: false }))
    r.run(command('firewall.setNetworkCategory', r.id('PC2'), 'Private'))
    r.run(
      command('firewall.newRule', srv, {
        displayName: 'Web 8080',
        direction: 'Inbound',
        action: 'Allow',
        protocol: 'TCP',
        localPorts: [8080]
      })
    )
    r.run(command('firewall.setRuleEnabled', srv, { group: 'Partage de fichiers et d’imprimantes' }, false))
    r.run(command('firewall.removeRule', srv, { displayName: 'Web 8080' }))
    done(r)
  })

  it('pare-feu pfSense : règles, ordre, alias, blocages automatiques, journal, états', () => {
    const r = runner()
    const fw = r.id('FW1')
    const first = r.run<string>(
      command('pf.addRule', fw, { iface: 'lan', action: 'block', protocol: 'icmp', descr: 'Pas de ping' })
    )
    const second = r.run<string>(
      command('pf.addRule', fw, { iface: 'lan', action: 'pass', log: true }, first)
    )
    r.run(command('pf.updateRule', fw, first, { action: 'reject', protocol: 'tcp' }))
    r.run(command('pf.moveRule', fw, second, null))
    r.run(command('pf.setAlias', fw, { name: 'Web', type: 'host', values: ['172.16.0.10'], descr: '' }))
    r.run(command('pf.removeAlias', fw, 'Web'))
    r.run(command('pf.setBlockNetworks', fw, 'wan', { blockPrivate: false, blockBogons: false }))
    r.run(command('pf.removeRule', fw, first))
    // Services (#245)
    r.run(
      command('pf.setDhcp', fw, 'lan', {
        enabled: true,
        rangeFrom: '192.168.1.100',
        rangeTo: '192.168.1.110'
      })
    )
    r.run(
      command('pf.setGateway', fw, {
        name: 'GW_DMZ',
        iface: 'lan',
        address: '192.168.1.254',
        isDefault: false
      })
    )
    r.run(command('pf.setDefaultGateway', fw, 'GW_DMZ'))
    r.run(command('pf.addStaticRoute', fw, { network: '10.9.0.0', prefixLength: 24, gateway: 'GW_DMZ' }))
    r.run(command('pf.removeStaticRoute', fw, '10.9.0.0', 24))
    r.run(command('pf.removeGateway', fw, 'GW_DMZ'))
    r.run(command('pf.setDnsResolver', fw, { forwarding: true }))
    r.run(command('pf.setDnsServers', fw, ['8.8.8.8']))
    r.run(command('pf.setHostOverride', fw, { host: 'nas', domain: 'lab.local', address: '192.168.1.50' }))
    r.run(command('pf.removeHostOverride', fw, 'nas', 'lab.local'))
    r.run(command('pf.clearLog', fw), false)
    r.run(command('pf.resetStates', fw), false)
    done(r)
  })

  it('accès à distance : NAT, VPN, connexion d’un client', () => {
    const r = runner()
    const srv = r.id('SRV1')
    r.run(command('system.installFeatures', srv, ['RemoteAccess', 'DirectAccess-VPN', 'Routing'], {}))
    r.run(command('topology.addServerInterface', srv))
    r.run(
      command('net.setInterfaceIpv4', srv, r.iface('SRV1', 1), {
        addressing: 'static',
        address: '203.0.113.2',
        mask: '24',
        gateway: null,
        dnsServers: []
      })
    )
    r.run(command('rras.configure', srv, { mode: 'nat', publicIfaceId: r.iface('SRV1', 1) }))
    r.run(command('rras.disable', srv))
    r.run(
      command('rras.configure', srv, {
        mode: 'vpn-nat',
        publicIfaceId: r.iface('SRV1', 1),
        pool: { start: '192.168.10.200', end: '192.168.10.210' }
      })
    )
    r.run(command('rras.setPool', srv, { start: '192.168.10.220', end: '192.168.10.230' }))
    r.run(command('vpn.addConnection', r.id('PC2'), { name: 'Bureau', server: '192.168.10.1' }))
    r.run(command('vpn.connect', r.id('PC2'), 'Bureau', { user: 'LAB\\jdupont', password: 'Azerty123!' }))
    r.run(command('vpn.disconnect', r.id('PC2'), 'Bureau'))
    r.run(command('vpn.removeConnection', r.id('PC2'), 'Bureau'))
    done(r)
  })

  it('sites, contrôleur supplémentaire, FSMO, réplication', () => {
    const r = runner()
    const srv = r.id('SRV1')
    r.run(command('adds.renameSite', DOMAIN, 'Default-First-Site-Name', 'Paris'))
    r.run(command('adds.newSite', DOMAIN, { name: 'Lyon' }))
    r.run(command('adds.newSubnet', DOMAIN, { prefix: '192.168.20.0/24', site: 'Lyon' }))
    r.run(command('adds.newSiteLink', DOMAIN, { name: 'PL', sites: ['Paris', 'Lyon'] }))
    r.run(command('adds.setSiteLink', DOMAIN, 'PL', { cost: 50, interval: 15 }))
    r.run(command('adds.moveDcToSite', DOMAIN, srv, 'Lyon'))
    r.run(command('adds.moveDcToSite', DOMAIN, srv, 'Paris'))
    r.run(command('adds.removeSiteLink', DOMAIN, 'PL'))
    r.run(command('adds.removeSubnet', DOMAIN, '192.168.20.0/24'))
    r.run(command('adds.removeSite', DOMAIN, 'Lyon'))
    r.run(command('adds.moveFsmoRoles', DOMAIN, srv, ['PDCEmulator']), false)
    // Un seul contrôleur : refus métier (la réplication à deux DC est testée dans ad-sites.test.ts)
    const sync = dispatch(r.state, command('adds.syncReplication', DOMAIN))
    expect(!sync.ok && sync.error.code).toBe('SingleController')
    r.covered.add('adds.syncReplication')
    r.run(
      command('adds.installDomainController', r.id('SRV1'), {
        domainName: DOMAIN,
        user: 'LAB\\Administrateur',
        password: 'x',
        safeModePassword: 'P@ssw0rd!'
      }),
      false
    )
    done(r)
  })

  it('NPS : clients RADIUS, stratégies réseau, serveur RADIUS du VPN', () => {
    const r = runner()
    const srv = r.id('SRV1')
    r.run(command('system.installFeatures', srv, ['NPAS', 'RemoteAccess', 'DirectAccess-VPN'], {}))
    r.run(command('nps.addClient', srv, { name: 'VPN', address: '192.168.10.2', sharedSecret: 'S3cret!' }))
    r.run(command('nps.removeClient', srv, 'VPN'))
    r.run(command('nps.addPolicy', srv, { name: 'Compta', groups: ['LAB\\GG_Compta'], access: 'Grant' }))
    r.run(command('nps.movePolicy', srv, 'Compta', 1))
    r.run(command('nps.setPolicyEnabled', srv, 'Compta', false))
    r.run(command('nps.removePolicy', srv, 'Compta'))
    r.run(command('rras.addRadius', srv, { server: '192.168.10.1', sharedSecret: 'S3cret!' }))
    r.run(command('rras.removeRadius', srv, '192.168.10.1'))
    done(r)
  })

  it('consoles, tâches de fond et lots', () => {
    const r = runner()
    const session = createShellSession(r.state, r.id('SRV1'), 'powershell')
    r.run(command('shell.exec', session, 'New-ADGroup -Name GG_Test -GroupScope Global', []))
    expect(r.state.domains[DOMAIN]?.groups.map((g) => g.name)).toContain('GG_Test')
    // Lab déjà stabilisé : un passage des tâches de fond ne change rien
    r.run(command('background.tick'), false)
    r.run(
      batch('Créer l’unité RH et son groupe', [
        command('adds.addOrganizationalUnit', DOMAIN, { name: 'RH' }),
        command('adds.addGroup', DOMAIN, { name: 'GG_RH', scope: 'Global', path: 'OU=RH,DC=lab,DC=local' })
      ])
    )
    done(r)
  })

  it('DHCP : client, post-installation, autorisation, étendues, exclusions, réservations, options', () => {
    const r = runner()
    const srv = r.id('SRV1')
    r.run(command('net.dhcpRelease', r.id('PC1'), r.iface('PC1')))
    r.run(command('net.dhcpRenew', r.id('PC1'), r.iface('PC1')))
    r.run(command('dhcp.completePostInstall', srv, { authorize: true }), false)
    r.run(command('dhcp.authorize', srv, false))
    r.run(command('dhcp.authorize', srv, true))
    const scope = dhcpServerOf(r.state.devices[srv]!)!.scopes[0]!.scopeId
    r.run(command('dhcp.setScopeState', srv, scope, false))
    r.run(command('dhcp.setScopeState', srv, scope, true))
    r.run(command('dhcp.addExclusion', srv, scope, '192.168.10.150', '192.168.10.160'))
    r.run(command('dhcp.removeExclusion', srv, scope, 0))
    r.run(
      command('dhcp.addReservation', srv, scope, {
        name: 'IMP1',
        ip: '192.168.10.180',
        mac: '00-15-5D-01-02-03'
      })
    )
    r.run(command('dhcp.removeReservation', srv, scope, '192.168.10.180'))
    r.run(command('dhcp.setOptions', srv, null, { dnsServers: ['192.168.10.1'] }))
    const other = r.run<string>(
      command('dhcp.addScope', srv, {
        name: 'Wifi',
        start: '172.16.0.10',
        end: '172.16.0.50',
        mask: '255.255.255.0'
      })
    )
    r.run(command('dhcp.removeScope', srv, other))
    r.run(
      command(
        'dhcp.createScope',
        srv,
        { name: 'Invités', start: '172.17.0.10', end: '172.17.0.50', mask: '255.255.255.0' },
        { router: ['172.17.0.1'] }
      )
    )
    done(r)
  })

  it('DNS : zones directe et inverse, enregistrements, redirecteurs', () => {
    const r = runner()
    const srv = r.id('SRV1')
    r.run(command('dns.addPrimaryZone', srv, { name: 'test.local', dynamicUpdate: 'None' }))
    r.run(command('dns.addPrimaryZone', srv, { networkId: '192.168.10.0/24' }))
    r.run(command('dns.addRecord', srv, 'test.local', { name: 'www', type: 'A', data: '192.168.10.50' }))
    r.run(command('dns.removeRecord', srv, 'test.local', 'www', 'A', '192.168.10.50'))
    r.run(command('dns.removeZone', srv, 'test.local'))
    r.run(command('dns.setForwarders', srv, ['8.8.8.8']))
    done(r)
  })

  it('AD DS : objets, comptes, jonction, sessions, nouvelle forêt', () => {
    const r = runner()
    r.run(command('adds.addOrganizationalUnit', DOMAIN, { name: 'Direction' }))
    r.run(
      command('adds.addUser', DOMAIN, {
        name: 'Paul Durand',
        sam: 'pdurand',
        path: COMPTA,
        password: 'Azerty123!',
        enabled: true
      })
    )
    r.run(command('adds.addGroup', DOMAIN, { name: 'GG_Direction', scope: 'Global' }))
    // Lot 2b : groupe modifié, compte d'ordinateur pré-créé
    r.run(command('adds.setGroupProperties', DOMAIN, 'GG_Direction', { description: 'Direction' }))
    r.run(command('adds.addComputer', DOMAIN, { name: 'POSTE42' }))
    // Canal sécurisé déjà valide : aucune modification
    r.run(command('adds.repairSecureChannel', r.id('PC1')), false)
    r.run(command('adds.addGroupMembers', DOMAIN, 'GG_Direction', ['pdurand']))
    r.run(command('adds.removeGroupMembers', DOMAIN, 'GG_Direction', ['pdurand']))
    const user = r.state.domains[DOMAIN]!.users.find((u) => u.sam === 'pdurand')!
    r.run(command('adds.moveObject', DOMAIN, user.id, 'OU=Direction,DC=lab,DC=local'))
    r.run(command('adds.setAccountEnabled', DOMAIN, 'pdurand', false))
    r.run(command('adds.setAccountEnabled', DOMAIN, 'pdurand', true))
    // Mot de passe à changer : la session aboutit après le changement imposé
    r.run(command('adds.resetPassword', DOMAIN, 'pdurand', 'Bienvenue123!', true))
    r.run(command('adds.setUserProperties', DOMAIN, 'pdurand', { passwordNeverExpires: true }))
    // Cybersécurité : compte de service, ancienneté du mot de passe, accès administrateur, paramètres du lab
    r.run(command('adds.setServicePrincipalNames', DOMAIN, 'pdurand', ['MSSQLSvc/srv1.lab.local:1433']))
    r.run(command('adds.setAccountActivity', DOMAIN, 'pdurand', { passwordAgeDays: 400 }))
    r.run(command('cyber.setAdminAccess', r.id('PC1'), [r.id('SRV1')]))
    r.run(command('cyber.configure', { targetAccount: 'pdurand', scenarios: ['auth-repetee'] }))
    r.run(
      command('adds.setAccountActivity', DOMAIN, 'pdurand', { createdDaysAgo: 200, lastLogonDaysAgo: null })
    )
    // Mauvais mot de passe : compteur d'échecs incrémenté, remis à zéro par le déverrouillage
    r.run(command('adds.logon', r.id('PC1'), { user: 'pdurand', password: 'Faux!', domain: 'LAB' }))
    r.run(command('adds.unlockAccount', DOMAIN, 'pdurand'))
    // Session refusée en attendant le changement : aucune modification de l'état
    const first = r.run<{ success: boolean; mustChangePassword: boolean }>(
      command('adds.logon', r.id('PC1'), { user: 'pdurand', password: 'Bienvenue123!', domain: 'LAB' }),
      false
    )
    expect(first.success).toBe(false)
    expect(first.mustChangePassword).toBe(true)
    const changed = r.run<{ success: boolean }>(
      command('adds.changePasswordAndLogon', r.id('PC1'), {
        user: 'pdurand',
        password: 'Bienvenue123!',
        newPassword: 'Nouveau456!',
        domain: 'LAB'
      })
    )
    expect(changed.success).toBe(true)
    r.run(command('adds.logoff', r.id('PC1')))
    r.run(command('adds.removeObject', DOMAIN, user.id, false))
    // Jonction puis retrait de PC2 (poste statique pointant vers le DC)
    const dc = r.state.devices[r.id('SRV1')]
    const password = dc?.kind === 'server' ? dc.host.localAdminPassword : ''
    const joined = r.run<{ success: boolean }>(
      command('adds.joinDomain', r.id('PC2'), { domain: DOMAIN, user: 'LAB\\Administrateur', password })
    )
    expect(joined.success).toBe(true)
    r.run(command('system.restartComputer', r.id('PC2')))
    const left = r.run<{ success: boolean }>(command('adds.leaveDomain', r.id('PC2')))
    expect(left.success).toBe(true)
    // Nouvelle forêt sur un second serveur
    r.run(command('topology.addDevice', { kind: 'server', position: { x: 0, y: 300 }, name: 'SRV2' }))
    r.run(
      command('net.setInterfaceIpv4', r.id('SRV2'), r.iface('SRV2'), {
        addressing: 'static',
        address: '192.168.10.2',
        mask: '24',
        gateway: null,
        dnsServers: ['127.0.0.1']
      })
    )
    r.run(command('system.installFeatures', r.id('SRV2'), ['AD-Domain-Services']))
    r.run(
      command('adds.installForest', r.id('SRV2'), {
        domainName: 'autre.local',
        safeModePassword: 'P@ssw0rd!'
      })
    )
    expect(r.state.domains['autre.local']).toBeDefined()
    done(r)
  })

  it('Fichiers : dossiers, partages, autorisations NTFS et de partage, lecteurs réseau', () => {
    const r = runner()
    const srv = r.id('SRV1')
    const token = r.admin()
    r.run(command('files.createItem', srv, 'C:\\Partages', 'folder', token, {}))
    r.run(command('files.createItem', srv, 'C:\\Partages\\lisezmoi.txt', 'file', token, {}))
    r.run(command('files.writeContent', srv, 'C:\\Partages\\lisezmoi.txt', 'Bonjour\r\n', token, {}))
    r.run(
      command('files.writeContent', srv, 'C:\\Partages\\lisezmoi.txt', 'Suite\r\n', token, { append: true })
    )
    r.run(command('files.copyItem', srv, 'C:\\Partages\\lisezmoi.txt', 'C:\\Partages\\copie.txt', token, {}))
    r.run(command('files.renameItem', srv, 'C:\\Partages\\copie.txt', 'renomme.txt', token, {}))
    r.run(command('files.moveItem', srv, 'C:\\Partages\\renomme.txt', 'C:\\Partages\\deplace.txt', token, {}))
    r.run(command('files.createShare', srv, { name: 'Partages', path: 'C:\\Partages' }, token))
    r.run(
      command(
        'files.setShareAcl',
        srv,
        'Partages',
        [{ principal: 'S-1-1-0', type: 'Allow', rights: 'Change' }],
        token
      )
    )
    r.run(
      command(
        'files.setNtfsEntry',
        srv,
        'C:\\Partages',
        'LAB\\GG_Compta',
        { allow: ['Modify'], deny: [] },
        token
      )
    )
    r.run(command('files.removeNtfs', srv, 'C:\\Partages', 'LAB\\GG_Compta', 'all', token))
    r.run(command('files.setNtfsInheritance', srv, 'C:\\Partages', 'convert', token))
    r.run(command('files.setNtfsInheritance', srv, 'C:\\Partages', 'enable', token))
    // Lecteur réseau depuis le poste joint, session jdupont
    r.run(command('adds.logon', r.id('PC1'), { user: 'jdupont', password: 'Azerty123!', domain: 'LAB' }))
    const user = sessionToken(r.state, r.id('PC1'))!
    r.run(command('files.mapDrive', r.id('PC1'), 'P', '\\\\SRV1\\Partages', user, { persistent: false }))
    r.run(command('files.unmapDrive', r.id('PC1'), 'P', user.account))
    r.run(command('files.removeShare', srv, 'Partages', token))
    r.run(command('files.setSmb1', srv, true))
    r.run(command('files.setSmb1', srv, false))
    r.run(command('files.removeItem', srv, 'C:\\Partages', token, { recurse: true }))
    r.run(
      command(
        'files.shareFolder',
        srv,
        { name: 'Commun', path: 'C:\\Commun' },
        localToken('SRV1', 'Administrateur')
      )
    )
    done(r)
  })

  it('GPO : création, liaison, état, héritage, filtrage, paramètres, suppression', () => {
    const r = runner()
    const ou = r.state.domains[DOMAIN]!.containers.find((c) => c.name === 'Compta')!
    const gpo = r.run<string>(command('gpo.create', DOMAIN, { name: 'Sécurité postes' }))
    r.run(command('gpo.rename', DOMAIN, gpo, 'Sécurité des postes'))
    r.run(command('gpo.setStatus', DOMAIN, gpo, 'UserSettingsDisabled'))
    r.run(command('gpo.link', DOMAIN, gpo, ou.id))
    r.run(command('gpo.updateLink', DOMAIN, gpo, ou.id, { enforced: true }))
    r.run(command('gpo.setInheritanceBlocked', DOMAIN, ou.id, true))
    r.run(command('gpo.setSecurityFilter', DOMAIN, gpo, 'GG_Compta', true))
    r.run(command('gpo.updateSettings', DOMAIN, gpo, { computer: { minPasswordLength: 10 } }))
    r.run(
      command('gpo.setRegistryValue', DOMAIN, gpo, {
        key: 'HKLM\\Software\\Policies\\Exemple',
        valueNames: ['Valeur'],
        values: [1],
        type: 'DWord'
      })
    )
    r.run(command('gpo.unlink', DOMAIN, gpo, ou.id))
    r.run(command('gpo.delete', DOMAIN, gpo))
    const linked = r.run<string>(command('gpo.createAndLink', DOMAIN, { name: 'Lecteurs' }, ou.id))
    expect(r.state.domains[DOMAIN]!.gpos.some((g) => g.id === linked)).toBe(true)
    done(r)
  })

  it('WSUS : post-installation, synchronisation, classifications, groupes, ciblage, approbations', () => {
    const r = runner()
    const srv = r.id('SRV1')
    r.run(command('system.installFeatures', srv, ['UpdateServices'], { includeManagementTools: true }))
    r.run(command('wsus.postInstall', srv, 'C:\\WSUS'))
    r.run(command('wsus.setClassification', srv, 'drivers', true))
    r.run(command('wsus.synchronize', srv))
    r.run(command('wsus.addGroup', srv, 'Postes'))
    r.run(command('wsus.assignComputer', srv, r.id('PC1'), 'Postes'))
    r.run(command('wsus.approve', srv, 'KB9100102', 'Postes', true))
    r.run(command('wsus.decline', srv, 'KB9100401', true))
    r.run(command('wsus.setTargeting', srv, 'client'))
    r.run(command('wsus.removeGroup', srv, 'Postes'))
    done(r)
  })

  it('IIS : sites, liaisons, certificat SSL, dossier racine, démarrage et arrêt', () => {
    const r = runner()
    const srv = r.id('SRV1')
    r.run(command('system.installFeatures', srv, ['Web-Server'], { includeManagementTools: true }))
    r.run(command('files.createItem', srv, 'C:\\Sites\\Intranet', 'folder', r.admin(), { parents: true }))
    r.run(
      command('iis.addSite', srv, {
        name: 'Intranet',
        physicalPath: 'C:\\inetpub\\wwwroot',
        binding: { host: 'intranet.lab.local' }
      })
    )
    r.run(command('iis.setPhysicalPath', srv, 'Intranet', 'C:\\Sites\\Intranet'))
    r.run(command('iis.addBinding', srv, 'Intranet', { protocol: 'https', host: 'intranet.lab.local' }))
    const thumb = r.run<string>(command('system.newSelfSignedCertificate', srv, ['intranet.lab.local']))
    r.run(
      command(
        'iis.setBindingCertificate',
        srv,
        'Intranet',
        { ip: '*', port: 443, host: 'intranet.lab.local' },
        thumb
      )
    )
    r.run(
      command('iis.removeBinding', srv, 'Intranet', {
        protocol: 'https',
        ip: '*',
        port: 443,
        host: 'intranet.lab.local'
      })
    )
    r.run(command('iis.setSiteState', srv, 'Intranet', false))
    r.run(command('iis.removeSite', srv, 'Intranet'))
    done(r)
  })

  it('Bureau à distance et RDS : paramètres, collection, RemoteApp, connexion, déconnexion', () => {
    const r = runner()
    const srv = r.id('SRV1')
    r.run(command('rds.setRemoteDesktop', srv, { enabled: true, users: ['GG_Compta'] }))
    r.run(command('system.installFeatures', srv, ['RDS-RD-Server'], { includeManagementTools: true }))
    r.run(command('rds.addCollection', srv, { name: 'Bureautique', userGroups: ['GG_Compta'] }))
    r.run(command('rds.setCollectionUserGroups', srv, 'Bureautique', ['GG_Compta', 'jdupont']))
    r.run(
      command('rds.addRemoteApp', srv, 'Bureautique', {
        displayName: 'Bloc-notes',
        filePath: 'C:\\Windows\\System32\\notepad.exe'
      })
    )
    const session = r.run<{ sessionId: number }>(
      command('rds.connect', r.id('PC1'), { computer: 'SRV1', user: 'LAB\\jdupont', password: 'Azerty123!' })
    )
    r.run(command('rds.disconnect', srv, session.sessionId))
    r.run(command('rds.removeRemoteApp', srv, 'Bureautique', 'notepad'))
    r.run(command('rds.removeCollection', srv, 'Bureautique'))
    done(r)
  })

  it('Hyper-V : commutateurs, machines virtuelles, cartes réseau, démarrage et suppression', () => {
    const r = runner()
    const srv = r.id('SRV1')
    r.run(command('system.installFeatures', srv, ['Hyper-V'], { includeManagementTools: true }))
    r.run(command('hyperv.newSwitch', srv, { name: 'Externe', type: 'External', netAdapter: 'Ethernet0' }))
    r.run(command('hyperv.newSwitch', srv, { name: 'Privé', type: 'Private' }))
    r.run(command('hyperv.newVm', srv, { name: 'VM1', switchName: 'Privé', memoryMB: 2048 }))
    r.run(command('hyperv.addAdapter', srv, 'VM1', 'Externe'))
    r.run(command('hyperv.setMemory', srv, 'VM1', 4096))
    r.run(command('hyperv.connectAdapter', srv, 'VM1', null))
    r.run(command('hyperv.setVmState', srv, 'VM1', true))
    r.run(command('hyperv.setVmState', srv, 'VM1', false))
    r.run(command('hyperv.removeVm', srv, 'VM1'))
    r.run(command('hyperv.removeSwitch', srv, 'Externe'))
    done(r)
  })

  it('AD CS : autorité, modèles, demande, révocation, inscription automatique', () => {
    const r = runner()
    const srv = r.id('SRV1')
    r.run(command('system.installFeatures', srv, ['ADCS-Cert-Authority'], { includeManagementTools: true }))
    r.run(command('adcs.install', srv, {}))
    r.run(command('adcs.removeTemplate', srv, 'Administrator'))
    r.run(command('adcs.addTemplate', srv, 'Workstation'))
    r.run(command('adcs.request', srv, { template: 'WebServer', dnsNames: ['intranet.lab.local'] }))
    r.run(command('adcs.pulse', r.id('PC1')))
    const serial = adcsOf(r.state.devices[srv])!.issued[0]!.serial
    r.run(command('adcs.revoke', srv, serial, 'Superseded'))
    done(r)
  })

  it('DFS : espace de noms, dossiers et cibles, groupe de réplication', () => {
    const r = runner()
    const srv = r.id('SRV1')
    const ns = '\\\\lab.local\\Partages\\Compta'
    r.run(
      command('system.installFeatures', srv, ['FS-DFS-Namespace', 'FS-DFS-Replication'], {
        includeManagementTools: true
      })
    )
    r.run(command('files.createItem', srv, 'C:\\Compta', 'folder', r.admin(), {}))
    r.run(command('files.createShare', srv, { name: 'Compta', path: 'C:\\Compta' }, r.admin()))
    r.run(command('dfs.newNamespace', srv, { name: 'Partages', createShare: true }))
    r.run(command('dfs.newFolder', ns, '\\\\SRV1\\Compta'))
    r.run(command('dfs.addTarget', ns, '\\\\SRV1\\Partages'))
    r.run(command('dfs.removeTarget', ns, '\\\\SRV1\\Partages'))
    r.run(command('dfs.removeFolder', ns))
    r.run(command('dfs.removeNamespace', srv, 'Partages'))
    r.run(command('dfs.newGroup', srv, 'Compta'))
    r.run(command('dfs.addMember', 'Compta', 'SRV1'))
    r.run(command('dfs.newReplicatedFolder', 'Compta', 'Compta'))
    r.run(
      command('dfs.setMembership', 'Compta', 'Compta', 'SRV1', { contentPath: 'C:\\Compta', primary: true })
    )
    r.run(command('dfs.sync', 'Compta'), false)
    r.run(command('dfs.removeGroup', 'Compta'))
    done(r)
  })

  it('Corbeille AD et Sauvegarde Windows Server', () => {
    const r = runner()
    const srv = r.id('SRV1')
    r.run(command('adds.enableRecycleBin', DOMAIN))
    const jd = r.state.domains[DOMAIN]!.users.find((u) => u.sam === 'jdupont')!.id
    r.run(command('adds.removeObject', DOMAIN, jd))
    r.run(command('adds.restoreDeleted', DOMAIN, jd))
    r.run(command('system.installFeatures', srv, ['Windows-Server-Backup'], {}))
    r.run(command('files.createItem', srv, 'C:\\Compta', 'folder', r.admin(), {}))
    r.run(command('backup.setPolicy', srv, { items: ['C:\\Compta'], target: 'E:', time: '21:00' }))
    const version = r.run<string>(command('backup.start', srv, null))
    r.run(command('backup.removePolicy', srv))
    r.run(command('files.removeItem', srv, 'C:\\Compta', r.admin(), {}))
    r.run(command('backup.recover', srv, version, 'C:\\Compta', 'Overwrite'))
    done(r)
  })

  it('serveur Linux : paquets installés au départ d’un lab', () => {
    const r = runner()
    r.run(command('linux.installPackages', r.id('LSRV1'), ['apache2']))
    done(r)
  })

  // Registre de scénarios vide : la commande est testée avec un scénario factice dans cyber/scenario.test.ts
  covered.add('cyber.playStep')
  covered.add('cyber.applyCountermeasure') // testée dans cyber/countermeasures.test.ts

  it('toute commande du catalogue est couverte par ce fichier', () => {
    const missing = Object.keys(commandDefinitions()).filter((t) => !covered.has(t))
    expect(missing).toEqual([])
  })
})
