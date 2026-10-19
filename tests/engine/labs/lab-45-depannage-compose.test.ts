/**
 * Lab 45 « Dépannage composé : deux causes qui se masquent » : départ cassé par buildLabState (DNS arrêté
 * qui masque un enregistrement A erroné, graine fixe), réparation officielle = 100 % des critères,
 * cas partiel (service relancé seul : la seconde cause apparaît).
 */
import { describe, expect, it } from 'vitest'
import { activeFaults, allRepaired, checkLab, getFault, type LabState } from '@engine/index'
import { run } from '../shell/helpers'
import { failing, loadTroubleshootingLab, play, repairOfficial } from './depannage-helpers'

const { lab, start } = loadTroubleshootingLab('lab-45-depannage-compose.json')
const id = (s: LabState, name: string) => Object.values(s.devices).find((d) => d.name === name)?.id ?? ''
const fault = activeFaults(start)[0]!
const def = getFault(fault.id)!
const nslookup = (s: LabState) => run(s, id(s, 'PC1'), 'nslookup srv1.lab.local', { shell: 'cmd' }).text

describe('lab-45-depannage-compose', () => {
  it('démarre cassé : une panne composée fixée, non réparée', () => {
    expect(lab.troubleshooting?.faults?.map((f) => f.id)).toEqual(['win.combo.dns-stopped-wrong-a'])
    expect(activeFaults(start)).toHaveLength(1)
    expect(fault.id).toBe('win.combo.dns-stopped-wrong-a')
    expect(def.symptomVisible(start, fault.params)).toBe(true)
    expect(def.healed(start, fault.params)).toBe(false)
    expect(allRepaired(start)).toBe(false)
  })

  it('départ : aucun critère validé, le nom ne se résout pas', () => {
    expect(checkLab(start, lab).passed).toBe(0)
    expect(failing(start, lab)).toHaveLength(lab.criteria.length)
    expect(nslookup(start)).toContain('Le délai d’attente de la requête')
  })

  it('la réparation officielle valide 100 % des critères', () => {
    const fixed = repairOfficial(start)
    expect(failing(fixed, lab)).toEqual([])
    expect(checkLab(fixed, lab).passed).toBe(lab.criteria.length)
    expect(allRepaired(fixed)).toBe(true)
    expect(nslookup(fixed)).toContain('192.168.10.1')
  })

  it('cas partiel : DNS relancé seul, le nom se résout vers une mauvaise adresse', () => {
    const [startService] = def.repair(start, fault.params)
    expect(startService?.type).toBe('service.start')
    const half = play(start, [startService!])
    const left = failing(half, lab)
    expect(left).toEqual(['panne-composee', 'enregistrement', 'resolution', 'partage'])
    expect(allRepaired(half)).toBe(false)
    // La seconde cause est maintenant visible : le nom répond, mais avec l'adresse erronée
    expect(nslookup(half)).toContain(String(fault.params['b.wrong']))
    expect(nslookup(half)).not.toContain('Le délai d’attente de la requête')
  })
})
