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

## Tirage contrôlé (graine)

`startTroubleshooting` tire les pannes avec le PRNG `mulberry32(seed)` : aucun `Math.random()` ni `Date.now()`,
catalogue parcouru dans l'ordre mélangé (Fisher-Yates) d'un tableau ordonné, jamais d'itération sur un objet.
Même graine = mêmes pannes, mêmes cibles, même ordre (sérialisation JSON identique, testée sur 100 graines).

Règle de compatibilité des pannes tirées (écartement déterministe, avant d'accepter une candidate) :

1. la candidate doit avoir un symptôme visible une fois injectée (comme pour une panne seule) ;
2. elle ne doit pas agir sur la même cible qu'une panne déjà active (même équipement et même interface,
   port, groupe, réseau ou service ; un équipement entier si l'une des deux n'a pas de détail) ;
3. son injection ne doit pas masquer le symptôme d'une panne déjà active.

Une candidate incompatible est ignorée et le tirage passe à la suivante. Si le nombre demandé ne peut être
atteint, l'erreur `NoFaultAvailable` est renvoyée (« Aucune panne du catalogue ne s’applique à ce lab avec ces
critères. » ou « Impossible de tirer N pannes compatibles… »). Garantie testée (`tests/engine/troubleshoot/draw.test.ts`) :
pour chaque lab sain de référence, 1 à 3 pannes et les domaines `reseau` / `windows`, tout tirage valide est
entièrement réparé par la réparation officielle appliquée dans l'ordre inverse puis dans l'ordre d'injection.

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
