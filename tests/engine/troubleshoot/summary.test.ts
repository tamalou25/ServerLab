/**
 * Bilan du dépannage (v2.12) : règles de calcul explicites (rétablissement 60, usage 25, contraintes 15,
 * redistribution des catégories absentes), autonomie séparée du résultat (un indice n'enlève aucun
 * point), objectifs partiellement atteints, contraintes dégradées, abandon, entraînement / examen,
 * chaîne des causes d'une panne composée, journal (changements et diagnostics), limites annoncées,
 * compte rendu texte. Aucune mention de « chemin le plus court ».
 */
import { describe, expect, it } from 'vitest'
import {
  allRepaired,
  checkLab,
  command,
  criteriaOutcomes,
  dispatch,
  faultTickets,
  getFault,
  hintsUsedTotal,
  isDiagnosticLabel,
  nextHintFaultId,
  revealedHints,
  SCORE_WEIGHTS,
  startTroubleshooting,
  summarizeTroubleshooting,
  troubleshootScoreOf,
  troubleshootSummaryText,
  unwrap,
  type LabState,
  type ObjectiveOutcome
} from '@engine/index'
import { healthyLab03 } from './bases'
import { loadTroubleshootingLab, repairOfficial } from '../labs/depannage-helpers'

function started(): { state: LabState; faultId: string } {
  const r = unwrap(
    startTroubleshooting(healthyLab03(), { seed: 7, faults: [{ id: 'windows.service-stopped' }] })
  )
  return { state: r.state, faultId: r.value.faults[0]!.id }
}

const stats = { commandsPlayed: 1, hintsUsed: 0, elapsedMs: 90_000, repaired: true, gaveUp: false }

const obj = (kind: ObjectiveOutcome['kind'], ok: boolean, id = `${kind}-${ok}`): ObjectiveOutcome => ({
  id,
  label: id,
  kind,
  ok
})

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

describe('règles de calcul du résultat (troubleshootScoreOf)', () => {
  it('poids déclarés : 60 / 25 / 15, total 100', () => {
    expect(SCORE_WEIGHTS).toEqual({ repair: 60, function: 25, constraint: 15 })
  })

  it('tout validé : 100 ; rien : 0 ; prorata par catégorie', () => {
    const all = [obj('repair', true), obj('function', true), obj('constraint', true)]
    expect(troubleshootScoreOf(all).score).toBe(100)
    expect(troubleshootScoreOf(all.map((o) => ({ ...o, ok: false }))).score).toBe(0)
    // Réparé, usage rétabli, une contrainte sur deux dégradée : 60 + 25 + 7,5 → 93 (arrondi)
    const degraded = [
      obj('repair', true),
      obj('function', true),
      obj('constraint', true, 'c1'),
      obj('constraint', false, 'c2')
    ]
    const r = troubleshootScoreOf(degraded)
    expect(r.score).toBe(93)
    expect(r.breakdown.map((b) => [b.kind, b.weight, b.met, b.total])).toEqual([
      ['repair', 60, 1, 1],
      ['function', 25, 1, 1],
      ['constraint', 15, 1, 2]
    ])
  })

  it('catégorie absente : son poids est redistribué (rétablissement seul = 100 points)', () => {
    expect(troubleshootScoreOf([obj('repair', true)]).score).toBe(100)
    expect(troubleshootScoreOf([obj('repair', true, 'a'), obj('repair', false, 'b')]).score).toBe(50)
    const two = troubleshootScoreOf([obj('repair', true), obj('function', false)])
    expect(two.breakdown.reduce((n, b) => n + b.weight, 0)).toBe(100)
    expect(two.score).toBe(71) // 60 / 85 × 100 = 70,6
    expect(troubleshootScoreOf([]).score).toBe(0)
  })
})

