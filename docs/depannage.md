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
- **Jamais de sortie inventée**, ni de panne matérielle (disque, carte, alimentation). Le câble débranché est admis : c’est un état du lien de la topologie, observable par les consoles déjà sourcées.
- Le titre et la cause ne sont montrés qu'à l'abandon ou au bilan ; le ticket ne cite ni la cause ni l'identifiant.

## Catalogue

| Identifiant               | Domaine | Difficulté | Panne                                                            | Symptôme                                         | Réparation                   |
| ------------------------- | ------- | ---------- | ---------------------------------------------------------------- | ------------------------------------------------ | ---------------------------- |
| `windows.service-stopped` | windows | 1          | Service DNS arrêté (`service.stop`)                              | Un nom de la zone ne se résout plus (`nslookup`) | `service.start`              |
| `net.wrong-mask`          | reseau  | 1          | Masque trop long sur une carte statique (`net.setInterfaceIpv4`) | Un voisin du même réseau ne répond plus (`ping`) | Remettre le masque d'origine |

Pannes réseau de l'issue #229 (domaine `reseau`) :

| Identifiant              | Difficulté | Panne                                                           | Symptôme observé                                              | Réparation                                   |
| ------------------------ | ---------- | --------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------- |
| `net.wrong-gateway`      | 1          | Passerelle erronée sur une carte statique                       | Hôte d'un autre réseau injoignable (`ping`)                   | Remettre la passerelle d'origine             |
| `net.duplicate-ip`       | 1          | Adresse d'un autre poste du même réseau                         | Adresse « Dupliqué(e) » (`ipconfig`)                          | Remettre l'adresse d'origine                 |
| `net.cable-unplugged`    | 1          | Câble d'un poste débranché (`topology.disconnect`)              | « Média déconnecté » (`ipconfig`), `ping` sans réponse        | Rebrancher aux mêmes ports                   |
| `net.wrong-vlan`         | 2          | Port d'accès dans un autre VLAN (`net.setSwitchport`)           | `ping` sans réponse, `show vlan`                              | Remettre le VLAN d'origine                   |
| `net.trunk-missing-vlan` | 2          | VLAN absent de la liste autorisée d'un trunk                    | `ping` sans réponse, `show interfaces trunk`                  | Remettre la liste d'origine                  |
| `net.port-err-disabled`  | 2          | Port err-disabled (violation de port-security, IOS)             | `show interfaces status`, `show port-security interface`      | Retirer la cause, `shutdown` / `no shutdown` |
| `net.acl-blocking`       | 2          | ACL étendue bloquante en entrée d'une interface de routeur      | `ping` sans réponse, `show access-lists`, `show ip interface` | Retirer l'ACL de l'interface                 |
| `net.missing-route`      | 2          | Route statique supprimée (`net.removeStaticRoute`)              | `ping`, `tracert`, `show ip route`                            | `net.addStaticRoute`                         |
| `net.wrong-nat`          | 3          | NAT : liste d'accès, interface de sortie ou rôles inversés      | `ping` vers l'extérieur, `show ip nat translations`           | Remettre la configuration d'origine          |
| `net.wrong-stp-root`     | 3          | Priorité STP plus basse sur un switch d'accès (mauvaise racine) | `show spanning-tree`                                          | Remettre la priorité d'origine               |
| `net.etherchannel-down`  | 3          | Mode `channel-group` incompatible avec le voisin                | `show etherchannel summary` (ports `I`)                       | Remettre le mode d'origine                   |

Les pannes IOS passent par des lignes de console rejouées en commandes `shell.exec` (`iosCommands`,
`faults/net-common.ts`). Labs sains de référence : lab 1, 3, 13, 23, 24 (routes statiques), 25 (NAT), 38.

## Interface

Code : `src/renderer/src/components/labs/Troubleshoot.tsx`, `lib/troubleshoot.ts`, `store/troubleshoot.ts`. Le
moteur reste seul juge : l'interface orchestre `startTroubleshooting`, `troubleshoot.useHint`, `allRepaired` et
`summarizeTroubleshooting` (`src/engine/troubleshoot/summary.ts`, pur et testé).

1. **Lancer** : Fichier > « Lancer un dépannage… » (ou le bouton du sélecteur de labs). Le lab de base est le
   document ouvert : il doit fonctionner (état sain). Choix de la difficulté maximale (1 à 3), du domaine
   (réseau, Windows, aléatoire), du nombre de pannes (1 ou 2) et de la graine (tirée et affichée, modifiable pour
   rejouer). Si aucune panne ne s'applique, le message du moteur (`NoFaultAvailable`…) est affiché dans la boîte.
2. **Ticket** : l'onglet Lab affiche le ticket de l'utilisateur (`FaultDef.ticket`), jamais la cause.
3. **Indices** : bouton « Indice » (symptôme, zone, piste) ; chaque clic est la commande nommée
   `troubleshoot.useHint`. Le compteur est affiché et pénalise le score (10 points par indice).
4. **« J'ai réparé »** : vérifie `allRepaired` ; sinon « Le problème persiste. » sans dire quoi.
   **« Abandonner »** révèle la cause et la correction officielle (libellés des commandes de `FaultDef.repair`).
5. **Journal** : nombre de commandes nommées jouées depuis le départ (annuler puis rétablir ne recompte pas),
   liste des libellés, indices et durée réelle (fournie par le renderer, le moteur ne lit pas l'horloge).
6. **Bilan** : symptôme, cause, correction officielle, « chemin le plus court » (commandes de la réparation
   officielle) comparé à la démarche de l'élève. Score sur 100 = `100 × officielles / max(jouées, officielles)`
   moins 10 par indice ; 0 sans réparation.
7. **Chronométré** : case « Dépannage chronométré » : session et résultat du mode examen (`labs/exam.ts`),
   durée imposée, indices désactivés, vérification unique ; un critère `faultRepaired` par panne donne la note
   sur 20, affichée avec le bilan.
8. **Annuler** : le départ du dépannage est chargé comme un nouveau document (historique vide) : « Annuler » ne
   revient jamais avant l'injection de la panne, seules les actions de l'élève (et les indices) sont annulables.

Test de bout en bout : `tests/e2e/troubleshoot.spec.ts`.
