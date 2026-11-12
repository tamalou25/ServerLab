# Performance — topologie de 100 équipements

Mesures de l'issue #13. Topologie générée par `tests/support/large-lab.ts` : 100 équipements
(SW1 cœur, SRV1 DHCP/DNS, SRV2, R1, 7 switchs d'accès, 89 postes dont 1 sur 8 en statique ; SW8
isolé, ses postes restent sans bail), baux déjà obtenus comme dans un lab enregistré après usage.

## Remesurer

```bash
npm run perf:measure                                            # moteur (Vitest, médianes)
npm run build && xvfb-run -a npx playwright test tests/e2e/performance.spec.ts   # application
```

Le test E2E affiche une ligne `[perf]` ; il pose `window.serverlabPerf` pour compter les rendus
des nœuds et des câbles (instrumentation inactive sinon, `src/renderer/src/lib/perf.ts`).
`npm run perf:measure` écrit aussi `out/lab-100.slab`, à ouvrir dans l'application (Fichier >
Ouvrir…) pour un essai manuel.

Environnement des mesures : conteneur Linux 4 vCPU, Electron 44 sous xvfb (60 images/s).

## Avant (`feat/8-annuler-retablir`)

| Mesure                                                     | Valeur       |
| ---------------------------------------------------------- | ------------ |
| Moteur — ouverture (lecture + tâches de fond + canvas)     | 15,9 ms      |
| Moteur — glisser, par mouvement                            | 9,1 ms       |
| — dont tâches de fond                                      | 0,2 ms       |
| — dont calcul du canvas (état et IP des nœuds, voyants)    | 9,0 ms       |
| Application — ouverture jusqu'aux 100 nœuds affichés       | 226 à 433 ms |
| Application — glisser, par mouvement                       | 53 à 68 ms   |
| Application — image p95 / max pendant le glisser           | 33 / 50 ms   |
| Application — rendus des **autres** nœuds (glisser de 30)  | 6 047        |
| Application — rendus des **autres** câbles (glisser de 30) | 5 917        |

Causes : chaque nœud et chaque câble est abonné à tout le lab ; le canvas recrée tous les objets
nœuds à chaque mouvement ; le cache des conflits d'adresses (`ipConflicts`, parcours des segments
de niveau 2) est indexé sur l'état, qui change à chaque mouvement ; les tâches de fond repassent sur
tout le lab (DORA retenté pour les postes sans bail) après chaque modification.

## Après (`feat/13-performance`)

| Mesure                                                     | Avant        | Après        |
| ---------------------------------------------------------- | ------------ | ------------ |
| Moteur — ouverture (lecture + tâches de fond + canvas)     | 15,9 ms      | 15,8 ms      |
| Moteur — glisser, par mouvement                            | 9,1 ms       | 0,15 ms      |
| — dont tâches de fond                                      | 0,2 ms       | 0,14 ms      |
| — dont calcul du canvas                                    | 9,0 ms       | 0,02 ms      |
| Application — ouverture jusqu'aux 100 nœuds affichés       | 226 à 433 ms | 205 à 243 ms |
| Application — glisser, par mouvement (pilotage Playwright) | 53 à 68 ms   | 31 à 36 ms   |
| Application — image p95 / max pendant le glisser           | 33 / 50 ms   | 16,7 / 33 ms |
| Application — rendus des **autres** nœuds (glisser de 30)  | 6 047        | **0**        |
| Application — rendus des **autres** câbles (glisser de 30) | 5 917        | **0**        |

Ce qui a changé :

- **Caches par réseau** (`src/engine/net/network-key.ts`) : grâce au partage structurel d'immer,
  un déplacement ou un renommage garde les mêmes câbles et les mêmes cartes (par référence).
  `ipConflicts` et `canvasStatus` (`src/engine/topology/view.ts` : état et IP de chaque nœud,
  voyants des câbles) ne sont recalculés que si le réseau change ; les entrées inchangées sont
  réutilisées par référence.
- **Rendus ciblés** : chaque nœud et chaque câble est abonné à son seul équipement (ou câble) et à
  son entrée de `canvasStatus` ; le canvas réutilise les objets nœuds inchangés ; le survol est
  ignoré pendant le glisser d'un autre élément.
- **Tâches de fond incrémentales** : chaque tâche déclare ses dépendances (`BackgroundTask.deps`) ;
  le moteur ne la relance que si elles ont changé. Un déplacement ne retente plus de DORA ; raccorder
  le switch isolé ou rallumer le serveur DHCP relance le client DHCP.

