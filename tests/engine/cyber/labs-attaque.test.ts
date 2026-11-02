/**
 * Labs de la v2.6.1 (31 à 35) : compromission et durcissement de l'annuaire, attaque et durcissement
 * du réseau L2, sujet Red/Blue. Chaque lab démarre incomplet ; la solution, saisie comme le ferait
 * l'étudiant (scénarios du panneau Simulation, console PowerShell, GPO, console IOS), est validée à 100 %.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  buildLabStart,
  checkLab,
  command,
  createGame,
  criterionCatalog,
  DEFAULT_DOMAIN_POLICY_ID,
  dispatch,
  draftFromLab,
  finishExam,
  parseLab,
  runIosScript,
  startExam,
  type AnyCommand,
  type LabDefinition,
  type LabState
} from '@engine/index'
import lab31 from '../../../labs/lab-31-compromission-ad.json'
import lab32 from '../../../labs/lab-32-durcissement-ad-cyber.json'
import lab33 from '../../../labs/lab-33-attaque-l2.json'
import lab34 from '../../../labs/lab-34-durcissement-reseau.json'
import lab35 from '../../../labs/lab-35-red-blue.json'
import { run } from '../shell/helpers'

// Solution enregistrée en commandes nommées et rejouée comme un rendu (mode enseignant, #405)
vi.mock('@engine/index', async (importOriginal) =>
  (await import('../teacher/recorder')).instrumentEngine(importOriginal)
)

const id = (s: LabState, name: string) => Object.values(s.devices).find((d) => d.name === name)?.id ?? ''
const load = (raw: unknown): LabDefinition => {
  const parsed = parseLab(raw)
  if (!parsed.ok) throw new Error(parsed.message)
  return parsed.lab
}
const apply = (s: LabState, cmd: AnyCommand): LabState => {
  const r = dispatch(s, cmd as Parameters<typeof dispatch>[1])
  if (!r.ok) throw new Error(r.error.message)
  return r.state
}
/** Joue un scénario depuis le panneau Scénarios (commande nommée, comme l'interface). */
const play = (s: LabState, scenario: string): LabState => apply(s, command('cyber.playStep', scenario, 0))

/** Correctifs de l'annuaire : mots de passe réinitialisés en PowerShell, verrouillage dans la GPO du domaine. */
function hardenAd(s: LabState): LabState {
  const srv = id(s, 'SRV1')
  for (const [sam, pwd] of [
    ['jdupont', 'Xk9#mQ2vLp!7'],
    ['svc-sql', 'Wp4$nT8zRb!5']
  ])
    s = run(
      s,
      srv,
      `Set-ADAccountPassword -Identity ${sam} -Reset -NewPassword (ConvertTo-SecureString '${pwd}' -AsPlainText -Force)`
    ).state
  return apply(
    s,
    command('gpo.updateSettings', 'lab.local', DEFAULT_DOMAIN_POLICY_ID, {
      computer: { lockoutThreshold: 5, lockoutDuration: 30, lockoutReset: 30 }
    })
  )
}

/** Correctifs du switch : inspection ARP (avec snooping) et négociation de trunk coupée sur le port de l'hôte. */
const hardenL2 = (s: LabState, port = 'Fa0/3'): LabState =>
  runIosScript(s, id(s, 'SW1'), [
    'enable',
    'configure terminal',
    'ip dhcp snooping',
    'ip dhcp snooping vlan 10',
    'ip arp inspection vlan 10',
    `interface ${port}`,
    'switchport nonegotiate',
    'end'
  ])

interface Case {
  lab: LabDefinition
  /** Critères validés au départ. */
  startPassed: number
  solve: (s: LabState) => LabState
}

const CASES: Case[] = [
  {
    lab: load(lab31),
    startPassed: 0,
    solve: (s) => ['auth-repetee', 'compte-service', 'reutilisation-acces'].reduce(play, s)
  },
  { lab: load(lab32), startPassed: 0, solve: hardenAd },
  { lab: load(lab33), startPassed: 0, solve: (s) => ['usurpation-arp', 'saut-de-vlan'].reduce(play, s) },
  { lab: load(lab34), startPassed: 0, solve: hardenL2 },
  { lab: load(lab35), startPassed: 0, solve: (s) => hardenL2(hardenAd(s), 'Fa0/4') }
]

describe('Labs de cybersécurité (attaque et durcissement)', () => {
  for (const { lab, startPassed, solve } of CASES)
    it(`${lab.id} : départ incomplet, solution validée à 100 %`, () => {
      const start = buildLabStart(lab.start)
      expect(checkLab(start, lab).passed).toBe(startPassed)
      const after = checkLab(solve(start), lab)
      expect(after.results.filter((r) => !r.ok).map((r) => r.id)).toEqual([])
    })

  it('la vérification d’un lab de durcissement rejoue les scénarios à blanc : l’état n’est pas modifié', () => {
    const start = buildLabStart(load(lab32).start)
    const before = JSON.stringify(start)
    checkLab(start, load(lab32))
    expect(JSON.stringify(start)).toBe(before)
    expect(start.domains['lab.local']!.users.some((u) => u.compromised)).toBe(false)
  })

  it('la topologie de départ porte les faiblesses voulues (comptes faibles, SPN ancien, accès administrateur)', () => {
    const s = buildLabStart(load(lab31).start)
    const users = s.domains['lab.local']!.users
    expect(users.find((u) => u.sam === 'svc-sql')).toMatchObject({ spns: ['MSSQLSvc/srv1.lab.local:1433'] })
    expect(s.clock - users.find((u) => u.sam === 'svc-sql')!.passwordLastSet).toBeGreaterThanOrEqual(
      400 * 86_400_000
    )
    const pc1 = s.devices[id(s, 'PC1')]
    expect(pc1?.kind === 'client' && pc1.host.session).toMatchObject({ user: 'jdupont' })
    expect(pc1?.kind === 'client' && pc1.host.adminTargets).toEqual([id(s, 'SRV1')])
    expect(s.cyber.scenarios).toEqual(['auth-repetee', 'compte-service', 'reutilisation-acces'])
  })

  it('un scénario non activé dans le lab est refusé (lab 33 : pas de scénario annuaire)', () => {
    const s = buildLabStart(load(lab33).start)
    const r = dispatch(s, command('cyber.playStep', 'auth-repetee', 0))
    expect(!r.ok && r.error.code).toBe('ScenarioDisabled')
  })

  it('aucun indice ne cite le scénario ou le compte visé par le critère', () => {
    for (const { lab } of CASES)
      for (const c of lab.criteria) {
        const check = c.check as { scenario?: string; account?: string }
        for (const v of [check.scenario, check.account])
          if (v) expect(c.hint.toLowerCase(), `${lab.id} › ${c.id}`).not.toContain(v.toLowerCase())
        expect(c.hint.length).toBeGreaterThan(20)
      }
  })
})

