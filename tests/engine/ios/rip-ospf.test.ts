/**
 * Routage dynamique du routeur (lot 4b) : RIP (version, network, auto-summary, passive-interface,
 * default-information originate) convergé sur la topologie, show ip rip database, show ip
 * protocols, show ip ospf, show ip ospf interface [brief], show ip ospf database, OSPF
 * default-information originate, clear ip ospf process.
 * Sources : RIP Command Reference
 * https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/iproute_rip/command/irr-cr-book/irr-cr-rip.html
 * OSPF Command Reference
 * https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/iproute_ospf/command/iro-cr-book/ospf-s1.html
 * show ip protocols : https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/iproute_pi/command/iri-cr-book/iri-cr-s1.html
 */
import { describe, expect, it } from 'vitest'
import { ping, routingTable, type LabState } from '@engine/index'
import { cable, createLab } from '../helpers'
import { addIos, IosConsole, type SharedLab } from './helpers'

const pingOk = (state: LabState, from: string, to: string): boolean => {
  const r = ping(state, from, to)
  return r.ok && r.value.success
}

/**
 * Chaîne R1 – R2 – R3 : R1 Gi0/1 = 172.16.1.1/24 (LAN), R1 Gi0/0 – R2 Gi0/0 en 10.0.12.0/30,
 * R2 Gi0/1 – R3 Gi0/0 en 10.0.23.0/30, R3 Gi0/1 = 192.168.3.1/24 (LAN, sans câble : up si câblé).
 */
function chain() {
  let s = createLab()
  const ids: string[] = []
  for (let n = 0; n < 4; n++) {
    const r = addIos(s, 'c1921')
    s = r.state
    ids.push(r.id)
  }
  const [r1, r2, r3, r4] = ids as [string, string, string, string]
  s = cable(s, r1, 0, r2, 0)
  s = cable(s, r2, 1, r3, 0)
  // R4 sert de voisin LAN de R1 (lien up)
  s = cable(s, r1, 1, r4, 0)
  const lab: SharedLab = { state: s }
  const c = ids.map((id) => new IosConsole(lab, id)) as [IosConsole, IosConsole, IosConsole, IosConsole]
  const ip = (con: IosConsole, port: string, address: string, mask: string) =>
    con.lines(`int ${port}`, `ip address ${address} ${mask}`, 'no shut', 'exit')
  for (const con of c) con.lines('en', 'conf t')
  ip(c[0], 'g0/0', '10.0.12.1', '255.255.255.252')
  ip(c[0], 'g0/1', '172.16.1.1', '255.255.255.0')
  ip(c[1], 'g0/0', '10.0.12.2', '255.255.255.252')
  ip(c[1], 'g0/1', '10.0.23.1', '255.255.255.252')
  ip(c[2], 'g0/0', '10.0.23.2', '255.255.255.252')
  ip(c[3], 'g0/0', '172.16.1.4', '255.255.255.0')
  return { lab, c, ids: ids as [string, string, string, string] }
}

const rip = (con: IosConsole, ...lines: string[]) => con.lines('router rip', ...lines, 'end', 'conf t')