describe('summarizeTroubleshooting : résultat, autonomie, descriptif', () => {
  it('panne réparée sans objectifs de lab : 100, autonome, limites annoncées, aucun « chemin le plus court »', () => {
    const { state } = started()
    const fixed = repairOfficial(state)
    const s = summarizeTroubleshooting(state, stats, { current: fixed })
    expect(s.faults).toHaveLength(1)
    expect(s.faults[0]!.healed).toBe(true)
    expect(s.faults[0]!.repairSteps.length).toBe(s.officialCommands)
    expect(s.faults[0]!.chain).toEqual([s.faults[0]!.cause])
    expect(s.faults[0]!.review).toContain('où regarder')
    expect(s.outcome).toBe('resolu')
    expect(s.score).toBe(100)
    expect(s.autonomy).toEqual({ hintsUsed: 0, hintsAvailable: 3, level: 'autonome' })
    expect(s.limits.some((l) => l.includes('seule réparation des pannes'))).toBe(true)
    expect(s.limits.some((l) => l.includes('ne mesure ni la compréhension'))).toBe(true)
    expect(JSON.stringify(s)).not.toMatch(/chemin le plus court/i)
    expect(s).not.toHaveProperty('extraCommands')
  })

  it('les indices n’enlèvent aucun point au résultat : ils changent le niveau d’autonomie', () => {
    const { state } = started()
    const fixed = repairOfficial(state)
    const hinted = summarizeTroubleshooting(state, { ...stats, hintsUsed: 1 }, { current: fixed })
    expect(hinted.score).toBe(100)
    expect(hinted.autonomy.level).toBe('guide')
    expect(hinted.verdict).toContain('1 indice')
    const assisted = summarizeTroubleshooting(state, { ...stats, hintsUsed: 3 }, { current: fixed })
    expect(assisted.score).toBe(100)
    expect(assisted.autonomy.level).toBe('assiste')
    expect(assisted.verdict).toContain('3 indices')
  })

  it('le nombre de commandes et la durée sont descriptifs : un chemin long garde 100', () => {
    const { state } = started()
    const fixed = repairOfficial(state)
    const long = summarizeTroubleshooting(
      state,
      { ...stats, commandsPlayed: 40, elapsedMs: 3_600_000 },
      { current: fixed }
    )
    expect(long.score).toBe(100)
    expect(long.playedCommands).toBe(40)
    expect(long.elapsedMs).toBe(3_600_000)
  })

  it('abandon ou panne non réparée : 0, cause et correction fournies', () => {
    const { state } = started()
    const gaveUp = summarizeTroubleshooting(
      state,
      { ...stats, repaired: false, gaveUp: true },
      { current: state }
    )
    expect(gaveUp.score).toBe(0)
    expect(gaveUp.outcome).toBe('abandonne')
    expect(gaveUp.repaired).toBe(false)
    expect(gaveUp.faults[0]!.healed).toBe(false)
    expect(gaveUp.faults[0]!.repairSteps.length).toBeGreaterThan(0)
    expect(gaveUp.verdict).toContain('abandonné')
    const notFixed = summarizeTroubleshooting(state, { ...stats, repaired: false })
    expect(notFixed.outcome).toBe('non-resolu')
    expect(notFixed.score).toBe(0)
    expect(notFixed.faults[0]!.healed).toBeNull()
  })

  it('examen : autonomie non évaluée, indices indisponibles, mode conservé', () => {
    const { state } = started()
    const s = summarizeTroubleshooting(state, { ...stats, mode: 'exam' }, { current: repairOfficial(state) })
    expect(s.mode).toBe('exam')
    expect(s.autonomy).toEqual({ hintsUsed: 0, hintsAvailable: 0, level: 'non-evaluee' })
    expect(s.verdict).toContain('examen')
    expect(summarizeTroubleshooting(state, stats).mode).toBe('training')
  })

  it('journal : commandes de diagnostic reconnues, changements listés ; absent → limite annoncée', () => {
    const { state } = started()
    const journal = [
      'ping 192.168.10.1 (sur PC1)',
      'nslookup srv1.lab.local (sur PC1)',
      'Get-Service DNS (sur SRV1)',
      'Démarrer le service DNS sur SRV1',
      'show ip route (sur R1)'
    ]
    const s = summarizeTroubleshooting(state, { ...stats, journal }, { current: repairOfficial(state) })
    expect(s.diagnosticCommands).toBe(4)
    expect(s.changes).toEqual(['Démarrer le service DNS sur SRV1'])
    expect(s.limits.some((l) => l.includes('Journal des commandes non fourni'))).toBe(false)
    const silent = summarizeTroubleshooting(state, stats, { current: repairOfficial(state) })
    expect(silent.limits.some((l) => l.includes('Journal des commandes non fourni'))).toBe(true)
    expect(isDiagnosticLabel('ipconfig /renew (sur PC1)')).toBe(false)
    expect(isDiagnosticLabel('ipconfig /all (sur PC1)')).toBe(true)
    expect(isDiagnosticLabel('sudo systemctl restart smbd (sur LSRV1)')).toBe(false)
    expect(isDiagnosticLabel('systemctl status smbd (sur LSRV1)')).toBe(true)
  })

  it('la correction de référence décrite guérit bien le lab', () => {
    const { state } = started()
    expect(allRepaired(repairOfficial(state))).toBe(true)
  })
})

