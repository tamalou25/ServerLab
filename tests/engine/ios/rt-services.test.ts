/**
 * Services et diagnostic du routeur (lot 4c) : show ip nat statistics, clear ip nat translation *,
 * show ip dhcp pool / conflict, clear ip dhcp binding *, show standby, show interfaces X complet,
 * show ip interface X, show arp / show ip arp, debug ip packet / debug ip ospf events, undebug all.
 * Sources :
 * - https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipaddr/command/ipaddr-cr-book/ipaddr-r1.html
 * - https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipaddr/command/ipaddr-cr-book/ipaddr-cr-book_chapter_01000.html
 * - https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipapp_fhrp/command/fhp-cr-book/fhp-s1.html
 * - https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/interface/command/ir-cr-book/ir-s4.html
 */
import { describe, expect, it } from 'vitest'
import { cable, createLab } from '../helpers'
import { addIos, IosConsole, router, type SharedLab } from './helpers'

/** R1 Gi0/0 (10.0.0.1/24) – R2 Gi0/0 (10.0.0.2/24). */
function pair() {
  const a = addIos(createLab(), 'c1921')
  const b = addIos(a.state, 'c1921')
  const lab: SharedLab = { state: cable(b.state, a.id, 0, b.id, 0) }
  const r1 = new IosConsole(lab, a.id)
  const r2 = new IosConsole(lab, b.id)
  r1.lines('en', 'conf t', 'int g0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shut', 'end')
  r2.lines('en', 'conf t', 'int g0/0', 'ip address 10.0.0.2 255.255.255.0', 'no shut', 'end')
  return { r1, r2, lab }
}

describe('NAT', () => {
  it('show ip nat statistics : traductions, interfaces, règles dynamiques', () => {
    const c = router()
    c.lines(
      'en',
      'conf t',
      'int g0/0',
      'ip nat inside',
      'int g0/1',
      'ip nat outside',
      'exit',
      'access-list 1 permit 192.168.1.0 0.0.0.255',
      'ip nat inside source list 1 interface g0/1 overload',
      'ip nat inside source static 192.168.1.10 203.0.113.10',
      'end'
    )
    expect(c.run('show ip nat statistics')).toEqual([
      'Total translations: 1 (1 static, 0 dynamic; 0 extended)',
      'Outside interfaces: GigabitEthernet0/1',
      'Inside interfaces: GigabitEthernet0/0',
      'Hits: 0  Misses: 0',
      'Expired translations: 0',
      'Dynamic mappings:',
      '-- Inside Source',
      'access-list 1 interface GigabitEthernet0/1 refcount 0'
    ])
    expect(c.run('clear ip nat translation *')).toEqual([])
  })
})

describe('DHCP', () => {
  it('show ip dhcp pool, show ip dhcp conflict, clear ip dhcp binding *', () => {
    const c = router()
    c.lines(
      'en',
      'conf t',
      'ip dhcp excluded-address 192.168.1.1 192.168.1.10',
      'ip dhcp pool LAN',
      'network 192.168.1.0 255.255.255.0',
      'end'
    )
    expect(c.run('show ip dhcp pool')).toEqual([
      'Pool LAN :',
      ' Utilization mark (high/low)    : 100 / 0',
      ' Subnet size (first/next)       : 0 / 0',
      ' Total addresses                : 254',
      ' Leased addresses               : 0',
      ' Pending event                  : none',
      ' 1 subnet is currently in the pool :',
      ' Current index        IP address range           Leased addresses',
      ' 192.168.1.11         192.168.1.1 - 192.168.1.254 0'
    ])
    expect(c.run('show ip dhcp conflict')).toEqual([
      'IP address    Detection method     Detection time         VRF'
    ])
    expect(c.run('clear ip dhcp binding *')).toEqual([])
    expect(c.run('clear ip dhcp binding')).toEqual(['% Incomplete command.', ''])
  })
})

describe('HSRP : show standby', () => {
  it('état détaillé, routeur actif et de secours', () => {
    const { r1, r2 } = pair()
    r1.lines(
      'conf t',
      'int g0/0',
      'standby 1 ip 10.0.0.254',
      'standby 1 priority 110',
      'standby 1 preempt',
      'end'
    )
    r2.lines('conf t', 'int g0/0', 'standby 1 ip 10.0.0.254', 'end')
    r1.state = r2.state
    const out = r1.run('show standby')
    expect(out[0]).toBe('GigabitEthernet0/0 - Group 1')
    expect(out).toContain('  State is Active')
    expect(out).toContain('  Virtual IP address is 10.0.0.254')
    expect(out).toContain('  Active virtual MAC address is 0000.0c07.ac01')
    expect(out).toContain('  Preemption enabled')
    expect(out).toContain('  Active router is local')
    expect(out.some((l) => l.startsWith('  Standby router is 10.0.0.2, priority 100'))).toBe(true)
    expect(out).toContain('  Priority 110 (configured 110)')
  })
})

