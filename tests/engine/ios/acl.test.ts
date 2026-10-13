/**
 * Listes d'accès IOS (audit T-04) : évaluation pure d'une liste (première entrée qui correspond,
 * refus implicite, protocole, port, masques génériques) puis effet réel sur un flux HTTP vers IIS.
 */
import { describe, expect, it } from 'vitest'
import { httpGet, installFeatures, ping, unwrap, type LabState } from '@engine/index'
import { aclMatch, aclPermits, type AclPacket } from '@engine/ios/acl'
import type { IosAcl, IosAclEntry } from '@engine/model/schema'
import { add, cable, createLab, setIp } from '../helpers'
import { addIos, IosConsole, type SharedLab } from './helpers'

const ANY = ['0.0.0.0', '255.255.255.255'] as const

function entry(seq: number, action: 'permit' | 'deny', partial: Partial<IosAclEntry> = {}): IosAclEntry {
  return {
    action,
    protocol: 'ip',
    src: ANY[0],
    srcWildcard: ANY[1],
    dst: ANY[0],
    dstWildcard: ANY[1],
    dstPort: null,
    seq,
    ...partial
  }
}

const acl = (...entries: IosAclEntry[]): IosAcl => ({ name: '110', type: 'extended', entries })
const http = (src: string, dst: string): AclPacket => ({ src, dst, protocol: 'tcp', dstPort: 80 })

describe('évaluation d’une liste d’accès', () => {
  it('première entrée qui correspond, puis refus implicite final', () => {
    const list = acl(
      entry(10, 'deny', { src: '192.168.1.10', srcWildcard: '0.0.0.0' }),
      entry(20, 'permit', { src: '192.168.1.0', srcWildcard: '0.0.0.255' })
    )
    expect(aclMatch(list, http('192.168.1.10', '10.0.0.1'))?.seq).toBe(10)
    expect(aclPermits(list, http('192.168.1.10', '10.0.0.1'))).toBe(false)
    expect(aclMatch(list, http('192.168.1.11', '10.0.0.1'))?.seq).toBe(20)
    expect(aclPermits(list, http('192.168.1.11', '10.0.0.1'))).toBe(true)
    // Aucune entrée : refus implicite « deny any »
    expect(aclMatch(list, http('172.16.0.1', '10.0.0.1'))).toBeNull()
    expect(aclPermits(list, http('172.16.0.1', '10.0.0.1'))).toBe(false)
    expect(aclPermits(acl(), http('172.16.0.1', '10.0.0.1'))).toBe(false)
  })

  it('protocole : « ip » couvre tout, « tcp » ni l’ICMP ni l’UDP', () => {
    const tcpOnly = acl(entry(10, 'permit', { protocol: 'tcp' }))
    expect(aclPermits(tcpOnly, http('1.1.1.1', '2.2.2.2'))).toBe(true)
    expect(aclPermits(tcpOnly, { src: '1.1.1.1', dst: '2.2.2.2', protocol: 'icmp' })).toBe(false)
    expect(aclPermits(tcpOnly, { src: '1.1.1.1', dst: '2.2.2.2', protocol: 'udp', dstPort: 53 })).toBe(false)
    const ip = acl(entry(10, 'permit'))
    for (const protocol of ['icmp', 'tcp', 'udp', 'other'] as const)
      expect(aclPermits(ip, { src: '1.1.1.1', dst: '2.2.2.2', protocol })).toBe(true)
  })

  it('port de destination (eq) : seul le port indiqué correspond, un paquet sans port non plus', () => {
    const www = acl(entry(10, 'permit', { protocol: 'tcp', dstPort: 80 }))
    expect(aclPermits(www, http('1.1.1.1', '2.2.2.2'))).toBe(true)
    expect(aclPermits(www, { src: '1.1.1.1', dst: '2.2.2.2', protocol: 'tcp', dstPort: 443 })).toBe(false)
    // Réponse du serveur (port de destination éphémère, non porté) : pas de correspondance, comme sur IOS
    expect(aclPermits(www, { src: '2.2.2.2', dst: '1.1.1.1', protocol: 'tcp' })).toBe(false)
  })

  it('masques génériques : réseau, hôte, any et masque non contigu', () => {
    // 10.0.x.1 pour tout x (octet 3 libre)
    const sparse = acl(entry(10, 'permit', { dst: '10.0.0.1', dstWildcard: '0.0.255.0' }))
    expect(aclPermits(sparse, http('1.1.1.1', '10.0.7.1'))).toBe(true)
    expect(aclPermits(sparse, http('1.1.1.1', '10.0.7.2'))).toBe(false)
    const host = acl(entry(10, 'permit', { dst: '10.0.0.1', dstWildcard: '0.0.0.0' }))
    expect(aclPermits(host, http('1.1.1.1', '10.0.0.1'))).toBe(true)
    expect(aclPermits(host, http('1.1.1.1', '10.0.0.2'))).toBe(false)
  })
})