describe('RIP : configuration et convergence', () => {
  it('version 2, network, no auto-summary : routes R calculées, ping de bout en bout', () => {
    const { lab, c, ids } = chain()
    rip(c[0], 'version 2', 'network 10.0.0.0', 'network 172.16.0.0', 'no auto-summary')
    rip(c[1], 'version 2', 'network 10.0.0.0', 'no auto-summary')
    rip(c[2], 'version 2', 'network 10.0.0.0', 'no auto-summary')
    const table = routingTable(lab.state, lab.state.devices[ids[2]]!)
    const lan = table.find((r) => r.network === '172.16.1.0')
    expect(lan).toMatchObject({ source: 'rip', prefixLength: 24, metric: 2, gateway: '10.0.23.1' })
    expect(pingOk(lab.state, ids[2], '10.0.12.1')).toBe(true)
    c[2].run('end')
    const route = c[2].run('show ip route')
    expect(route).toContain('R        10.0.12.0/30 [120/1] via 10.0.23.1, 00:00:00, GigabitEthernet0/0')
    expect(route.some((l) => l.startsWith('R        172.16.1.0/24 [120/2] via 10.0.23.1'))).toBe(true)
  })

  it('network enregistré en réseau de classe ; running-config dans l’ordre IOS', () => {
    const { c } = chain()
    rip(
      c[0],
      'version 2',
      'passive-interface g0/1',
      'network 10.0.12.0',
      'default-information originate',
      'no auto-summary'
    )
    c[0].run('end')
    const run = c[0].run('show running-config')
    const at = run.indexOf('router rip')
    expect(run.slice(at, at + 6)).toEqual([
      'router rip',
      ' version 2',
      ' passive-interface GigabitEthernet0/1',
      ' network 10.0.0.0',
      ' default-information originate',
      ' no auto-summary'
    ])
  })

  it('auto-summary (défaut) : 172.16.1.0/24 annoncé en 172.16.0.0/16', () => {
    const { lab, c, ids } = chain()
    rip(c[0], 'version 2', 'network 10.0.0.0', 'network 172.16.0.0')
    rip(c[1], 'version 2', 'network 10.0.0.0')
    const r2 = routingTable(lab.state, lab.state.devices[ids[1]]!)
    expect(r2.find((r) => r.network === '172.16.0.0')).toMatchObject({
      prefixLength: 16,
      source: 'rip',
      metric: 1
    })
    expect(r2.find((r) => r.network === '172.16.1.0')).toBeUndefined()
  })

  it('versions incompatibles : un routeur v2 ignore les mises à jour v1', () => {
    const { lab, c, ids } = chain()
    rip(c[0], 'network 10.0.0.0', 'network 172.16.0.0')
    rip(c[1], 'version 2', 'network 10.0.0.0')
    expect(routingTable(lab.state, lab.state.devices[ids[1]]!).some((r) => r.source === 'rip')).toBe(false)
    // Sans version, R1 accepte la version 2 de R2
    expect(
      routingTable(lab.state, lab.state.devices[ids[0]]!).find((r) => r.network === '10.0.23.0')
    ).toMatchObject({
      source: 'rip'
    })
  })

  it('passive-interface : plus de mise à jour sur l’interface ; coupure de lien = route retirée', () => {
    const { lab, c, ids } = chain()
    rip(c[0], 'version 2', 'network 10.0.0.0', 'network 172.16.0.0', 'no auto-summary')
    rip(c[1], 'version 2', 'network 10.0.0.0', 'no auto-summary')
    const has = () =>
      routingTable(lab.state, lab.state.devices[ids[1]]!).some((r) => r.network === '172.16.1.0')
    expect(has()).toBe(true)
    rip(c[0], 'passive-interface g0/0')
    expect(has()).toBe(false)
    rip(c[0], 'no passive-interface g0/0')
    expect(has()).toBe(true)
    c[0].lines('int g0/0', 'shutdown', 'exit')
    expect(has()).toBe(false)
  })

  it('default-information originate : route R* et passerelle de dernier recours', () => {
    const { c } = chain()
    rip(c[0], 'version 2', 'network 10.0.0.0', 'default-information originate')
    rip(c[1], 'version 2', 'network 10.0.0.0')
    c[1].run('end')
    const route = c[1].run('show ip route')
    expect(route).toContain('Gateway of last resort is 10.0.12.1 to network 0.0.0.0')
    expect(route.some((l) => l.startsWith('R*    0.0.0.0/0 [120/1] via 10.0.12.1'))).toBe(true)
  })

  it('erreurs : version hors bornes, commande RIP hors de router rip', () => {
    const { c } = chain()
    c[0].run('router rip')
    expect(c[0].run('version 3')).toEqual([
      `${' '.repeat('R1(config-router)#version '.length)}^`,
      "% Invalid input detected at '^' marker.",
      ''
    ])
    c[0].lines('exit', 'router ospf 1')
    expect(c[0].run('version 2')[1]).toBe("% Invalid input detected at '^' marker.")
    expect(c[0].run('auto-summary')[1]).toBe("% Invalid input detected at '^' marker.")
  })
})

