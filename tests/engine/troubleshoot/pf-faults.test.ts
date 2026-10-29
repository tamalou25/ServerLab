/**
 * Pannes du pare-feu pfSense (v2.10, #248, domaine `pare-feu`) : chaque panne se tire sur le lab sain du pare-feu
 * (lab 59), produit un symptôme lu par la sonde de joignabilité (le moteur de paquets), se répare avec les
 * commandes `pf.*` ; variantes forcées, symptômes vus depuis les postes (ping, curl) et garde-fous du tirage.
 */
import { describe, expect, it } from 'vitest'
import {
  dispatch,
  FAULTS,
  getFault,
  startTroubleshooting,
  type FaultTargetParams,
  type LabState
} from '@engine/index'
import { mulberry32 } from '@engine/core/prng'
import { run } from '../shell/helpers'
import { buildPfHealthy } from './bases-pf'

const healthy = buildPfHealthy()
const id = (s: LabState, name: string) => Object.values(s.devices).find((d) => d.name === name)?.id ?? ''
const PF = FAULTS.filter((f) => f.domain === 'pare-feu')

function applyAll(state: LabState, commands: ReturnType<NonNullable<ReturnType<typeof getFault>>['repair']>) {
  let next = state
  for (const c of commands) {
    const r = dispatch(next, c)
    if (!r.ok) throw new Error(`${c.type} : ${r.error.message}`)
    next = r.state
  }
  return next
}

/** Cible tirée avec une graine, filtrée par un prédicat (pour atteindre une variante précise). */
function pickWhere(faultId: string, accept: (p: FaultTargetParams) => boolean): FaultTargetParams {
  const fault = getFault(faultId)!
  for (let seed = 1; seed <= 300; seed++) {
    const p = fault.pick(healthy, mulberry32(seed))
    if (p && accept(p)) return p
  }
  throw new Error(`Aucune cible ${faultId} ne convient`)
}

const sh = (s: LabState, machine: string, line: string) => run(s, id(s, machine), line, { shell: 'cmd' })
const ps = (s: LabState, machine: string, line: string) => run(s, id(s, machine), line, { shell: 'cmd' })

describe('catalogue des pannes du pare-feu', () => {
  it('8 pannes de domaine pare-feu, identifiants uniques, trois indices non vides', () => {
    expect(PF.map((f) => f.id).sort()).toEqual([
      'pf.alias-wrong',
      'pf.dhcp-options',
      'pf.forward-target',
      'pf.nat-disabled',
      'pf.no-default-gateway',
      'pf.rule-disabled',
      'pf.rule-order',
      'pf.rule-removed'
    ])
  })

  it.each(PF.map((f) => [f.id] as const))('%s : tirage, symptôme, réparation officielle', (faultId) => {
    const fault = getFault(faultId)!
    for (const seed of [1, 2, 3, 4, 5]) {
      const p = fault.pick(healthy, mulberry32(seed))
      expect(p, `graine ${seed}`).not.toBeNull()
      for (const v of Object.values(p!)) expect(['string', 'number', 'boolean']).toContain(typeof v)
      // Sain : guéri, sans symptôme
      expect(fault.healed(healthy, p!)).toBe(true)
      expect(fault.symptomVisible(healthy, p!)).toBe(false)
      // Cassé : symptôme, non guéri, textes en français sans la cause ni l'identifiant
      const bad = applyAll(healthy, fault.inject(healthy, p!))
      expect(fault.symptomVisible(bad, p!)).toBe(true)
      expect(fault.healed(bad, p!)).toBe(false)
      expect(fault.ticket(bad, p!)).not.toContain(faultId)
      expect(fault.hints(bad, p!)).toHaveLength(3)
      expect(fault.cause(bad, p!).length).toBeGreaterThan(20)
      // Réparé
      const fixed = applyAll(bad, fault.repair(bad, p!))
      expect(fault.healed(fixed, p!)).toBe(true)
      expect(fault.symptomVisible(fixed, p!)).toBe(false)
    }
  })

  it('le tirage est déterministe (même graine, mêmes cibles)', () => {
    for (const f of PF) expect(f.pick(healthy, mulberry32(9))).toEqual(f.pick(healthy, mulberry32(9)))
  })

  it('une panne ne s’applique pas à un lab sans pare-feu', () => {
    const lab = startTroubleshooting(healthy, { seed: 1, faults: [{ id: 'pf.nat-disabled' }] })
    expect(lab.ok).toBe(true)
    // Un lab sans pare-feu (état vide) ne donne aucune cible
    const empty = { ...healthy, devices: {} }
    for (const f of PF) expect(f.pick(empty, mulberry32(1))).toBeNull()
  })
})

