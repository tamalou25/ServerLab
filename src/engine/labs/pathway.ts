/**
 * Parcours pédagogiques (v2.14) : une suite ordonnée d'étapes qui réutilisent les labs fournis autour
 * d'une même entreprise, avec pour chaque étape ses prérequis, les compétences travaillées, le résultat
 * concret attendu, le niveau d'aide et l'exercice suivant recommandé. Le parcours aide à choisir : il ne
 * verrouille rien, tous les labs restent ouvrables librement.
 *
 * Progression visée : exercice guidé → exercice moins guidé → incident inconnu → révision différée.
 * Données pures (aucune dépendance) ; la progression de l'élève est calculée dans `progress.ts`.
 */

/** Compétences transférables vers de vraies machines (identifiants stables, enregistrés dans la progression). */
export const COMPETENCES = {
  'ipv4-adressage': {
    label: 'Adressage IPv4 et masques',
    detail: 'Choisir et poser des adresses cohérentes, lire un plan d’adressage, vérifier par ping.'
  },
  'routage-passerelle': {
    label: 'Routage et passerelle par défaut',
    detail: 'Comprendre le rôle de la passerelle, faire communiquer deux réseaux par un routeur.'
  },
  dhcp: {
    label: 'DHCP (étendue, options, baux)',
    detail: 'Distribuer adresses, passerelle et DNS ; lire et renouveler un bail côté client.'
  },
  dns: {
    label: 'DNS (zones, enregistrements, résolution)',
    detail: 'Créer zones et enregistrements, diagnostiquer une résolution de nom qui échoue.'
  },
  'annuaire-comptes': {
    label: 'Annuaire Active Directory et comptes',
    detail: 'Organiser OU, utilisateurs et groupes ; joindre un poste ; ouvrir une session de domaine.'
  },
  'groupes-droits-partages': {
    label: 'Groupes, droits NTFS et partages',
    detail: 'Accorder le juste droit par des groupes ; raisonner partage ∩ NTFS ; vérifier l’accès effectif.'
  },
  gpo: {
    label: 'Stratégies de groupe',
    detail: 'Lier une GPO à une OU, régler un paramètre, contrôler son application sur le poste.'
  },
  'linux-services': {
    label: 'Services Linux (configuration, redémarrage, journal)',
    detail: 'Éditer la configuration d’un service, la faire relire, vérifier depuis un client.'
  },
  'segmentation-vlan': {
    label: 'Segmentation par VLAN',
    detail: 'Séparer des services sur un switch, trunk 802.1Q, routage inter-VLAN.'
  },
  'pare-feu': {
    label: 'Filtrage par pare-feu',
    detail:
      'Écrire des règles minimales entre zones (LAN, DMZ, Internet), vérifier ce qui passe et ce qui est bloqué.'
  },
  'diagnostic-methode': {
    label: 'Méthode de diagnostic',
    detail: 'Reproduire le symptôme, départager des hypothèses par des observations, corriger, re-tester.'
  },
  'compte-rendu': {
    label: 'Compte rendu d’intervention',
    detail: 'Rendre compte : symptôme, causes, changements, vérifications, points de vigilance.'
  }
} as const

export type CompetenceId = keyof typeof COMPETENCES

/**
 * Niveau d'aide d'une étape :
 * - `detaille` : énoncé pas à pas, indices progressifs ;
 * - `indices` : objectifs à atteindre, indices progressifs à la demande ;
 * - `ticket` : incident inconnu, seul un ticket d'utilisateur, indices comptés dans le bilan ;
 * - `examen` : chronométré, sans indice, vérification finale unique.
 */
export type HelpLevel = 'detaille' | 'indices' | 'ticket' | 'examen'

export const HELP_LABELS: Record<HelpLevel, string> = {
  detaille: 'Guidé pas à pas',
  indices: 'Objectifs et indices à la demande',
  ticket: 'Incident inconnu : ticket seul, indices comptés',
  examen: 'Révision en mode examen : chronométré, sans indice'
}

/** Phase de la progression à laquelle appartient l'étape. */
export type PathwayPhase = 'guide' | 'moins-guide' | 'incident' | 'revision'

export const PHASE_LABELS: Record<PathwayPhase, string> = {
  guide: 'Exercice guidé',
  'moins-guide': 'Exercice moins guidé',
  incident: 'Incident inconnu',
  revision: 'Révision différée'
}

export interface PathwayStep {
  id: string
  /** Lab fourni réutilisé (identifiant du fichier labs/*.json). */
  labId: string
  /** Titre de la mission dans l'histoire de l'entreprise. */
  title: string
  /** Continuité : ce qui se passe dans l'entreprise et pourquoi on fait cette étape. */
  story: string
  phase: PathwayPhase
  help: HelpLevel
  /** Étapes à terminer avant (recommandation, jamais un verrou). */
  prerequisites: string[]
  competences: CompetenceId[]
  /** Résultat concret attendu, observable à la fin. */
  outcome: string
  /** Étape suivante recommandée (null : fin du parcours). */
  next: string | null
  /** L'étape se joue en mode examen (révision différée). */
  mode?: 'exam'
  /** Révision différée : jours à attendre après la réussite de l'étape d'origine. */
  deferDaysAfter?: { step: string; days: number }
  /** Variantes (graines) d'un lab de dépannage : même mission, cibles différentes. */
  variantSeeds?: number[]
}