L'ouverture reste dominée par le premier rendu de React Flow (100 nœuds mesurés) ; la lecture et
les tâches de fond du moteur n'en représentent que ~16 ms.

Mesure en CI (GitHub Actions, `ubuntu-latest`, 2 passages) : ouverture 211 / 308 ms, glisser
22,5 / 30,9 ms par mouvement, image p95 16,7 / 16,8 ms, 0 rendu des autres nœuds et câbles.

## Seuils du test automatisé

`tests/e2e/performance.spec.ts` échoue au-delà de ces seuils (constante `THRESHOLDS`) :

| Contrôle                                        | Seuil      | Rôle                                     |
| ----------------------------------------------- | ---------- | ---------------------------------------- |
| Rendus des autres nœuds pendant le glisser      | 0          | strict : abonnements par équipement      |
| Rendus des câbles non raccordés au nœud déplacé | 0          | strict                                   |
| Ouverture jusqu'aux 100 nœuds affichés          | < 2 000 ms | régression grossière (runners variables) |
| Glisser, durée par mouvement                    | < 80 ms    | régression grossière                     |
| Image p95 pendant le glisser                    | < 70 ms    | régression grossière                     |

Les durées dépendent de la machine (glisser mesuré de 22 à 46 ms par mouvement selon l'hôte, le
pilotage Playwright en représente l'essentiel) : elles servent de garde-fou. Le contrôle précis est
le nombre de rendus : sans la réutilisation des objets nœuds du canvas, le test relève 3 075 rendus
des autres nœuds et échoue.

## Modification réseau (audit v2.6.2, P-01)

Une modification du réseau (adresse IP, câble, alimentation) recalcule `canvasStatus`. Deux coûts
quadratiques la dominaient : `computeConflicts` parcourait le domaine de diffusion de **chaque**
carte adressée, et `linkOnInterface` parcourait tous les câbles pour chaque port.

| Mesure (`npm run perf:measure`, 100 équipements)      | Avant    | Après    |
| ----------------------------------------------------- | -------- | -------- |
| Modification réseau : IP d'un poste (tâches + canvas) | 18,85 ms | 3,27 ms  |
| — dont calcul du canvas                               | 17,56 ms | 1,83 ms  |
| Ouverture (lecture + tâches de fond + canvas)         | 36,58 ms | 15,02 ms |

- `src/engine/net/conflicts.ts` : seules les adresses portées par au moins deux cartes déclenchent
  le parcours du domaine de diffusion (résultat identique).
- `src/engine/topology/queries.ts` : `linkOnInterface` lit l'index `portIndex` sur un état figé ;
  dans un brouillon immer, les câbles changent sous la même référence et le parcours direct reste
  utilisé (test « à jour dans un brouillon immer »).

## Lab mixte de 100 équipements et endurance (audit v2.11.1, phase 4)

`buildLargeLab({ mixed: true })` (`tests/support/large-lab.ts`, outil de test seulement, jamais
embarqué) produit 100 équipements hétérogènes : cœur Catalyst 9200, 7 Catalyst 2960, routeur Cisco
1921, pare-feu FW1, serveur Linux SRV3, SRV1/SRV2 Windows, postes Windows et Linux en alternance.
`npm run perf:measure` mesure les deux variantes et écrit `out/lab-100.slab` et `out/lab-100-mixte.slab`.

| Mesure (E2E, même environnement) | Standard | Mixte   |
| -------------------------------- | -------- | ------- |
| Ouverture                        | 251 ms   | 217 ms  |
| Glisser (par mouvement)          | 37,4 ms  | 34,6 ms |
| Image p95                        | 16,8 ms  | 16,7 ms |
| Rendus des autres nœuds / câbles | 0 / 0    | 0 / 0   |
| Tas du renderer après ouverture  | 36 Mo    | 36 Mo   |
| Moteur — ouverture (médiane)     | 16,7 ms  | 11,3 ms |
| Moteur — glisser par mouvement   | 0,37 ms  | 0,18 ms |

Endurance (`tests/e2e/endurance.spec.ts`) : 50 ouvertures de labs intégrés à la suite, tas mesuré
après GC forcé (DevTools). Début 8,7 Mo, après 10 : 11,3 Mo, après 50 : 11,5 Mo (DOM stable à 1 091
éléments, RSS du processus principal 164 → 175 Mo). Seuil : croissance du tas entre 10 et 50
ouvertures inférieure à 10 Mo, et du DOM inférieure à 200 éléments.
