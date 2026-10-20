/**
 * Labs sains de référence des tests du mode panne : les labs fournis, avec leur solution appliquée.
 */
import {
  command,
  dispatch,
  runIosScript,
  type AnyCommand,
  addPrimaryZone,
  addRecord,
  buildLabStart,
  installFeatures,
  parseLab,
  setInterfaceIpv4,
  unwrap,
  type LabState
} from '@engine/index'
import lab1 from '../../../labs/lab-01-adressage.json'
import lab3 from '../../../labs/lab-03-dns.json'
import { WINDOWS_BASES } from './bases-windows'
import { buildLinuxHealthy } from './bases-linux'
import lab13 from '../../../labs/lab-13-vlan.json'
import lab23 from '../../../labs/lab-23-ios-vlan.json'
import lab24 from '../../../labs/lab-24-ios-routage.json'
import lab25 from '../../../labs/lab-25-ios-services.json'
import lab38 from '../../../labs/lab-38-stp-etherchannel.json'
import { run } from '../shell/helpers'

function start(raw: unknown): LabState {
  const parsed = parseLab(raw)
  if (!parsed.ok) throw new Error(parsed.message)
  return buildLabStart(parsed.lab.start)
}

export const idOf = (s: LabState, name: string): string =>
  Object.values(s.devices).find((d) => d.name === name)?.id ?? ''

function ip(s: LabState, device: string, port: string | null, cidr: string, gateway?: string): LabState {
  const d = s.devices[idOf(s, device)]
  const iface = port ? d?.interfaces.find((i) => i.name === port) : d?.interfaces.find((i) => i.l3)
  const [address = '', mask = '24'] = cidr.split('/')
  return unwrap(
    setInterfaceIpv4(s, idOf(s, device), iface?.id ?? '', {
      addressing: 'static',
      address,
      mask,
      gateway: gateway ?? null,
      dnsServers: []
    })
  ).state
}

/** Lab 1 (adressage) résolu : deux réseaux reliés par R1. */
export function healthyLab01(): LabState {
  let s = start(lab1)
  s = ip(s, 'R1', 'Gi0/0', '192.168.10.254/24')
  s = ip(s, 'R1', 'Gi0/1', '192.168.20.254/24')
  s = ip(s, 'PC1', null, '192.168.10.10/24', '192.168.10.254')
  return ip(s, 'PC2', null, '192.168.20.10/24', '192.168.20.254')
}

/** Lab 3 (DNS) résolu : SRV1 sert la zone entreprise.local à PC1. */
export function healthyLab03(): LabState {
  let s = start(lab3)
  const srv = idOf(s, 'SRV1')
  s = unwrap(installFeatures(s, srv, ['DNS'], { includeManagementTools: true })).state
  s = unwrap(addPrimaryZone(s, srv, { name: 'entreprise.local' })).state
  s = unwrap(addPrimaryZone(s, srv, { networkId: '192.168.10.0/24' })).state
  s = unwrap(
    addRecord(s, srv, 'entreprise.local', { name: 'srv1', type: 'A', data: '192.168.10.1', createPtr: true })
  ).state
  s = unwrap(addRecord(s, srv, 'entreprise.local', { name: 'pc1', type: 'A', data: '192.168.10.10' })).state
  return unwrap(
    addRecord(s, srv, 'entreprise.local', { name: 'intranet', type: 'CNAME', data: 'srv1.entreprise.local' })
  ).state
}

// --- Labs réseau (issue #229) ---------------------------------------------------------------

const cfg = (...lines: string[]) => ['enable', 'configure terminal', ...lines, 'end']
const ios = (s: LabState, name: string, lines: string[]) => runIosScript(s, idOf(s, name), lines)

/** Lab 13 (VLAN, switch non Cisco) résolu : VLAN 10 et 20, trunk vers R1. */
export function healthyLab13(): LabState {
  let s = start(lab13)
  const sw = idOf(s, 'SW1')
  const r1 = idOf(s, 'R1')
  const port = (device: string, name: string) =>
    s.devices[device]!.interfaces.find((i) => i.name === name)!.id
  const exec = (cmd: AnyCommand) => {
    s = unwrap(dispatch(s, cmd)).state
  }
  exec(command('net.addVlan', sw, 10, 'Compta'))
  exec(command('net.addVlan', sw, 20, 'RH'))
  exec(command('net.setSwitchport', sw, port(sw, 'Fa0/1'), { mode: 'access', accessVlan: 10 }))
  exec(command('net.setSwitchport', sw, port(sw, 'Fa0/2'), { mode: 'access', accessVlan: 20 }))
  exec(command('net.setSwitchport', sw, port(sw, 'Fa0/16'), { mode: 'trunk' }))
  for (const vlan of [10, 20]) {
    exec(command('net.addSubinterface', r1, port(r1, 'Gi0/0'), vlan))
    s = ip(s, 'R1', `Gi0/0.${vlan}`, `192.168.${vlan}.254/24`)
  }
  return s
}

