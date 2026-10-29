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
      'non-régression : le compte restauré garde son OU et son groupe ; la restauration elle-même est vérifiée par « undeleted »'
  },
  'lab-15-pare-feu': {
    allowed: 'non-régression : PC1 doit rester joignable après le blocage',
    profile: 'non-régression : le pare-feu doit rester actif'
  },
  'lab-19-durcissement-ad': { dupont: 'non-régression : le compte légitime reste actif' },
  'lab-21-durcissement-pare-feu': { ping: 'non-régression : le ping reste autorisé' },
  'lab-46-linux-ssh-fail2ban': {
    f2b: 'non-régression : fail2ban installé tourne déjà, il doit rester actif'
  },
  'lab-47-linux-apache2': { web: 'non-régression : la page par défaut répond avant les deux sites (200)' },
  'lab-48-linux-samba': {
    smbd: 'non-régression : smbd installé tourne déjà, il doit rester actif',
    port: 'non-régression : le port 445 reste ouvert'
  },
  'lab-51-mixte-samba-windows': {
    smbd: 'non-régression : smbd est déjà démarré avec le partage public, il doit le rester'
  },
  'lab-49-linux-bind9': { named: 'non-régression : named installé tourne déjà, il doit rester actif' },
  'lab-54-pfsense-regles-lan-dmz': {
    c1: 'non-régression : le LAN atteint déjà WEB1 (règle d’usine du LAN)',
    c4: 'non-régression : le LAN a déjà accès à Internet',
    c6: 'non-régression : la DMZ est isolée par le refus par défaut (aucune règle)',
    c7: 'non-régression : la DMZ n’atteint pas PC1 (refus par défaut)'
  },
  'lab-55-pfsense-dmz-web-publie': {
    c4: 'non-régression : seul le port 80 sera publié : SSH est fermé au départ',
    c5: 'non-régression : le LAN atteint déjà WEB1 (règle d’usine du LAN)',
    c6: 'non-régression : la DMZ est isolée par le refus par défaut'
  },
  'lab-58-pfsense-mixte-windows-linux': {
    c4: 'non-régression : le LAN atteint déjà WEB1 (règle d’usine du LAN)',
    c6: 'non-régression : le LAN a déjà accès à Internet',
    c8: 'non-régression : la DMZ est isolée par le refus par défaut',
    c9: 'non-régression : la DMZ est isolée par le refus par défaut'
  },
  'lab-59-depannage-pare-feu': {
    c5: 'non-régression : la DMZ est isolée du LAN, elle doit le rester après la réparation'
  },
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
