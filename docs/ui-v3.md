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

(Suite : écarts par rapport aux maquettes et procédure d'essai, complétés lot par lot.)