describe('show ip rip database et show ip protocols', () => {
  it('show ip rip database : connectés, appris, auto-summary', () => {
    const { c } = chain()
    rip(c[0], 'network 10.0.0.0', 'network 172.16.0.0')
    rip(c[1], 'network 10.0.0.0')
    c[1].run('end')
    expect(c[1].run('show ip rip database')).toEqual([
      '10.0.0.0/8    auto-summary',
      '10.0.12.0/30    directly connected, GigabitEthernet0/0',
      '10.0.23.0/30    directly connected, GigabitEthernet0/1',
      '172.16.0.0/16',
      '    [1] via 10.0.12.1, 00:00:00, GigabitEthernet0/0'
    ])
  })

  it('show ip protocols : RIP version, réseaux, passives, sources', () => {
    const { c } = chain()
    rip(
      c[0],
      'version 2',
      'network 10.0.0.0',
      'network 172.16.0.0',
      'passive-interface g0/1',
      'no auto-summary'
    )
    rip(c[1], 'version 2', 'network 10.0.0.0', 'no auto-summary')
    c[0].run('end')
    expect(c[0].run('show ip protocols')).toEqual([
      'Routing Protocol is "rip"',
      '  Outgoing update filter list for all interfaces is not set',
      '  Incoming update filter list for all interfaces is not set',
      '  Sending updates every 30 seconds, next due in 30 seconds',
      '  Invalid after 180 seconds, hold down 180, flushed after 240',
      '  Redistributing: rip',
      '  Default version control: send version 2, receive version 2',
      '  Automatic network summarization is not in effect',
      '  Maximum path: 4',
      '  Routing for Networks:',
      '    10.0.0.0',
      '    172.16.0.0',
      '  Passive Interface(s):',
      '    GigabitEthernet0/1',
      '  Routing Information Sources:',
      '    Gateway         Distance      Last Update',
      '    10.0.12.2            120      00:00:00',
      '  Distance: (default is 120)'
    ])
  })
})

