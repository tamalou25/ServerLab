/**
 * Équipement pare-feu (v2.10, #242) : pose, interfaces WAN/LAN/DMZ, câblage, renommage, copie,
 * enregistrement et refus d'une valeur invalide.
 */
import { describe, expect, it } from 'vitest'
import {
  addDevice,
  connect,
  createLab,
  duplicateDevices,
  parseSlab,
  renameDevice,
  serializeSlab,
  unwrap,
  type LabState
} from '@engine/index'

const place = (s: LabState, name?: string) =>
  unwrap(addDevice(s, { kind: 'firewall', position: { x: 10, y: 20 }, name }))

describe('pare-feu', () => {
  it('fabrique : FW1, trois cartes em0-em2, WAN/LAN/DMZ, LAN préconfiguré', () => {
    const { state, value } = place(createLab())
    const fw = state.devices[value]!
    expect(fw.kind).toBe('firewall')
    if (fw.kind !== 'firewall') return
    expect(fw.name).toBe('FW1')
    expect(fw.interfaces.map((i) => i.name)).toEqual(['em0', 'em1', 'em2'])
    expect(fw.interfaces.every((i) => i.l3 && i.addressing === 'static')).toBe(true)
    expect(fw.interfaces.map((i) => i.address)).toEqual([null, '192.168.1.1', null])
    expect(fw.pf.assignments.map((a) => [a.key, a.descr, a.ifaceId])).toEqual([
      ['wan', 'WAN', fw.interfaces[0]!.id],
      ['lan', 'LAN', fw.interfaces[1]!.id],
      ['opt1', 'DMZ', fw.interfaces[2]!.id]
    ])
    expect(fw.pf.nat.outboundMode).toBe('automatic')
    expect(fw.pf.rules).toEqual([])
  })

  it('les noms suivent : FW1, FW2', () => {
    const a = place(createLab())
    expect(place(a.state).state.devices[place(a.state).value]!.name).toBe('FW2')
  })

  it('se câble à un autre équipement', () => {
    let s = place(createLab()).state
    const fw = Object.values(s.devices)[0]!
    const pc = unwrap(addDevice(s, { kind: 'client', position: { x: 0, y: 0 } }))
    s = unwrap(
      connect(
        pc.state,
        { deviceId: fw.id, ifaceId: fw.interfaces[1]!.id },
        { deviceId: pc.value, ifaceId: pc.state.devices[pc.value]!.interfaces[0]!.id }
      )
    ).state
    expect(Object.keys(s.links)).toHaveLength(1)
  })

  it('renommage : le nom d’hôte pfSense suit ; nom invalide refusé en français', () => {
    const { state, value } = place(createLab())
    const renamed = unwrap(renameDevice(state, value, 'fw-dmz')).state
    const fw = renamed.devices[value]!
    expect(fw.kind === 'firewall' && fw.pf.hostname).toBe('fw-dmz')
    const bad = renameDevice(state, value, '1pare')
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error.message).toContain('commencer par une lettre')
  })

  it('copie : mêmes affectations sur les nouvelles cartes, journal vide', () => {
    const { state, value } = place(createLab())
    const copied = unwrap(
      duplicateDevices(state, { devices: [state.devices[value]!], links: [] }, { x: 40, y: 40 })
    )
    const copy = copied.state.devices[copied.value[0]!]!
    expect(copy.kind).toBe('firewall')
    if (copy.kind !== 'firewall') return
    expect(copy.pf.hostname).toBe(copy.name)
    expect(copy.pf.assignments.map((a) => a.ifaceId)).toEqual(copy.interfaces.map((i) => i.id))
  })

  it('enregistrement : aller-retour .slab à l’identique', () => {
    const { state } = place(createLab())
    const text = serializeSlab(state, {
      savedAt: '2026-10-05T12:00:00.000Z',
      appVersion: '0.0.0',
      viewport: { x: 0, y: 0, zoom: 1 }
    })
    const parsed = parseSlab(text)
    expect(parsed.ok && parsed.doc.lab.devices).toEqual(state.devices)
  })
})
