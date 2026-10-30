/**
 * Générateur de la topologie de 100 équipements utilisée pour les mesures de performance.
 */
import { describe, expect, it } from 'vitest'
import { buildLargeLab } from '../../support/large-lab'

describe('générateur de grande topologie', () => {
  it('100 équipements câblés, baux DHCP obtenus sauf sur le switch isolé', () => {
    const { state, ids } = buildLargeLab()
    expect(Object.keys(state.devices)).toHaveLength(100)
    expect(Object.keys(state.links)).toHaveLength(3 + 6 + 89)
    const lease = (name: string) => state.devices[ids[name] ?? '']?.interfaces[0]?.dhcpLease?.address
    expect(lease('PC1')).toMatch(/^10\.0\./)
    // PC85 à PC89 : switch SW8 non raccordé au cœur
    expect(lease('PC85')).toBeUndefined()
    // Un poste sur huit en statique
    expect(state.devices[ids['PC8'] ?? '']?.interfaces[0]?.addressing).toBe('static')
  })

  it('option mixte : 100 équipements hétérogènes (Cisco, pare-feu, Linux, Windows)', () => {
    const { state } = buildLargeLab({ mixed: true })
    const devices = Object.values(state.devices)
    expect(devices).toHaveLength(100)
    expect(devices.some((d) => d.kind === 'firewall')).toBe(true)
    const os = (kind: string, value: string) =>
      devices.filter((d) => d.kind === kind && 'host' in d && d.host.os === value)
    expect(os('server', 'linux')).toHaveLength(1)
    expect(os('client', 'linux').length).toBeGreaterThan(0)
    expect(os('client', 'windows').length).toBeGreaterThan(0)
    expect(devices.some((d) => 'model' in d && d.model === 'c9200')).toBe(true)
  })
})
