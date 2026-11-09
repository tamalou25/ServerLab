/**
 * Zones réseau du plan : un réseau IPv4 par zone, calculé depuis les adresses effectives ;
 * routeurs jamais membres (passerelles), switch membre seulement s'il sert un seul réseau,
 * VLAN affiché seulement s'il est unique. Regroupement descriptif, mémoïsé sur le réseau.
 */
import { describe, expect, it } from 'vitest'
import { moveDevice, networkZones, setSwitchport, unwrap, type LabState } from '@engine/index'
import { build, cable, setIp } from '../helpers'

function twoNetworks() {
  const { state, ids } = build([
    ['client', 'PC1'],
    ['client', 'PC2'],
    ['server', 'SRV1'],
    ['switch', 'SW1'],
    ['switch', 'SW2'],
    ['router', 'R1']
  ])
  let s = cable(state, ids.PC1!, 0, ids.SW1!, 0)
  s = cable(s, ids.PC2!, 0, ids.SW1!, 1)
  s = cable(s, ids.SRV1!, 0, ids.SW2!, 0)
  s = cable(s, ids.SW1!, 2, ids.R1!, 0)
  s = cable(s, ids.SW2!, 2, ids.R1!, 1)
  s = setIp(s, ids.PC1!, 0, '192.168.10.10/24', '192.168.10.254')
  s = setIp(s, ids.PC2!, 0, '192.168.10.11/24', '192.168.10.254')
  s = setIp(s, ids.SRV1!, 0, '192.168.20.10/24', '192.168.20.254')
  s = setIp(s, ids.R1!, 0, '192.168.10.254/24')
  s = setIp(s, ids.R1!, 1, '192.168.20.254/24')
  return { s, ids }
}

describe('networkZones', () => {
  it('une zone par réseau IPv4, hôtes et switch membres, routeur en passerelle', () => {
    const { s, ids } = twoNetworks()
    const zones = networkZones(s)
    expect(zones.map((z) => z.cidr)).toEqual(['192.168.10.0/24', '192.168.20.0/24'])
    const lan = zones[0]!
    expect(new Set(lan.deviceIds)).toEqual(new Set([ids.PC1, ids.PC2, ids.SW1]))
    expect(lan.deviceIds).not.toContain(ids.R1)
    expect(lan.gateways).toEqual([
      { deviceId: ids.R1, deviceName: 'R1', ifaceName: expect.any(String), address: '192.168.10.254' }
    ])
    expect(new Set(zones[1]!.deviceIds)).toEqual(new Set([ids.SRV1, ids.SW2]))
  })

  it('un masque erroné place l’hôte hors zone ; une adresse APIPA ou un hôte éteint sont ignorés', () => {
    const { s, ids } = twoNetworks()
    const wrongMask = setIp(s, ids.PC2!, 0, '192.168.10.11/16')
    const zones = networkZones(wrongMask)
    expect(zones.map((z) => z.cidr)).toEqual(['192.168.0.0/16', '192.168.10.0/24', '192.168.20.0/24'])
    expect(zones[1]!.deviceIds).not.toContain(ids.PC2)
    // Le switch sert alors deux réseaux : il n'est plus enveloppé
    expect(zones[1]!.deviceIds).not.toContain(ids.SW1)
    // Sans adresse exploitable, aucune zone
    const { state: bare } = build([['client', 'PC9']])
    expect(networkZones(bare)).toEqual([])
  })

  it('VLAN indiqué seulement quand tous les hôtes membres sont sur le même VLAN d’accès', () => {
    const { s, ids } = twoNetworks()
    const sw = s.devices[ids.SW1!]!
    const port0 = sw.interfaces[0]!.id
    const port1 = sw.interfaces[1]!.id
    expect(networkZones(s)[0]!.vlan).toBe(1)
    let v = unwrap(setSwitchport(s, ids.SW1!, port0, { mode: 'access', accessVlan: 10 })).state
    // VLAN mixte (10 et 1) : pas d'étiquette, jamais devinée
    expect(networkZones(v)[0]!.vlan).toBeUndefined()
    v = unwrap(setSwitchport(v, ids.SW1!, port1, { mode: 'access', accessVlan: 10 })).state
    expect(networkZones(v)[0]!.vlan).toBe(10)
  })

  it('mémoïsé sur le réseau : un déplacement rend le même tableau, une adresse le recalcule', () => {
    const { s, ids } = twoNetworks()
    const first = networkZones(s)
    const moved: LabState = unwrap(moveDevice(s, ids.PC1!, { x: 400, y: 300 })).state
    expect(networkZones(moved)).toBe(first)
    expect(networkZones(setIp(s, ids.PC1!, 0, '192.168.10.12/24'))).not.toBe(first)
  })
})
