/**
 * Parcours (pathway.ts) et progression (progress.ts) : cohérence du parcours PME (labs existants,
 * prérequis connus, compétences du catalogue, progression guidé → moins guidé → incident → révision),
 * lecture tolérante du fichier de progression (anciennes données, entrées corrompues), règles « exercice
 * terminé » / « compétence démontrée », prochaine étape recommandée, révision différée, déterminisme.
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  addAttempt,
  attemptsOfStep,
  COMPETENCES,
  competenceStatus,
  getPathway,
  HELP_LABELS,
  MAX_ATTEMPTS,
  parseProgress,
  PATHWAY_PME,
  PATHWAYS,
  pathwayOverview,
  PHASE_LABELS,
  serializeProgress,
  stepsForLab,
  type ProgressAttempt
} from '@engine/index'

const labIds = readdirSync(join(__dirname, '../../../labs'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''))

const T0 = Date.UTC(2026, 10, 2, 9, 0, 0)
const DAY = 86_400_000
const iso = (t: number) => new Date(t).toISOString()

let n = 0
const attempt = (patch: Partial<ProgressAttempt> & { labId: string }): ProgressAttempt => ({
  id: `a${++n}`,
  mode: 'lab',
  finishedAt: iso(T0),
  passed: 5,
  total: 5,
  success: true,
  hintsUsed: 0,
  hintsAvailable: 0,
  gaveUp: false,
  competences: [],
  ...patch
})

describe('parcours PME', () => {
  it('réutilise des labs fournis existants, prérequis connus, compétences du catalogue, suivant cohérent', () => {
    expect(PATHWAYS.map((p) => p.id)).toEqual(['pme-atelier-lambert'])
    expect(getPathway('pme-atelier-lambert')).toBe(PATHWAY_PME)
    const ids = new Set(PATHWAY_PME.steps.map((s) => s.id))
    expect(ids.size).toBe(PATHWAY_PME.steps.length)
    expect(PATHWAY_PME.steps.length).toBeGreaterThanOrEqual(8)
    expect(PATHWAY_PME.steps.length).toBeLessThanOrEqual(12)
    for (const s of PATHWAY_PME.steps) {
      expect(labIds, s.id).toContain(s.labId)
      for (const p of s.prerequisites) expect(ids.has(p), `${s.id} → ${p}`).toBe(true)
      for (const c of s.competences) expect(Object.keys(COMPETENCES)).toContain(c)
      expect(s.competences.length).toBeGreaterThan(0)
      expect(s.outcome.length).toBeGreaterThan(20)
      expect(s.story.length).toBeGreaterThan(40)
      if (s.next !== null) expect(ids.has(s.next)).toBe(true)
      expect(HELP_LABELS[s.help]).toBeTruthy()
      expect(PHASE_LABELS[s.phase]).toBeTruthy()
    }
    // Un seul dernier maillon, aucun cycle de prérequis (chaque prérequis précède l'étape)
    expect(PATHWAY_PME.steps.filter((s) => s.next === null)).toHaveLength(1)
    const order = new Map(PATHWAY_PME.steps.map((s, i) => [s.id, i]))
    for (const s of PATHWAY_PME.steps)
      for (const p of s.prerequisites) expect(order.get(p)!).toBeLessThan(order.get(s.id)!)
  })

  it('progression : guidé, puis moins guidé, puis incidents inconnus, puis révision différée en examen', () => {
    const phases = PATHWAY_PME.steps.map((s) => s.phase)
    const firstIndex = (p: string) => phases.indexOf(p as never)
    expect(firstIndex('guide')).toBe(0)
    expect(firstIndex('guide')).toBeLessThan(firstIndex('moins-guide'))
    expect(firstIndex('moins-guide')).toBeLessThan(firstIndex('incident'))
    expect(firstIndex('incident')).toBeLessThan(firstIndex('revision'))
    const revision = PATHWAY_PME.steps.find((s) => s.phase === 'revision')!
    expect(revision.mode).toBe('exam')
    expect(revision.help).toBe('examen')
    expect(revision.deferDaysAfter?.step).toBe('etape-05')
    // Les incidents reposent sur un ticket seul ; la mission a des variantes par graine
    for (const s of PATHWAY_PME.steps.filter((x) => x.phase === 'incident')) expect(s.help).toBe('ticket')
    expect(stepsForLab('lab-60-mission-compta')[0]!.step.variantSeeds?.length).toBeGreaterThan(1)
    expect(stepsForLab('lab-05-ntfs').map((x) => x.step.id)).toEqual(['etape-05', 'etape-12'])
    expect(stepsForLab('lab-99')).toEqual([])
  })
})

describe('fichier de progression', () => {
  it('lit un fichier valide, écarte les entrées corrompues une à une, tolère les champs inconnus', () => {
    const good = attempt({ labId: 'lab-01-adressage' })
    const parsed = parseProgress({
      formatVersion: 1,
      attempts: [good, { id: 'x' }, null, { ...good, id: 'b', passed: -1 }, { ...good, id: 'c', extra: true }]
    })
    expect(parsed.map((a) => a.id)).toEqual([good.id, 'c'])
    expect(parsed[1]).not.toHaveProperty('extra')
  })

  it('fichier absent, illisible ou d’un autre format : liste vide, jamais d’exception', () => {
    expect(parseProgress(undefined)).toEqual([])
    expect(parseProgress('texte')).toEqual([])
    expect(parseProgress({ formatVersion: 2, attempts: [] })).toEqual([])
    expect(parseProgress({ attempts: [attempt({ labId: 'x' })] })).toEqual([])
    expect(parseProgress(JSON.parse(serializeProgress([])))).toEqual([])
  })

  it('aller-retour sérialisation, défauts remplis, limite de taille (les plus récentes gardées)', () => {
    const a = attempt({ labId: 'lab-02-dhcp', score: 90 })
    const back = parseProgress(JSON.parse(serializeProgress([a])))
    expect(back).toEqual([a])
    const minimal = parseProgress({
      formatVersion: 1,
      attempts: [
        {
          id: 'm',
          labId: 'lab-01-adressage',
          mode: 'lab',
          finishedAt: iso(T0),
          passed: 1,
          total: 1,
          success: true
        }
      ]
    })
    expect(minimal[0]).toMatchObject({ hintsUsed: 0, hintsAvailable: 0, gaveUp: false, competences: [] })
    const many = Array.from({ length: MAX_ATTEMPTS + 5 }, (_, i) =>
      attempt({ id: `n${i}`, labId: 'lab-01-adressage' })
    )
    const kept = parseProgress({ formatVersion: 1, attempts: many })
    expect(kept).toHaveLength(MAX_ATTEMPTS)
    expect(kept[0]!.id).toBe('n5')
    let list: ProgressAttempt[] = []
    for (const m of many) list = addAttempt(list, m)
    expect(list).toHaveLength(MAX_ATTEMPTS)
    // Même identifiant : remplacé, pas dupliqué
    expect(addAttempt([a], { ...a, score: 50 })).toEqual([{ ...a, score: 50 }])
  })
})

describe('règles de progression', () => {
  const step = (id: string) => PATHWAY_PME.steps.find((s) => s.id === id)!

  it('au départ : rien de terminé, première étape recommandée, compétences non travaillées', () => {
    const o = pathwayOverview(PATHWAY_PME, [], T0)
    expect(o.completed).toBe(0)
    expect(o.recommended?.id).toBe('etape-01')
    expect(o.steps[0]!.state).toBe('recommande')
    expect(o.steps.slice(1).every((s) => s.state === 'disponible')).toBe(true)
    expect(o.steps.find((s) => s.step.id === 'etape-02')!.missingPrerequisites).toEqual(['etape-01'])
    expect(o.competences.every((c) => c.state === 'non-travaillee')).toBe(true)
    // La révision différée n'est pas recommandée tant que son étape d'origine n'est pas réussie
    expect(o.steps.find((s) => s.step.id === 'etape-12')!.availableFrom).toBeNull()
  })

  it('exercice terminé ≠ compétence démontrée : une réussite guidée ne suffit pas', () => {
    const a = attempt({ labId: 'lab-01-adressage', hintsUsed: 2, hintsAvailable: 7 })
    const o = pathwayOverview(PATHWAY_PME, [a], T0 + DAY)
    expect(o.steps[0]!.state).toBe('termine')
    expect(o.steps[0]!.successes).toBe(1)
    expect(o.recommended?.id).toBe('etape-02')
    const ipv4 = o.competences.find((c) => c.id === 'ipv4-adressage')!
    expect(ipv4.state).toBe('travaillee')
    expect(ipv4.missing).toContain('sans indice')
    // Un échec seul ne termine pas l'étape
    const fail = pathwayOverview(
      PATHWAY_PME,
      [attempt({ labId: 'lab-01-adressage', success: false, passed: 3 })],
      T0
    )
    expect(fail.steps[0]!.state).toBe('recommande')
    expect(fail.steps[0]!.attempts).toBe(1)
  })

  it('compétence démontrée par transfert : réussite autonome + réussite dans une autre étape', () => {
    const attempts = [
      attempt({ labId: 'lab-01-adressage' }), // autonome, ipv4 + routage
      attempt({ labId: 'lab-02-dhcp', hintsUsed: 1, finishedAt: iso(T0 + 3_600_000) }) // ipv4 travaillée ailleurs
    ]
    const ipv4 = competenceStatus(PATHWAY_PME, 'ipv4-adressage', attempts)
    expect(ipv4.state).toBe('demontree')
    expect(ipv4.stepsSucceeded).toEqual(['etape-01', 'etape-02'])
    const routage = competenceStatus(PATHWAY_PME, 'routage-passerelle', attempts)
    expect(routage.state).toBe('travaillee')
    expect(routage.missing).toContain('seconde réussite')
    // Deux réussites guidées dans deux étapes : travaillée, pas démontrée (aucune autonome)
    const guided = [
      attempt({ labId: 'lab-01-adressage', hintsUsed: 1 }),
      attempt({ labId: 'lab-02-dhcp', hintsUsed: 1 })
    ]
    expect(competenceStatus(PATHWAY_PME, 'ipv4-adressage', guided).state).toBe('travaillee')
  })

  it('compétence démontrée par révision différée : même étape, au moins un jour plus tard', () => {
    const sameDay = [
      attempt({ labId: 'lab-03-dns' }),
      attempt({ labId: 'lab-03-dns', finishedAt: iso(T0 + 3_600_000) })
    ]
    expect(competenceStatus(PATHWAY_PME, 'dns', sameDay).state).toBe('travaillee')
    const later = [
      attempt({ labId: 'lab-03-dns' }),
      attempt({ labId: 'lab-03-dns', finishedAt: iso(T0 + DAY), hintsUsed: 1 })
    ]
    expect(competenceStatus(PATHWAY_PME, 'dns', later).state).toBe('demontree')
  })

  it('révision différée en examen : comptée seulement en mode examen, disponible un jour après l’étape 5', () => {
    const base = ['lab-01-adressage', 'lab-02-dhcp', 'lab-03-dns', 'lab-04-ad-gpo'].map((labId, i) =>
      attempt({ labId, finishedAt: iso(T0 + i * 3_600_000) })
    )
    const five = attempt({ labId: 'lab-05-ntfs', finishedAt: iso(T0 + 5 * 3_600_000), hintsUsed: 1 })
    const o = pathwayOverview(PATHWAY_PME, [...base, five], T0 + 6 * 3_600_000)
    const rev = o.steps.find((s) => s.step.id === 'etape-12')!
    expect(rev.state).toBe('disponible')
    expect(rev.availableFrom).toBe(iso(T0 + 5 * 3_600_000 + DAY))
    // Une réussite en mode lab ne termine pas l'étape de révision
    expect(attemptsOfStep(step('etape-12'), [five])).toEqual([])
    const exam = attempt({ labId: 'lab-05-ntfs', mode: 'exam', finishedAt: iso(T0 + 2 * DAY) })
    expect(attemptsOfStep(step('etape-12'), [five, exam])).toEqual([exam])
    const later = pathwayOverview(PATHWAY_PME, [...base, five, exam], T0 + 3 * DAY)
    expect(later.steps.find((s) => s.step.id === 'etape-12')!.state).toBe('termine')
    // Droits : réussite guidée puis examen autonome un jour plus tard sur la même étape → démontrée
    expect(later.competences.find((c) => c.id === 'groupes-droits-partages')!.state).toBe('demontree')
  })

  it('prochaine étape : première non terminée aux prérequis terminés ; accès libre aux autres', () => {
    const done = ['lab-01-adressage', 'lab-02-dhcp', 'lab-03-dns'].map((labId) => attempt({ labId }))
    const o = pathwayOverview(PATHWAY_PME, done, T0)
    expect(o.recommended?.id).toBe('etape-04')
    expect(o.completed).toBe(3)
    // L'étape 7 (VLAN) ne dépend que de l'étape 1 : disponible sans prérequis manquant, mais pas la recommandation
    const vlan = o.steps.find((s) => s.step.id === 'etape-07')!
    expect(vlan.state).toBe('disponible')
    expect(vlan.missingPrerequisites).toEqual([])
    // Une étape faite hors ordre compte quand même
    const skip = pathwayOverview(PATHWAY_PME, [attempt({ labId: 'lab-13-vlan' })], T0)
    expect(skip.steps.find((s) => s.step.id === 'etape-07')!.state).toBe('termine')
    expect(skip.recommended?.id).toBe('etape-01')
  })

  it('parcours terminé : plus de recommandation, sauf une révision due (étape ancienne, compétence non démontrée)', () => {
    const all = PATHWAY_PME.steps.map((s, i) =>
      attempt({
        labId: s.labId,
        mode: s.mode === 'exam' ? 'exam' : 'lab',
        finishedAt: iso(T0 + i * DAY),
        hintsUsed: 1
      })
    )
    const o = pathwayOverview(PATHWAY_PME, all, T0 + 12 * DAY)
    expect(o.completed).toBe(o.total)
    // Toutes guidées : aucune compétence démontrée → les étapes de plus de 7 jours sont à revoir
    const due = o.steps.filter((s) => s.state === 'a-revoir').map((s) => s.step.id)
    expect(due.length).toBeGreaterThan(0)
    expect(due).toContain('etape-01')
    expect(o.recommended?.id).toBe(due[0])
    // Tout démontré et récent : rien à recommander
    const strong = PATHWAY_PME.steps.flatMap((s, i) => [
      attempt({
        labId: s.labId,
        mode: s.mode === 'exam' ? 'exam' : 'lab',
        finishedAt: iso(T0 + i * 3_600_000)
      }),
      attempt({
        labId: s.labId,
        mode: s.mode === 'exam' ? 'exam' : 'lab',
        finishedAt: iso(T0 + i * 3_600_000 + 2 * DAY)
      })
    ])
    const fin = pathwayOverview(PATHWAY_PME, strong, T0 + 3 * DAY)
    expect(fin.recommended).toBeNull()
    expect(fin.competences.every((c) => c.state === 'demontree')).toBe(true)
  })

  it('tentatives hors parcours : compétences enregistrées prises en compte, labs inconnus ignorés', () => {
    const free = attempt({ labId: 'lab-99-perso', competences: ['dns', 'inconnue'] })
    expect(competenceStatus(PATHWAY_PME, 'dns', [free]).state).toBe('travaillee')
    const o = pathwayOverview(PATHWAY_PME, [free], T0)
    expect(o.completed).toBe(0)
  })

  it('déterminisme : même entrée, même sortie ; horodatage illisible toléré', () => {
    const attempts = [attempt({ labId: 'lab-01-adressage', finishedAt: 'n/a' })]
    expect(pathwayOverview(PATHWAY_PME, attempts, T0)).toEqual(pathwayOverview(PATHWAY_PME, attempts, T0))
    expect(pathwayOverview(PATHWAY_PME, attempts, T0).steps[0]!.state).toBe('a-revoir')
  })
})
