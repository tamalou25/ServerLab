/**
 * isc-dhcp-server sur serveur Linux (v2.9, #240) : démarrage conditionné par dhcpd.conf et INTERFACESv4,
 * configuration en vigueur, baux réellement attribués aux clients simulés (Linux et Windows) et écrits dans
 * dhcpd.leases, journal de dhcpd, réservations, renouvellement, libération, conflit avec un autre serveur DHCP.
 */
import {
  dhcpAcquire,
  dhcpRelease,
  dhcpRenew,
  installFeatures,
  addScope,
  setInterfaceIpv4,
  unwrap,
  type LabState
} from '@engine/index'
import { describe, expect, it } from 'vitest'
import {
  buildBindLab,
  CONF_DEFAULTS,
  Consoles,
  DHCP_READY,
  DHCPD_LINES,
  INSTALL_DHCP,
  writeFile,
  type Command
} from './bind-lab'

function ready(prepare: Command[] = DHCP_READY): Consoles {
  const c = new Consoles(buildBindLab())
  for (const [who, line, answers] of prepare) c.run(who, line, answers)
  return c
}

const device = (c: Consoles, name: string) => Object.values(c.state.devices).find((d) => d.name === name)!
const lease = (c: Consoles, name: string) => {
  const d = device(c, name)
  return d.kind === 'client' || d.kind === 'server' ? d.interfaces[0]!.dhcpLease : null
}

/** PC1 (Windows) en DHCP, sans adresse. */
function winDhcp(c: Consoles) {
  const pc1 = device(c, 'PC1')
  c.state = unwrap(
    setInterfaceIpv4(c.state, pc1.id, pc1.interfaces[0]!.id, {
      addressing: 'dhcp',
      address: '',
      mask: '',
      gateway: null,
      dnsServers: []
    })
  ).state
}

describe('isc-dhcp-server : démarrage', () => {
  it('apt install démarre le paquet mais dhcpd refuse : INTERFACESv4 vide et dhcpd.conf d’exemple', () => {
    const c = ready([INSTALL_DHCP])
    expect(c.run('srv', 'systemctl is-active isc-dhcp-server')).toBe('failed')
    const journal = c.run('srv', 'sudo journalctl -u isc-dhcp-server --no-pager')
    expect(journal).toContain('Failed to start isc-dhcp-server.service')
    // dhcpd -t signale les noms inconnus de l’exemple fourni
    expect(c.run('srv', 'sudo dhcpd -t')).toContain('ns1.example.org: host unknown.')
  })

  it('INTERFACESv4 ne désignant aucun sous-réseau déclaré : « No subnet declaration »', () => {
    const c = ready([
      INSTALL_DHCP,
      ...writeFile('/etc/default/isc-dhcp-server', [CONF_DEFAULTS]),
      ...writeFile('/etc/dhcp/dhcpd.conf', ['default-lease-time 600;'])
    ])
    expect(c.run('srv', 'sudo systemctl restart isc-dhcp-server')).toContain(
      'Job for isc-dhcp-server.service failed'
    )
    const journal = c.run('srv', 'sudo journalctl -u isc-dhcp-server --no-pager')
    expect(journal).toContain('No subnet declaration for eth0 (192.168.2.10).')
    expect(journal).toContain('Not configured to listen on any interfaces!')
  })

  it('une erreur de syntaxe empêche le démarrage, la correction le permet', () => {
    const c = ready([
      INSTALL_DHCP,
      ...writeFile('/etc/default/isc-dhcp-server', [CONF_DEFAULTS]),
      ...writeFile('/etc/dhcp/dhcpd.conf', ['default-lease-time 600', 'authoritative;'])
    ])
    c.run('srv', 'sudo systemctl restart isc-dhcp-server')
    expect(c.run('srv', 'systemctl is-active isc-dhcp-server')).toBe('failed')
    expect(c.run('srv', 'sudo journalctl -u isc-dhcp-server --no-pager')).toContain('semicolon expected.')
    for (const [who, line, a] of writeFile('/etc/dhcp/dhcpd.conf', DHCPD_LINES)) c.run(who, line, a)
    expect(c.run('srv', 'sudo systemctl restart isc-dhcp-server')).toBe('')
    expect(c.run('srv', 'systemctl is-active isc-dhcp-server')).toBe('active')
  })

  it('dhcpd lancé à la main, ou avec une option inconnue, n’est pas simulé', () => {
    const c = ready()
    expect(c.run('srv', 'sudo dhcpd')).toContain('n’est pas simulé')
    expect(c.run('srv', 'sudo dhcpd -x')).toContain('n’est pas simulée')
    expect(c.run('srv', 'sudo dhcp-lease-list')).toContain('non simulée')
  })
})