export interface Pathway {
  id: string
  title: string
  /** L'entreprise et ses utilisateurs identifiables, fil rouge de toutes les étapes. */
  company: string
  summary: string
  steps: PathwayStep[]
}

/** Premier parcours : la PME Atelier Lambert (ferronnerie, 30 salariés). */
export const PATHWAY_PME: Pathway = {
  id: 'pme-atelier-lambert',
  title: 'Parcours PME : l’Atelier Lambert',
  company:
    'L’Atelier Lambert (ferronnerie, 30 salariés) : la direction (Marie Martin), la comptabilité (Jean Dupont, Sophie Leroy, Alice côté Linux), le commercial (Bob) et l’atelier (Paul Durand). Vous êtes l’administrateur systèmes et réseau arrivé en alternance : le réseau se construit étape par étape, puis il faut le faire vivre et le dépanner.',
  summary:
    'Douze étapes autour d’une même entreprise : adressage et connectivité, DHCP et DNS, annuaire et comptes, groupes, droits et partages, stratégies de groupe, services Linux, segmentation et pare-feu, puis dépannage transversal et révision différée.',
  steps: [
    {
      id: 'etape-01',
      labId: 'lab-01-adressage',
      title: '1. Relier le bureau et l’atelier',
      story:
        'Le bâtiment administratif et l’atelier ont chacun leur réseau. Avant tout service, les deux côtés doivent se joindre à travers le routeur.',
      phase: 'guide',
      help: 'detaille',
      prerequisites: [],
      competences: ['ipv4-adressage', 'routage-passerelle'],
      outcome: 'PC1 et PC2 se répondent au ping à travers R1, avec les passerelles attendues.',
      next: 'etape-02'
    },
    {
      id: 'etape-02',
      labId: 'lab-02-dhcp',
      title: '2. Arrêter d’adresser les postes à la main',
      story:
        'Trente postes à adresser un par un, ce n’est plus tenable : SRV1 distribue désormais adresses, passerelle et DNS.',
      phase: 'guide',
      help: 'detaille',
      prerequisites: ['etape-01'],
      competences: ['dhcp', 'ipv4-adressage'],
      outcome: 'Les postes obtiennent un bail de SRV1 avec passerelle et DNS, et se joignent.',
      next: 'etape-03'
    },
    {
      id: 'etape-03',
      labId: 'lab-03-dns',
      title: '3. Donner des noms aux machines',
      story:
        'Les utilisateurs refusent de retenir des adresses : la zone lab.local nomme les serveurs et les postes.',
      phase: 'moins-guide',
      help: 'indices',
      prerequisites: ['etape-02'],
      competences: ['dns'],
      outcome: 'nslookup résout les noms directs et inverses depuis un poste.',
      next: 'etape-04'
    },
    {
      id: 'etape-04',
      labId: 'lab-04-ad-gpo',
      title: '4. Créer l’annuaire et appliquer une première règle',
      story:
        'La comptabilité arrive dans le domaine : OU, compte de Jean Dupont, groupe GG_Compta, poste joint, et une stratégie de groupe qui s’applique vraiment.',
      phase: 'moins-guide',
      help: 'indices',
      prerequisites: ['etape-03'],
      competences: ['annuaire-comptes', 'gpo'],
      outcome: 'jdupont ouvre une session de domaine sur PC1 et gpresult montre la GPO appliquée.',
      next: 'etape-05'
    },
    {
      id: 'etape-05',
      labId: 'lab-05-ntfs',
      title: '5. Le dossier commun de la comptabilité',
      story:
        'La comptabilité veut un dossier partagé : les comptables modifient, la direction consulte, l’atelier n’y accède pas. Les droits se vérifient par l’accès effectif de chaque personne.',
      phase: 'moins-guide',
      help: 'indices',
      prerequisites: ['etape-04'],
      competences: ['groupes-droits-partages', 'annuaire-comptes'],
      outcome:
        'jdupont écrit, mmartin lit seulement, pdurand est refusé, au travers de \\\\SRV1\\Compta ; S: est connecté sur PC1.',
      next: 'etape-06'
    },
    {
      id: 'etape-06',
      labId: 'lab-48-linux-samba',
      title: '6. Le même besoin, côté Linux',
      story:
        'Un serveur Debian héberge les archives de la comptabilité : partage Samba réservé au groupe compta, compte Samba d’alice, et refus de bob (commercial). Le service doit relire sa configuration.',
      phase: 'moins-guide',
      help: 'indices',
      prerequisites: ['etape-05'],
      competences: ['linux-services', 'groupes-droits-partages'],
      outcome: 'Depuis LNX1, alice liste et écrit dans //LSRV1/compta ; bob et un invité sont refusés.',
      next: 'etape-07'
    },
    {
      id: 'etape-07',
      labId: 'lab-13-vlan',
      title: '7. Séparer la comptabilité des RH',
      story:
        'Les deux services partagent un switch mais ne doivent plus être sur le même réseau : VLAN, trunk et routeur « on a stick ».',
      phase: 'moins-guide',
      help: 'indices',
      prerequisites: ['etape-01'],
      competences: ['segmentation-vlan', 'routage-passerelle'],
      outcome: 'Chaque service est dans son VLAN et les deux communiquent seulement par le routeur.',
      next: 'etape-08'
    },
    {
      id: 'etape-08',
      labId: 'lab-54-pfsense-regles-lan-dmz',
      title: '8. Publier le site vitrine sans exposer le bureau',
      story:
        'Le site web de l’atelier passe en DMZ derrière pfSense : le LAN ne joint le serveur que sur le port 80, la DMZ n’initie rien vers le LAN.',
      phase: 'moins-guide',
      help: 'indices',
      prerequisites: ['etape-07'],
      competences: ['pare-feu', 'segmentation-vlan'],
      outcome:
        'Les flux attendus passent, les flux interdits sont bloqués et visibles dans le journal du pare-feu.',
      next: 'etape-09'
    },
    {
      id: 'etape-09',
      labId: 'lab-44-depannage-windows',
      title: '9. Lundi matin : personne n’ouvre de session',
      story:
        'Premier incident réel : un ticket, aucune cause annoncée. Deux causes indépendantes à départager par des observations, puis à corriger.',
      phase: 'incident',
      help: 'ticket',
      prerequisites: ['etape-04'],
      competences: ['diagnostic-methode', 'dns', 'annuaire-comptes'],
      outcome: 'Les sessions de domaine s’ouvrent de nouveau ; chaque cause est identifiée et corrigée.',
      next: 'etape-10'
    },
    {
      id: 'etape-10',
      labId: 'lab-60-mission-compta',
      title: '10. Mission : la comptabilité ne peut plus enregistrer',
      story:
        'La clôture mensuelle est demain. Rétablir l’écriture pour la comptabilité sans ouvrir le dossier aux autres salariés, vérifier, puis rendre compte. Plusieurs réparations sont acceptables ; les raccourcis sont détectés.',
      phase: 'incident',
      help: 'ticket',
      prerequisites: ['etape-05', 'etape-09'],
      competences: ['diagnostic-methode', 'groupes-droits-partages', 'compte-rendu'],
      outcome:
        'La comptabilité écrit de nouveau, la direction garde la lecture seule, l’atelier reste exclu ; le bilan exporté sert de compte rendu.',
      next: 'etape-11',
      variantSeeds: [11, 2, 5, 8, 13]
    },
    {
      id: 'etape-11',
      labId: 'lab-45-depannage-compose',
      title: '11. Une panne qui en cache une autre',
      story:
        'Le nom du serveur ne répond plus… et une fois le service relancé, il répond à une mauvaise adresse. Diagnostiquer une chaîne de causes.',
      phase: 'incident',
      help: 'ticket',
      prerequisites: ['etape-10'],
      competences: ['diagnostic-methode', 'dns'],
      outcome:
        'Les deux causes sont corrigées dans l’ordre et le partage est de nouveau accessible par son nom.',
      next: 'etape-12'
    },
    {
      id: 'etape-12',
      labId: 'lab-05-ntfs',
      title: '12. Révision différée : les droits, sans filet',
      story:
        'Quelques jours après l’étape 5, refaire le dossier de la comptabilité en mode examen : chronomètre, aucun indice, vérification unique. C’est ainsi qu’une compétence se démontre durablement.',
      phase: 'revision',
      help: 'examen',
      prerequisites: ['etape-10'],
      competences: ['groupes-droits-partages', 'annuaire-comptes'],
      outcome: 'Note d’examen de 20/20 sur le lab 05, sans indice.',
      next: null,
      mode: 'exam',
      deferDaysAfter: { step: 'etape-05', days: 1 }
    }
  ]
}

export const PATHWAYS: readonly Pathway[] = [PATHWAY_PME]

export function getPathway(id: string): Pathway | undefined {
  return PATHWAYS.find((p) => p.id === id)
}

export function pathwayStep(pathway: Pathway, stepId: string): PathwayStep | undefined {
  return pathway.steps.find((s) => s.id === stepId)
}

/** Étapes de tous les parcours qui utilisent ce lab. */
export function stepsForLab(labId: string): { pathway: Pathway; step: PathwayStep }[] {
  return PATHWAYS.flatMap((pathway) =>
    pathway.steps.filter((s) => s.labId === labId).map((step) => ({ pathway, step }))
  )
}
