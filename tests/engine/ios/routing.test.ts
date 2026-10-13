/**
 * Routage IOS : routes statiques et par défaut, OSPF monozone (convergence de trois routeurs,
 * recalcul à la coupure d'un lien), show ip route et show ip ospf neighbor.
 */
import { describe, expect, it } from 'vitest'
import { ping, routingTable, type LabState } from '@engine/index'
import { add, cable, createLab, setIp } from '../helpers'
import { addIos, IosConsole, type SharedLab } from './helpers'

const pingOk = (state: LabState, from: string, to: string): boolean => {
  const r = ping(state, from, to)
  return r.ok && r.value.success
}

/** Triangle R1–R2–R3 : Gi0/0 et Gi0/1 de chaque routeur. */
function triangle() {
  let s = createLab()
  const ids: string[] = []
  for (let n = 0; n < 3; n++) {
    const r = addIos(s, 'c1921')
    s = r.state
    ids.push(r.id)
  }
  const [r1, r2, r3] = ids as [string, string, string]
  s = cable(s, r1, 0, r2, 0) // 10.0.12.0/30
  s = cable(s, r2, 1, r3, 0) // 10.0.23.0/30
  s = cable(s, r3, 1, r1, 1) // 10.0.13.0/30
  const lab: SharedLab = { state: s }
  const c = ids.map((id) => new IosConsole(lab, id)) as [IosConsole, IosConsole, IosConsole]
  const setup = (con: IosConsole, a: string, b: string) =>
    con.lines(
      'en',
      'conf t',
      'int g0/0',
      `ip address ${a} 255.255.255.252`,
      'no shut',
      'int g0/1',
      `ip address ${b} 255.255.255.252`,
      'no shut',
      'exit'
    )
  setup(c[0], '10.0.12.1', '10.0.13.1')
  setup(c[1], '10.0.12.2', '10.0.23.1')
  setup(c[2], '10.0.23.2', '10.0.13.2')
  return { lab, c, ids: ids as [string, string, string] }
}

describe('routes statiques', () => {
  function twoSites() {
    const r1 = addIos(createLab(), 'c1921')
    const r2 = addIos(r1.state, 'c1921')
    const pc = add(r2.state, 'client')
    let s = cable(pc.state, r1.id, 0, r2.id, 0)
    s = cable(s, pc.id, 0, r2.id, 1)
    s = setIp(s, pc.id, 0, '192.168.2.10/24', '192.168.2.1')
    const lab: SharedLab = { state: s }
    const c1 = new IosConsole(lab, r1.id)
    const c2 = new IosConsole(lab, r2.id)
    c1.lines('en', 'conf t', 'int g0/0', 'ip address 10.0.12.1 255.255.255.252', 'no shut', 'end')
    c2.lines('en', 'conf t', 'int g0/0', 'ip address 10.0.12.2 255.255.255.252', 'no shut')
    c2.lines('int g0/1', 'ip address 192.168.2.1 255.255.255.0', 'no shut', 'end')
    return { lab, c1, c2, r1: r1.id, pc: pc.id }
  }

  it('ip route : S dans la table, ping du réseau distant', () => {
    const { lab, c1, r1 } = twoSites()
    expect(pingOk(lab.state, r1, '192.168.2.10')).toBe(false)
    c1.lines('conf t', 'ip route 192.168.2.0 255.255.255.0 10.0.12.2', 'end')
    expect(pingOk(lab.state, r1, '192.168.2.10')).toBe(true)
    const out = c1.run('show ip route')
    expect(out).toContain('Gateway of last resort is not set')
    // Réseau de classe C entier : affiché sans ligne de regroupement
    expect(out).toContain('S     192.168.2.0/24 [1/0] via 10.0.12.2')
    expect(c1.run('show running-config')).toContain('ip route 192.168.2.0 255.255.255.0 10.0.12.2')
  })

  it('boucle de routage : le TTL expire en transit, sans boucle infinie (audit T-03)', () => {
    const { lab, c1, c2, pc } = twoSites()
    // R1 renvoie 172.16.0.0/16 vers R2, qui le renvoie vers R1 ; R1 connaît le retour vers le poste
    // (TTL 128 du poste : il expire sur R1, qui doit pouvoir émettre l'ICMP « temps dépassé »)
    c1.lines(
      'conf t',
      'ip route 172.16.0.0 255.255.0.0 10.0.12.2',
      'ip route 192.168.2.0 255.255.255.0 10.0.12.2',
      'end'
    )
    c2.lines('conf t', 'ip route 172.16.0.0 255.255.0.0 10.0.12.1', 'end')
    const r = ping(lab.state, pc, '172.16.5.5')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.success).toBe(false)
    expect(r.value.outcomes).toHaveLength(4)
    for (const outcome of r.value.outcomes) {
      expect(outcome.kind).toBe('ttl-expired')
      // ICMP « temps dépassé » émis par l'un des deux routeurs de la boucle
      if (outcome.kind === 'ttl-expired')
        expect(['10.0.12.1', '10.0.12.2', '192.168.2.1']).toContain(outcome.from)
    }
    expect(
      r.value.lines.filter((l) => l.endsWith(': Durée de vie TTL expirée lors du transit.'))
    ).toHaveLength(4)
  })

  it('route par défaut : S* et passerelle de dernier recours', () => {
    const { lab, c1, r1 } = twoSites()
    c1.lines('conf t', 'ip route 0.0.0.0 0.0.0.0 10.0.12.2', 'end')
    const out = c1.run('show ip route')
    expect(out).toContain('Gateway of last resort is 10.0.12.2 to network 0.0.0.0')
    expect(out).toContain('S*    0.0.0.0/0 [1/0] via 10.0.12.2')
    expect(pingOk(lab.state, r1, '192.168.2.10')).toBe(true)
    c1.lines('conf t', 'no ip route 0.0.0.0 0.0.0.0 10.0.12.2', 'end')
    expect(pingOk(lab.state, r1, '192.168.2.10')).toBe(false)
  })

  it('erreurs : masque incohérent, prochain saut local', () => {
    const { c1 } = twoSites()
    c1.lines('conf t')
    expect(c1.run('ip route 192.168.2.1 255.255.255.0 10.0.12.2')).toEqual(['%Inconsistent address and mask'])
    expect(c1.run('ip route 192.168.2.0 255.255.255.0 10.0.12.1')).toEqual([
      "%Invalid next hop address (it's this router)"
    ])
  })

  it('show ip route : connectées et locales regroupées', () => {
    const { c1 } = twoSites()
    const out = c1.run('show ip route')
    expect(out.slice(-3)).toEqual([
      '      10.0.0.0/8 is variably subnetted, 2 subnets, 2 masks',
      'C        10.0.12.0/30 is directly connected, GigabitEthernet0/0',
      'L        10.0.12.1/32 is directly connected, GigabitEthernet0/0'
    ])
  })
})

