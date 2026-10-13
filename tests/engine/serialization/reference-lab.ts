/**
 * Lab de référence des fichiers .slab de tests/engine/serialization/fixtures : contrôleur de
 * domaine (DNS, DHCP autorisé), switch, routeur, poste en DHCP joint au domaine, poste statique.
 * Depuis la v6 : VLAN 20 sur le switch (port d'accès libre, trunk vers le routeur) et
 * sous-interface Gi0/0.20 du routeur.
 * Depuis la v9 : routeur Cisco CR1 (1921) et switch Cisco CSW1 (2960) configurés en IOS
 * Depuis la v10 : sécurité L2 de CSW1 (DHCP snooping, inspection ARP, trunk sans DTP)
 * (VLAN 30, trunk, sous-interface, OSPF, DHCP, ACL, HSRP, enregistrement).
 * Le même scénario a servi à produire chaque fichier vN.slab avec le code de la version N.
 */
import {
  addDevice,
  addGroup,
  addGroupMembers,
  addOrganizationalUnit,
  addRecord,
  addScope,
  addSubinterface,
  addVlan,
  addUser,
  authorizeDhcpServer,
  autoConfigureDhcp,
  connect,
  createLab,
  installFeatures,
  installForest,
  joinDomain,
  restartComputer,
  runIosScript,
  setDhcpOptions,
  setInterfaceIpv4,
  setSwitchport,
  unwrap,
  type DeviceKind,
  type IosModel,
  type LabState
} from '@engine/index'

export const REFERENCE_SAVED_AT = '2026-10-05T12:00:00.000Z'

