/**
 * Lab 60 « Mission : la comptabilité ne peut plus enregistrer ses documents » : départ = lab 05 résolu
 * (déclaratif, champ `ntfs`) cassé par deux causes qui se cumulent (autorisations du partage rabaissées,
 * entrée NTFS du groupe disparue). Symptôme reproductible depuis les postes, observations qui départagent,
 * réparation officielle et réparation alternative acceptées, raccourci « tout ouvrir » refusé par les
 * contraintes de sécurité, variantes par graine toutes solubles.
 */
import { describe, expect, it } from 'vitest'
import {
  activeFaults,
  allRepaired,
  buildLabState,
  checkLab,
  command,
  criteriaOutcomes,
  domainToken,
  getFault,
  parseLabText,
  summarizeTroubleshooting,
  type Domain,
  type LabState
} from '@engine/index'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { run } from '../shell/helpers'
import { failing, loadTroubleshootingLab, play, repairOfficial } from './depannage-helpers'

const { lab, start } = loadTroubleshootingLab('lab-60-mission-compta.json')
const id = (s: LabState, name: string) => Object.values(s.devices).find((d) => d.name === name)?.id ?? ''
const admin = (s: LabState) => domainToken(s.domains['lab.local'] as Domain, 'Administrateur')!
const PATH = 'C:\\Partages\\Compta'

const cmd = (s: LabState, machine: string, line: string) => run(s, id(s, machine), line, { shell: 'cmd' })

describe('lab-60-mission-compta : départ', () => {
  it('démarre cassé : deux causes imposées, actives et visibles, sans la cause dans le ticket', () => {
    expect(activeFaults(start).map((f) => f.id)).toEqual(['win.share-acl', 'win.ntfs-rights'])
    for (const f of activeFaults(start)) {
      const def = getFault(f.id)!
      expect(def.symptomVisible(start, f.params)).toBe(true)
      expect(def.healed(start, f.params)).toBe(false)
      const ticket = def.ticket(start, f.params)
      expect(ticket).toContain('Accès refusé')
      expect(ticket).not.toMatch(/NTFS|autorisations du partage/i)
    }
    expect(lab.title).not.toMatch(/NTFS|partage|autorisation/i)
    expect(allRepaired(start)).toBe(false)
  })

  it('symptôme reproductible : accès refusé pour jdupont et sleroy, le serveur répond', () => {
    expect(cmd(start, 'PC1', 'net use S: \\\\SRV1\\Compta').errors).toBe('')
    expect(cmd(start, 'PC1', 'dir \\\\SRV1\\Compta').errors).toContain('Accès refusé')
    expect(cmd(start, 'PC1', 'echo test > \\\\SRV1\\Compta\\essai.txt').errors).toContain('Accès refusé')
    expect(cmd(start, 'PC2', 'echo test > \\\\SRV1\\Compta\\essai.txt').errors).toContain('Accès refusé')
  })

  it('critères : causes et accès de la compta en échec ; direction, atelier et admins déjà conformes (contraintes)', () => {
    expect(failing(start, lab)).toEqual(['causes', 'jdupont', 'sleroy'])
    const kinds = criteriaOutcomes(start, start, lab).map((o) => [o.id, o.kind])
    expect(kinds).toEqual([
      ['causes', 'repair'],
      ['jdupont', 'function'],
      ['sleroy', 'function'],
      ['direction', 'constraint'],
      ['atelier', 'constraint'],
      ['admins', 'constraint']
    ])
  })
})

