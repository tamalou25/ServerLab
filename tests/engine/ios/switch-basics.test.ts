/**
 * Switch 2960 (lot 5a) : ip default-gateway, show interfaces vlan / status / switchport, table
 * d'adresses MAC apprise par les trames simulées, CDP calculé depuis les câbles.
 *
 * Sources :
 * - https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/15-0_2_se/command/reference/cr2960/cli2.html
 *   (show interfaces status, show interfaces switchport, show mac address-table [dynamic])
 * - https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/15-0_2_se/configuration/guide/scg2960/swipaddr.html
 *   (ip default-gateway)
 * - https://www.cisco.com/c/en/us/support/docs/switches/catalyst-6500-series-switches/12027-53.html
 *   (colonnes de show interfaces status, Access Mode VLAN « ((Inactive)) », Negotiation of Trunking: Off)
 * - https://www.cisco.com/c/en/us/support/docs/network-management/discovery-protocol-cdp/43485-cdponios43485.html
 *   (show cdp neighbors, « % CDP is not enabled »)
 * - https://www.cisco.com/c/en/us/support/docs/switches/catalyst-6000-series-switches/41263-catmac-41263.html
 *   (Hardware is EtherSVI)
 */
import { describe, expect, it } from 'vitest'
import { applyStatePatches, command, dispatch, routingTable, type LabState } from '@engine/index'
import { cable, createLab } from '../helpers'
import { addIos, IosConsole, type SharedLab } from './helpers'

/** R1 (Gi0/0) — Fa0/1 SW1 Fa0/2 — (Gi0/0) R2, réseau 10.0.0.0/24. */
function lab() {
  const r1 = addIos(createLab(), 'c1921', 'R1')
  const r2 = addIos(r1.state, 'c1921', 'R2')
  const sw = addIos(r2.state, 'c2960', 'SW1')
  let s: LabState = cable(sw.state, r1.id, 0, sw.id, 0)
  s = cable(s, r2.id, 0, sw.id, 1)
  const shared: SharedLab = { state: s }
  const router = (id: string, ip: string) => {
    const c = new IosConsole(shared, id)
    c.lines('en', 'conf t', 'int g0/0', `ip address ${ip} 255.255.255.0`, 'no shut', 'end')
    return c
  }
  const c1 = router(r1.id, '10.0.0.1')
  const c2 = router(r2.id, '10.0.0.2')
  const c = new IosConsole(shared, sw.id)
  c.lines('en')
  return { shared, sw: c, r1: c1, r2: c2, swId: sw.id }
}

describe('ip default-gateway', () => {
  it('enregistré dans la running-config et route par défaut via l’interface VLAN', () => {
    const { sw, swId } = lab()
    sw.lines('conf t', 'int vlan 1', 'ip address 10.0.0.10 255.255.255.0', 'no shut', 'exit')
    expect(sw.run('ip default-gateway 10.0.0.1')).toEqual([])
    const run = sw.run('do show running-config')
    expect(run).toContain('ip default-gateway 10.0.0.1')
    const route = routingTable(sw.state, sw.state.devices[swId]!).find((r) => r.prefixLength === 0)
    expect(route?.gateway).toBe('10.0.0.1')
    sw.run('no ip default-gateway')
    expect(sw.run('do show running-config')).not.toContain('ip default-gateway 10.0.0.1')
  })

  it('absente sur un routeur ; commande de configuration globale seulement', () => {
    const { r1, sw } = lab()
    r1.lines('conf t')
    expect(r1.run('ip default-gateway 10.0.0.254')[1]).toBe("% Invalid input detected at '^' marker.")
    // Mode privilégié : premier mot inconnu traité comme un nom d'hôte, comme sur IOS
    expect(sw.run('ip default-gateway 10.0.0.1').at(-1)).toBe(
      '% Unknown command or computer name, or unable to find computer address'
    )
  })

  it('annuler/rétablir par les patches de la commande shell.exec', () => {
    const { sw, swId } = lab()
    sw.lines('conf t')
    const before = sw.state
    const r = dispatch(before, command('shell.exec', sw.session, 'ip default-gateway 10.0.0.1', []))
    if (!r.ok || !r.entry) throw new Error('shell.exec')
    const gw = (s: LabState) => (s.devices[swId]! as { ios?: { defaultGateway: string | null } }).ios
    expect(gw(r.state)?.defaultGateway).toBe('10.0.0.1')
    const undone = applyStatePatches(r.state, r.entry.inversePatches)
    expect(gw(undone)?.defaultGateway ?? null).toBeNull()
    expect(gw(applyStatePatches(undone, r.entry.patches))?.defaultGateway).toBe('10.0.0.1')
  })
})

