# Mode panne (dépannage)

Un lab de dépannage démarre **cassé** : l'élève lit un ticket, diagnostique avec les consoles et
l'interface, puis répare. Tout est calculé depuis l'état du lab (moteur pur, déterministe).

## Le modèle

Code : `src/engine/troubleshoot/`.

- **`FaultDef`** (`types.ts`) : une panne est une transformation déterministe de l'état sain.
  `pick` choisit les cibles (graine fournie), `inject` rend les commandes nommées qui cassent,
  `symptomVisible` constate le symptôme, `ticket` / `hints` (3 indices) / `cause` sont les textes,
  `repair` rend la réparation officielle et `healed` constate la guérison.
- **`startTroubleshooting(healthy, spec)`** (`session.ts`) : tire (ou prend) les pannes, les injecte par
  `dispatch` et renvoie l'état cassé comme **nouveau point de départ**. Les commandes d'injection ne sont
  pas dans le journal : l'historique annuler / rétablir démarre après, une panne ne se répare pas par
  « Annuler ». Même graine, mêmes pannes.
- **État** : champ facultatif `troubleshooting { seed, faults[{ id, params, hintsUsed }] }` de `LabState`
  (sauvé dans le `.slab`, format 26 inchangé). Commande nommée `troubleshoot.useHint` (annulable).
- **Lab** : champ facultatif `troubleshooting { seed, domain?, difficulty?, count?, faults? }` de la
  définition d'un lab ; `buildLabState(lab)` construit le lab sain puis injecte. Critère `faultRepaired`
  (toutes les pannes actives, ou `faultId`), combinable avec les critères existants.

## Ajouter une panne (6 étapes)

1. Créer `src/engine/troubleshoot/faults/<panne>.ts` qui exporte une `FaultDef` (`id` du type `domaine.nom`).
2. `pick` : cibles valides dans l'état sain (ou `null`), tirées avec le `rand` fourni, jamais `Math.random()`.
3. `inject` et `repair` : uniquement des commandes nommées du catalogue (`command('service.stop', …)`).
4. `symptomVisible` et `healed` : lire l'état par les fonctions du moteur (ping, résolution…), pas de texte.
5. `ticket` (sans la cause), 3 `hints` (symptôme, zone, piste, sans la solution), `cause`.
6. L'ajouter à `FAULTS` (`registry.ts`) : le test de cohérence et le test de réparabilité (100 graines sur
   les labs de `tests/engine/troubleshoot/bases.ts`) la couvrent ; ajouter un lab sain de référence si
   aucun ne convient.

## Garde-fous

- **Réparable** avec les commandes disponibles : le test de réparabilité l'exige pour chaque panne.
- **Symptômes sourcés** : le symptôme est la sortie d'une commande déjà simulée et sourcée ; une panne
  n'ajoute jamais de sortie de console. Pas de source, pas de panne.
- **Jamais de sortie inventée**, ni de panne physique ou matérielle.
- Le titre et la cause ne sont montrés qu'à l'abandon ou au bilan ; le ticket ne cite ni la cause ni l'identifiant.

## Catalogue

| Identifiant               | Domaine | Difficulté | Panne                                                            | Symptôme                                         | Réparation                   |
| ------------------------- | ------- | ---------- | ---------------------------------------------------------------- | ------------------------------------------------ | ---------------------------- |
| `windows.service-stopped` | windows | 1          | Service DNS arrêté (`service.stop`)                              | Un nom de la zone ne se résout plus (`nslookup`) | `service.start`              |
| `net.wrong-mask`          | reseau  | 1          | Masque trop long sur une carte statique (`net.setInterfaceIpv4`) | Un voisin du même réseau ne répond plus (`ping`) | Remettre le masque d'origine |

Les autres pannes réseau viennent avec l'issue #229.
