/**
 * Comportements publics de services/linuxhttp : date HTTP et écoute d'Apache sur un serveur Linux.
 */
import { unwrap, type HostDevice } from '@engine/index'
import { apacheListening, httpDate } from '@engine/services/linuxhttp'
import { installPackages } from '@engine/services/linuxsystem'
import { describe, expect, it } from 'vitest'
import { buildLinuxLab } from '../shell/linux-lab'

describe('linuxhttp : httpDate', () => {
  it('formate une date RFC 7231 en GMT', () => {
    expect(httpDate(Date.UTC(2026, 9, 20, 8, 0, 3))).toBe('Tue, 20 Oct 2026 08:00:03 GMT')
    expect(httpDate(Date.UTC(2026, 0, 5, 23, 59, 59))).toBe('Mon, 05 Jan 2026 23:59:59 GMT')
  })
})

describe('linuxhttp : apacheListening', () => {
  it('faux sans Apache, vrai sur le port 80 une fois installé, faux sur un autre port', () => {
    const lab = buildLinuxLab()
    const id = lab.ids.LSRV1!
    expect(apacheListening(lab.state.devices[id] as HostDevice, 80, '192.168.2.10')).toBe(false)
    const { state } = unwrap(installPackages(lab.state, id, ['apache2']))
    const host = state.devices[id] as HostDevice
    expect(apacheListening(host, 80, '192.168.2.10')).toBe(true)
    expect(apacheListening(host, 8081, '192.168.2.10')).toBe(false)
  })
})
