/**
 * Services du pare-feu pfSense (v2.10, #245) : serveur DHCP par interface, résolveur DNS (Unbound),
 * passerelles, passerelle par défaut et routes statiques.
 */
import { describe, expect, it } from 'vitest'
import {
  addStaticRoute,
  addPfStaticRoute,
  dhcpAcquire,
  dhcpRelease,
  dhcpRenew,
  ping,
  removePfGateway,
  resolveName,
  routingTable,
  setInterfaceIpv4,
  setPfDefaultGateway,
  setPfDhcp,
  setPfDnsResolver,
  setPfDnsServers,
  setPfGateway,
  setPfHostOverride,
  unwrap,
  type LabState
} from '@engine/index'
import { build, cable, setIp } from '../helpers'

/** PC1 (DHCP) — LAN FW1 192.168.1.1/24 ; WAN 45.10.0.1/30 — INTERNET ; DMZ 172.16.0.1/24 — R1 — PC2. */
function topo() {
  const { state, ids } = build([
    ['firewall', 'FW1'],
    ['client', 'PC1'],
    ['cloud', 'INTERNET'],
    ['router', 'R1'],
    ['client', 'PC2']
  ])
  let s = cable(state, ids.INTERNET!, 0, ids.FW1!, 0)
  s = cable(s, ids.PC1!, 0, ids.FW1!, 1)
  s = cable(s, ids.R1!, 0, ids.FW1!, 2)
  s = cable(s, ids.PC2!, 0, ids.R1!, 1)
  s = setIp(s, ids.FW1!, 0, '45.10.0.1/30')
  s = setIp(s, ids.FW1!, 2, '172.16.0.1/24')
  s = setIp(s, ids.INTERNET!, 0, '45.10.0.2/30')
  s = setIp(s, ids.R1!, 0, '172.16.0.2/24')
  s = setIp(s, ids.R1!, 1, '10.9.0.1/24')
  s = setIp(s, ids.PC2!, 0, '10.9.0.10/24', '10.9.0.1')
  s = unwrap(addStaticRoute(s, ids.R1!, { network: '0.0.0.0', mask: '0', nextHop: '172.16.0.1' })).state
  // PC1 en DHCP
  const iface = s.devices[ids.PC1!]!.interfaces[0]!
  s = unwrap(
    setInterfaceIpv4(s, ids.PC1!, iface.id, {
      addressing: 'dhcp',
      address: '',
      mask: '24',
      gateway: null,
      dnsServers: []
    })
  ).state
  return { s, ids }
}

const nic = (s: LabState, id: string) => s.devices[id]!.interfaces[0]!.id

const dhcpOn = (s: LabState, fw: string) =>
  unwrap(setPfDhcp(s, fw, 'lan', { enabled: true, rangeFrom: '192.168.1.100', rangeTo: '192.168.1.110' }))
    .state

const withLease = (s: LabState, ids: Record<string, string>) =>
  dhcpAcquire(dhcpOn(s, ids.FW1!), ids.PC1!, nic(s, ids.PC1!)).state

const doPing = (s: LabState, from: string, to: string) => {
  const r = ping(s, from, to, { count: 1 })
  if (!r.ok) throw new Error(r.error.message)
  return r.value
}

describe('serveur DHCP du pare-feu', () => {
  it('le LAN obtient un bail avec passerelle et DNS du pare-feu', () => {
    const { s, ids } = topo()
    const op = dhcpAcquire(dhcpOn(s, ids.FW1!), ids.PC1!, nic(s, ids.PC1!))
    expect(op.outcome).toBe('bound')
    expect(op.address).toBe('192.168.1.100')
    const lease = op.state.devices[ids.PC1!]!.interfaces[0]!.dhcpLease!
    expect(lease.gateway).toBe('192.168.1.1')
    expect(lease.dnsServers).toEqual(['192.168.1.1'])
    const fw = op.state.devices[ids.FW1!]!
    if (fw.kind !== 'firewall') throw new Error('pare-feu attendu')
    expect(fw.pf.dhcp.lan!.leases.map((l) => l.ip)).toEqual(['192.168.1.100'])
  })

  it('sans serveur activé, aucun bail ; renouvellement et libération mettent à jour les baux', () => {
    const { s, ids } = topo()
    const id = nic(s, ids.PC1!)
    expect(dhcpAcquire(s, ids.PC1!, id).outcome).toBe('failed')
    const bound = dhcpAcquire(dhcpOn(s, ids.FW1!), ids.PC1!, id)
    const renewed = dhcpRenew(bound.state, ids.PC1!, id)
    expect(renewed.outcome).toBe('renewed')
    const released = dhcpRelease(renewed.state, ids.PC1!, id)
    const fw = released.state.devices[ids.FW1!]!
    if (fw.kind !== 'firewall') throw new Error('pare-feu attendu')
    expect(fw.pf.dhcp.lan!.leases).toEqual([])
  })

  it('refuse une plage hors du sous-réseau ou contenant l’adresse du pare-feu', () => {
    const { s, ids } = topo()
    const bad = setPfDhcp(s, ids.FW1!, 'lan', { enabled: true, rangeFrom: '10.0.0.5', rangeTo: '10.0.0.9' })
    expect(bad.ok).toBe(false)
    const own = setPfDhcp(s, ids.FW1!, 'lan', {
      enabled: true,
      rangeFrom: '192.168.1.1',
      rangeTo: '192.168.1.9'
    })
    expect(own.ok).toBe(false)
    expect(setPfDhcp(s, ids.FW1!, 'wan', { enabled: true }).ok).toBe(false)
  })
})

