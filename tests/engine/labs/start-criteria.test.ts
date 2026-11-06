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
  'lab-46-linux-ssh-fail2ban': {
    f2b: 'non-régression : fail2ban installé tourne déjà, il doit rester actif',
    'ssh-applique':
      'contrainte : sshd applique sa configuration au départ ; toute modification doit être relue',
    'f2b-applique':
      'contrainte : fail2ban applique sa configuration au départ ; toute modification doit être relue'
  },
  'lab-47-linux-apache2': {
    web: 'non-régression : la page par défaut répond avant les deux sites (200)',
    applique: 'contrainte : Apache applique sa configuration au départ ; toute modification doit être relue'
  },
  'lab-48-linux-samba': {
    smbd: 'non-régression : smbd installé tourne déjà, il doit rester actif',
    port: 'non-régression : le port 445 reste ouvert',
    applique: 'contrainte : smbd applique sa configuration au départ ; toute modification doit être relue',
    bob: 'contrainte de sécurité : le partage n’existe pas encore, bob ne doit jamais pouvoir l’ouvrir',
    invite:
      'contrainte de sécurité : le partage n’existe pas encore, un invité ne doit jamais pouvoir l’ouvrir'
  },
  'lab-51-mixte-samba-windows': {
    smbd: 'non-régression : smbd est déjà démarré avec le partage public, il doit le rester',
    'lecture-seule':
      'contrainte : le partage lecture n’existe pas encore ; une fois créé, il doit rester en lecture seule',
    'alice-public':
      'non-régression : alice écrit déjà dans public, la modification de smb.conf ne doit pas le casser'
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
  'lab-60-mission-compta': {
    direction: 'contrainte : la direction est déjà en lecture seule, elle doit le rester après la réparation',
    atelier: 'contrainte : pdurand n’a déjà aucun accès, il ne doit pas en gagner',
    admins: 'contrainte : les administrateurs gardent le contrôle total'
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
