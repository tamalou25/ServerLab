/**
 * Labs sains de référence des tests du mode panne : les labs fournis, avec leur solution appliquée.
 */
import {
  addPrimaryZone,
  addRecord,
  buildLabStart,
  installFeatures,
  parseLab,
  setInterfaceIpv4,
  unwrap,
  type LabState
} from '@engine/index'
import lab1 from '../../../labs/lab-01-adressage.json'
import lab3 from '../../../labs/lab-03-dns.json'
import { WINDOWS_BASES } from './bases-windows'

function start(raw: unknown): LabState {
  const parsed = parseLab(raw)
  if (!parsed.ok) throw new Error(parsed.message)
  return buildLabStart(parsed.lab.start)
}

export const idOf = (s: LabState, name: string): string =>
  Object.values(s.devices).find((d) => d.name === name)?.id ?? ''

function ip(s: LabState, device: string, port: string | null, cidr: string, gateway?: string): LabState {
  const d = s.devices[idOf(s, device)]
  const iface = port ? d?.interfaces.find((i) => i.name === port) : d?.interfaces.find((i) => i.l3)
  const [address = '', mask = '24'] = cidr.split('/')
  return unwrap(
    setInterfaceIpv4(s, idOf(s, device), iface?.id ?? '', {
      addressing: 'static',
      address,
      mask,
      gateway: gateway ?? null,
      dnsServers: []
    })
  ).state
}

/** Lab 1 (adressage) résolu : deux réseaux reliés par R1. */
export function healthyLab01(): LabState {
  let s = start(lab1)
  s = ip(s, 'R1', 'Gi0/0', '192.168.10.254/24')
  s = ip(s, 'R1', 'Gi0/1', '192.168.20.254/24')
  s = ip(s, 'PC1', null, '192.168.10.10/24', '192.168.10.254')
  return ip(s, 'PC2', null, '192.168.20.10/24', '192.168.20.254')
}

/** Lab 3 (DNS) résolu : SRV1 sert la zone entreprise.local à PC1. */
export function healthyLab03(): LabState {
  let s = start(lab3)
  const srv = idOf(s, 'SRV1')
  s = unwrap(installFeatures(s, srv, ['DNS'], { includeManagementTools: true })).state
  s = unwrap(addPrimaryZone(s, srv, { name: 'entreprise.local' })).state
  s = unwrap(addPrimaryZone(s, srv, { networkId: '192.168.10.0/24' })).state
  s = unwrap(
    addRecord(s, srv, 'entreprise.local', { name: 'srv1', type: 'A', data: '192.168.10.1', createPtr: true })
  ).state
  s = unwrap(addRecord(s, srv, 'entreprise.local', { name: 'pc1', type: 'A', data: '192.168.10.10' })).state
  return unwrap(
    addRecord(s, srv, 'entreprise.local', { name: 'intranet', type: 'CNAME', data: 'srv1.entreprise.local' })
  ).state
}

export const BASES: { name: string; build: () => LabState }[] = [
  { name: 'lab-01-adressage', build: healthyLab01 },
  { name: 'lab-03-dns', build: healthyLab03 },
  ...WINDOWS_BASES
]