describe('lab-60-mission-compta : réparations', () => {
  it('la réparation officielle valide 100 % des critères et l’écriture fonctionne depuis les deux postes', () => {
    const fixed = repairOfficial(start)
    expect(failing(fixed, lab)).toEqual([])
    expect(allRepaired(fixed)).toBe(true)
    expect(cmd(fixed, 'PC1', 'echo test > \\\\SRV1\\Compta\\essai.txt').errors).toBe('')
    expect(cmd(fixed, 'PC2', 'echo test > \\\\SRV1\\Compta\\essai2.txt').errors).toBe('')
    expect(cmd(fixed, 'PC1', 'dir \\\\SRV1\\Compta').errors).toBe('')
    const s = summarizeTroubleshooting(
      start,
      { commandsPlayed: 2, hintsUsed: 0, elapsedMs: 1, repaired: true, gaveUp: false },
      { current: fixed, lab }
    )
    expect(s.outcome).toBe('resolu')
    expect(s.score).toBe(100)
    expect(s.breakdown.map((b) => b.kind)).toEqual(['repair', 'function', 'constraint'])
  })

  it('une seule cause corrigée (NTFS) : le dossier s’ouvre, l’écriture reste refusée, la seconde cause reste à trouver', () => {
    const ntfs = activeFaults(start).find((f) => f.id === 'win.ntfs-rights')!
    const half = play(start, getFault(ntfs.id)!.repair(start, ntfs.params))
    expect(cmd(half, 'PC1', 'dir \\\\SRV1\\Compta').errors).toBe('')
    expect(cmd(half, 'PC1', 'echo test > \\\\SRV1\\Compta\\essai.txt').errors).toContain('Accès refusé')
    expect(failing(half, lab)).toEqual(['causes', 'jdupont', 'sleroy'])
    expect(allRepaired(half)).toBe(false)
    const s = summarizeTroubleshooting(
      start,
      { commandsPlayed: 1, hintsUsed: 1, elapsedMs: 1, repaired: false, gaveUp: false },
      { current: half, lab }
    )
    expect(s.outcome).toBe('non-resolu')
    // Les contraintes sont préservées : elles rapportent leurs points même sans réparation
    expect(s.breakdown.find((b) => b.kind === 'constraint')?.met).toBe(3)
  })

  it('réparation alternative : GG_Compta en Modification et GG_Direction en Lecture sur le partage (cmdlets) + NTFS : acceptée', () => {
    const ntfs = activeFaults(start).find((f) => f.id === 'win.ntfs-rights')!
    let s = start
    for (const line of [
      'Revoke-SmbShareAccess -Name Compta -AccountName "Tout le monde" -Force',
      'Grant-SmbShareAccess -Name Compta -AccountName "LAB\\GG_Compta" -AccessRight Change -Force',
      'Grant-SmbShareAccess -Name Compta -AccountName "LAB\\GG_Direction" -AccessRight Read -Force'
    ]) {
      const r = run(s, id(s, 'SRV1'), line)
      expect(r.errors, line).toBe('')
      s = r.state
    }
    s = play(s, getFault(ntfs.id)!.repair(s, ntfs.params))
    expect(failing(s, lab)).toEqual([])
    expect(allRepaired(s)).toBe(true)
  })

  it('raccourci « tout ouvrir » (Tout le monde en modification NTFS + partage) : la compta écrit mais les contraintes échouent', () => {
    const srv = id(start, 'SRV1')
    const share = activeFaults(start).find((f) => f.id === 'win.share-acl')!
    let s = play(start, getFault(share.id)!.repair(start, share.params))
    s = play(s, [
      command(
        'files.grantNtfs',
        srv,
        PATH,
        { principal: 'Tout le monde', type: 'Allow', rights: ['Modify'] },
        admin(s)
      )
    ])
    expect(cmd(s, 'PC1', 'echo test > \\\\SRV1\\Compta\\essai.txt').errors).toBe('')
    // Les pannes sont « guéries » (la compta écrit) : seules les contraintes de sécurité révèlent le raccourci
    expect(failing(s, lab)).toEqual(['direction', 'atelier'])
    const summary = summarizeTroubleshooting(
      start,
      { commandsPlayed: 2, hintsUsed: 0, elapsedMs: 1, repaired: allRepaired(s), gaveUp: false },
      { current: s, lab }
    )
    expect(summary.objectives.filter((o) => o.kind === 'constraint' && !o.ok).map((o) => o.id)).toEqual([
      'direction',
      'atelier'
    ])
    expect(summary.outcome).toBe('resolu-avec-reserves')
    // 60 (pannes) + 25 (usage) + 15 × 1/3 (une contrainte sur trois préservée : admins)
    expect(summary.score).toBe(90)
  })

  it('les administrateurs retirés par erreur : la contrainte admins le détecte', () => {
    const srv = id(start, 'SRV1')
    const fixed = repairOfficial(start)
    const s = play(fixed, [
      command('files.removeNtfs', srv, PATH, 'BUILTIN\\Administrateurs', 'all', admin(fixed))
    ])
    expect(failing(s, lab)).toEqual(['admins'])
  })
})

describe('lab-60-mission-compta : variantes par graine', () => {
  const text = readFileSync(join(__dirname, '../../../labs/lab-60-mission-compta.json'), 'utf8')
  it.each([1, 2, 3, 5, 8, 13, 21, 34, 55, 89])(
    'graine %i : départ cassé soluble par la réparation officielle',
    (seed) => {
      const parsed = parseLabText(text)
      if (!parsed.ok) throw new Error(parsed.message)
      const variant = { ...parsed.lab, troubleshooting: { ...parsed.lab.troubleshooting!, seed } }
      const broken = buildLabState(variant)
      expect(allRepaired(broken)).toBe(false)
      expect(failing(broken, variant)).toContain('causes')
      const fixed = repairOfficial(broken)
      expect(failing(fixed, variant)).toEqual([])
      expect(checkLab(fixed, variant).passed).toBe(variant.criteria.length)
    }
  )

  it('les graines font varier le poste observé (PC1 ou PC2) : au moins deux variantes distinctes', () => {
    const parsed = parseLabText(text)
    if (!parsed.ok) throw new Error(parsed.message)
    const clients = new Set<string>()
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      const s = buildLabState({ ...parsed.lab, troubleshooting: { ...parsed.lab.troubleshooting!, seed } })
      for (const f of activeFaults(s)) clients.add(String(f.params['client']))
    }
    expect(clients.size).toBeGreaterThanOrEqual(2)
  })

  it('déterminisme : même graine, même état', () => {
    expect(JSON.stringify(buildLabState(lab))).toBe(JSON.stringify(buildLabState(lab)))
  })
})
