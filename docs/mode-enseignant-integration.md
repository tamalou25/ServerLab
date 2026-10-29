# Mode enseignant — suivi du chantier isolé

Cette branche est `lab/mode-enseignant`, créée depuis `main`. Le chantier est hors version publiée : ne pas ouvrir de PR vers `main`, ne pas créer de tag, ne pas modifier la version ni le CHANGELOG avant la demande explicite de Gary (« on intègre »).

## État

- [x] Branche longue durée créée depuis `main`.
- [x] Lecture initiale des consignes, feuille de route, suivi de fidélité, moteur des labs, historique/dispatch, sérialisation et composants d’interface demandés.
- [ ] Chantier 1 : formats autonomes, validation, export/import sujet et barème.
- [ ] Chantiers suivants : passation, correction, démonstration et documentation.

## Points d’accroche prévus (aucun changement de fichier existant à ce stade)

| Fichier existant | Ligne | Raison                                                                                                                                                      |
| ---------------- | ----: | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Aucun            |     — | Le chantier n’a pas encore ajouté de code ni modifié de fichier existant. Les accroches seront recensées précisément au moment où elles seront nécessaires. |

## Intégration ultérieure

- Rebaser sur `origin/main` au début de chaque session et traiter les conflits en gardant `main`, puis réappliquer seulement les accroches documentées.
- Vérifier un drapeau de fonctionnalité désactivé par défaut avant toute intégration ; un merge accidentel ne doit pas activer le mode.
- Les formats `.slabsujet`, `.slabrendu` et `.slabcorrection` doivent rester autonomes, bornés en taille, validés strictement par zod, et avoir leur propre numéro de format/migrations. Aucun changement requis aux `.slab` tant qu’une fonctionnalité ne le nécessite pas.
- Le moteur ne lit pas l’horloge système : l’interface fournit les horodatages.
- À l’intégration seulement : mettre à jour version et CHANGELOG, puis préparer une PR selon la demande de Gary.

## Limites de sécurité à documenter

Une application hors ligne ne peut pas rendre inviolable un examen sur le poste de l’élève. Le code d’activation n’est qu’une protection contre l’activation accidentelle. La correction recalculée par rejeu permet de détecter des incohérences, mais ne prouve pas l’absence de copie, d’aide externe ou d’altération sophistiquée. Les imports devront limiter la taille, les étapes de rejeu et le temps de traitement.

## Après l'interface v2 (2.11.0)

La branche intègre `main` (interface v2, voir [ui-v2.md](ui-v2.md)). Le chantier n'a toujours ajouté aucun code : seule la cartographie des accroches change.

### Ce qui change pour le mode enseignant

- **Composants** : la fenêtre unique est organisée en `MainToolbar`, `Palette`, `TopologyCanvas`, `RightPanel` (inspecteur), `SimulationPanel` et `StatusBar`, tous sous `src/renderer/src/components/`. Les écrans du mode enseignant (sujet, barème, correction) réutilisent ce vocabulaire, sans fenêtre à part.
- **Tokens** : toute couleur du chrome passe par les variables `--sl-*` de `src/renderer/src/styles.css`, exposées en classes Tailwind (`bg-panel`, `bg-surface`, `text-fg-muted`, `border-line`, `bg-accent`, `text-ok-text`…). Aucune couleur brute. Les états se doublent d'un second indice (forme, symbole ou texte) : une note ou un critère validé/échoué ne se signale pas par la couleur seule. Le Bureau simulé reste en `data-theme="light"` avec sa palette propre.
- **Inspecteur à onglets** : `RightPanel.tsx` porte la liste `TABS` (Propriétés, Lab, Audit, Dépannage) ; l'onglet actif est `rightTab` dans `src/renderer/src/store/ui.ts` (type `RightTab`). L'onglet Lab n'apparaît que si un lab ou un résultat d'examen existe, et un dépannage en cours a le sien. Le contenu des labs vient de `components/labs/` (`LabPanel`, `Exam`, `Troubleshoot`).
- **Panneau Simulation** : `components/simulation/SimulationPanel.tsx` (bas) et `ScenarioTimeline.tsx`. Il ne concerne le mode enseignant que pour la démonstration (rejeu pas à pas), pas pour la passation.
- **Raccourcis** : tout nouveau raccourci est déclaré dans `src/shared/shortcuts.ts` (menu natif et aide).

### Points d'accroche prévus (à confirmer à l'implémentation)

| Fichier existant                                   | Accroche                                                           | Raison                                            |
| -------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------- |
| `src/renderer/src/store/ui.ts`                     | ajouter `'teacher'` à `RightTab`                                   | nouvel état d'onglet                              |
| `src/renderer/src/components/RightPanel.tsx`       | entrée dans `TABS`, visible seulement si le drapeau est actif      | onglet « Enseignant » (sujet, barème, correction) |
| `src/main/menu.ts` + `src/shared/ipc.ts`           | entrée de menu (`cmd('teacher:…')`) et type de commande            | ouvrir/exporter un sujet, importer un rendu       |
| `src/renderer/src/App.tsx`                         | traitement de la commande de menu                                  | même chemin que `file:troubleshoot`               |
| `src/renderer/src/components/MainToolbar.tsx`      | bouton optionnel (icône `lucide-react`, `aria-label`)              | accès rapide, absent par défaut                   |
| `src/shared/shortcuts.ts`                          | raccourcis éventuels                                               | catalogue unique                                  |
| `src/main/labfiles.ts`, `validate.ts`, `atomic.ts` | lecture/écriture des `.slabsujet`, `.slabrendu`, `.slabcorrection` | IPC validé, taille bornée, écriture atomique      |

Le drapeau de fonctionnalité reste désactivé par défaut : onglet, entrée de menu et bouton sont absents tant qu'il ne l'est pas.

### Reste à faire

- Chantier 1 : formats autonomes, schémas zod stricts, numéro de format et migrations propres, bornes de taille et de pas de rejeu, export/import sujet et barème.
- Passation (chronomètre fourni par l'interface, code d'activation), correction par rejeu, démonstration.
- Onglet « Enseignant », entrée de menu natif, bouton de barre d'outils, textes FR/EN, tests Vitest du moteur et E2E.
- Références visuelles (`tests/e2e/visual.spec.ts`) à régénérer si l'interface change.
- Version et CHANGELOG uniquement à la demande de Gary (« on intègre »).