describe('résolveur DNS Unbound', () => {
  it('résout un Host Override puis un nom public pour un client LAN', () => {
    const { s, ids } = topo()
    let st = withLease(s, ids)
    st = unwrap(setPfGateway(st, ids.FW1!, { name: 'WAN_GW', iface: 'wan', address: '45.10.0.2' })).state
    st = unwrap(
      setPfHostOverride(st, ids.FW1!, { host: 'nas', domain: 'lab.local', address: '192.168.1.50' })
    ).state
    const local = resolveName(st, ids.PC1!, 'nas.lab.local')
    expect(local.result.kind).toBe('answer')
    expect(local.server).toBe('192.168.1.1')
    expect(resolveName(st, ids.PC1!, 'www.example.com').result.kind).toBe('answer')
  })

  it('en redirection : utilise les DNS généraux ; désactivé : plus de réponse', () => {
    const { s, ids } = topo()
    let st = withLease(s, ids)
    st = unwrap(setPfGateway(st, ids.FW1!, { name: 'WAN_GW', iface: 'wan', address: '45.10.0.2' })).state
    st = unwrap(setPfDnsResolver(st, ids.FW1!, { forwarding: true })).state
    expect(resolveName(st, ids.PC1!, 'www.example.com').result.kind).toBe('servfail')
    st = unwrap(setPfDnsServers(st, ids.FW1!, ['8.8.8.8'])).state
    expect(resolveName(st, ids.PC1!, 'www.example.com').result.kind).toBe('answer')
    st = unwrap(setPfDnsResolver(st, ids.FW1!, { enabled: false })).state
    expect(resolveName(st, ids.PC1!, 'www.example.com').result.kind).toBe('timeout')
  })
})

describe('passerelles et routes statiques', () => {
  it('route vers le WAN via la passerelle par défaut', () => {
    const { s, ids } = topo()
    let st = unwrap(setPfGateway(s, ids.FW1!, { name: 'WAN_GW', iface: 'wan', address: '45.10.0.2' })).state
    const fw = st.devices[ids.FW1!]!
    expect(routingTable(st, fw).find((r) => r.prefixLength === 0)?.gateway).toBe('45.10.0.2')
    st = withLease(st, ids)
    expect(doPing(st, ids.PC1!, '93.184.215.14').success).toBe(true)
  })

  it('sans passerelle, l’hôte public n’est pas joignable', () => {
    const { s, ids } = topo()
    expect(doPing(withLease(s, ids), ids.PC1!, '93.184.215.14').success).toBe(false)
  })

  it('route statique vers un réseau derrière R1', () => {
    const { s, ids } = topo()
    let st = withLease(s, ids)
    st = unwrap(
      setPfGateway(st, ids.FW1!, { name: 'DMZ_R1', iface: 'opt1', address: '172.16.0.2', isDefault: false })
    ).state
    expect(doPing(st, ids.PC1!, '10.9.0.10').success).toBe(false)
    st = unwrap(
      addPfStaticRoute(st, ids.FW1!, { network: '10.9.0.0', prefixLength: 24, gateway: 'DMZ_R1' })
    ).state
    expect(doPing(st, ids.PC1!, '10.9.0.10').success).toBe(true)
  })

  it('erreurs métier en français', () => {
    const { s, ids } = topo()
    const offLink = setPfGateway(s, ids.FW1!, { name: 'X', iface: 'wan', address: '10.1.1.1' })
    expect(!offLink.ok && offLink.error.message).toContain('n’est pas dans le sous-réseau')
    const noGw = addPfStaticRoute(s, ids.FW1!, { network: '10.9.0.0', prefixLength: 24, gateway: 'Z' })
    expect(!noGw.ok && noGw.error.code).toBe('GatewayNotFound')
    let st = unwrap(setPfGateway(s, ids.FW1!, { name: 'G', iface: 'opt1', address: '172.16.0.2' })).state
    st = unwrap(addPfStaticRoute(st, ids.FW1!, { network: '10.9.0.0', prefixLength: 24, gateway: 'G' })).state
    const used = removePfGateway(st, ids.FW1!, 'G')
    expect(!used.ok && used.error.code).toBe('GatewayInUse')
    expect(setPfDefaultGateway(st, ids.FW1!, 'G').ok).toBe(true)
  })
})
