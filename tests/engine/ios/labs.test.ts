/**
 * Labs notés Cisco IOS : chacun démarre incomplet et la solution (lignes saisies à la console,
 * comme un élève) le valide à 100 %.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  addScope,
  buildLabStart,
  checkLab,
  parseLab,
  runIosScript,
  setDhcpOptions,
  unwrap,
  autoConfigureDhcp,
  type LabDefinition,
  type LabState
} from '@engine/index'
import lab22 from '../../../labs/lab-22-ios-base.json'
import lab23 from '../../../labs/lab-23-ios-vlan.json'
import lab24 from '../../../labs/lab-24-ios-routage.json'
import lab25 from '../../../labs/lab-25-ios-services.json'
import lab26 from '../../../labs/lab-26-ios-hsrp.json'
import lab27 from '../../../labs/lab-27-ios-securite.json'
import lab28 from '../../../labs/lab-28-ios-sujet-e6.json'
import { run } from '../shell/helpers'

// Solution enregistrée en commandes nommées et rejouée comme un rendu (mode enseignant, #405)
vi.mock('@engine/index', async (importOriginal) =>
  (await import('../teacher/recorder')).instrumentEngine(importOriginal)
)

function load(raw: unknown): LabDefinition {
  const parsed = parseLab(raw)
  if (!parsed.ok) throw new Error(parsed.message)
  return parsed.lab
}

const id = (s: LabState, name: string) => Object.values(s.devices).find((d) => d.name === name)?.id ?? ''
const cfg = (...lines: string[]) => ['enable', 'configure terminal', ...lines, 'end']
const ios = (s: LabState, name: string, lines: string[]) => runIosScript(s, id(s, name), lines)
const pc = (s: LabState, name: string, line: string) => run(s, id(s, name), line, { shell: 'cmd' }).state

const SOLUTIONS: Record<string, (s: LabState) => LabState> = {
  'lab-22-ios-base': (s) =>
    ios(s, 'R1', [
      ...cfg(
        'enable secret Cisco123',
        'banner motd #Acces reserve#',
        'interface Gi0/0',
        'description LAN PC1',
        'ip address 192.168.1.1 255.255.255.0',
        'no shutdown',
        'exit'
      ),
      'write memory'
    ]),
  'lab-23-ios-vlan': (s) => {
    s = ios(
      s,
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
  },
  'lab-24-ios-routage': (s) => {
    s = ios(
      s,
      'R1',
      cfg(
        'router ospf 1',
        'network 192.168.1.0 0.0.0.255 area 0',
        'network 10.0.12.0 0.0.0.3 area 0',
        'passive-interface Gi0/0'
      )
    )
    s = ios(
      s,
      'R2',
      cfg('router ospf 1', 'network 10.0.12.0 0.0.0.3 area 0', 'network 10.0.23.0 0.0.0.3 area 0')
    )
    return ios(
      s,
      'R3',
      cfg(
        'router ospf 1',
        'network 192.168.3.0 0.0.0.255 area 0',
        'network 10.0.23.0 0.0.0.3 area 0',
        'passive-interface Gi0/1'
      )
    )
  },
  'lab-25-ios-services': (s) => {
    s = ios(
      s,
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
    s = pc(s, 'PC1', 'ipconfig /renew')
    return pc(s, 'PC1', 'ping 198.51.100.10')
  },
  'lab-26-ios-hsrp': (s) => {
    const group = (priority: string[]) => cfg('interface Gi0/0', 'standby 1 ip 192.168.1.254', ...priority)
    s = ios(s, 'R1', group(['standby 1 priority 110', 'standby 1 preempt']))
    return ios(s, 'R2', group([]))
  },
  'lab-27-ios-securite': (s) => {
    s = ios(
      s,
      'R1',
      cfg(
        'ip access-list extended BLOQUE-ICMP',
        'deny icmp 192.168.1.0 0.0.0.255 host 10.0.0.10',
        'permit ip any any',
        'exit',
        'interface Gi0/0',
        'ip access-group BLOQUE-ICMP in',
        'exit',
        'ip domain-name entreprise.local',
        'crypto key generate rsa modulus 1024',
        'ip ssh version 2',
        'username admin secret Admin123',
        'line vty 0 4',
        'login local',
        'transport input ssh',
        'exit',
        'service password-encryption'
      )
    )
    s = ios(s, 'R1', ['enable', 'write memory'])
    return ios(
      s,
      'SW1',
      cfg(
        'interface Fa0/1',
        'switchport mode access',
        'switchport port-security',
        'switchport port-security maximum 1',
        'switchport port-security mac-address sticky',
        'switchport port-security violation shutdown'
      )
    )
  },
  'lab-28-ios-sujet-e6': (s) => {
    s = ios(
      s,
      'SW1',
      cfg(
        'vlan 10',
        'vlan 20',
        'interface Fa0/1',
        'switchport mode access',
        'switchport access vlan 10',
        'interface Fa0/2',
        'switchport mode access',
        'switchport access vlan 20',
        'interface Gi0/1',
        'switchport mode trunk',
        'interface Gi0/2',
        'switchport mode trunk'
      )
    )
    const paris = (n: string, priority: string[]) => [
      'interface Gi0/0',
      'no shutdown',
      'interface Gi0/0.10',
      'encapsulation dot1Q 10',
      `ip address 192.168.10.${n} 255.255.255.0`,
      'ip helper-address 192.168.20.10',
      'standby 1 ip 192.168.10.254',
      ...priority,
      'interface Gi0/0.20',
      'encapsulation dot1Q 20',
      `ip address 192.168.20.${n} 255.255.255.0`,
      'exit',
      'router ospf 1',
      'network 192.168.10.0 0.0.0.255 area 0',
      'network 192.168.20.0 0.0.0.255 area 0',
      'passive-interface GigabitEthernet0/0.10'
    ]
    s = ios(s, 'R1', [
      'enable',
      'configure terminal',
      ...paris('1', ['standby 1 priority 110', 'standby 1 preempt']),
      'exit',
      'access-list 1 permit 192.168.10.0 0.0.0.255',
      'interface Gi0/0.10',
      'ip nat inside',
      'interface Gi0/1',
      'ip nat outside',
      'exit',
      'ip nat inside source list 1 interface Gi0/1 overload',
      'ip route 0.0.0.0 0.0.0.0 203.0.113.1',
      'end',
      'write memory'
    ])
    s = ios(s, 'R2', cfg(...paris('2', []), 'network 10.0.23.0 0.0.0.3 area 0'))
    s = ios(
      s,
      'R3',
      cfg(
        'router ospf 1',
        'network 10.0.23.0 0.0.0.3 area 0',
        'network 192.168.30.0 0.0.0.255 area 0',
        'passive-interface FastEthernet0/1',
        'exit',
        'ip access-list extended NO-PING',
        'deny icmp 192.168.30.0 0.0.0.255 host 192.168.20.10',
        'permit ip any any',
        'exit',
        'interface Fa0/1',
        'ip access-group NO-PING in',
        'ip helper-address 192.168.20.10'
      )
    )
    const srv = id(s, 'SRV1')
    for (const [name, start, end, router] of [
      ['Utilisateurs', '192.168.10.100', '192.168.10.200', '192.168.10.254'],
      ['Lyon', '192.168.30.100', '192.168.30.200', '192.168.30.1']
    ] as const) {
      const scope = unwrap(addScope(s, srv, { name, start, end, mask: '255.255.255.0' }))
      s = unwrap(setDhcpOptions(scope.state, srv, scope.value, { router: [router] })).state
    }
    s = autoConfigureDhcp(s).state
    s = pc(s, 'PC1', 'ipconfig /renew')
    s = pc(s, 'PC2', 'ipconfig /renew')
    return pc(s, 'PC1', 'ping 203.0.113.1')
  }
}

const labs = [lab22, lab23, lab24, lab25, lab26, lab27, lab28].map(load)

describe('labs IOS', () => {
  it('identifiants et critères uniques', () => {
    expect(new Set(labs.map((l) => l.id)).size).toBe(labs.length)
    for (const lab of labs) expect(new Set(lab.criteria.map((c) => c.id)).size).toBe(lab.criteria.length)
  })

  for (const lab of labs) {
    it(`${lab.id} : départ incomplet, solution validée à 100 %`, () => {
      const start = buildLabStart(lab.start)
      const before = checkLab(start, lab)
      expect(before.passed).toBeLessThan(before.total)
      const after = checkLab(SOLUTIONS[lab.id]!(start), lab)
      expect(after.results.filter((r) => !r.ok).map((r) => r.id)).toEqual([])
    })
  }

  it('aucun indice ne reprend la valeur attendue', () => {
    const KEYS = new Set(['line', 'network', 'via', 'address', 'to', 'interface'])
    for (const lab of labs)
      for (const c of lab.criteria)
        for (const [key, value] of Object.entries(c.check))
          if (KEYS.has(key) && typeof value === 'string' && value.length >= 4)
            expect(c.hint.toLowerCase(), `${lab.id} › ${c.id}`).not.toContain(value.toLowerCase())
  })
})
