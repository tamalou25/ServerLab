/**
 * Caches indexés sur le réseau : un déplacement ou un renommage réutilise les calculs (conflits
 * d'adresses, résumé du canvas) ; une modification du réseau les refait, en réutilisant les
 * entrées des nœuds qui n'ont pas changé.
 */
import { produce } from 'immer'
import { describe, expect, it } from 'vitest'
import {
  canvasStatus,
  ipConflicts,
  linkOnInterface,
  moveDevice,
  renameDevice,
  restartComputer,
  sameNetwork,
  setPower,
  unwrap,
  type LabState
} from '@engine/index'
import { buildLargeLab } from '../../support/large-lab'
import { add, build, cable, setIp } from '../helpers'

function smallLab() {
  const { state, ids } = build([
    ['server', 'SRV1'],
    ['client', 'PC1'],
    ['client', 'PC2'],
    ['switch', 'SW1']
  ])
  let s = cable(state, ids.SRV1!, 0, ids.SW1!, 0)
  s = cable(s, ids.PC1!, 0, ids.SW1!, 1)
  s = cable(s, ids.PC2!, 0, ids.SW1!, 2)
  s = setIp(s, ids.SRV1!, 0, '192.168.1.1/24')
  s = setIp(s, ids.PC1!, 0, '192.168.1.10/24')
  s = setIp(s, ids.PC2!, 0, '192.168.1.11/24')
  return { s, ids }
}

const move = (s: LabState, id: string, x: number) => unwrap(moveDevice(s, id, { x, y: 0 })).state

describe('sameNetwork', () => {
  it('déplacer ou renommer ne change pas le réseau', () => {
    const { s, ids } = smallLab()
    expect(sameNetwork(s, move(s, ids.PC1!, 500))).toBe(true)
    expect(sameNetwork(s, unwrap(renameDevice(s, ids.PC1!, 'COMPTA1')).state)).toBe(true)
  })

  it('adresse, câble, alimentation ou équipement ajouté changent le réseau', () => {
    const { s, ids } = smallLab()
    expect(sameNetwork(s, setIp(s, ids.PC1!, 0, '192.168.1.20/24'))).toBe(false)
    expect(sameNetwork(s, unwrap(setPower(s, ids.PC2!, false)).state)).toBe(false)
    const extra = build([['client', 'PC9']]).state.devices
    expect(sameNetwork(s, { ...s, devices: { ...s.devices, ...extra } })).toBe(false)
    const { state: other } = build([['client', 'PC1']])
    expect(sameNetwork(s, { ...s, links: other.links })).toBe(false)
  })
})

describe('conflits d’adresses', () => {
  it('détectés, puis réutilisés tels quels après un déplacement', () => {
    const { s, ids } = smallLab()
    const conflict = setIp(s, ids.PC2!, 0, '192.168.1.10/24')
    const set = ipConflicts(conflict)
    expect([...set].sort()).toEqual(
      [
        `${ids.PC1}/${conflict.devices[ids.PC1!]!.interfaces[0]!.id}`,
        `${ids.PC2}/${conflict.devices[ids.PC2!]!.interfaces[0]!.id}`
      ].sort()
    )
    expect(ipConflicts(move(conflict, ids.PC1!, 300))).toBe(set)
    // Conflit résolu : nouveau calcul
    expect(ipConflicts(setIp(conflict, ids.PC2!, 0, '192.168.1.12/24')).size).toBe(0)
  })
})

describe('conflits d’adresses : cas limites (audit P-01)', () => {
  it('même adresse dans deux domaines de diffusion distincts : aucun conflit', () => {
    const { s, ids } = smallLab()
    // PC9 isolé (sans câble vers SW1) avec l'adresse de PC1
    const { state: merged, id: pc9 } = add(s, 'client')
    expect(ipConflicts(setIp(merged, pc9, 0, '192.168.1.10/24')).size).toBe(0)
    // Une troisième carte du même segment avec cette adresse : seules les deux voisines sont en conflit
    const triple = setIp(setIp(merged, pc9, 0, '192.168.1.10/24'), ids.PC2!, 0, '192.168.1.10/24')
    expect([...ipConflicts(triple)].map((k) => k.split('/')[0]).sort()).toEqual([ids.PC1, ids.PC2].sort())
  })

  it('un équipement éteint ne crée ni ne subit de conflit', () => {
    const { s, ids } = smallLab()
    const conflict = setIp(s, ids.PC2!, 0, '192.168.1.10/24')
    expect(ipConflicts(unwrap(setPower(conflict, ids.PC2!, false)).state).size).toBe(0)
  })
})