describe('isc-dhcp-server : baux distribués aux clients', () => {
  it('le poste Linux obtient un bail avec passerelle, DNS et domaine, écrit dans dhcpd.leases', () => {
    const c = ready()
    c.run('pc', 'sudo dhclient eth0')
    expect(lease(c, 'LNX1')).toMatchObject({
      address: '192.168.2.100',
      prefixLength: 24,
      gateway: '192.168.2.254',
      dnsServers: ['192.168.2.10'],
      dnsSuffix: 'lab.lan',
      expiresAt: expect.any(Number)
    })
    const leases = c.run('srv', 'cat /var/lib/dhcp/dhcpd.leases')
    expect(leases).toContain('lease 192.168.2.100 {')
    expect(leases).toContain('binding state active;')
    expect(leases).toContain('client-hostname "LNX1";')
    // default-lease-time 600
    const l = lease(c, 'LNX1')!
    expect(l.expiresAt - l.obtainedAt).toBeGreaterThan(590_000)
    expect(l.expiresAt - l.obtainedAt).toBeLessThanOrEqual(600_000)
  })

  it('un poste Windows passe par ipconfig /renew et reçoit l’adresse suivante', () => {
    const c = ready()
    c.run('pc', 'sudo dhclient eth0')
    winDhcp(c)
    c.run('win', 'ipconfig /renew')
    expect(lease(c, 'PC1')).toMatchObject({ address: '192.168.2.101', gateway: '192.168.2.254' })
    expect(c.run('win', 'ipconfig /all')).toContain('192.168.2.101')
    expect(c.run('srv', 'cat /var/lib/dhcp/dhcpd.leases').match(/^lease /gm)).toHaveLength(2)
  })

  it('le journal de dhcpd reprend DHCPDISCOVER, DHCPOFFER, DHCPREQUEST et DHCPACK', () => {
    const c = ready()
    c.run('pc', 'sudo dhclient eth0')
    const journal = c.run('srv', 'sudo journalctl -u isc-dhcp-server --no-pager')
    const mac = device(c, 'LNX1').interfaces[0]!.mac.toLowerCase().replace(/-/g, ':')
    expect(journal).toContain(`DHCPDISCOVER from ${mac} via eth0`)
    expect(journal).toContain(`DHCPOFFER on 192.168.2.100 to ${mac} (LNX1) via eth0`)
    expect(journal).toContain(`DHCPREQUEST for 192.168.2.100 (192.168.2.10) from ${mac} (LNX1) via eth0`)
    expect(journal).toContain(`DHCPACK on 192.168.2.100 to ${mac} (LNX1) via eth0`)
  })

  it('une réservation (host / hardware ethernet / fixed-address) donne toujours la même adresse', () => {
    const c = ready()
    const mac = device(c, 'LNX1').interfaces[0]!.mac.toLowerCase().replace(/-/g, ':')
    for (const [who, line, a] of writeFile('/etc/dhcp/dhcpd.conf', [
      ...DHCPD_LINES,
      'host lnx1 {',
      `  hardware ethernet ${mac};`,
      '  fixed-address 192.168.2.105;',
      '}'
    ]))
      c.run(who, line, a)
    c.run('srv', 'sudo systemctl restart isc-dhcp-server')
    c.run('pc', 'sudo dhclient eth0')
    expect(lease(c, 'LNX1')?.address).toBe('192.168.2.105')
  })

  it('dhcpd.conf n’est relu qu’au redémarrage', () => {
    const c = ready()
    for (const [who, line, a] of writeFile('/etc/dhcp/dhcpd.conf', [
      ...DHCPD_LINES.slice(0, 4),
      '  range 192.168.2.150 192.168.2.160;',
      '  option routers 192.168.2.254;',
      '}'
    ]))
      c.run(who, line, a)
    c.run('pc', 'sudo dhclient eth0')
    expect(lease(c, 'LNX1')?.address).toBe('192.168.2.100')
    c.run('pc', 'sudo dhclient -r eth0')
    c.run('srv', 'sudo systemctl restart isc-dhcp-server')
    c.run('pc', 'sudo dhclient eth0')
    expect(lease(c, 'LNX1')?.address).toBe('192.168.2.150')
  })

  it('les baux survivent au redémarrage du service (dhcpd.leases) et la plage épuisée refuse', () => {
    const c = ready([
      ...DHCP_READY.slice(0, 2),
      ...writeFile('/etc/dhcp/dhcpd.conf', [
        'subnet 192.168.2.0 netmask 255.255.255.0 {',
        '  range 192.168.2.100;',
        '}'
      ]),
      ['srv', 'sudo systemctl restart isc-dhcp-server']
    ])
    c.run('pc', 'sudo dhclient eth0')
    expect(lease(c, 'LNX1')?.address).toBe('192.168.2.100')
    c.run('srv', 'sudo systemctl restart isc-dhcp-server')
    winDhcp(c)
    c.run('win', 'ipconfig /renew')
    expect(lease(c, 'PC1')).toBeNull()
  })

  it('le service arrêté ne distribue plus rien', () => {
    const c = ready()
    c.run('srv', 'sudo systemctl stop isc-dhcp-server')
    c.run('pc', 'sudo dhclient eth0')
    expect(lease(c, 'LNX1')).toBeNull()
  })
})