describe('summarizeTroubleshooting avec les objectifs d’un lab (lab 45, panne composée)', () => {
  const { lab, start } = loadTroubleshootingLab('lab-45-depannage-compose.json')

  it('criteriaOutcomes classe les critères : réparation, usage attendu, contrainte (vraie au départ)', () => {
    const out = criteriaOutcomes(start, start, lab)
    expect(out.map((o) => [o.id, o.kind, o.ok])).toEqual([
      ['panne-composee', 'repair', false],
      ['dns-demarre', 'function', false],
      ['enregistrement', 'function', false],
      ['resolution', 'function', false],
      ['partage', 'function', false]
    ])
  })

  it('chaîne des causes d’une panne composée : la masquante puis la masquée', () => {
    const s = summarizeTroubleshooting(start, { ...stats, repaired: false }, { current: start, lab })
    expect(s.faults[0]!.chain).toHaveLength(2)
    expect(s.faults[0]!.chain[0]).toMatch(/^Cause visible en premier/)
    expect(s.faults[0]!.chain[1]).toMatch(/^Cause masquée/)
    expect(s.faults[0]!.referenceExplanation).toContain('réparation qui fonctionne')
    expect(s.outcome).toBe('non-resolu')
    expect(s.score).toBe(0)
  })

  it('réparation partielle (service relancé seul) : objectifs partiellement atteints, résultat intermédiaire', () => {
    const f = start.troubleshooting!.faults[0]!
    const [startService] = getFault(f.id)!.repair(start, f.params)
    const half = unwrap(dispatch(start, startService!)).state
    const s = summarizeTroubleshooting(start, { ...stats, repaired: false }, { current: half, lab })
    expect(s.outcome).toBe('partiel')
    expect(s.objectives.filter((o) => o.ok).map((o) => o.id)).toEqual(['dns-demarre'])
    // Usage attendu : 1 sur 4 → 25 × 1/4 = 6 ; rétablissement 0 ; contraintes absentes (redistribuées)
    expect(s.score).toBeGreaterThan(0)
    expect(s.score).toBeLessThan(20)
    expect(s.faults[0]!.healed).toBe(false)
  })

  it('réparation complète : résolu, 100, usage vérifié ; compte rendu texte complet', () => {
    const fixed = repairOfficial(start)
    expect(checkLab(fixed, lab).passed).toBe(lab.criteria.length)
    const s = summarizeTroubleshooting(
      start,
      { ...stats, journal: ['nslookup srv1.lab.local (sur PC1)', 'Démarrer le service DNS sur SRV1'] },
      { current: fixed, lab }
    )
    expect(s.outcome).toBe('resolu')
    expect(s.score).toBe(100)
    expect(s.verdict).toContain('usage attendu vérifié')
    expect(s.breakdown.map((b) => b.kind)).toEqual(['repair', 'function'])
    const text = troubleshootSummaryText(s)
    expect(text).toContain('Résultat : 100 / 100')
    expect(text).toContain('Cause visible en premier')
    expect(text).toContain('[OK] (Usage attendu)')
    expect(text).toContain('Changements effectués :')
    expect(text).toContain('Limites du bilan')
    expect(text).not.toMatch(/chemin le plus court/i)
  })

  it('contrainte dégradée : résolu avec réserves, points retirés sur les contraintes seulement', () => {
    const objectives: ObjectiveOutcome[] = [
      obj('repair', true, 'p'),
      obj('function', true, 'u'),
      obj('constraint', false, 'securite')
    ]
    const s = summarizeTroubleshooting(start, stats, { objectives })
    expect(s.outcome).toBe('resolu-avec-reserves')
    expect(s.score).toBe(85)
    expect(s.verdict).toContain('1 contrainte dégradée')
  })

  it('déterminisme : deux bilans du même état sont identiques', () => {
    const fixed = repairOfficial(start)
    const a = summarizeTroubleshooting(start, stats, { current: fixed, lab })
    const b = summarizeTroubleshooting(start, stats, { current: fixed, lab })
    expect(a).toEqual(b)
  })
})