describe('Sujet Red/Blue (lab 35)', () => {
  const lab = load(lab35)

  it('réglages de partie du lab : minuteur, tours, budget, camp de l’IA', () => {
    const s = buildLabStart(lab.start)
    expect(s.cyber.game).toEqual({ maxTurns: 6, timerSeconds: 900, blueBudget: 4, aiSide: 'red' })
    expect(s.cyber.scenarios).toBeNull()
  })

  it('le lab impose le camp de l’IA : le joueur qui demande Red joue Blue', () => {
    const s = buildLabStart(lab.start)
    expect(createGame(s, { side: 'red', seed: 3 }).side).toBe('blue')
    expect(createGame(s, { side: 'blue', seed: 3 }).side).toBe('blue')
  })

  it('combine annuaire et réseau : les cinq scénarios réussissent au départ', () => {
    const all = ['auth-repetee', 'compte-service', 'reutilisation-acces', 'usurpation-arp', 'saut-de-vlan']
    let s = buildLabStart(lab.start)
    const outcomes = all.map((scenario) => {
      const r = dispatch(s, command('cyber.playStep', scenario, 0))
      if (!r.ok) throw new Error(r.error.message)
      s = r.state
      return (r.value as { success: boolean }).success
    })
    expect(outcomes).toEqual([true, true, true, true, true])
    expect(s.cyber.intercepts).toHaveLength(1)
  })

  it('rejouer les attaques avant de durcir ne fausse pas la vérification (évaluation sans trace d’attaque)', () => {
    const start = buildLabStart(lab.start)
    const dirty = [
      'auth-repetee',
      'compte-service',
      'reutilisation-acces',
      'usurpation-arp',
      'saut-de-vlan'
    ].reduce(play, start)
    expect(checkLab(dirty, lab).passed).toBe(0)
    expect(checkLab(hardenL2(hardenAd(dirty), 'Fa0/4'), lab).passed).toBe(5)
  })

  it('disponible en mode examen : durée tirée du lab, note à la vérification finale', () => {
    const exam = startExam(lab, 0)
    expect(exam.minutes).toBe(45)
    const start = buildLabStart(lab.start)
    expect(finishExam(exam, start, lab, 60_000).grade).toBe(0)
    const solved = finishExam(exam, hardenL2(hardenAd(start), 'Fa0/4'), lab, 60_000)
    expect(solved).toMatchObject({ passed: 5, total: 5, grade: 20 })
  })

  it('disponible dans l’éditeur de labs : brouillon repris et critères connus du catalogue', () => {
    const draft = draftFromLab(lab)
    expect(draft.criteria).toHaveLength(5)
    const types = new Set(criterionCatalog().map((c) => c.type))
    for (const c of draft.criteria) expect(types.has(c.check.type)).toBe(true)
    expect(types.has('scenarioOutcome')).toBe(true)
  })
})

describe('Configuration des labs de cybersécurité', () => {
  const start = buildLabStart(load(lab35).start)

  it('cyber.configure refuse un scénario inconnu et des valeurs hors limites', () => {
    const unknown = dispatch(start, command('cyber.configure', { scenarios: ['inconnu'] }))
    expect(!unknown.ok && unknown.error.code).toBe('ScenarioNotFound')
    const bad = dispatch(start, command('cyber.configure', { attempts: 0 }))
    expect(!bad.ok && bad.error.code).toBe('InvalidCyberConfig')
  })

  it('un SPN mal formé est refusé', () => {
    const r = dispatch(
      start,
      command('adds.setServicePrincipalNames', 'lab.local', 'svc-sql', ['sans-classe'])
    )
    expect(!r.ok && r.error.code).toBe('InvalidSpn')
  })

  it('l’accès administrateur vise un autre serveur ou poste', () => {
    const self = dispatch(start, command('cyber.setAdminAccess', id(start, 'PC1'), [id(start, 'PC1')]))
    expect(self.ok).toBe(false)
    const sw = dispatch(start, command('cyber.setAdminAccess', id(start, 'PC1'), [id(start, 'SW1')]))
    expect(sw.ok).toBe(false)
  })

  it('l’IA Red du lab 33 n’enchaîne que les scénarios activés', () => {
    const l2 = buildLabStart(load(lab33).start)
    expect([...createGame(l2, { side: 'blue', seed: 1 }).redPlan].sort()).toEqual([
      'saut-de-vlan',
      'usurpation-arp'
    ])
  })
})
