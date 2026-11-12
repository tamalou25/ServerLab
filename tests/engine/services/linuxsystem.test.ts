/**
 * Comportements publics de services/linuxsystem : unités systemd, paquets, horodatages.
 */
import { unwrap, type HostDevice } from '@engine/index'
import {
  installPackages,
  isInstalled,
  journalStamp,
  relativeAgo,
  removePackages,
  statusStamp,
  unitAction,
  unitJournal
} from '@engine/services/linuxsystem'
import { describe, expect, it } from 'vitest'
import { buildLinuxLab } from '../shell/linux-lab'

describe('linuxsystem : horodatages', () => {
  const lab = buildLinuxLab()
  const host = lab.state.devices[lab.ids.LSRV1!] as HostDevice

  it('journalctl et systemctl status', () => {
    expect(journalStamp(host, 3000)).toBe('Jan 05 08:00:03')
    expect(statusStamp(host, 3000)).toBe('Mon 2026-01-05 08:00:03 UTC')
  })

  it('relativeAgo', () => {
    expect(relativeAgo(-5)).toBe('0s ago')
    expect(relativeAgo(42_000)).toBe('42s ago')
    expect(relativeAgo(5 * 60_000)).toBe('5min ago')
    expect(relativeAgo(131_000)).toBe('2min 11s ago')
    expect(relativeAgo(3 * 3600_000)).toBe('3h ago')
    expect(relativeAgo(3900_000)).toBe('1h 5min ago')
    expect(relativeAgo(72 * 3600_000)).toBe('3 days ago')
  })
})

describe('linuxsystem : paquets et unités', () => {
  const lab = buildLinuxLab()
  const id = lab.ids.LSRV1!

  it('installe apache2 : paquet, service actif puis arrêt et redémarrage journalisés', () => {
    const inst = unwrap(installPackages(lab.state, id, ['apache2']))
    expect(inst.value.changed).toContain('apache2')
    let state = inst.state
    expect(isInstalled(state.devices[id] as HostDevice, 'apache2')).toBe(true)

    state = unwrap(unitAction(state, id, 'apache2', 'stop')).state
    state = unwrap(unitAction(state, id, 'apache2', 'start')).state
    const journal = unitJournal(state.devices[id] as HostDevice, 'apache2')
    expect(journal.some((e) => e.message.startsWith('Started '))).toBe(true)
  })

  it('refuse un reload sur une unité arrêtée et une unité inconnue', () => {
    let state = unwrap(installPackages(lab.state, id, ['apache2'])).state
    state = unwrap(unitAction(state, id, 'apache2', 'stop')).state
    const reload = unitAction(state, id, 'apache2', 'reload')
    expect(reload.ok).toBe(false)
    if (!reload.ok) expect(reload.error.code).toBe('JobNotApplicable')
    const unknown = unitAction(state, id, 'inexistante', 'start')
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.error.code).toBe('UnitNotFound')
  })

  it('enable puis disable affichent le lien symbolique, idempotents', () => {
    let state = unwrap(installPackages(lab.state, id, ['apache2'])).state
    state = unwrap(unitAction(state, id, 'apache2', 'disable')).state
    const en = unwrap(unitAction(state, id, 'apache2', 'enable'))
    expect(en.value.lines[0]).toContain('Created symlink')
    const again = unwrap(unitAction(en.state, id, 'apache2', 'enable'))
    expect(again.value.lines).toEqual([])
    const dis = unwrap(unitAction(again.state, id, 'apache2', 'disable'))
    expect(dis.value.lines[0]).toContain('Removed')
  })

  it('removePackages retire le paquet', () => {
    const state = unwrap(installPackages(lab.state, id, ['apache2'])).state
    const rem = unwrap(removePackages(state, id, ['apache2']))
    expect(isInstalled(rem.state.devices[id] as HostDevice, 'apache2')).toBe(false)
  })
})
