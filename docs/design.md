# Direction graphique : l'atelier technique

Ce document fixe la direction retenue pour l'interface (accueil, catalogue, parcours, mission) et les règles
qui en découlent. Il complète [ui-v3.md](ui-v3.md) (disposition, tokens, espaces) sans le remplacer.
Captures avant / après : [captures/atelier-technique](captures/atelier-technique/README.md).

## Pourquoi cette direction

ServerLab est une interface de **travail et de lecture** : on y lit une consigne, on manipule une topologie,
on observe un résultat. Deux pistes ont été comparées.

| Piste                              | Idée                                                                                              | Décision                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **A. Atelier technique** (retenue) | Un établi calme : surface neutre, filets fins, repères techniques en chasse fixe, un seul accent. | Réutilise les tokens et primitives de la v3 ; l'identité vit dans les vues de travail, sans rien inventer. |
| B. Carnet de TP                    | Mise en page éditoriale : grande typographie, cartes illustrées par thème, ton plus chaleureux.   | Écartée : suppose des illustrations et des catégories thématiques que les données des labs ne portent pas. |

Ce qui rend ServerLab reconnaissable n'est pas un décor mais une façon constante de présenter les choses :
les numéros d'étape et d'objectif, les adresses et les noms d'équipements en JetBrains Mono, la frise du
parcours, les états toujours écrits en toutes lettres à côté de leur symbole.

## Règles

1. **Une action principale par écran.** Un seul bouton plein (`Button variant="primary"`) : « Ouvrir l'étape »
   à l'accueil, l'étape conseillée dans le parcours, « Vérifier » en mission. Le reste est secondaire
   (contour) ou tertiaire (texte).
2. **L'action principale dépend de l'état réel.** Accueil : tutoriel proposé → prochaine étape conseillée →
   parcours terminé. Une étape conseillée n'est jamais appelée « reprise » : aucune session n'est reprise.
3. **Des listes avant des cartes.** Une carte regroupe un objet et ses actions (étape du parcours, bloc de
   réussite). Les collections (catalogue, objectifs, accès, exercices) sont des listes séparées par un filet
   (`border-b border-line`) dans un seul cadre. Pas de carte dans une carte.
4. **Le détail se déplie.** Parcours : une ligne par étape, détails à la demande (étape conseillée dépliée).
   Mission : l'aide d'un objectif non validé est repliée ; le résultat se lit d'abord.
5. **Résultat, aide et suggestion ne se mélangent pas.** Résultat = constat du moteur (symbole + « Validé » /
   « Non validé »). Aide = indice rédigé par l'auteur du lab (filet et fond `warn`, à la demande).
   Suggestion = repère de méthode ou autoévaluation, toujours annoncée comme telle.
6. **Rien n'est inventé.** Pas de taux de maîtrise, de diagnostic supposé, de statistique décorative. La
   vérification dit ce qui n'est pas encore vrai, pas pourquoi : l'interface le dit aussi.
7. **Chasse fixe pour ce qui se tape ou se compte** : adresses, noms d'équipements, numéros d'objectif,
   compteurs (`font-mono`, `tabular-nums`). Inter pour tout le reste. Aucune autre police.
8. **Un état n'est jamais une couleur seule** : symbole + libellé (`Badge`), coche sur un filtre actif
   (`Chip`), barres de niveau sur la difficulté (`DifficultyBadge`).
9. **Largeur de lecture bornée** : 62 à 78 caractères pour les paragraphes (`max-w-[62ch]`…), texte courant
   `text-body`.
10. **Mouvement utile seulement** : rotation du chevron d'un détail, transition de couleur au survol
    (120 à 180 ms). Aucune animation d'entrée, rien de permanent ; `prefers-reduced-motion` coupe tout.
11. **Deux thèmes réglés séparément** par les tokens (`styles.css`, ratios dans
    [ui-v3-contrastes.md](ui-v3-contrastes.md)) ; aucune couleur Tailwind brute.
12. **Vocabulaire constant** : « Ouvrir » (un exercice, une étape, un fichier), « Vérifier », « Afficher
    l'aide », « Catalogue », « Parcours », « Prochaine étape conseillée ». Une action garde son nom partout.

## Primitives

| Primitive           | Fichier                    | Usage                                                                  |
| ------------------- | -------------------------- | ---------------------------------------------------------------------- |
| `Button`            | `common/ui.tsx`            | primaire (un par écran), secondaire, fantôme                           |
| `Badge`             | `common/Badge.tsx`         | état ou catégorie : icône + texte                                      |
| `Chip`              | `common/Chip.tsx`          | filtre à bascule (`aria-pressed`, coche quand actif)                   |
| `EmptyState`        | `common/EmptyState.tsx`    | liste vide : explication et action de sortie                           |
| `DifficultyBadge`   | `labs/DifficultyBadge.tsx` | niveau d'un lab : barres + libellé                                     |
| `PathwayRail`       | `labs/PathwayRail.tsx`     | frise du parcours, un segment par étape (décorative, doublée du texte) |
| `Tabs`, `Segmented` | `common/`                  | onglets et choix exclusifs au clavier                                  |

