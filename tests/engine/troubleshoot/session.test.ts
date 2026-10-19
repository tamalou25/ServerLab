import { describe, expect, it } from 'vitest'
import {
  allRepaired,
  buildLabState,
  checkLab,
  command,
  dispatch,
  emptyHistory,
  evaluateCheck,
  getFault,
  parseLab,
  parseSlab,
  serializeSlab,
  startTroubleshooting,
  undoStep,
  unwrap,
  type JournalEntry,
  type LabState
} from '@engine/index'
import { readFixture } from '../serialization/fixtures'
import { healthyLab03, idOf } from './bases'

const opts = { savedAt: '2026-01-01T00:00:00.000Z', appVersion: '0.1.0' }

function start(seed: number, id?: string) {
  return unwrap(startTroubleshooting(healthyLab03(), id ? { seed, faults: [{ id }] } : { seed, count: 2 }))
}

describe('startTroubleshooting', () => {
  it('même graine = mêmes pannes et même état cassé', () => {
    const a = start(42)
    const b = start(42)
    expect(a.value.faults).toEqual(b.value.faults)
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state))
    const ids = a.value.faults.map((f) => f.id)
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
  })

  it('des graines différentes peuvent tirer des cibles différentes', () => {
    const seen = new Set<string>()
    for (let seed = 1; seed <= 30; seed++) {
      const f = start(seed, 'net.wrong-mask').value.faults[0]!
      seen.add(`${f.params['device']}:${f.params['wrong']}`)
    }
    expect(seen.size).toBeGreaterThan(1)
  })

  it('l’état retourné est le point de départ : aucun historique, la panne ne s’annule pas', () => {
    const r = start(3, 'windows.service-stopped')
    // Aucune entrée de journal n’est rendue : le renderer démarre avec un historique vide
    expect(undoStep(r.state, emptyHistory()).ok).toBe(false)
    expect(allRepaired(r.state)).toBe(false)
    expect(r.state.troubleshooting?.faults).toEqual(r.value.faults)
    expect(r.value.faults[0]!.hintsUsed).toBe(0)
    // L’état sain d’origine n’est pas modifié
    expect(healthyLab03().troubleshooting).toBeUndefined()
  })

  it('filtre par domaine, refuse une demande impossible', () => {
    const base = healthyLab03()
    const net = unwrap(startTroubleshooting(base, { seed: 1, domain: 'reseau' }))
    expect(net.value.faults.every((f) => getFault(f.id)?.domain === 'reseau')).toBe(true)
    expect(startTroubleshooting(base, { seed: 1, domain: 'linux' }).ok).toBe(false)
    expect(startTroubleshooting(base, { seed: 1, count: 99 }).ok).toBe(false)
    expect(startTroubleshooting(base, { seed: 1, faults: [{ id: 'x.y' }] }).ok).toBe(false)
  })

  it('refuse des cibles qui n’existent pas dans le lab', () => {
    const r = startTroubleshooting(healthyLab03(), {
      seed: 1,
      faults: [
        { id: 'windows.service-stopped', params: { device: 'nope', service: 'DNS', client: 'x', name: 'y' } }
      ]
    })
    expect(r.ok).toBe(false)
  })
})

describe('indices et critère', () => {
  it('troubleshoot.useHint incrémente le compteur (3 au plus) et s’annule', () => {
    const r = start(5, 'net.wrong-mask')
    const id = r.value.faults[0]!.id
    let s = r.state
    const past: JournalEntry[] = []
    for (let n = 1; n <= 3; n++) {
      const d = dispatch(s, command('troubleshoot.useHint', id))
      if (!d.ok) throw new Error(d.error.message)
      expect(d.value).toBe(n)
      s = d.state
      past.push(d.entry!)
    }
    expect(dispatch(s, command('troubleshoot.useHint', id)).ok).toBe(false)
    expect(s.troubleshooting?.faults[0]?.hintsUsed).toBe(3)
    const back = undoStep(s, { past, future: [] })
    if (!back.ok) throw new Error(back.error.message)
    expect(back.state.troubleshooting?.faults[0]?.hintsUsed).toBe(2)
    expect(dispatch(r.state, command('troubleshoot.useHint', 'inconnue')).ok).toBe(false)
  })

  it('critère faultRepaired : faux cassé, vrai après la réparation officielle', () => {
    const r = start(9)
    let s: LabState = r.state
    expect(evaluateCheck(s, { type: 'faultRepaired' })).toBe(false)
    expect(evaluateCheck(healthyLab03(), { type: 'faultRepaired' })).toBe(false) // pas de dépannage
    for (const f of r.value.faults) {
      // Le critère global reste faux tant qu’il reste une panne à réparer
      expect(evaluateCheck(s, { type: 'faultRepaired' })).toBe(false)
      for (const c of getFault(f.id)!.repair(s, f.params)) s = unwrap(dispatch(s, c)).state
    }
    // Deux pannes peuvent se recouvrir (p. ex. DNS en échec et masque erroné vers le même serveur) :
    // le critère ciblé de chacune n’est exigé qu’une fois toutes les réparations faites
    for (const f of r.value.faults) {
      expect(evaluateCheck(s, { type: 'faultRepaired', faultId: f.id })).toBe(true)
    }
    expect(evaluateCheck(s, { type: 'faultRepaired' })).toBe(true)
  })
})

describe('persistance et labs', () => {
  it('le dépannage survit à l’enregistrement .slab', () => {
    const r = start(11)
    const parsed = parseSlab(serializeSlab(r.state, opts))
    if (!parsed.ok) throw new Error(parsed.message)
    expect(parsed.doc.lab.troubleshooting).toEqual(r.state.troubleshooting)
    expect(allRepaired(parsed.doc.lab)).toBe(false)
  })

  it('v26.slab s’ouvre sans dépannage', () => {
    const parsed = parseSlab(readFixture(26))
    if (!parsed.ok) throw new Error(parsed.message)
    expect(parsed.doc.schemaVersion).toBe(26)
    expect(parsed.doc.lab.troubleshooting).toBeUndefined()
  })

  it('un lab avec « troubleshooting » démarre cassé (buildLabState) et se valide par faultRepaired', () => {
    const parsed = parseLab({
      formatVersion: 1,
      id: 'test-panne',
      title: 'Panne',
      difficulty: 'Débutant',
      duration: '5 min',
      summary: 's',
      statement: 's',
      start: {
        devices: [
          { kind: 'server', name: 'SRV1', x: 0, y: 0, ip: '192.168.10.1/24' },
          { kind: 'switch', name: 'SW1', x: 0, y: 0 },
          { kind: 'client', name: 'PC1', x: 0, y: 0, ip: '192.168.10.10/24' }
        ],
        links: [
          ['SRV1:Ethernet0', 'SW1:Fa0/1'],
          ['PC1:Ethernet0', 'SW1:Fa0/2']
        ]
      },
      criteria: [{ id: 'repare', label: 'Réparée', hint: 'h', check: { type: 'faultRepaired' } }],
      troubleshooting: { seed: 4, faults: [{ id: 'net.wrong-mask' }] }
    })
    if (!parsed.ok) throw new Error(parsed.message)
    const s = buildLabState(parsed.lab)
    expect(s.troubleshooting?.faults).toHaveLength(1)
    expect(checkLab(s, parsed.lab).passed).toBe(0)
    expect(idOf(s, 'PC1')).not.toBe('')
  })
})