describe('show interfaces, show ip interface, ARP', () => {
  it('ping : compteurs d’interface et cache ARP calculés', () => {
    const { r1 } = pair()
    r1.run('ping 10.0.0.2')
    const out = r1.run('show interfaces g0/0')
    expect(out).toContain('  Full-duplex, 1000Mb/s')
    expect(out).toContain('  Input queue: 0/75/0/0 (size/max/drops/flushes); Total output drops: 0')
    const input = out.find((l) => l.includes('packets input'))
    const output = out.find((l) => l.includes('packets output'))
    expect(input).toMatch(/^ {5}[1-9]\d* packets input, \d+ bytes$/)
    expect(output).toMatch(/^ {5}[1-9]\d* packets output, \d+ bytes, 0 underruns$/)
    expect(r1.run('show ip arp')).toEqual([
      'Protocol  Address              Age(min)       Hardware Addr     Type      Interface',
      expect.stringMatching(/^Internet {2}10\.0\.0\.1 {13}- {14}\S{14} {4}ARPA {6}GigabitEthernet0\/0$/),
      expect.stringMatching(/^Internet {2}10\.0\.0\.2 {13}0 {14}\S{14} {4}ARPA {6}GigabitEthernet0\/0$/)
    ])
    expect(r1.run('show arp')[0]).toBe(
      'Protocol   Address          Age (min)   Hardware Addr    Type    Interface'
    )
  })

  it('interface inactive : Auto-duplex, compteurs nuls, never', () => {
    const c = router()
    c.run('en')
    const out = c.run('show interfaces g0/1')
    expect(out).toContain('  Auto-duplex, Auto-speed')
    expect(out).toContain('  Last input never, output never, output hang never')
    expect(out).toContain('     0 packets input, 0 bytes')
  })

  it('show ip interface X : ACL appliquées, helper, NAT', () => {
    const c = router()
    c.lines(
      'en',
      'conf t',
      'access-list 10 permit any',
      'int g0/0',
      'ip address 10.0.0.1 255.255.255.0',
      'ip access-group 10 in',
      'ip helper-address 10.0.1.5',
      'ip nat inside',
      'end'
    )
    const out = c.run('show ip interface g0/0')
    expect(out.slice(0, 5)).toEqual([
      'GigabitEthernet0/0 is administratively down, line protocol is down',
      '  Internet address is 10.0.0.1/24',
      '  Broadcast address is 255.255.255.255',
      '  Address determined by setup command',
      '  MTU is 1500 bytes'
    ])
    expect(out).toContain('  Helper address is 10.0.1.5')
    expect(out).toContain('  Inbound access list is 10')
    expect(out).toContain('  Outgoing access list is not set')
    expect(out).toContain('  Network address translation is enabled, interface in domain inside')
    expect(c.run('show ip interface g0/1')).toEqual([
      'GigabitEthernet0/1 is administratively down, line protocol is down',
      '  Internet protocol processing disabled'
    ])
  })
})

describe('debug et undebug', () => {
  it('debug ip packet : journal simulé à la console et dans show logging ; undebug all', () => {
    const { r1 } = pair()
    expect(r1.run('debug ip packet')).toEqual(['IP packet debugging is on'])
    const out = r1.run('ping 10.0.0.2')
    expect(
      out.some((l) =>
        /: IP: s=10\.0\.0\.1 \(local\), d=10\.0\.0\.2 \(GigabitEthernet0\/0\), len 100, sending$/.test(l)
      )
    ).toBe(true)
    expect(
      out.some((l) => /: IP: s=10\.0\.0\.2 \(GigabitEthernet0\/0\), d=10\.0\.0\.1, len 100, rcvd 3$/.test(l))
    ).toBe(true)
    expect(r1.run('show logging').some((l) => l.includes('IP: s=10.0.0.1 (local)'))).toBe(true)
    expect(r1.run('debug ip ospf events')).toEqual(['OSPF events debugging is on'])
    expect(r1.run('undebug all')).toEqual(['All possible debugging has been turned off'])
    expect(r1.run('ping 10.0.0.2').some((l) => l.includes('IP: s='))).toBe(false)
    expect(r1.run('no debug all')).toEqual(['All possible debugging has been turned off'])
  })

  it('debug en mode utilisateur : refusé', () => {
    const c = router()
    expect(c.run('debug ip packet')[0]).toMatch(/^Translating "debug"/)
  })
})