/** Lab 23 (VLAN IOS) résolu : switch Cisco, trunk, routeur sur un lien. */
export function healthyLab23(): LabState {
  const s = ios(
    start(lab23),
    'SW1',
    cfg(
      'vlan 10',
      'name COMPTA',
      'vlan 20',
      'name RH',
      'interface Fa0/1',
      'switchport mode access',
      'switchport access vlan 10',
      'interface Fa0/2',
      'switchport mode access',
      'switchport access vlan 20',
      'interface Gi0/1',
      'switchport mode trunk'
    )
  )
  return ios(
    s,
    'R1',
    cfg(
      'interface Gi0/0',
      'no shutdown',
      'interface Gi0/0.10',
      'encapsulation dot1Q 10',
      'ip address 192.168.10.254 255.255.255.0',
      'interface Gi0/0.20',
      'encapsulation dot1Q 20',
      'ip address 192.168.20.254 255.255.255.0'
    )
  )
}

/** Lab 24 (routage) résolu avec des routes STATIQUES entre R1, R2 et R3. */
export function healthyLab24(): LabState {
  let s = start(lab24)
  s = ios(
    s,
    'R1',
    cfg('ip route 192.168.3.0 255.255.255.0 10.0.12.2', 'ip route 10.0.23.0 255.255.255.252 10.0.12.2')
  )
  s = ios(
    s,
    'R2',
    cfg('ip route 192.168.1.0 255.255.255.0 10.0.12.1', 'ip route 192.168.3.0 255.255.255.0 10.0.23.2')
  )
  return ios(
    s,
    'R3',
    cfg('ip route 192.168.1.0 255.255.255.0 10.0.23.1', 'ip route 10.0.12.0 255.255.255.252 10.0.23.1')
  )
}

/** Lab 25 (NAT/PAT vers l'ISP) résolu : PC1 joint SRV-WEB à travers le NAT. */
export function healthyLab25(): LabState {
  const s = ios(
    start(lab25),
    'R1',
    cfg(
      'ip dhcp excluded-address 192.168.1.1 192.168.1.10',
      'ip dhcp pool LAN',
      'network 192.168.1.0 255.255.255.0',
      'default-router 192.168.1.1',
      'dns-server 8.8.8.8',
      'exit',
      'access-list 1 permit 192.168.1.0 0.0.0.255',
      'interface Gi0/0',
      'ip nat inside',
      'interface Gi0/1',
      'ip nat outside',
      'exit',
      'ip nat inside source list 1 interface Gi0/1 overload',
      'ip route 0.0.0.0 0.0.0.0 203.0.113.1'
    )
  )
  return run(s, idOf(s, 'PC1'), 'ipconfig /renew', { shell: 'cmd' }).state
}

/** Lab 38 (STP et EtherChannel) résolu : SW1 racine, EtherChannel LACP SW1 ↔ SW2. */
export function healthyLab38(): LabState {
  const s = ios(
    start(lab38),
    'SW1',
    cfg('spanning-tree vlan 1 root primary', 'interface range gi0/1 - 2', 'channel-group 1 mode active')
  )
  return ios(s, 'SW2', cfg('interface range gi0/1 - 2', 'channel-group 1 mode active'))
}

export const BASES: { name: string; build: () => LabState }[] = [
  { name: 'lab-01-adressage', build: healthyLab01 },
  { name: 'lab-03-dns', build: healthyLab03 },
  { name: 'lab-13-vlan', build: healthyLab13 },
  { name: 'lab-23-ios-vlan', build: healthyLab23 },
  { name: 'lab-24-routes-statiques', build: healthyLab24 },
  { name: 'lab-25-ios-nat', build: healthyLab25 },
  { name: 'lab-38-stp-etherchannel', build: healthyLab38 },
  ...WINDOWS_BASES,
  { name: 'linux-serveur-debian', build: buildLinuxHealthy }
]