export function buildReferenceLab(): LabState {
  let s = createLab()
  const ids = new Map<string, string>()
  const id = (name: string) => ids.get(name) ?? ''
  const device = (kind: DeviceKind, name: string, x: number, y: number) => {
    const r = unwrap(addDevice(s, { kind, position: { x, y }, name }))
    s = r.state
    ids.set(name, r.value)
  }
  device('server', 'SRV1', 0, 0)
  device('switch', 'SW1', 200, 0)
  device('client', 'PC1', 400, -80)
  device('client', 'PC2', 400, 80)
  device('router', 'R1', 200, 200)

  const iface = (name: string, port?: string) => {
    const d = s.devices[id(name)]
    const found = port ? d?.interfaces.find((i) => i.name === port) : d?.interfaces.find((i) => i.l3)
    return found?.id ?? ''
  }
  const switchPorts = s.devices[id('SW1')]?.interfaces ?? []
  const toSwitch = (name: string, port: number, ownPort?: string) => {
    s = unwrap(
      connect(
        s,
        { deviceId: id(name), ifaceId: iface(name, ownPort) },
        { deviceId: id('SW1'), ifaceId: switchPorts[port]?.id ?? '' }
      )
    ).state
  }
  toSwitch('SRV1', 0)
  toSwitch('PC1', 1)
  toSwitch('PC2', 2)
  toSwitch('R1', 3, 'Gi0/0')

  const ip = (name: string, address: string, gateway: string | null, dns: string[], port?: string) => {
    s = unwrap(
      setInterfaceIpv4(s, id(name), iface(name, port), {
        addressing: 'static',
        address,
        mask: '24',
        gateway,
        dnsServers: dns
      })
    ).state
  }
  ip('SRV1', '192.168.10.1', '192.168.10.254', ['192.168.10.1'])
  ip('R1', '192.168.10.254', null, [], 'Gi0/0')
  ip('PC2', '192.168.10.20', '192.168.10.254', ['192.168.10.1'])
  // VLAN 20 « Compta » : port d'accès Fa0/5 (libre), trunk vers le routeur, sous-interface Gi0/0.20
  const sw = id('SW1')
  s = unwrap(addVlan(s, sw, 20, 'Compta')).state
  s = unwrap(setSwitchport(s, sw, switchPorts[4]?.id ?? '', { mode: 'access', accessVlan: 20 })).state
  s = unwrap(setSwitchport(s, sw, switchPorts[3]?.id ?? '', { mode: 'trunk' })).state
  const sub = unwrap(addSubinterface(s, id('R1'), iface('R1', 'Gi0/0'), 20))
  s = sub.state
  ip('R1', '192.168.20.254', null, [], 'Gi0/0.20')
  s = unwrap(
    setInterfaceIpv4(s, id('PC1'), iface('PC1'), {
      addressing: 'dhcp',
      address: '',
      mask: '',
      gateway: null,
      dnsServers: []
    })
  ).state

  const srv = id('SRV1')
  s = unwrap(
    installFeatures(s, srv, ['AD-Domain-Services', 'DHCP', 'DNS'], { includeManagementTools: true })
  ).state
  s = unwrap(installForest(s, srv, { domainName: 'lab.local', safeModePassword: 'P@ssw0rd!' })).state
  s = unwrap(addOrganizationalUnit(s, 'lab.local', { name: 'Compta' })).state
  const compta = 'OU=Compta,DC=lab,DC=local'
  s = unwrap(
    addUser(s, 'lab.local', {
      name: 'Jean Dupont',
      sam: 'jdupont',
      path: compta,
      upn: 'jdupont@lab.local',
      password: 'Azerty123!',
      enabled: true
    })
  ).state
  s = unwrap(addGroup(s, 'lab.local', { name: 'GG_Compta', scope: 'Global', path: compta })).state
  s = unwrap(addGroupMembers(s, 'lab.local', 'GG_Compta', ['jdupont'])).state
  const scope = unwrap(
    addScope(s, srv, { name: 'LAN', start: '192.168.10.100', end: '192.168.10.200', mask: '255.255.255.0' })
  )
  s = unwrap(
    setDhcpOptions(scope.state, srv, scope.value, {
      router: ['192.168.10.254'],
      dnsServers: ['192.168.10.1'],
      dnsDomain: 'lab.local'
    })
  ).state
  s = unwrap(authorizeDhcpServer(s, srv, true)).state
  s = unwrap(
    addRecord(s, srv, 'lab.local', { name: 'intranet', type: 'CNAME', data: 'srv1.lab.local' })
  ).state
  s = autoConfigureDhcp(s).state

  // Jonction de PC1 avec le compte Administrateur du domaine (mot de passe local du DC promu)
  const dc = s.devices[srv]
  const password = dc?.kind === 'server' ? dc.host.localAdminPassword : ''
  const joined = joinDomain(s, id('PC1'), { domain: 'lab.local', user: 'LAB\\Administrateur', password })
  if (!joined.ok) throw new Error(joined.message)
  s = unwrap(restartComputer(joined.state, id('PC1'))).state
  s = autoConfigureDhcp(s).state

  // Équipements Cisco IOS (v9) : routeur CR1 relié au switch CSW1 par un trunk (sans poste)
  const cisco = (kind: DeviceKind, model: IosModel, name: string, x: number, y: number) => {
    const r = unwrap(addDevice(s, { kind, model, position: { x, y }, name }))
    s = r.state
    ids.set(name, r.value)
  }
  cisco('router', 'c1921', 'CR1', 0, 400)
  cisco('switch', 'c2960', 'CSW1', 200, 400)
  s = unwrap(
    connect(
      s,
      { deviceId: id('CR1'), ifaceId: iface('CR1', 'Gi0/0') },
      { deviceId: id('CSW1'), ifaceId: iface('CSW1', 'Gi0/1') }
    )
  ).state
  s = runIosScript(s, id('CSW1'), [
    'enable',
    'configure terminal',
    'vlan 30',
    'name CISCO',
    'interface Gi0/1',
    'switchport mode trunk',
    'interface Fa0/2',
    'switchport mode access',
    'switchport access vlan 30',
    'switchport port-security',
    // v10 : sécurité de niveau 2
    'exit',
    'ip dhcp snooping',
    'ip dhcp snooping vlan 30',
    'ip arp inspection vlan 30',
    'interface Gi0/1',
    'switchport nonegotiate',
    'ip dhcp snooping trust',
    'ip arp inspection trust',
    'end',
    'write memory'
  ])
  return runIosScript(s, id('CR1'), [
    'enable',
    'configure terminal',
    'enable secret Cisco123',
    'ip dhcp pool CISCO',
    'network 192.168.30.0 255.255.255.0',
    'default-router 192.168.30.1',
    'exit',
    'access-list 10 permit 192.168.30.0 0.0.0.255',
    // v15 : entrée journalisée (mot-clé « log »)
    'access-list 110 deny ip any any log',
    'interface Gi0/0',
    'no shutdown',
    'interface Gi0/0.30',
    'encapsulation dot1Q 30',
    'ip address 192.168.30.1 255.255.255.0',
    'standby 1 ip 192.168.30.254',
    'exit',
    'router ospf 1',
    'network 192.168.30.0 0.0.0.255 area 0',
    'end',
    'write memory'
  ])
}