describe('isc-dhcp-server : renouvellement, libération, conflit', () => {
  it('le renouvellement réécrit le bail, la libération le passe à « free »', () => {
    const c = ready()
    c.run('pc', 'sudo dhclient eth0')
    const lnx = device(c, 'LNX1')
    const iface = lnx.interfaces[0]!.id
    c.state = dhcpRenew(c.state, lnx.id, iface).state
    expect(c.run('srv', 'cat /var/lib/dhcp/dhcpd.leases').match(/^lease 192\.168\.2\.100 \{/gm)).toHaveLength(
      2
    )
    c.state = dhcpRelease(c.state, lnx.id, iface).state
    const leases = c.run('srv', 'cat /var/lib/dhcp/dhcpd.leases')
    expect(leases.trimEnd().endsWith('}')).toBe(true)
    expect(leases.lastIndexOf('binding state free;')).toBeGreaterThan(
      leases.lastIndexOf('binding state active;')
    )
    expect(c.run('srv', 'sudo journalctl -u isc-dhcp-server --no-pager')).toContain(
      'DHCPRELEASE of 192.168.2.100'
    )
    // l’adresse libérée est réattribuée
    c.state = dhcpAcquire(c.state, lnx.id, iface).state
    expect(lease(c, 'LNX1')?.address).toBe('192.168.2.100')
  })

  it('un second serveur DHCP (Windows) sur le même réseau : le client retient la première offre', () => {
    const c = ready()
    const srv1 = device(c, 'SRV1')
    let s: LabState = unwrap(
      installFeatures(c.state, srv1.id, ['DHCP'], { includeManagementTools: true })
    ).state
    s = unwrap(
      addScope(s, srv1.id, {
        name: 'LAN',
        start: '192.168.2.200',
        end: '192.168.2.210',
        mask: '255.255.255.0'
      })
    ).state
    c.state = s
    const lnx = device(c, 'LNX1')
    c.state = unwrap(
      setInterfaceIpv4(c.state, lnx.id, lnx.interfaces[0]!.id, {
        addressing: 'dhcp',
        address: '',
        mask: '',
        gateway: null,
        dnsServers: []
      })
    ).state
    const op = dhcpAcquire(c.state, lnx.id, lnx.interfaces[0]!.id)
    expect(op.outcome).toBe('bound')
    const notes = op.trace.events.map((e) => e.note ?? '').join('\n')
    expect(notes).toContain('retiendra la première offre')
    const address = op.address ?? ''
    expect(['192.168.2.100', '192.168.2.200']).toContain(address)
  })
})