describe('symptômes vus depuis les postes', () => {
  it('NAT désactivé : le ping vers Internet échoue, le site reste publié', () => {
    const p = pickWhere('pf.nat-disabled', (t) => t['mode'] === 'disabled' && t['fromName'] === 'PC1')
    const bad = applyAll(healthy, getFault('pf.nat-disabled')!.inject(healthy, p))
    expect(sh(bad, 'PC1', 'ping 8.8.8.8').text).toContain('perdus = 4')
    expect(sh(healthy, 'PC1', 'ping 8.8.8.8').text).toContain('perdus = 0')
    expect(sh(bad, 'INTERNET', 'curl -sI http://45.10.0.1/').text).toContain('200')
  })

  it('redirection vers la mauvaise adresse : le site publié ne répond plus (curl)', () => {
    const p = pickWhere('pf.forward-target', (t) => t['variant'] === 'ip')
    const bad = applyAll(healthy, getFault('pf.forward-target')!.inject(healthy, p))
    expect(sh(healthy, 'INTERNET', 'curl -sI http://45.10.0.1/').text).toContain('200')
    expect(sh(bad, 'INTERNET', 'curl -sI http://45.10.0.1/').text).not.toContain('200')
  })

  it('redirection vers le mauvais port : aucun service n’écoute sur la cible', () => {
    const p = pickWhere('pf.forward-target', (t) => t['variant'] === 'port')
    const bad = applyAll(healthy, getFault('pf.forward-target')!.inject(healthy, p))
    expect(sh(bad, 'INTERNET', 'curl -sI http://45.10.0.1/').text).not.toContain('200')
  })

  it('DHCP désactivé : le poste ne reçoit plus de bail', () => {
    const p = pickWhere('pf.dhcp-options', (t) => t['variant'] === 'disabled')
    const bad = applyAll(healthy, getFault('pf.dhcp-options')!.inject(healthy, p))
    expect(ps(healthy, 'PC2', 'ipconfig /renew').text).toContain('192.168.1.100')
    expect(ps(bad, 'PC2', 'ipconfig /renew').text).not.toContain('192.168.1.100')
  })

  it('DHCP avec mauvaise passerelle : le bail est accordé mais la passerelle est fausse', () => {
    const p = pickWhere('pf.dhcp-options', (t) => t['variant'] === 'gateway')
    const bad = applyAll(healthy, getFault('pf.dhcp-options')!.inject(healthy, p))
    const lease = ps(bad, 'PC2', 'ipconfig /renew').state.devices[id(bad, 'PC2')]!.interfaces[0]!.dhcpLease!
    expect(lease.gateway).toBe(String(p['wrong']))
  })

  it('passerelle par défaut absente : les réseaux du fournisseur ne sont plus joints', () => {
    const bad = applyAll(
      healthy,
      getFault('pf.no-default-gateway')!.inject(
        healthy,
        getFault('pf.no-default-gateway')!.pick(healthy, mulberry32(1))!
      )
    )
    const fw = bad.devices[id(bad, 'FW1')]!
    if (fw.kind !== 'firewall') throw new Error('pare-feu attendu')
    expect(fw.pf.gateways).toEqual([])
    expect(sh(bad, 'PC1', 'ping 8.8.8.8').text).toContain('Impossible de joindre le réseau de destination')
  })
})

describe('règles : variantes et réparations réelles', () => {
  it('rule-order : la règle Block ajoutée précède la règle Pass', () => {
    const p = pickWhere('pf.rule-order', () => true)
    const bad = applyAll(healthy, getFault('pf.rule-order')!.inject(healthy, p))
    const fw = bad.devices[String(p['device'])]!
    if (fw.kind !== 'firewall') throw new Error('pare-feu attendu')
    const block = fw.pf.rules.findIndex((r) => r.descr === p['blockDescr'])
    const pass = fw.pf.rules.findIndex((r) => r.id === p['rule'])
    expect(block).toBeGreaterThanOrEqual(0)
    expect(block).toBe(pass - 1)
    // Réparation de l'élève : déplacer la règle Pass avant la règle Block
    const blockId = fw.pf.rules[block]!.id
    const moved = applyAll(bad, [{ type: 'pf.moveRule', args: [fw.id, String(p['rule']), blockId] }])
    expect(getFault('pf.rule-order')!.healed(moved, p)).toBe(true)
  })

  it('rule-removed : la règle recréée reprend sa place et ses paramètres', () => {
    const p = pickWhere('pf.rule-removed', () => true)
    const fault = getFault('pf.rule-removed')!
    const bad = applyAll(healthy, fault.inject(healthy, p))
    const fixed = applyAll(bad, fault.repair(bad, p))
    const before = healthy.devices[String(p['device'])]!
    const after = fixed.devices[String(p['device'])]!
    if (before.kind !== 'firewall' || after.kind !== 'firewall') throw new Error('pare-feu attendu')
    const strip = (rules: typeof before.pf.rules) => rules.map(({ id: _id, ...r }) => (void _id, r))
    expect(strip(after.pf.rules)).toEqual(strip(before.pf.rules))
  })

  it('alias-wrong : l’alias est restauré tel quel', () => {
    const p = pickWhere('pf.alias-wrong', () => true)
    const fault = getFault('pf.alias-wrong')!
    const bad = applyAll(healthy, fault.inject(healthy, p))
    const fixed = applyAll(bad, fault.repair(bad, p))
    const alias = (s: LabState) => {
      const fw = s.devices[String(p['device'])]!
      return fw.kind === 'firewall' ? fw.pf.aliases : []
    }
    expect(alias(bad)).not.toEqual(alias(healthy))
    expect(alias(fixed)).toEqual(alias(healthy))
  })
})

describe('tirage de plusieurs pannes', () => {
  it('deux pannes du domaine pare-feu sont compatibles et se réparent dans n’importe quel ordre', () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const r = startTroubleshooting(healthy, { seed, domain: 'pare-feu', count: 2 })
      if (!r.ok) continue
      const faults = r.value.faults
      expect(faults).toHaveLength(2)
      for (const order of [faults, [...faults].reverse()]) {
        let s = r.state
        for (const f of order) s = applyAll(s, getFault(f.id)!.repair(s, f.params))
        for (const f of faults) expect(getFault(f.id)!.healed(s, f.params), f.id).toBe(true)
      }
    }
  })
})