## Écrans

### Accueil (`home/HomeScreen.tsx`)

Deux colonnes équilibrées. À gauche : l'action principale, puis les accès (parcours avec sa frise, tutoriel
« premier ping », ouvrir un fichier, nouvelle topologie libre) et les fichiers récents. À droite : une
sélection d'exercices et l'accès au catalogue complet.

| État réel                                  | Action principale                                             | Sélection d'exercices                             |
| ------------------------------------------ | ------------------------------------------------------------- | ------------------------------------------------- |
| Progression en cours de lecture            | emplacement réservé (`aria-busy`), aucune recommandation      | selon les données déjà connues                    |
| Tutoriel proposé (premier lancement, Aide) | « Commencer le tutoriel », « Passer », case « au démarrage »  | labs « Débutant »                                 |
| Aucune tentative enregistrée               | « Commencer le parcours » : étape 1                           | labs « Débutant »                                 |
| Tentatives enregistrées, étape conseillée  | « Prochaine étape conseillée » (étape calculée par le moteur) | suite du parcours, exercices travaillés récemment |
| Parcours terminé, aucune révision due      | « Parcourir le catalogue »                                    | exercices travaillés récemment                    |
| Fichier récent introuvable                 | inchangée                                                     | ligne signalée « Introuvable », retirable         |

La proposition du tutoriel est intégrée à l'accueil ; la carte flottante n'apparaît que hors de l'accueil.

### Catalogue (`labs/LabCatalog.tsx`, logique pure `shared/catalog.ts`)

Recherche (titre, résumé, identifiant ; sans accents ni casse ; tous les mots requis) et filtres fondés sur
des métadonnées **réelles** uniquement : difficulté, durée annoncée (trois tranches), appartenance au
parcours, réussite enregistrée. Aucun classement thématique : les labs n'en portent pas, et le déduire des
titres serait fragile. Nombre de résultats annoncé (`role="status"`), remise à zéro, état « aucun résultat ».
Clavier : focus sur la recherche à l'ouverture, flèche bas vers le premier résultat, Entrée ouvre l'exercice
s'il est le seul retenu.

### Parcours (`labs/PathwayList.tsx`)

En tête : l'entreprise, la progression (frise + décompte) et la prochaine étape conseillée. Étapes
regroupées par jalon (exercice guidé, moins guidé, incident inconnu, révision différée), une ligne par
étape, détails dépliables. Colonne des compétences : non travaillée, travaillée, démontrée, avec ce qui
manque. Aucun verrou : les prérequis restent une recommandation.

### Mission

- **Titre une seule fois** (lecteur). La barre latérale donne le régime, la démarche suggérée et les consoles.
- **Place dans le parcours** (`mission/PathwayContext.tsx`) : étape et récit de l'Atelier Lambert au-dessus
  de l'énoncé. Les labs sont réutilisés tels quels : quand l'énoncé d'origine nomme une autre société, une
  note le dit et précise que manipulations et critères sont identiques.
- **Fenêtre ancrée** : dans l'espace Mission, une fenêtre d'équipement peut être ancrée à gauche du lecteur
  (bouton de la barre de titre). Elle recouvre le contexte et le plan, suit la largeur du lecteur, et la
  consigne reste lisible. Le choix est mémorisé sur le poste ; les fenêtres flottantes, multiples et le
  Bureau simulé sont inchangés.
- **Cadrage du plan** : recadré à l'ouverture et quand un panneau change de taille, tant que l'utilisateur
  n'a ni déplacé la vue, ni zoomé, ni déplacé un équipement. Ensuite son cadrage n'est plus touché.
- **Après Vérifier** (`mission/VerificationSummary.tsx`) : objectifs validés et à reprendre, rappel de la
  limite du constat, aide repliée sous chaque objectif non validé. Le premier indice reste non compté, les
  suivants sont comptés comme avant. En examen et en épreuve, ni résumé ni aide ne sont rendus.
- **Réussite** : résultat attendu de l'étape, compétences **travaillées**, aide utilisée, rappel de la règle
  « démontrée », autoévaluation annoncée comme ni notée ni enregistrée, étape conseillée suivante.

## Limites connues

- Pas de filtre thématique tant que les labs n'ont pas de champ de catégorie (évolution du format de lab).
- La vérification ne fournit que validé / non validé par critère : aucune preuve détaillée n'est affichée.
- Sous 1 200 px CSS, la barre latérale Mission reste masquée (pas de bouton pour la rouvrir).
