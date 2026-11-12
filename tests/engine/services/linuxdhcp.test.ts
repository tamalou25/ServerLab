/**
 * Comportements publics de services/linuxdhcp : version, lecture de dhcpd.conf, INTERFACESv4, baux
 * (dhcpd.leases) et formatage des erreurs.
 */
import {
  activeLeases,
  dhcpVersion,
  errorLines,
  interfacesV4,
  leaseBlock,
  leaseDate,
  parseDhcpd,
  parseLeases
} from '@engine/services/linuxdhcp'
import { describe, expect, it } from 'vitest'

const noHost = () => null

const CONF = `
authoritative;
default-lease-time 600;
option domain-name "lab.lan";
subnet 192.168.2.0 netmask 255.255.255.0 {
  range 192.168.2.100 192.168.2.150;
  option routers 192.168.2.254;
  option domain-name-servers 192.168.2.1, 192.168.2.2;
}
host pc1 {
  hardware ethernet 00:11:22:33:44:55;
  fixed-address 192.168.2.50;
}
`

describe('linuxdhcp : lecture de dhcpd.conf', () => {
  it('lit sous-réseau, plage, options héritées et réservation', () => {
    const { conf, errors } = parseDhcpd(CONF, noHost)
    expect(errors).toEqual([])
    expect(conf.authoritative).toBe(true)
    expect(conf.global.defaultLease).toBe(600)
    expect(conf.subnets).toHaveLength(1)
    const s = conf.subnets[0]!
    expect(s.network).toBe('192.168.2.0')
    expect(s.prefix).toBe(24)
    expect(s.ranges).toEqual([{ start: '192.168.2.100', end: '192.168.2.150' }])
    expect(s.params.routers).toEqual(['192.168.2.254'])
    expect(s.params.dns).toEqual(['192.168.2.1', '192.168.2.2'])
    expect(s.params.domain).toBe('lab.lan')
    expect(conf.hosts[0]).toMatchObject({ name: 'pc1', fixed: '192.168.2.50' })
  })

  it('signale une erreur de syntaxe avec la ligne fautive et le caret', () => {
    const { errors } = parseDhcpd('authoritative\nsubnet', noHost)
    expect(errors).toHaveLength(1)
    const lines = errorLines('/etc/dhcp/dhcpd.conf', errors[0]!)
    expect(lines[0]).toContain('/etc/dhcp/dhcpd.conf line')
    expect(lines[2]).toMatch(/\^$/)
  })

  it('ignore les commentaires', () => {
    const { conf, errors } = parseDhcpd('# rien\nauthoritative; # fin\n', noHost)
    expect(errors).toEqual([])
    expect(conf.authoritative).toBe(true)
    expect(conf.subnets).toEqual([])
  })
})

describe('linuxdhcp : version et interfaces', () => {
  it('affiche une version sans époque ni révision de paquet', () => {
    expect(dhcpVersion('debian12')).toMatch(/^\d+\.\d+\.\d+/)
    expect(dhcpVersion('debian12')).not.toContain(':')
  })

  it('INTERFACESv4 : dernière affectation non commentée', () => {
    expect(interfacesV4('INTERFACESv4=""\n')).toEqual([])
    expect(interfacesV4('# INTERFACESv4="x"\nINTERFACESv4="eth0 eth1"\n')).toEqual(['eth0', 'eth1'])
    expect(interfacesV4('INTERFACESv4="eth0"\nINTERFACESv4="eth1"')).toEqual(['eth1'])
  })
})

describe('linuxdhcp : baux', () => {
  const base = { ip: '192.168.2.100', starts: 0, ends: 600_000, mac: 'AA-BB-CC-00-11-22', hostname: 'pc2' }

  it('leaseDate suit le format de dhcpd.leases', () => {
    expect(leaseDate(0)).toBe('1 2026/01/05 08:00:00')
    expect(leaseDate(3_723_000)).toBe('1 2026/01/05 09:02:03')
  })

  it("un bloc écrit est relu à l'identique ; le dernier bail d'une adresse gagne", () => {
    const one = parseLeases(leaseBlock({ ...base, state: 'active' }))
    expect(one[0]).toMatchObject({
      starts: 0,
      ends: 600_000,
      hostname: 'pc2',
      state: 'active',
      mac: base.mac
    })

    const text =
      leaseBlock({ ...base, state: 'active' }) + leaseBlock({ ...base, state: 'free', hostname: null })
    expect(leaseBlock({ ...base, state: 'free' })).toContain('hardware ethernet aa:bb:cc:00:11:22;')
    const entries = parseLeases(text)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ state: 'free', hostname: null })
  })

  it('activeLeases ne garde que les baux actifs non expirés', () => {
    const mk = (ip: string, state: 'active' | 'free', ends: number) =>
      parseLeases(leaseBlock({ ip, starts: 0, ends, state, mac: '00-00-00-00-00-01', hostname: null }))[0]!
    const list = [
      mk('10.0.0.1', 'active', 1000),
      mk('10.0.0.2', 'active', 5000),
      mk('10.0.0.3', 'free', 9000)
    ]
    expect(activeLeases(list, 2000).map((l) => l.ip)).toEqual(['10.0.0.2'])
  })

  it('ignore un bail aux dates illisibles', () => {
    expect(parseLeases('lease 10.0.0.9 { starts foo; ends bar; }')).toEqual([])
  })
})
