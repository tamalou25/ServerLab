/**
 * Départ de chaque lab fourni (labs/*.json, lus sur le disque comme le fait l'application ; un lab de
 * dépannage démarre cassé, par buildLabState) : chaque critère doit échouer avant toute action de l'élève, sauf exception justifiée ci-dessous. Un
 * évaluateur qui renverrait toujours « vrai » serait ainsi détecté (audit T-01).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildLabState, checkLab, parseLabText } from '@engine/index'

/** Critères déjà satisfaits au départ, et pourquoi. */
const ALREADY_MET: Record<string, Record<string, string>> = {
  'lab-12-sauvegarde': {
    restored:
      'le compte n’est supprimé par aucune étape du départ : critère de non-régression (à revoir, rapport d’audit)'
  },
  'lab-15-pare-feu': {
    allowed: 'non-régression : PC1 doit rester joignable après le blocage',
    profile: 'non-régression : le pare-feu doit rester actif'
  },
  'lab-19-durcissement-ad': { dupont: 'non-régression : le compte légitime reste actif' },
  'lab-21-durcissement-pare-feu': { ping: 'non-régression : le ping reste autorisé' },
  'lab-28-ios-sujet-e6': {
    'acl-block': 'ping bloqué au départ faute de routage ; les autres critères exigent le routage'
  }
}

const dir = join(__dirname, '../../../labs')
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .sort()

describe('départ des labs : chaque critère échoue', () => {
  it('tous les labs fournis sont lus', () => {
    expect(files.length).toBeGreaterThanOrEqual(35)
  })

  for (const file of files) {
    it(file, () => {
      const parsed = parseLabText(readFileSync(join(dir, file), 'utf8'))
      expect(parsed.ok, file).toBe(true)
      if (!parsed.ok) return
      const lab = parsed.lab
      const allowed = ALREADY_MET[lab.id] ?? {}
      const met = checkLab(buildLabState(lab), lab)
        .results.filter((r) => r.ok)
        .map((r) => r.id)
      // Aucun critère inattendu n'est validé au départ, et chaque exception est encore d'actualité
      expect(met.sort()).toEqual(Object.keys(allowed).sort())
    })
  }
})
