# Interface v2 — étape 0 (audit, maquettes, plan)

Base lue : `origin/main` @ `ae83d78` (2.10.0). Aucun fichier de l'application modifié.

## Écarts avec le brief

| Point du brief                                      | Réalité                                                                                                           |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| « après la v2.10.1 »                                | `main` = **2.10.0** ; aucune v2.10.1, ni tag v2.10.0                                                              |
| `docs/audit-v2.10.1.md`                             | absent ; seul `docs/audit-v2.6.2.md` existe                                                                       |
| Grille à points 20 px                               | **déjà en place** (`TopologyCanvas.tsx:326`)                                                                      |
| LED aux 2 extrémités, étiquettes de ports en option | **déjà en place** (`CableEdge.tsx`, `view:togglePortLabels`)                                                      |
| Outil « Note »                                      | n'existe pas (`Tool` = select/cable/pdu/delete) → nouveau, sans moteur : à décider (hors .slab ⇒ non persistant)  |
| Icônes « SVG maison, pas de bibliothèque »          | `lucide-react` déjà présent (règle CLAUDE.md) : garder lucide pour le chrome, SVG maison pour les **équipements** |
| `RightPanel`                                        | 4 onglets existants : Lab (si lab) / Propriétés / Simulation / Audit ; Dépannage = sous-vue de Lab                |
| Branches `claude/ui-v2-1-theme`, `ui-v2-2-nodes`    | déjà fusionnées (0 commit d'avance) : refonte v1 des tokens et nœuds                                              |
| Bug                                                 | `ScenarioTimeline.tsx:64,71` : classe `text-bad` sans token → texte d'erreur non coloré                           |
| Thème                                               | `:root` = sombre ; clair via `data-theme`, désactivé par l'OS « Système »                                         |

## Inventaire

### Couleurs brutes — chrome (5 fichiers)

| Fichier                           | Occ. | Nature                                                       |
| --------------------------------- | ---: | ------------------------------------------------------------ |
| `lib/protocols.ts`                |   24 | couleurs de protocoles (palette Tailwind)                    |
| `components/console/Terminal.tsx` |   26 | couleurs ANSI de terminal (légitimes → tokens `--sl-term-*`) |
| `lib/wallpapers.ts`               |   26 | fonds d'écran du Bureau → relève de `--win-*`                |
| `lib/devices.tsx`                 |    6 | `text-white` de `DEVICE_COLORS`                              |
| `canvas/PacketAnimation.tsx`      |    4 | `stroke-white`                                               |

### Couleurs brutes — Windows simulé

`components/desktop|mmc|apps` : **~990 occurrences dans 56 fichiers**. Proposition `--win-*` : oui, mais **à l'étape 9 ou après**, en lot mécanique (haiku), sans changement visuel ; pas dans le chemin critique.

### Tailles hors échelle (chrome)

`text-[10px]` ×5, `text-[10.5px]` ×2 (IP des nœuds), `text-[8px]` ×1 (badge VM), `text-[14px]` ×1, `text-sm` (14 px) ×21, `text-base` ×7, `text-lg` ×2, `text-xl`/`2xl` ×4 (accueil). Windows simulé : 64 tailles arbitraires (exclues).

### `data-testid` touchés par la refonte (637 au total)

`palette`, `palette-toggle`, `palette-search`, `palette-<kind>`, **`palette-group-<id>`** (devient onglet), `device-<nom>`, `device-led`, `device-virtual`, `cable-<a>-<b>`, `port-*`, `tool-<id>`, `tool-hint`, `zoom-*`, `minimap-toggle`, **`right-tab-<id>`** (11 fichiers de tests), `properties-*`, `simulation-panel`, `sim-step`, `sim-events`, `pdu-details`, `pdu-list`, `scenario-*`, `game-open`, `status-bar|counts|save|theme|zoom`, **`mode-realtime|simulation`** (8 fichiers, déplacés vers la barre d'outils : ids conservés).

## Risques

| Risque                        | Détail                                                                                                                                          | Parade                                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| E2E                           | `right-tab-simulation` (Simulation quitte l'inspecteur) ; `palette-group-*` ; `data-health`                                                     | garder les ids sur les nouveaux éléments ; alias `right-tab-properties` → onglet Résumé   |
| Thème clair                   | LED `#22c55e`/`#f59e0b` sur blanc = 2,3/2,2 (< 3:1, WCAG 1.4.11)                                                                                | liseré sombre autour de la LED + forme ; variantes `-text` pour le texte                  |
| Accent                        | blanc sur `#3b82f6` = **3,68** (< 4,5)                                                                                                          | fond de bouton `#2563eb` (5,17) dans les deux thèmes ; `#3b82f6` réservé aux traits/focus |
| Perf canvas                   | `DeviceNode`/`CableEdge` mémoïsés, abonnés à leur seul équipement ; SVG d'icône = `<use>` d'un sprite unique (pas de SVG inline lourd par nœud) | mesure `performance.spec.ts` à 2, 5                                                       |
| Raccourcis (U-01)             | `useKeyboardShortcuts` ignore les modales, mais une **fenêtre d'équipement non modale** reçoit Ctrl+Z/Suppr avec sélection → agit sur le lab    | traiter à l'étape 3 (garde `inDeviceWindow` sur toutes les touches)                       |
| `ICON_CENTER` (`lib/flow.ts`) | 56 → 64 px décale câbles/PDU                                                                                                                    | constante unique à mettre à jour à l'étape 2                                              |

## Branche `lab/mode-enseignant`

1 commit (`ec44bc6`), basée sur un `main` ancien (lab 38) ; **ajoute uniquement** `docs/mode-enseignant-integration.md`. **Aucun composant de `src/renderer` ajouté ou modifié** → aucun conflit avec les étapes 1–9.
Recommandation : **(b)** — le mode enseignant, quand il aura du code, partira de `main` post-refonte et utilisera directement les tokens v2.

## Maquettes

`docs/ui-v2/maquettes/` : `maquette-a-console-dense.html`, `maquette-b-atelier.html`, `planche-icones.html` (+ PNG). Recommandation : **A** pour la mise en page (Simulation pleine largeur), avec le **détail PDU à droite** de B.

## Contrastes (tokens proposés)

| Token       | Sombre (panel / canvas) | Clair (panel / canvas) |
| ----------- | ----------------------- | ---------------------- |
| fg          | 14,85 / 15,27           | 17,74 / 16,84          |
| fg-muted    | 7,89 / 8,12             | 7,56 / 7,17            |
| fg-subtle   | 5,59 / 5,75             | 5,72 / 5,43            |
| accent-text | 10,03 / 10,31           | 6,70 / 6,36            |
| ok-text     | 10,38 / 10,67           | 5,02 / 4,76            |
| warn-text   | 10,83 / 11,14           | 5,02 / 4,77            |
| danger-text | 6,54 / 6,72             | 6,47 / 6,14            |

## Ordre des commits / PR (une issue chacune)

0. `docs: maquettes et plan de l'interface v2` (ce dossier)
1. `test(e2e): références visuelles de l'interface actuelle` puis `feat(renderer): tokens v2, échelle typographique, variantes de texte AA` (+ fix `text-bad`)
2. `feat(renderer): icônes d'équipements SVG et nœud 64 px à LED double indice` (+ `ICON_CENTER`)
3. `feat(renderer): barre d'outils principale` (+ correctif U-01)
4. `feat(renderer): palette à onglets et vignettes 48 px`
5. `feat(renderer): câbles — infobulle, étiquettes, légende des protocoles`
6. `feat(renderer): inspecteur à onglets (Résumé, Lab, Audit, Dépannage)`
7. `feat(renderer): panneau Simulation inférieur rétractable`
8. `feat(renderer): barre de titre des fenêtres et menu contextuel des nœuds`
9. `docs: interface v2, captures, liens ServerLab` + `chore: 2.11.0`

## Version

**2.11.0** : aucun changement de format `.slab`, de moteur ni d'API ; raccourcis et menu inchangés.

## Décisions de Gary

Maquette A + détail du PDU de B · mode enseignant : (b) · version 2.11.0 · démarrage sur la base 2.10.0.
Issues : #292 (étape 0) à #301 (étape 9).
