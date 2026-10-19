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

Pannes simples (symptômes lus par des consoles déjà sourcées, rien de nouveau n'est affiché) :

| Identifiant                | Domaine | Diff. | Panne                                                                                   | Symptôme                                                              | Réparation                                            |
| -------------------------- | ------- | ----- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------- |
| `windows.service-stopped`  | windows | 1     | Service arrêté (`service.stop -Force`) : DNS, DHCPServer, LanmanServer, W3SVC, Netlogon | Nom non résolu, bail refusé, erreur 53, site muet, plus de contrôleur | `service.start` (+ dépendants, + renouvellement bail) |
| `win.service-disabled`     | windows | 2     | Service arrêté et désactivé (`service.setStartType Disabled`)                           | Idem, et `Start-Service` refuse de démarrer                           | Type Automatic puis `service.start`                   |
| `win.service-failed`       | windows | 2     | Service en échec au démarrage (`service.setFailure`, 1066 ou 1053)                      | Idem, démarrage refusé avec l'erreur Win32                            | `service.clearFailure` puis `service.start`           |
| `win.dependency-stopped`   | windows | 3     | Dépendance arrêtée de force (`WAS` pour `W3SVC`, `LanmanServer` pour `Netlogon`)        | Le service dépendant est tombé avec elle                              | `service.start` du dépendant (relance la dépendance)  |
| `win.dns-wrong-a`          | windows | 2     | Enregistrement A vers une mauvaise IP (`dns.removeRecord` + `dns.addRecord`)            | `nslookup` renvoie l'adresse erronée, le ping du nom échoue           | Remettre l'adresse d'origine                          |
| `win.dhcp-scope-disabled`  | windows | 2     | Étendue DHCP désactivée (`dhcp.setScopeState`)                                          | `ipconfig /renew` sans bail                                           | Réactiver l'étendue, renouveler le bail               |
| `win.dhcp-scope-exhausted` | windows | 2     | Étendue épuisée : une exclusion couvre toute la plage (`dhcp.addExclusion`)             | `ipconfig /renew` sans bail                                           | `dhcp.removeExclusion`, renouveler le bail            |
| `win.trust-broken`         | windows | 3     | Compte d'ordinateur supprimé puis recréé (`adds.removeObject` + `adds.addComputer`)     | `Test-ComputerSecureChannel` renvoie False                            | `adds.repairSecureChannel`                            |
| `win.account-locked`       | windows | 2     | Compte verrouillé par des mots de passe erronés (`adds.logon` × seuil)                  | Session refusée : « compte … verrouillé »                             | `adds.unlockAccount`                                  |
| `win.account-disabled`     | windows | 1     | Compte désactivé (`adds.setAccountEnabled`)                                             | Session refusée : « compte … désactivé »                              | Réactiver le compte                                   |
| `win.gpo-unlinked`         | windows | 2     | GPO non liée (`gpo.unlink`)                                                             | `gpresult` : la GPO n'est plus appliquée                              | `gpo.link` (ordre et application d'origine)           |
| `win.gpo-filtered`         | windows | 3     | « Utilisateurs authentifiés » retiré du filtrage (`gpo.setSecurityFilter`)              | `gpresult` : GPO refusée (sécurité)                                   | Remettre le filtrage                                  |
| `win.ntfs-rights`          | windows | 2     | Entrée NTFS du groupe supprimée (`files.setNtfsEntry` vide)                             | Écriture refusée dans le partage                                      | `files.setNtfsEntry` d'origine                        |
| `win.share-acl`            | windows | 2     | Autorisations du partage rabaissées à Lecture (`files.setShareAcl`)                     | Écriture refusée malgré les droits NTFS                               | Remettre l'ACL du partage                             |
| `win.clock-skew`           | windows | 2     | Horloge d'un poste décalée de plus de 5 min (`host.setClock`)                           | Session de domaine refusée (Kerberos, écart d'heure)                  | `host.resyncClock` (`w32tm /resync`)                  |
| `net.wrong-mask`           | reseau  | 1     | Masque trop long sur une carte statique (`net.setInterfaceIpv4`)                        | Un voisin du même réseau ne répond plus (`ping`)                      | Remettre le masque d'origine                          |

Les autres pannes réseau viennent avec l'issue #229. Le compte « expiré » n'existe pas : le modèle n'a pas
de date d'expiration de compte (voir `docs/fidelite.md`, D-20 et suivants).

## Pannes composées

Une panne composée associe **deux causes dont la première masque la seconde** : la seconde n'est visible
qu'une fois la première réparée. Exemple : DNS arrêté + enregistrement A erroné. Tant que le service est
arrêté, le nom ne se résout pas ; une fois relancé, le nom se résout mais vers la mauvaise adresse.

- **Définition** (`composite.ts`, `defineComposite`) : une `FaultDef` ordinaire du registre avec
  `parts: [masquante, masquée]` (deux `FaultDef` simples). Son identifiant (`win.combo.*`) se passe à
  `startTroubleshooting` comme n'importe quelle panne, et le tirage par graine peut la choisir. Une seule
  entrée `ActiveFault` : `params` regroupe les cibles des deux parties, préfixées `a.` (masquante) et
  `b.` (masquée).
- **Injection** : la masquée d'abord, puis la masquante (la seconde cause se pose tant que le lab est sain).
- **Symptôme, ticket, indices 1 et 2** : ceux de la masquante. L'indice 3 annonce qu'une seconde cause
  peut apparaître après la première correction.
- **Réparation** : celle de la masquante, puis celle de la masquée. `healed` : les deux parties sont guéries.
- **Cibles retenues** : `pick` ne garde qu'un couple réellement masqué (après injection, le symptôme de la
  masquée est invisible ; la masquante seule réparée, il apparaît). Si `symptomVisible` d'une partie
  dépend du service qui tourne ou du contrôleur joignable, c'est ce qui crée le masque.
- **Tirage de plusieurs pannes** : une panne tirée en plus n'est retenue que si chaque panne reste
  réparable seule sur l'état cassé complet (deux pannes qui se bloquent ne sont pas tirées ensemble).

| Identifiant                             | Masquante (visible)                | Masquée (révélée après)                |
| --------------------------------------- | ---------------------------------- | -------------------------------------- |
| `win.combo.dns-stopped-wrong-a`         | Service DNS arrêté                 | Enregistrement A erroné                |
| `win.combo.clock-account-locked`        | Horloge décalée (Kerberos)         | Compte verrouillé                      |
| `win.combo.dhcp-stopped-scope-disabled` | Service Serveur DHCP arrêté        | Étendue désactivée                     |
| `win.combo.dhcp-failed-scope-exhausted` | Service Serveur DHCP en échec      | Étendue épuisée                        |
| `win.combo.dc-dependency-gpo-unlinked`  | Netlogon tombé avec sa dépendance  | GPO non liée (`gpupdate` impossible)   |
| `win.combo.lanman-stopped-ntfs-rights`  | Service Serveur arrêté (erreur 53) | Droits NTFS incohérents (accès refusé) |

Tests : `tests/engine/troubleshoot/composite.test.ts` (100 graines par composée : seconde cause invisible
tant que la première n'est pas réparée, visible ensuite, guérison complète) en plus du test de
réparabilité commun (`faults.test.ts`). Labs sains de référence : `tests/engine/troubleshoot/bases-windows.ts`
(labs 2, 4, 5 et 7 résolus, domaine avec verrouillage à 3 échecs).