describe('show interfaces vlan, status, switchport', () => {
  it('show interfaces vlan 1 : EtherSVI, état calculé', () => {
    const { sw } = lab()
    sw.lines('conf t', 'int vlan 1', 'ip address 10.0.0.10 255.255.255.0', 'no shut', 'end')
    const out = sw.run('show interfaces vlan 1')
    expect(out[0]).toBe('Vlan1 is up, line protocol is up')
    expect(out[1]).toMatch(/^ {2}Hardware is EtherSVI, address is [0-9a-f.]+ \(bia [0-9a-f.]+\)$/)
    expect(out[2]).toBe('  Internet address is 10.0.0.10/24')
  })

  it('show interfaces status : connected / notconnect / disabled, VLAN, trunk', () => {
    const { sw } = lab()
    sw.lines(
      'conf t',
      'vlan 10',
      'int fa0/2',
      'switchport mode trunk',
      'int fa0/3',
      'switchport access vlan 10'
    )
    sw.lines('int fa0/4', 'shutdown', 'int fa0/1', 'description Vers R1', 'end')
    const out = sw.run('show interfaces status')
    expect(out[1]).toBe('Port    Name               Status       Vlan       Duplex  Speed Type')
    expect(out[2]).toBe('Fa0/1   Vers R1            connected    1          a-full  a-100 10/100BaseTX')
    expect(out[3]).toBe('Fa0/2                      connected    trunk      a-full  a-100 10/100BaseTX')
    expect(out[4]).toBe('Fa0/3                      notconnect   10           auto   auto 10/100BaseTX')
    expect(out[5]).toBe('Fa0/4                      disabled     1            auto   auto 10/100BaseTX')
    expect(out.at(-1)).toBe(
      'Gi0/2                      notconnect   1            auto   auto 10/100/1000BaseTX'
    )
  })

  it('show interfaces fa0/3 switchport : mode et VLAN d’accès', () => {
    const { sw } = lab()
    sw.lines('conf t', 'int fa0/3', 'switchport access vlan 30', 'end')
    const out = sw.run('show interfaces fa0/3 switchport')
    expect(out.slice(0, 9)).toEqual([
      'Name: Fa0/3',
      'Switchport: Enabled',
      'Administrative Mode: static access',
      'Operational Mode: down',
      'Administrative Trunking Encapsulation: dot1q',
      'Operational Trunking Encapsulation: native',
      'Negotiation of Trunking: Off',
      'Access Mode VLAN: 30 (VLAN0030)',
      'Trunking Native Mode VLAN: 1 (default)'
    ])
    expect(out).toContain('Trunking VLANs Enabled: ALL')
  })

  it('trunk actif : Operational Mode trunk, liste autorisée', () => {
    const { sw } = lab()
    sw.lines('conf t', 'int fa0/2', 'switchport mode trunk', 'switchport trunk allowed vlan 1,10-12', 'end')
    const out = sw.run('show interfaces fa0/2 switchport')
    expect(out[3]).toBe('Operational Mode: trunk')
    expect(out[6]).toBe('Negotiation of Trunking: On')
    expect(out).toContain('Trunking VLANs Enabled: 1,10-12')
  })

  it('commandes de switch absentes du routeur', () => {
    const { r1 } = lab()
    expect(r1.run('show interfaces status')[1]).toBe("% Invalid input detected at '^' marker.")
  })
})

