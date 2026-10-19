import { describe, expect, it } from 'vitest'
import { FAULTS, getFault } from '@engine/index'

describe('registre des pannes', () => {
  it('identifiants uniques, domaine et difficulté valides', () => {
    const ids = FAULTS.map((f) => f.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const f of FAULTS) {
      expect(['reseau', 'windows', 'linux', 'pare-feu']).toContain(f.domain)
      expect([1, 2, 3]).toContain(f.difficulty)
      expect(f.title.trim()).not.toBe('')
      expect(getFault(f.id)).toBe(f)
    }
    expect(getFault('inconnue')).toBeUndefined()
  })

  it('catalogue : service-stopped, les 12 pannes réseau (net.*) et les pannes Windows', () => {
    expect(FAULTS.map((f) => f.id)).toEqual(
      expect.arrayContaining([
        'net.acl-blocking',
        'net.cable-unplugged',
        'net.duplicate-ip',
        'net.etherchannel-down',
        'net.missing-route',
        'net.port-err-disabled',
        'net.trunk-missing-vlan',
        'net.wrong-gateway',
        'net.wrong-mask',
        'net.wrong-nat',
        'net.wrong-stp-root',
        'net.wrong-vlan',
        'windows.service-stopped'
      ])
    )
    expect(FAULTS.filter((f) => f.domain === 'reseau')).toHaveLength(12)
    // Difficulté : câble, passerelle, masque, doublon = 1 ; VLAN, route, ACL, err-disabled = 2 ; STP, EtherChannel, NAT = 3
    const level = (id: string) => FAULTS.find((f) => f.id === id)?.difficulty
    expect(['net.cable-unplugged', 'net.wrong-gateway', 'net.wrong-mask'].map(level)).toEqual([1, 1, 1])
    expect(['net.wrong-stp-root', 'net.etherchannel-down', 'net.wrong-nat'].map(level)).toEqual([3, 3, 3])
  })
})
