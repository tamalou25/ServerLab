# Interface v3 (en cours)

Évolution graphique de l'application en trois espaces, à partir des maquettes de
[docs/ui-v3/maquettes](ui-v3/maquettes/README.md) : **Atelier** (topologie et inspecteur), **Mission**
(énoncé élargi, objectifs, indices, plan et consoles) et **Enseignant** (sujets, copies, correction, rejeu).
Le moteur, le format `.slab`, les barèmes, les règles d'examen et les commandes IPC ne changent pas.

Les maquettes expriment une direction graphique ; leurs données (élèves, notes, journal, étapes cochées) sont
fictives. Chaque élément de l'interface réelle repose sur une donnée ou une action existante, ou est présenté
comme une suggestion.

## Principes

- **Texte courant à 14 px** (`text-body`, interligne 1,55) pour tout ce qui se lit : énoncés, tickets,
  correction, aide. Le chrome garde l'échelle dense de la v2 : `text-meta` 11, `text-dense` 12, `text-ui` 13,
  `text-title` 15 ; titres de lecteur et de page en `text-heading` 18, affichage (titre d'énoncé, note) en
  `text-display` 23.
- **Densité** : Confort (défaut) ou Compact (`html[data-density='compact']`, texte courant 13 px).
- **Un accent**, des états toujours doublés d'une forme ou d'un texte (`Badge` : icône + libellé).
- **Mouvement court et optionnel** : transitions de 120 à 180 ms, désactivées par `prefers-reduced-motion`
  (chrome en CSS, enveloppes de la simulation en JavaScript).
- **Rayons** : `rounded-control` 6 px (boutons, champs), `rounded-panel` 8 px (panneaux, cartes de liste),
  `rounded-card` 10 px (cartes d'indicateurs).

## Tokens ajoutés

Ratios de contraste : [ui-v3-contrastes.md](ui-v3-contrastes.md) (script `scripts/contrast-tokens.mjs`).

| Token                                                                 | Usage                                            |
| --------------------------------------------------------------------- | ------------------------------------------------ |
| `--sl-text-body` (14 px, 13 px en Compact)                            | taille du texte courant (`text-body`)            |
| `--sl-rail`, `--sl-rail-hover`, `--sl-on-rail`, `--sl-on-rail-active` | rail des espaces, sombre dans les deux thèmes    |
| `--sl-zone`, `--sl-zone-line`                                         | zones réseau du plan (fond translucide, contour) |
| `--sl-motion-fast`, `--sl-motion-base`                                | durées des transitions                           |

## Disposition et espaces

| Zone                      | Composant         | Rôle                                                                                                                           |
| ------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| En-tête (44 px)           | `shell/AppHeader` | marque et badge de l'espace, nom du document et état d'enregistrement, Temps réel / Simulation, Nouveau / Ouvrir / Enregistrer |
| Rail (64 px, 48 px serré) | `shell/AppRail`   | Atelier, Mission, Labs (sélecteur), Enseignant (mode activé), Aide ; `aria-current` sur l'espace affiché                       |
| Barre du plan (40 px)     | `shell/CanvasBar` | « Vue d'ensemble » et compteurs réels, annuler / rétablir, outils, zoom                                                        |
| Barre d'état (24 px)      | `StatusBar`       | outil actif, paquets en attente, zoom, thème                                                                                   |

Trois espaces (`ui.workspace`, raccourcis `Ctrl+Maj+A / M / E`, menu Affichage > Espace) :

- **Atelier** : palette | plan | inspecteur (`RightPanel`, onglets Résumé / Audit / Dépannage, largeur
  280–480 px mémorisée).
- **Mission** : contexte (`mission/MissionSidebar` : titre, difficulté, résumé, durée, régime, consoles) |
  plan | lecteur (`mission/MissionReader` : Mission / Dépannage / Résumé, 320 px à 60 % de la fenêtre,
  bouton Élargir à 560 px, largeur mémorisée). Disponible dès qu'un lab, un résultat d'examen, un
  dépannage ou une épreuve est ouvert ; sélectionné automatiquement à l'ouverture. Le plan reste le même
  composant monté : sélection, fenêtres d'équipement et vue sont conservées d'un espace à l'autre.
- **Enseignant** (`teacher/TeacherWorkspace`) : page qui recouvre la zone centrale ; palette, plan et
  inspecteur restent montés mais **inertes** (`inert`), les fenêtres d'équipement et le panneau Simulation
  ne sont pas rendus, les raccourcis et commandes de menu du canvas sont sans effet. Visible seulement si
  Affichage > Mode enseignant est coché, jamais pendant une épreuve ni pendant le tutoriel. Le focus arrive
  sur le titre de la page et revient au bouton du rail à la sortie. La démonstration (rejeu) bascule sur
  l'Atelier et revient à l'espace Enseignant à sa fermeture.

Les règles d'affichage de la v2 sont conservées : pendant une épreuve, seuls Atelier et Mission existent et
le lecteur ne montre jamais les critères ; un dépannage généré remplace l'énoncé, un lab de dépannage fourni
garde son énoncé à côté de l'onglet Dépannage.

## Espace Atelier

- **Palette** : en-tête « Équipements » et nombre de types, recherche avec état vide, liste des familles
  (icône, nom, compteur ; la famille active cliquée revient à « Tous »), vignettes sur deux colonnes.
  Sur un écran serré (moins de 1 200 px CSS, ex. 1 366 × 768 à 125 %), la palette est repliée en colonne
  d'icônes et se déplie pour la session.
- **Nœuds** : carte de 64 px conservée (même centre d'icône, mêmes performances à 100 équipements), halo
  de sélection (anneau accent et ombre `accent-soft`), focus clavier visible.
- **Câbles, trois mises en évidence** (légende du plan en haut à gauche dès que l'une est visible) :
  câble sélectionné (accent, 2,5 px), branche de l'équipement sélectionné (accent, 2 px), chemin de
  l'échange choisi dans le panneau Simulation (info, tirets : câbles traversés par la même opération
  jusqu'au pas choisi, d'après le `linkId` de chaque trame). L'échange produit par le moteur reste
  représenté par les enveloppes animées. Attribut `data-state` (`selected`, `path`, `branch`, `plain`)
  sur la zone de survol du câble.
- **Zones réseau** (bascule « Zones réseau » dans la barre du plan, préférence du poste) : une zone par
  réseau IPv4 calculé depuis l'adresse et le masque effectifs de chaque interface (statique ou bail
  DHCP ; APIPA, interfaces désactivées ou débranchées exclues). Membres enveloppés : hôtes adressés dans
  le réseau, et switch seulement s'il ne sert qu'un réseau. Routeurs et pare-feu ne sont jamais
  enveloppés : ils sont la frontière, leur interface figure dans l'étiquette (« passerelle R1 Gi0/0 ·
  192.168.10.254 »). Le VLAN n'est indiqué que si tous les hôtes membres sont raccordés par un port
  d'accès du même VLAN. La zone est **descriptive** (« ces adresses partagent un préfixe ») : elle ne
  modifie rien et n'implique pas la connectivité ; un hôte dont le masque le place dans un autre réseau
  apparaît hors zone, ce qui est voulu. Calcul pur `engine/topology/groups.ts` (mémoïsé sur le réseau :
  un déplacement ne recalcule que la géométrie), désactivé au-delà de 60 équipements.
- **Inspecteur** (280–480 px, largeur mémorisée) : Résumé (carte d'identité, badge d'état forme + texte,
  actions, Général, Interfaces, Rôles, Services, Routes), Interfaces, Journal (évènements d'un hôte),
  Audit, Dépannage. Câble : extrémités en cartes avec badge d'état ; multi-sélection : liste avec
  icônes ; rien de sélectionné : compteurs par famille en cartes, liaisons, domaines, état vide.

## Espace Mission

- **Barre latérale** : titre, difficulté, résumé, **démarche suggérée** (observer, diagnostiquer, corriger,
  vérifier) présentée comme un repère de méthode sans aucune étape cochée (rien dans l'état ne permettrait
  de la valider), durée indicative, régime (entraînement, examen, épreuve, dépannage), accès direct aux
  consoles des équipements. Masquée sous 1 200 px CSS.
- **Lecteur** : énoncé en texte courant 14 px (titres, listes, citations, **tableaux** : `shared/markdown.ts`,
  parseur pur testé, aucun HTML interprété), objectifs numérotés avec symbole et texte d'état d'après le
  dernier clic sur Vérifier (« À vérifier », « Validé », « Non validé » : `data-state`), indices progressifs
  en carte sous l'objectif non validé (« Indice suivant (2 / 3) »), pied fixe (progression avec barre
  accessible, Vérifier, Examen, Recommencer).
- **Examen** : bandeau du chronomètre (rôle `timer`), objectifs sans résultat intermédiaire ni indice,
  « Terminer l'examen » ; résultat en carte (note, critères, durée, fin, sorties) avec export.
- **Épreuve** (mode enseignant) : chronomètre et « Terminer et rendre » en tête, énoncé, rappel que les
  critères sont masqués, indice avec pénalité confirmée, question d'oral au déclencheur. Les règles de
  masquage de la v2 sont reprises à l'identique.

## Espace Enseignant

- **Page** : eyebrow « Espace enseignant », titre, sous-titre (titre du sujet), commande Sujet / Correction.
  Sujet : point de départ (bibliothèque, lab ouvert, éditeur, fichier) puis éditeur (méta, énoncé, barème,
  oral, prévisualisation, export) ; aucune règle de barème modifiée.
- **Correction** : indicateurs **uniquement calculables** par `classStats` : « Copies importées » (le nombre
  d'élèves attendus n'est pas connu), moyenne sur 20 recalculée par rejeu, durée moyenne face à la durée
  prévue du barème, critère le plus raté (« manqué dans k copies sur N »), signalements. Masqués sans copie.
- **Copies** : recherche, initiales, nom, temps et indices, note, badges dérivés de la correction
  (`copyStatus`, moteur) : « Signalée » (drapeaux), « Rejeu interrompu » (`replay-failed`), « Oral à
  renseigner » (question sans points), « k / N critères ». Les fichiers refusés à l'import sont listés
  « Rendu invalide » avec le message du moteur, en plus de la modale.
- **Détail** : badges, nom, méta, note recalculée, tableau Critère / Résultat (Validé ✓ / Non validé ✗) /
  Points, composantes de la note (critères, temps, erreurs : valeurs réelles et poids du barème), oral à
  noter, commentaire, export, chronologie du **journal réel** de l'élève (`journalTimeline` : commandes,
  annulations, glisser, indices, réponses, en temps relatif) et « Rejouer pas à pas » (bascule sur l'Atelier,
  retour à l'espace Enseignant à la fermeture). Mention : « La note décrit le résultat de cette épreuve, pas
  une mesure générale de maîtrise de la compétence. »

## Écarts volontaires par rapport aux maquettes

| Maquette                                                  | Décision                                                                                           |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Avatar « GF », entrée « Réglages » du rail                | Supprimés : aucun compte ni écran de réglages réel (thème, langue au menu natif).                  |
| Onglet « Journal » du lecteur de mission                  | Non repris : aucun journal d'observations ; le journal d'évènements est dans l'inspecteur.         |
| Onglet « Indices » séparé                                 | Indices progressifs sous l'objectif concerné (mécanisme réel, ids de test conservés).              |
| Étapes « Observer / Diagnostiquer… » cochées              | « Démarche suggérée » sans état.                                                                   |
| « 4 / 4 élèves », « Rejeu terminé » sur toutes les copies | « N copies importées » ; badges dérivés des drapeaux réels de la correction.                       |
| Chronologie rédigée (« Prise en charge », …)              | Chronologie du journal réel.                                                                       |
| Liens orthogonaux, nœuds de 126 px avec sous-titre        | Câbles droits et nœuds de 64 px conservés (performance, centre d'icône) ; sous-titre en étiquette. |
| Console ancrée sous le plan                               | Fenêtres flottantes conservées (plusieurs consoles, Bureau) ; raccourcis dans la barre latérale.   |
| Inspecteur sans Audit ni Dépannage                        | Conservés comme onglets (fonctions existantes).                                                    |
| Pied du plan « Votre infrastructure est opérationnelle »  | Compteurs réels dans la barre du plan ; aucun verdict global inventé.                              |

## Repli des panneaux (petits écrans, zoom 125 %)

Référence : 1 366 × 768 à 125 % = 1 093 × 614 px CSS. Sous 1 200 px CSS : rail en icônes (48 px, infobulles),
palette repliée en colonne (dépliable pour la session), barre latérale Mission masquée, inspecteur borné à
300 px, lecteur borné à 50 % de la fenêtre, libellés des boutons de la barre du plan masqués. Sous 680 px CSS
de haut : en-tête 40 px, barre du plan 36 px. Les préférences de largeur sont bornées à l'affichage, jamais
réécrites. Les pieds de panneaux (Vérifier, Terminer, Importer) restent visibles sans défilement.

## Essayer les trois espaces

1. **Atelier** : nouveau document, glisser deux postes et un switch, câbler, configurer les adresses
   (fenêtre d'équipement) : la zone « 192.168.10.0/24 · VLAN 1 » apparaît ; sélectionner un poste met sa
   branche en évidence et la légende l'explique ; onglets Résumé / Interfaces / Journal de l'inspecteur,
   poignée de largeur (flèches au clavier, double-clic pour revenir à 348 px).
2. **Mission** : Labs › lab 1, lire l'énoncé, Vérifier, ouvrir les indices, Examen (indices absents,
   chronomètre), Terminer ; la bascule Atelier ↔ Mission conserve la sélection et les fenêtres.
3. **Enseignant** : Affichage › Mode enseignant, rail › Enseignant, Sujet depuis la bibliothèque, puis
   Correction › Ouvrir le sujet… et Importer des rendus… ; indicateurs, badges, détail, chronologie, Rejouer
   (retour automatique à l'espace Enseignant à la fermeture), CSV.