describe('show mac address-table', () => {
  it('vide avant tout trafic ; adresses apprises par un ping à travers le switch', () => {
    const { sw, r1 } = lab()
    expect(sw.run('show mac address-table dynamic')).toEqual([
      '          Mac Address Table',
      '-------------------------------------------',
      '',
      'Vlan    Mac Address       Type        Ports',
      '----    -----------       --------    -----',
      'Total Mac Addresses for this criterion: 0'
    ])
    r1.run('ping 10.0.0.2')
    const out = sw.run('show mac address-table dynamic')
    const rows = out.filter((l) => l.includes('DYNAMIC'))
    expect(rows).toHaveLength(2)
    expect(rows.map((l) => l.trim().split(/\s+/)[3]).sort()).toEqual(['Fa0/1', 'Fa0/2'])
    expect(rows[0]).toMatch(/^ {3}1 {4}[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4} {4}DYNAMIC {5}Fa0\/\d$/)
    expect(out.at(-1)).toBe('Total Mac Addresses for this criterion: 2')
  })

  it('table complète : entrées STATIC CPU puis dynamiques ; clear vide les dynamiques', () => {
    const { sw, r1 } = lab()
    r1.run('ping 10.0.0.2')
    const out = sw.run('show mac address-table')
    expect(out[5]).toBe(' All    0000.0000.0001    STATIC      CPU')
    expect(out.at(-1)).toBe('Total Mac Addresses for this criterion: 13')
    sw.run('clear mac address-table dynamic')
    expect(sw.run('show mac address-table dynamic').at(-1)).toBe('Total Mac Addresses for this criterion: 0')
  })

  it('VLAN de la trame : port d’accès dans le VLAN 10', () => {
    const { sw, r1 } = lab()
    sw.lines('conf t', 'int range fa0/1 - 2', 'switchport access vlan 10', 'end')
    r1.run('ping 10.0.0.2')
    const rows = sw.run('show mac address-table dynamic').filter((l) => l.includes('DYNAMIC'))
    expect(rows.every((l) => l.startsWith('  10    '))).toBe(true)
  })

  it('port coupé : ses adresses ne sont plus affichées', () => {
    const { sw, r1 } = lab()
    r1.run('ping 10.0.0.2')
    sw.lines('conf t', 'int fa0/2', 'shutdown', 'end')
    const rows = sw.run('show mac address-table dynamic').filter((l) => l.includes('DYNAMIC'))
    expect(rows).toHaveLength(1)
  })
})

describe('CDP', () => {
  it('show cdp neighbors : voisins calculés depuis les câbles', () => {
    const { sw, r1 } = lab()
    const out = sw.run('show cdp neighbors')
    expect(out.slice(0, 4)).toEqual([
      'Capability Codes: R - Router, T - Trans Bridge, B - Source Route Bridge',
      '                  S - Switch, H - Host, I - IGMP, r - Repeater',
      '',
      'Device ID        Local Intrfce     Holdtme    Capability  Platform  Port ID'
    ])
    expect(out[4]).toBe('R1               Fas 0/1            180    R B S I        CISCO1921 Gig 0/0')
    expect(out[5]).toMatch(/^R2 {15}Fas 0\/2/)
    const fromRouter = r1.run('show cdp neighbors')
    expect(fromRouter[4]).toBe('SW1              Gig 0/0            180        S I        WS-C2960- Fas 0/1')
  })

  it('show cdp neighbors detail : adresse, plateforme, interfaces', () => {
    const { sw } = lab()
    const out = sw.run('show cdp neighbors detail')
    expect(out.slice(0, 8)).toEqual([
      '-------------------------',
      'Device ID: R1',
      'Entry address(es): ',
      '  IP address: 10.0.0.1',
      'Platform: cisco CISCO1921/K9,  Capabilities: Router Source-Route-Bridge Switch IGMP ',
      'Interface: FastEthernet0/1,  Port ID (outgoing port): GigabitEthernet0/0',
      'Holdtime : 180 sec',
      ''
    ])
  })

  it('no cdp run : « % CDP is not enabled », plus annoncé aux voisins', () => {
    const { sw, r1 } = lab()
    sw.lines('conf t', 'no cdp run', 'end')
    expect(sw.run('show cdp neighbors')).toEqual(['% CDP is not enabled'])
    expect(sw.run('show running-config')).toContain('no cdp run')
    expect(r1.run('show cdp neighbors')).toHaveLength(4)
    sw.lines('conf t', 'cdp run', 'end')
    expect(r1.run('show cdp neighbors')).toHaveLength(5)
  })

  it('câble débranché ou port coupé : voisin absent', () => {
    const { sw } = lab()
    sw.lines('conf t', 'int fa0/1', 'shutdown', 'end')
    const out = sw.run('show cdp neighbors')
    expect(out).toHaveLength(5)
    expect(out[4]).toMatch(/^R2 /)
  })
})