describe('câble d’un port (index)', () => {
  it('à jour dans un brouillon immer après un nouveau câble', () => {
    const { s, ids } = smallLab()
    const pc1Nic = s.devices[ids.PC1!]!.interfaces[0]!.id
    expect(linkOnInterface(s, ids.PC1!, pc1Nic)).toBeDefined()
    const { state: merged, id: pc9 } = add(s, 'client')
    const nic = merged.devices[pc9]!.interfaces[0]!.id
    const sw = merged.devices[ids.SW1!]!.interfaces[5]!.id
    expect(linkOnInterface(merged, pc9, nic)).toBeUndefined()
    const after = produce(merged, (draft) => {
      // Index lu dans le brouillon avant l'ajout, puis câble ajouté sous la même référence
      expect(linkOnInterface(draft, pc9, nic)).toBeUndefined()
      draft.links['lx'] = {
        id: 'lx',
        a: { deviceId: pc9, ifaceId: nic },
        b: { deviceId: ids.SW1!, ifaceId: sw },
        virtual: false
      }
      expect(linkOnInterface(draft, pc9, nic)?.id).toBe('lx')
    })
    expect(linkOnInterface(after, pc9, nic)?.id).toBe('lx')
  })
})

describe('résumé du canvas', () => {
  it('identique (même objet) après un déplacement', () => {
    const { s, ids } = smallLab()
    const first = canvasStatus(s)
    expect(first.devices[ids.PC1!]?.health.status).toBe('ok')
    expect(first.devices[ids.PC1!]?.ip?.text).toBe('192.168.1.10/24')
    expect(canvasStatus(move(s, ids.PC1!, 400))).toBe(first)
  })

  it('après une modification, seules les entrées concernées changent', () => {
    const { s, ids } = smallLab()
    const before = canvasStatus(s)
    const after = canvasStatus(setIp(s, ids.PC1!, 0, '192.168.1.50/24'))
    expect(after).not.toBe(before)
    expect(after.devices[ids.PC1!]).not.toBe(before.devices[ids.PC1!])
    expect(after.devices[ids.PC1!]?.ip?.text).toBe('192.168.1.50/24')
    expect(after.devices[ids.PC2!]).toBe(before.devices[ids.PC2!])
    expect(after.devices[ids.SRV1!]).toBe(before.devices[ids.SRV1!])
  })

  it('un redémarrage en attente change la LED du poste', () => {
    const { s, ids } = smallLab()
    canvasStatus(s)
    const pc = s.devices[ids.PC1!]
    if (pc?.kind !== 'client') throw new Error('poste attendu')
    const pending: LabState = {
      ...s,
      devices: { ...s.devices, [pc.id]: { ...pc, host: { ...pc.host, pendingReboot: true } } }
    }
    expect(canvasStatus(pending).devices[pc.id]?.health.status).toBe('warn')
    const restarted = unwrap(restartComputer(pending, pc.id)).state
    expect(canvasStatus(restarted).devices[pc.id]?.health.status).toBe('ok')
  })

  it('topologie de 100 équipements : 30 déplacements sans recalcul', () => {
    const { state, ids } = buildLargeLab()
    const first = canvasStatus(state)
    let s = state
    const start = performance.now()
    for (let i = 1; i <= 30; i++) {
      s = move(s, ids['PC1']!, i * 10)
      expect(canvasStatus(s)).toBe(first)
    }
    // Seuil large (machine de CI) : sans cache, ~9 ms par mouvement mesurés avant optimisation
    expect((performance.now() - start) / 30).toBeLessThan(5)
  })
})
