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

(Suite : disposition, espaces, écarts par rapport aux maquettes et procédure d'essai, complétés lot par lot.)