describe('OSPF : affichages et default-information originate', () => {
  function ospf() {
    const { lab, c, ids } = chain()
    const area = (con: IosConsole, ...lines: string[]) =>
      con.lines('router ospf 1', ...lines, 'end', 'conf t')
    area(
      c[0],
      'router-id 1.1.1.1',
      'network 10.0.12.0 0.0.0.3 area 0',
      'network 172.16.1.0 0.0.0.255 area 0',
      'passive-interface g0/1'
    )
    area(c[1], 'router-id 2.2.2.2', 'network 10.0.0.0 0.255.255.255 area 0')
    area(c[2], 'router-id 3.3.3.3', 'network 10.0.23.0 0.0.0.3 area 0')
    for (const con of c) con.run('end')
    return { lab, c, ids }
  }

  it('show ip ospf interface brief : coût, état DR/BDR, voisins', () => {
    const { c } = ospf()
    expect(c[1].run('show ip ospf interface brief')).toEqual([
      'Interface    PID   Area            IP Address/Mask    Cost  State Nbrs F/C',
      'Gi0/0        1     0               10.0.12.2/30       1     DR    1/1',
      'Gi0/1        1     0               10.0.23.1/30       1     BDR   1/1'
    ])
  })

  it('show ip ospf interface X : DR, BDR, adjacence ; interface passive', () => {
    const { c } = ospf()
    const out = c[1].run('show ip ospf interface g0/0')
    expect(out.slice(0, 6)).toEqual([
      'GigabitEthernet0/0 is up, line protocol is up',
      '  Internet Address 10.0.12.2/30, Area 0',
      '  Process ID 1, Router ID 2.2.2.2, Network Type BROADCAST, Cost: 1',
      '  Transmit Delay is 1 sec, State DR, Priority 1',
      '  Designated Router (ID) 2.2.2.2, Interface address 10.0.12.2',
      '  Backup Designated router (ID) 1.1.1.1, Interface address 10.0.12.1'
    ])
    expect(out).toContain('  Neighbor Count is 1, Adjacent neighbor count is 1')
    expect(out).toContain('    Adjacent with neighbor 1.1.1.1  (Backup Designated Router)')
    expect(c[0].run('show ip ospf interface g0/1')).toContain('    No Hellos (Passive interface)')
  })

  it('show ip ospf : processus, identifiant, zone et nombre de LSA', () => {
    const { c } = ospf()
    const out = c[0].run('show ip ospf')
    expect(out[0]).toBe(' Routing Process "ospf 1" with ID 1.1.1.1')
    expect(out).toContain(' Number of areas in this router is 1. 1 normal 0 stub 0 nssa')
    expect(out).toContain('    Area BACKBONE(0)')
    expect(out).toContain('        Number of interfaces in this area is 2')
    // 3 LSA routeur + 2 LSA réseau (segments R1–R2, R2–R3)
    expect(out.some((l) => /^ {8}Number of LSA 5\. Checksum Sum 0x[0-9A-F]+$/.test(l))).toBe(true)
  })

  it('show ip ospf database : LSA routeur et réseau calculées', () => {
    const { c } = ospf()
    const out = c[0].run('show ip ospf database')
    expect(out.slice(0, 6)).toEqual([
      '',
      '            OSPF Router with ID (1.1.1.1) (Process ID 1)',
      '',
      '\t\tRouter Link States (Area 0)',
      '',
      'Link ID         ADV Router      Age         Seq#       Checksum Link count'
    ])
    const rows = out.filter((l) => /^\d+\.\d+\.\d+\.\d+ /.test(l))
    expect(rows.map((r) => r.split(/\s+/)[0])).toEqual([
      '1.1.1.1',
      '2.2.2.2',
      '3.3.3.3',
      '10.0.12.2',
      '10.0.23.2'
    ])
    expect(rows[0]).toMatch(/^1\.1\.1\.1 {9}1\.1\.1\.1 {9}0 {11}0x80000001 0x[0-9A-F]{6} 2$/)
  })

  it('default-information originate : O*E2 si une route par défaut statique existe (ou always)', () => {
    const { lab, c } = ospf()
    c[0].lines('conf t', 'router ospf 1', 'default-information originate', 'end')
    expect(c[2].run('show ip route').some((l) => l.startsWith('O*E2'))).toBe(false)
    c[0].lines('conf t', 'ip route 0.0.0.0 0.0.0.0 172.16.1.4', 'end')
    expect(c[2].run('show ip route').some((l) => l.startsWith('O*E2  0.0.0.0/0 [110/1] via 10.0.23.1'))).toBe(
      true
    )
    expect(c[0].run('show ip ospf database')).toContain('\t\tType-5 AS External Link States')
    c[0].lines(
      'conf t',
      'no ip route 0.0.0.0 0.0.0.0 172.16.1.4',
      'router ospf 1',
      'default-information originate always',
      'end'
    )
    expect(c[2].run('show ip route').some((l) => l.startsWith('O*E2'))).toBe(true)
    expect(c[0].run('show running-config')).toContain(' default-information originate always')
    void lab
  })

  it('show ip protocols (OSPF) et clear ip ospf process', () => {
    const { c } = ospf()
    const out = c[1].run('show ip protocols')
    expect(out.slice(0, 4)).toEqual([
      'Routing Protocol is "ospf 1"',
      '  Outgoing update filter list for all interfaces is not set',
      '  Incoming update filter list for all interfaces is not set',
      '  Router ID 2.2.2.2'
    ])
    expect(out).toContain('    10.0.0.0 0.255.255.255 area 0')
    expect(c[1].run('clear ip ospf process', ['no'])).toEqual([])
    expect(c[1].run('clear ip ospf process', ['yes'])).toEqual([
      '%OSPF-5-ADJCHG: Process 1, Nbr 1.1.1.1 on GigabitEthernet0/0 from FULL to DOWN, Neighbor Down: Interface down or detached',
      '%OSPF-5-ADJCHG: Process 1, Nbr 3.3.3.3 on GigabitEthernet0/1 from FULL to DOWN, Neighbor Down: Interface down or detached',
      '%OSPF-5-ADJCHG: Process 1, Nbr 1.1.1.1 on GigabitEthernet0/0 from LOADING to FULL, Loading Done',
      '%OSPF-5-ADJCHG: Process 1, Nbr 3.3.3.3 on GigabitEthernet0/1 from LOADING to FULL, Loading Done'
    ])
  })

  it('OSPF préféré à RIP (distance 110 < 120)', () => {
    const { lab, c, ids } = ospf()
    for (const con of c.slice(0, 3))
      con.lines(
        'conf t',
        'router rip',
        'version 2',
        'network 10.0.0.0',
        'network 172.16.0.0',
        'no auto-summary',
        'end'
      )
    const lan = routingTable(lab.state, lab.state.devices[ids[2]]!).find((r) => r.network === '172.16.1.0')
    expect(lan?.source).toBe('ospf')
  })
})
