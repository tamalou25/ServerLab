/**
 * Lab 43 « Dépannage réseau : Internet ne répond plus » : départ cassé par buildLabState (VLAN erroné sur
 * le port de PC2 + passerelle erronée sur WEB, graine fixe), réparation officielle = 100 % des critères,
 * cas partiels. Le départ sain est vérifié par la réparation (aucune panne ne reste active).
 */
import { describe, expect, it } from 'vitest'
import { activeFaults, allRepaired, checkLab, getFault, type LabState } from '@engine/index'
import { run } from '../shell/helpers'
import { failing, loadTroubleshootingLab, repairOfficial } from './depannage-helpers'

const { lab, start } = loadTroubleshootingLab('lab-43-depannage-reseau.json')
const id = (s: LabState, name: string) => Object.values(s.devices).find((d) => d.name === name)?.id ?? ''
const ping = (s: LabState, from: string, target: string) =>
  run(s, id(s, from), `ping ${target}`, { shell: 'cmd' }).text
const faultIds = () => activeFaults(start).map((f) => f.id)

describe('lab-43-depannage-reseau', () => {
  it('démarre cassé : deux pannes réseau fixées, aucune réparée', () => {
    expect(lab.troubleshooting?.faults?.map((f) => f.id)).toEqual(['net.wrong-vlan', 'net.wrong-gateway'])
    expect(faultIds()).toEqual(['net.wrong-vlan', 'net.wrong-gateway'])
    expect(allRepaired(start)).toBe(false)
    for (const f of activeFaults(start)) {
      const def = getFault(f.id)!
      expect(def.symptomVisible(start, f.params), f.id).toBe(true)
      expect(def.healed(start, f.params), f.id).toBe(false)
    }
  })

  it('départ : aucun critère validé, symptôme visible', () => {
    const r = checkLab(start, lab)
    expect(r.passed).toBe(0)
    expect(failing(start, lab)).toHaveLength(lab.criteria.length)
    // Le ticket : PC2 ne joint ni PC1 ni WEB, PC1 n'ouvre plus WEB
    expect(ping(start, 'PC2', '192.168.10.10')).toMatch(/Impossible de joindre|Délai d’attente/)
    expect(ping(start, 'PC2', '203.0.113.10')).toMatch(/Impossible de joindre|Délai d’attente/)
    expect(ping(start, 'PC1', '203.0.113.10')).toMatch(/Impossible de joindre|Délai d’attente/)
    // Une fois réparé, la même requête aboutit
    expect(ping(repairOfficial(start), 'PC2', '203.0.113.10')).toMatch(/Réponse de 203\.0\.113\.10 : octets=/)
  })

  it('la réparation officielle valide 100 % des critères', () => {
    const fixed = repairOfficial(start)
    expect(failing(fixed, lab)).toEqual([])
    expect(checkLab(fixed, lab).passed).toBe(lab.criteria.length)
    expect(allRepaired(fixed)).toBe(true)
  })

  it('cas partiel : seul le VLAN réparé, PC2 rejoint PC1 mais pas WEB', () => {
    const half = repairOfficial(start, 'net.wrong-vlan')
    const left = failing(half, lab)
    expect(left).not.toEqual([])
    expect(left).toEqual(expect.arrayContaining(['panne-passerelle', 'pc2-web', 'pc1-web']))
    expect(left).not.toContain('panne-vlan')
    expect(left).not.toContain('pc2-pc1')
    expect(allRepaired(half)).toBe(false)
  })

  it('cas partiel : seule la passerelle réparée, PC2 reste isolé', () => {
    const half = repairOfficial(start, 'net.wrong-gateway')
    expect(failing(half, lab)).toEqual(expect.arrayContaining(['panne-vlan', 'acces-rh', 'pc2-pc1']))
    expect(checkLab(half, lab).passed).toBeLessThan(lab.criteria.length)
    expect(allRepaired(half)).toBe(false)
  })
})
