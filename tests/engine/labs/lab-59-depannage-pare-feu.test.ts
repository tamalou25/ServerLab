/**
 * Lab 59 « Dépannage pare-feu » : départ cassé par buildLabState (règle Block avant la règle Pass + NAT sortant
 * désactivé, graine fixe), symptômes vus depuis les postes, réparation par les commandes `pf.*` de l'élève
 * puis réparation officielle = 100 % des critères, cas partiels.
 */
import { describe, expect, it } from 'vitest'
import { activeFaults, allRepaired, checkLab, command, getFault, type LabState } from '@engine/index'
import { run } from '../shell/helpers'
import { failing, loadTroubleshootingLab, play, repairOfficial } from './depannage-helpers'

const { lab, start } = loadTroubleshootingLab('lab-59-depannage-pare-feu.json')
const id = (s: LabState, name: string) => Object.values(s.devices).find((d) => d.name === name)?.id ?? ''
const sh = (s: LabState, machine: string, line: string) => run(s, id(s, machine), line, { shell: 'cmd' })

describe('lab-59-depannage-pare-feu', () => {
  it('démarre cassé : deux pannes du pare-feu fixées, aucune réparée', () => {
    expect(activeFaults(start).map((f) => f.id)).toEqual(['pf.rule-order', 'pf.nat-disabled'])
    expect(allRepaired(start)).toBe(false)
    for (const f of activeFaults(start)) expect(getFault(f.id)!.healed(start, f.params), f.id).toBe(false)
  })

  it('symptômes visibles sur les deux pannes et critères non validés', () => {
    for (const f of activeFaults(start))
      expect(getFault(f.id)!.symptomVisible(start, f.params), f.id).toBe(true)
    expect(failing(start, lab)).toContain('c1')
  })

  it('la réparation officielle valide 100 % des critères', () => {
    const fixed = repairOfficial(start)
    expect(failing(fixed, lab)).toEqual([])
    expect(checkLab(fixed, lab).passed).toBe(lab.criteria.length)
    expect(allRepaired(fixed)).toBe(true)
    expect(sh(fixed, 'INTERNET', 'curl -sI http://45.10.0.1/').text).toContain('200 OK')
  })

  it('cas partiel : le NAT réparé, la règle mal placée toujours en cause', () => {
    const half = repairOfficial(start, 'pf.nat-disabled')
    expect(allRepaired(half)).toBe(false)
    expect(failing(half, lab)).toContain('c1')
  })

  it('réparation de l’élève : supprimer la règle Block et rétablir le NAT automatique', () => {
    const order = activeFaults(start).find((f) => f.id === 'pf.rule-order')!
    const fw = id(start, 'FW1')
    const firewall = start.devices[fw]!
    if (firewall.kind !== 'firewall') throw new Error('pare-feu attendu')
    const block = firewall.pf.rules.find((r) => r.descr === order.params['blockDescr'])!
    const fixed = play(start, [
      command('pf.removeRule', fw, block.id),
      command('pf.setNatMode', fw, 'automatic')
    ])
    expect(failing(fixed, lab)).toEqual([])
  })
})
