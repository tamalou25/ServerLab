import { describe, expect, it } from 'vitest'
import {
  allRepaired,
  command,
  dispatch,
  faultTickets,
  getFault,
  hintsUsedTotal,
  nextHintFaultId,
  revealedHints,
  startTroubleshooting,
  summarizeTroubleshooting,
  unwrap,
  type LabState
} from '@engine/index'
import { healthyLab03 } from './bases'

function started(): { state: LabState; faultId: string } {
  const r = unwrap(
    startTroubleshooting(healthyLab03(), { seed: 7, faults: [{ id: 'windows.service-stopped' }] })
  )
  return { state: r.state, faultId: r.value.faults[0]!.id }
}

const stats = { commandsPlayed: 1, hintsUsed: 0, elapsedMs: 90_000, repaired: true, gaveUp: false }

describe('accesseurs du mode panne', () => {
  it('le ticket ne révèle ni l’identifiant ni la cause', () => {
    const { state, faultId } = started()
    const f = state.troubleshooting!.faults[0]!
    const [ticket] = faultTickets(state)
    expect(ticket).toBeTruthy()
    expect(ticket).not.toContain(faultId)
    expect(ticket).not.toBe(getFault(faultId)!.cause(state, f.params))
  })

  it('les indices révélés suivent le compteur de l’état, dans l’ordre', () => {
    const { state, faultId } = started()
    expect(revealedHints(state, state)).toEqual([])
    expect(nextHintFaultId(state)).toBe(faultId)
    let s = unwrap(dispatch(state, command('troubleshoot.useHint', faultId))).state
    s = unwrap(dispatch(s, command('troubleshoot.useHint', faultId))).state
    const shown = revealedHints(state, s)
    expect(shown.map((h) => h.level)).toEqual([1, 2])
    expect(shown[0]!.text).toBe(getFault(faultId)!.hints(state, state.troubleshooting!.faults[0]!.params)[0])
    expect(hintsUsedTotal(s)).toBe(2)
    s = unwrap(dispatch(s, command('troubleshoot.useHint', faultId))).state
    expect(nextHintFaultId(s)).toBeNull()
  })
})

describe('summarizeTroubleshooting', () => {
  it('chemin le plus court : autant de commandes que la réparation officielle, score 100', () => {
    const { state } = started()
    const s = summarizeTroubleshooting(state, stats)
    expect(s.faults).toHaveLength(1)
    expect(s.officialCommands).toBeGreaterThan(0)
    expect(s.faults[0]!.repairSteps.length).toBe(s.officialCommands)
    expect(s.faults[0]!.cause).toBeTruthy()
    const exact = summarizeTroubleshooting(state, { ...stats, commandsPlayed: s.officialCommands })
    expect(exact.extraCommands).toBe(0)
    expect(exact.score).toBe(100)
    expect(exact.verdict).toContain('Chemin le plus court')
  })

  it('une démarche plus longue ou des indices réduisent le score', () => {
    const { state } = started()
    const official = summarizeTroubleshooting(state, stats).officialCommands
    const long = summarizeTroubleshooting(state, { ...stats, commandsPlayed: official * 4 })
    expect(long.extraCommands).toBe(official * 3)
    expect(long.score).toBe(25)
    const hinted = summarizeTroubleshooting(state, { ...stats, commandsPlayed: official, hintsUsed: 2 })
    expect(hinted.score).toBe(80)
    expect(hinted.verdict).toContain('2 indices')
    const lots = summarizeTroubleshooting(state, { ...stats, commandsPlayed: official * 100, hintsUsed: 3 })
    expect(lots.score).toBe(0)
  })

  it('abandon ou panne non réparée : score nul, cause et correction fournies', () => {
    const { state } = started()
    const gaveUp = summarizeTroubleshooting(state, { ...stats, repaired: false, gaveUp: true })
    expect(gaveUp.score).toBe(0)
    expect(gaveUp.repaired).toBe(false)
    expect(gaveUp.faults[0]!.repairSteps.length).toBeGreaterThan(0)
    expect(gaveUp.verdict).toContain('abandonné')
    expect(summarizeTroubleshooting(state, { ...stats, repaired: false }).verdict).toBe('Panne non réparée.')
  })

  it('la réparation officielle décrite guérit bien le lab', () => {
    const { state } = started()
    const f = state.troubleshooting!.faults[0]!
    let s = state
    for (const c of getFault(f.id)!.repair(state, f.params)) s = unwrap(dispatch(s, c)).state
    expect(allRepaired(s)).toBe(true)
  })
})
