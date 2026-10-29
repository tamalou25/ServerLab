/**
 * Serveur Linux (v2.9, #234) : fabrique, prédicat `isLinuxHost` et console bash sur un serveur.
 */
import { describe, expect, it } from 'vitest'
import { addDevice, createLab, createShellSession, isLinuxHost, shellPrompt, unwrap } from '@engine/index'
import { run } from '../shell/helpers'

const add = (kind: 'server' | 'client', os?: 'linux') =>
  unwrap(addDevice(createLab(), { kind, os, position: { x: 0, y: 0 } }))

describe('serveur Linux', () => {
  it('fabrique : LSRV1, eth0, admin, debian12, aucune fonctionnalité Windows', () => {
    const { state, value } = add('server', 'linux')
    const d = state.devices[value]!
    expect(d.name).toBe('LSRV1')
    expect(d.interfaces.map((i) => i.name)).toEqual(['eth0'])
    expect(d.kind === 'server' && [d.host.os, d.host.linux, d.host.session?.user, d.host.features]).toEqual([
      'linux',
      { distro: 'debian12' },
      'admin',
      []
    ])
  })

  it('un serveur Windows reste inchangé (SRV1, pas de champ linux)', () => {
    const { state, value } = add('server')
    const d = state.devices[value]!
    expect(d.name).toBe('SRV1')
    expect(d.kind === 'server' && [d.host.os, d.host.linux]).toEqual(['windows', undefined])
  })

  it('prédicat isLinuxHost : serveur et poste Linux, pas Windows', () => {
    const l = add('server', 'linux')
    const w = add('server')
    const c = add('client', 'linux')
    const p = add('client')
    expect(isLinuxHost(l.state.devices[l.value])).toBe(true)
    expect(isLinuxHost(c.state.devices[c.value])).toBe(true)
    expect(isLinuxHost(w.state.devices[w.value])).toBe(false)
    expect(isLinuxHost(p.state.devices[p.value])).toBe(false)
    expect(isLinuxHost(undefined)).toBe(false)
  })

  it('bash fonctionne sur un serveur Linux (invite admin@LSRV1, whoami, ip a)', () => {
    const { state, value } = add('server', 'linux')
    const session = createShellSession(state, value, 'cmd')
    expect(session.stack).toEqual(['bash'])
    expect(shellPrompt(session, state)).toBe('admin@LSRV1:~$ ')
    const who = run(state, value, 'whoami', { session })
    expect(who.text).toBe('admin')
    const ip = run(state, value, 'ip a', { session })
    expect(ip.text).toContain('eth0')
  })
})