describe('effet d’une liste d’accès sur le trafic', () => {
  /** PC1 (192.168.1.10) — R1 — SRV1 (192.168.2.10, IIS). */
  function webLab() {
    const r1 = addIos(createLab(), 'c1921')
    const pc1 = add(r1.state, 'client')
    const srv = add(pc1.state, 'server')
    let s = cable(srv.state, pc1.id, 0, r1.id, 0)
    s = cable(s, srv.id, 0, r1.id, 1)
    s = setIp(s, pc1.id, 0, '192.168.1.10/24', '192.168.1.1')
    s = setIp(s, srv.id, 0, '192.168.2.10/24', '192.168.2.1')
    s = unwrap(installFeatures(s, srv.id, ['Web-Server'], { includeManagementTools: true })).state
    const lab: SharedLab = { state: s }
    const c = new IosConsole(lab, r1.id)
    c.lines('en', 'conf t', 'int g0/0', 'ip address 192.168.1.1 255.255.255.0', 'no shut')
    c.lines('int g0/1', 'ip address 192.168.2.1 255.255.255.0', 'no shut', 'end')
    return { lab, c, pc1: pc1.id }
  }
  const web = (s: LabState, pc: string) => httpGet(s, pc, 'http://192.168.2.10').kind
  const pings = (s: LabState, pc: string) => {
    const r = ping(s, pc, '192.168.2.10')
    return r.ok && r.value.success
  }

  it('deny tcp … eq www : HTTP bloqué, ICMP autorisé', () => {
    const { lab, c, pc1 } = webLab()
    expect(web(lab.state, pc1)).toBe('response')
    c.lines(
      'conf t',
      'access-list 110 deny tcp any host 192.168.2.10 eq www',
      'access-list 110 permit ip any any',
      'int g0/0',
      'ip access-group 110 in',
      'end'
    )
    expect(web(lab.state, pc1)).toBe('failure')
    expect(pings(lab.state, pc1)).toBe(true)
  })

  it('permit tcp … eq www seul : HTTP passe, le ping tombe dans le refus implicite', () => {
    const { lab, c, pc1 } = webLab()
    c.lines(
      'conf t',
      'access-list 120 permit tcp any host 192.168.2.10 eq www',
      'int g0/0',
      'ip access-group 120 in',
      'end'
    )
    expect(web(lab.state, pc1)).toBe('response')
    expect(pings(lab.state, pc1)).toBe(false)
  })

  it('port différent (eq 443) : HTTP sur 80 refusé', () => {
    const { lab, c, pc1 } = webLab()
    c.lines(
      'conf t',
      'access-list 130 permit tcp any any eq 443',
      'int g0/0',
      'ip access-group 130 in',
      'end'
    )
    expect(web(lab.state, pc1)).toBe('failure')
  })
})