describe('OSPF monozone', () => {
  function ospfTriangle() {
    const t = triangle()
    t.c[0].lines('router ospf 1', 'router-id 1.1.1.1', 'network 10.0.0.0 0.255.255.255 area 0', 'end')
    t.c[1].lines('router ospf 1', 'router-id 2.2.2.2', 'network 10.0.0.0 0.255.255.255 area 0', 'end')
    t.c[2].lines('router ospf 1', 'router-id 3.3.3.3', 'network 10.0.0.0 0.255.255.255 area 0', 'end')
    return t
  }

  it('les trois routeurs convergent', () => {
    const { lab, c, ids } = ospfTriangle()
    const out = c[0].run('show ip route')
    expect(
      out.some((l) =>
        /^O {8}10\.0\.23\.0\/30 \[110\/2\] via 10\.0\.1[23]\.2, \d\d:\d\d:\d\d, GigabitEthernet0\/[01]$/.test(
          l
        )
      )
    ).toBe(true)
    expect(pingOk(lab.state, ids[0], '10.0.23.2')).toBe(true)
    const neighbors = c[0].run('show ip ospf neighbor')
    expect(neighbors[1]).toBe('Neighbor ID     Pri   State           Dead Time   Address         Interface')
    expect(neighbors).toContain(
      '2.2.2.2           1   FULL/DR         00:00:35    10.0.12.2       GigabitEthernet0/0'
    )
    expect(neighbors).toContain(
      '3.3.3.3           1   FULL/DR         00:00:35    10.0.13.2       GigabitEthernet0/1'
    )
  })

  it('le voisinage s’annonce (%OSPF-5-ADJCHG)', () => {
    const t = triangle()
    t.c[1].lines('router ospf 1', 'router-id 2.2.2.2', 'network 10.0.12.0 0.0.0.3 area 0', 'end')
    expect(t.c[0].lines('router ospf 1', 'network 10.0.12.0 0.0.0.3 area 0')).toEqual([
      '%OSPF-5-ADJCHG: Process 1, Nbr 2.2.2.2 on GigabitEthernet0/0 from LOADING to FULL, Loading Done'
    ])
  })

  it('couper un lien recalcule les routes', () => {
    const { lab, c, ids } = ospfTriangle()
    const via = () =>
      routingTable(lab.state, lab.state.devices[ids[0]]!).find(
        (r) => r.network === '10.0.23.0' && r.source === 'ospf'
      )
    expect(via()).toBeDefined()
    // R2 coupe son lien vers R1 : 10.0.23.0/30 n'est plus joignable que par R3
    c[1].lines('conf t', 'int g0/0', 'shutdown', 'end')
    expect(via()).toMatchObject({ gateway: '10.0.13.2', metric: 2 })
    expect(routingTable(lab.state, lab.state.devices[ids[0]]!).some((r) => r.network === '10.0.12.0')).toBe(
      false
    )
    expect(pingOk(lab.state, ids[0], '10.0.23.1')).toBe(true)
  })

  it('passive-interface : pas de voisin sur l’interface, réseau annoncé', () => {
    const { c } = ospfTriangle()
    c[0].lines('conf t', 'router ospf 1')
    expect(c[0].run('passive-interface g0/0')).toEqual([
      '%OSPF-5-ADJCHG: Process 1, Nbr 2.2.2.2 on GigabitEthernet0/0 from FULL to DOWN, Neighbor Down: Interface down or detached'
    ])
    c[0].run('end')
    expect(c[0].run('show ip ospf neighbor').some((l) => l.startsWith('2.2.2.2'))).toBe(false)
    // R2 apprend toujours 10.0.12.0/30 ? Connecté chez lui ; R3 l'apprend de R1 (passif) ou R2
    expect(c[2].run('show ip route').some((l) => l.includes('10.0.12.0/30 [110/2]'))).toBe(true)
    const run = c[0].run('show running-config')
    const at = run.indexOf('router ospf 1')
    expect(run.slice(at, at + 4)).toEqual([
      'router ospf 1',
      ' router-id 1.1.1.1',
      ' passive-interface GigabitEthernet0/0',
      ' network 10.0.0.0 0.255.255.255 area 0'
    ])
  })

  it('no router ospf supprime le processus et les routes', () => {
    const { lab, c, ids } = ospfTriangle()
    c[0].lines('conf t', 'no router ospf 1', 'end')
    expect(routingTable(lab.state, lab.state.devices[ids[0]]!).some((r) => r.source === 'ospf')).toBe(false)
    expect(c[0].run('show running-config').includes('router ospf 1')).toBe(false)
  })
})
