/**
 * DNS Windows : suivi d'une délégation NS existante dans une zone (NS + glue A d'un sous-domaine).
 * Un nom sous la délégation est résolu par le serveur indiqué (ici Bind9 sur un poste Linux) au lieu de
 * recevoir un NXDOMAIN autoritatif (audit v2.11.1, M-01).
 */
import {
  addPrimaryZone,
  addRecord,
  installFeatures,
  resolveName,
  setInterfaceIpv4,
  unwrap
} from '@engine/index'
import { describe, expect, it } from 'vitest'
import { buildBindLab, Consoles, INSTALL_BIND, localConf, writeFile, type Command } from '../shell/bind-lab'

const SUB_FILE = '/var/cache/bind/db.sub.lab.local'
const SUB_LINES = [
  '$TTL 604800',
  '@ IN SOA ns1.sub.lab.local. admin.sub.lab.local. (',
  '        1 ; Serial',
  '        604800',
  '        86400',
  '        2419200',
  '        604800 )',
  '@ IN NS ns1.sub.lab.local.',
  'ns1 IN A 192.168.2.10',
  'www IN A 192.168.2.77'
]

function lab(withGlue = true): Consoles {
  const c = new Consoles(buildBindLab())
  const prepare: Command[] = [
    INSTALL_BIND,
    ...writeFile(SUB_FILE, SUB_LINES),
    ...localConf(['zone "sub.lab.local" {', '    type master;', '    file "db.sub.lab.local";', '};']),
    ['srv', 'sudo rndc reload']
  ]
  for (const [who, line, answers] of prepare) c.run(who, line, answers)
  const srv1 = Object.values(c.state.devices).find((d) => d.name === 'SRV1')!
  c.state = unwrap(installFeatures(c.state, srv1.id, ['DNS'], { includeManagementTools: true })).state
  c.state = unwrap(addPrimaryZone(c.state, srv1.id, { name: 'lab.local' })).state
  c.state = unwrap(
    addRecord(c.state, srv1.id, 'lab.local', { name: 'sub', type: 'NS', data: 'ns1.sub.lab.local' })
  ).state
  if (withGlue)
    c.state = unwrap(
      addRecord(c.state, srv1.id, 'lab.local', { name: 'ns1.sub', type: 'A', data: '192.168.2.10' })
    ).state
  const pc1 = Object.values(c.state.devices).find((d) => d.name === 'PC1')!
  c.state = unwrap(
    setInterfaceIpv4(c.state, pc1.id, pc1.interfaces[0]!.id, {
      addressing: 'static',
      address: '192.168.2.30',
      mask: '255.255.255.0',
      gateway: '192.168.2.254',
      dnsServers: ['192.168.2.1']
    })
  ).state
  return c
}

const pcId = (c: Consoles): string => Object.values(c.state.devices).find((d) => d.name === 'PC1')!.id

describe('DNS Windows : délégation NS vers Bind9', () => {
  it('résout un nom de la sous-zone via le serveur délégué (non autoritatif côté Windows)', () => {
    const c = lab()
    const r = resolveName(c.state, pcId(c), 'www.sub.lab.local')
    expect(r.result.kind).toBe('answer')
    if (r.result.kind === 'answer') {
      expect(r.result.records[0]?.data).toBe('192.168.2.77')
      expect(r.result.authoritative).toBe(false)
    }
    expect(c.run('win', 'nslookup www.sub.lab.local')).toContain('192.168.2.77')
  })

  it('un nom inexistant sous la délégation est tranché par le serveur délégué', () => {
    const c = lab()
    expect(c.run('win', 'nslookup nope.sub.lab.local')).toContain('Non-existent domain')
  })

  it('sans glue résoluble, la délégation échoue (SERVFAIL) au lieu d’un NXDOMAIN autoritatif', () => {
    const c = lab(false)
    expect(resolveName(c.state, pcId(c), 'www.sub.lab.local').result.kind).toBe('servfail')
  })

  it('les noms de la zone parente restent autoritatifs', () => {
    const c = lab()
    expect(resolveName(c.state, pcId(c), 'absent.lab.local').result).toMatchObject({
      kind: 'nxdomain',
      authoritative: true
    })
  })
})
