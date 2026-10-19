/**
 * Lab 44 « Dépannage Windows : les postes n'ouvrent plus de session » : départ cassé par buildLabState
 * (horloge de PC1 décalée + service DNS arrêté, graine fixe), réparation officielle = 100 % des
 * critères, cas partiels.
 */
import { describe, expect, it } from 'vitest'
import {
  activeFaults,
  allRepaired,
  checkLab,
  getFault,
  logon,
  TIME_SKEW_MESSAGE,
  type LabState
} from '@engine/index'
import { run } from '../shell/helpers'
import { failing, loadTroubleshootingLab, repairOfficial } from './depannage-helpers'

const { lab, start } = loadTroubleshootingLab('lab-44-depannage-windows.json')
const id = (s: LabState, name: string) => Object.values(s.devices).find((d) => d.name === name)?.id ?? ''
const session = (s: LabState) =>
  logon(s, id(s, 'PC1'), { user: 'jdupont', password: 'Azerty123!', domain: 'LAB' })

describe('lab-44-depannage-windows', () => {
  it('démarre cassé : deux pannes Windows fixées, aucune réparée', () => {
    expect(lab.troubleshooting?.faults?.map((f) => f.id)).toEqual([
      'win.clock-skew',
      'windows.service-stopped'
    ])
    expect(activeFaults(start).map((f) => f.id)).toEqual(['win.clock-skew', 'windows.service-stopped'])
    expect(allRepaired(start)).toBe(false)
    for (const f of activeFaults(start)) {
      const def = getFault(f.id)!
      expect(def.healed(start, f.params), f.id).toBe(false)
    }
    // Le DNS arrêté masque la seconde cause : l'écart d'horloge n'apparaît qu'une fois le DNS relancé
    const [clock, service] = activeFaults(start).map((f) => getFault(f.id)!)
    expect(service!.symptomVisible(start, activeFaults(start)[1]!.params)).toBe(true)
    expect(clock!.symptomVisible(start, activeFaults(start)[0]!.params)).toBe(false)
    const dnsFixed = repairOfficial(start, 'windows.service-stopped')
    expect(clock!.symptomVisible(dnsFixed, activeFaults(start)[0]!.params)).toBe(true)
  })

  it('départ : aucun critère validé, symptômes visibles', () => {
    expect(checkLab(start, lab).passed).toBe(0)
    expect(failing(start, lab)).toHaveLength(lab.criteria.length)
    // Le ticket : session refusée (aucun serveur disponible) et nom du serveur non résolu
    const nslookup = run(start, id(start, 'PC1'), 'nslookup srv1.lab.local', { shell: 'cmd' })
    expect(nslookup.text).toContain('Le délai d’attente de la requête')
    const refused = session(start)
    expect(refused.ok).toBe(false)
    expect(refused.message).toMatch(/aucun serveur d’ouverture de session/)
    // Le DNS relancé, la session reste refusée, cette fois pour l'écart d'heure
    const dnsOnly = session(repairOfficial(start, 'windows.service-stopped'))
    expect(dnsOnly.ok).toBe(false)
    expect(dnsOnly.message).toBe(TIME_SKEW_MESSAGE)
  })

  it('la réparation officielle valide 100 % des critères et la session s’ouvre', () => {
    const fixed = repairOfficial(start)
    expect(failing(fixed, lab)).toEqual([])
    expect(checkLab(fixed, lab).passed).toBe(lab.criteria.length)
    expect(allRepaired(fixed)).toBe(true)
    expect(session(fixed).ok).toBe(true)
  })

  it('cas partiel : DNS relancé seul, l’horloge reste fausse', () => {
    const half = repairOfficial(start, 'windows.service-stopped')
    const left = failing(half, lab)
    expect(left).toEqual(['panne-horloge', 'horloge'])
    expect(allRepaired(half)).toBe(false)
  })

  it('cas partiel : horloge resynchronisée seule, la résolution reste en panne', () => {
    const half = repairOfficial(start, 'win.clock-skew')
    const left = failing(half, lab)
    expect(left).toEqual(expect.arrayContaining(['panne-service', 'dns-demarre', 'resolution']))
    expect(left).not.toContain('horloge')
    expect(checkLab(half, lab).passed).toBeLessThan(lab.criteria.length)
    expect(allRepaired(half)).toBe(false)
  })
})
