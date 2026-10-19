# Roadmap ServerLab

Versions prévues après la v1.0.0, avec leurs objectifs et critères d'acceptation. Le détail de
chaque fonctionnalité (critères à cocher) est dans son issue GitHub, rattachée au milestone de sa
version. Source unique : [`.github/roadmap/roadmap.json`](.github/roadmap/roadmap.json), synchronisé
avec GitHub par le workflow **Roadmap sync** (ne crée que ce qui manque).

| Version | Thème                                                         | Milestone                                                                      |
| ------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| v1.1    | Consolider (prérequis d'architecture, ergonomie, performance) | [v1.1](https://github.com/tamalou25/packetracer-windows/milestone/1)           |
| v2.1    | Nouveaux rôles serveur                                        | [v2.1](https://github.com/tamalou25/packetracer-windows/milestone/2)           |
| v2.2    | Réseau avancé                                                 | [v2.2](https://github.com/tamalou25/packetracer-windows/milestone/3)           |
| v2.3    | Cybersécurité défensive                                       | [v2.3](https://github.com/tamalou25/packetracer-windows/milestone/4)           |
| v2.4    | Pédagogie et communauté                                       | [v2.4](https://github.com/tamalou25/packetracer-windows/milestone/5)           |
| v2.5    | Équipements Cisco IOS                                         | [v2.5](https://github.com/tamalou25/packetracer-windows/milestone/6)           |
| v2.6    | Cybersécurité défensive                                       | [v2.6](https://github.com/tamalou25/packetracer-windows/milestones?q=v2.6)     |
| v2.6.1  | Cybersécurité, volet attaque                                  | [v2.6.1](https://github.com/tamalou25/packetracer-windows/milestones?q=v2.6.1) |
| v2.8    | Révision E6 et serveurs Linux                                 | [v2.8](https://github.com/tamalou25/packetracer-windows/milestones?q=v2.8)     |

> Le milestone v1.1 est sorti sous le numéro de version **2.0.0** (choix de Gary), suivi de la 2.0.1
> (stabilisation). Les milestones suivants ajoutent des fonctionnalités sans casser les fichiers
> existants (migrations `.slab`) : ce sont des versions mineures (SemVer), de 2.1.0 à 2.4.0.
> Corrections de la 2.0 : milestone `v2.0.x`.

Règles : un milestone ne commence qu'une fois le précédent terminé et validé ; une issue = une
branche `feat/<num>-<slug>` = une PR (`Closes #N`) ; fin de milestone = CHANGELOG, version, tag
`vX.Y.0` (voir [CLAUDE.md](CLAUDE.md)).

## v1.1 — Consolider

**Objectif** : rendre le moteur extensible avant d'ajouter des rôles, et finir l'ergonomie de base.

### Prérequis d'architecture (en premier)

| Fonctionnalité                  | Critère d'acceptation                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Modules de rôles (`RoleModule`) | DHCP, DNS, AD DS, GPO et Fichiers migrés dans `src/engine/roles/<rôle>` ; un nouveau rôle ne touche plus au cœur         |
| Pattern Command                 | Toute modification = commande nommée via un `dispatch` unique ; inverse par patches immer ; rejeu du journal = même état |
| Migrations `.slab`              | Un fichier de référence par version ; chacun s'ouvre et migre jusqu'à la version courante                                |
| Validation zod                  | Tout fichier importé est validé ; un fichier corrompu donne une erreur claire, jamais un plantage                        |

### Fonctionnalités

| Fonctionnalité                   | Critère d'acceptation                                               | Déjà fait (audit v1.0)              |
| -------------------------------- | ------------------------------------------------------------------- | ----------------------------------- |
| Annuler / rétablir               | Ctrl+Z / Ctrl+Y sur canvas, configs et consoles, avec libellés      | Pile de 100 instantanés, raccourcis |
| Thème, raccourcis, zoom, minimap | Thème « Système » par défaut, raccourcis documentés                 | Sombre/clair, zoom, minimap         |
| Écran d'accueil                  | Récents, nouveau lab, labs fournis                                  | —                                   |
| Tutoriel interactif              | Premier ping guidé, étapes validées par l'état réel, désactivable   | —                                   |
| Signaler un bug                  | Issue GitHub préremplie (version, OS, étapes), URL en liste blanche | —                                   |
| Performance                      | 100 équipements fluides, mesuré par un test                         | —                                   |
| Logique hors composants          | Règles NTFS et ports déplacées dans le moteur                       | Ajoutée par l'audit                 |

## v2.1 — Nouveaux rôles serveur

**Objectif** : couvrir les rôles d'infrastructure courants, chacun sous forme de `RoleModule`.

| Rôle       | À simuler                                                                 | Critère d'acceptation                                                        |
| ---------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| WSUS       | Synchro, classifications, groupes d'ordinateurs, approbations, GPO client | Un client ne reçoit que les MAJ approuvées pour son groupe                   |
| IIS        | Sites, liaisons (port, en-tête d'hôte), dossier racine, HTTPS             | `http://intranet.domaine.local` répond depuis un client après ajout du CNAME |
| RDS        | Hôte de session, groupe d'accès, RemoteApp                                | Seuls les membres autorisés ouvrent une session                              |
| Hyper-V    | VM imbriquées, commutateurs externe / interne / privé                     | Une VM sur commutateur privé ne joint pas le réseau physique                 |
| ADCS       | AC racine d'entreprise, modèles, inscription auto par GPO                 | Certificat IIS émis par l'AC interne, approuvé par les clients du domaine    |
| DFS        | Espaces de noms, groupes de réplication                                   | Un fichier créé sur un serveur apparaît sur l'autre                          |
| Sauvegarde | Planification, restauration, corbeille AD                                 | Un utilisateur AD supprimé est restaurable                                   |

## v2.2 — Réseau avancé

| Fonctionnalité                 | Critère d'acceptation                                        |
| ------------------------------ | ------------------------------------------------------------ |
| VLAN, trunk 802.1Q, inter-VLAN | Deux VLAN ne communiquent que via le routeur « on a stick »  |
| Relais DHCP                    | Un serveur DHCP sert plusieurs VLAN (helper-address)         |
| Pare-feu simulé                | Profils et règles avec effet réel sur ping et partages       |
| RRAS                           | NAT vers Internet et VPN simple fonctionnels                 |
| NPS / RADIUS                   | VPN autorisé uniquement pour un groupe AD                    |
| Multi-sites AD                 | Sites, liens, réplication entre DC, transfert des rôles FSMO |

## v2.3 — Cybersécurité (défensif)

| Fonctionnalité                | Critère d'acceptation                                                                                                |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Mode Audit                    | Score de sécurité + recommandations (admins, expiration, partages, SMBv1, mots de passe, comptes inactifs, pare-feu) |
| Labs de durcissement          | Lab mal configuré → corrections → score validé                                                                       |
| Journaux de sécurité          | 4624, 4625, 4720, 4728, 4740, 4672 simulés et filtrables                                                             |
| Verrouillage et audit par GPO | Effet visible dans les journaux                                                                                      |
| Rapport PDF                   | Rapport d'audit exportable                                                                                           |

## v2.4 — Pédagogie et communauté

| Fonctionnalité             | Critère d'acceptation                                                       |
| -------------------------- | --------------------------------------------------------------------------- |
| Éditeur de labs            | Énoncé, topologie, critères sans code, indices progressifs                  |
| Mode examen                | Chronomètre, sans indices, note détaillée exportable                        |
| Bibliothèque communautaire | Index JSON dans un dépôt séparé, validation zod stricte, aucun code exécuté |
| Client Linux               | Poste Ubuntu simulé : `ip a`, `realm join`, accès SMB                       |
| Interface FR / EN          | i18n complète, aucune clé manquante                                         |
| Signature de code          | Procédure documentée, rien d'automatisé sans accord                         |

## v2.5 — Équipements Cisco IOS

Routeurs (1921, 2811) et switchs (Catalyst 2960, 9200) dotés d'une CLI IOS simulée, branchés sur le
moteur réseau existant (pas de second moteur de routage).

| Fonctionnalité        | Critère d'acceptation                                                    |
| --------------------- | ------------------------------------------------------------------------ |
| Nœuds Cisco           | Se posent, se câblent, s'enregistrent ; console IOS au double-clic       |
| Moteur CLI            | Modes, abréviations, `?`, Tab, `no`, `do`, erreurs IOS fidèles           |
| Configuration de base | `no shut` → up/up ; `reload` sans sauvegarde perd la configuration       |
| Switching et VLAN     | Ping inter-VLAN via router-on-a-stick puis via SVI                       |
| Routage               | Statique et OSPF monozone ; couper un lien recalcule les routes          |
| Services IP           | Relais DHCP vers Windows Server, DHCP IOS, NAT/PAT visible en Simulation |
| HSRP                  | La passerelle virtuelle bascule puis revient avec `preempt`              |
| Sécurité              | ACL (visible en Simulation), port-security err-disabled, SSH             |
| Labs et format        | `.slab` v9, un lab par thème, sujet E6 complet, mode examen              |

Hors périmètre : STP/RSTP détaillé, EtherChannel, OSPF multizone, EIGRP/BGP, IPv6, QoS, VTP
(pistes ultérieures) ; attaques L2 : v2.6.1.

## v2.6 — Cybersécurité défensive

Détection dans les journaux, contre-mesures L2 Cisco, audit adossé à l'ANSSI et au CIS, labs de
durcissement. Prérequis : v2.5 (IOS, VLAN, ACL, port-security).

| Fonctionnalité    | Critère d'acceptation                                                                  |
| ----------------- | -------------------------------------------------------------------------------------- |
| Détection         | 4624, 4625, 4740, 4769, 4672 ; corrélations « N échecs puis 1 succès », hors horaires  |
| Contre-mesures L2 | DHCP snooping, DAI, DTP coupé, VLAN natif dédié ; l'audit signale les ports non durcis |
| Audit ANSSI / CIS | Le rapport PDF cite la référence ; corriger un point coche la recommandation           |
| Labs et format    | `.slab` v10, labs de détection et de durcissement (L2, AD), mode examen                |

## v2.6.1 — Cybersécurité, volet attaque

Scénarios d'attaque simulés de façon **abstraite** : on modélise leur résultat sur l'état simulé
(compte compromis, événement journalisé), jamais l'exploit ; aucun code offensif réel
(`docs/fidelite.md`).

| Fonctionnalité          | Critère d'acceptation                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| Moteur de scénarios     | Un scénario progresse pas à pas en Simulation et modifie l'état de façon réversible               |
| Attaques sur l'annuaire | Authentification répétée, compte de service, réutilisation d'accès : échouent sur un lab durci    |
| Attaques L2             | Usurpation d'adresse, changement de VLAN : échouent après le durcissement de la v2.6              |
| Mode Red / Blue         | Partie complète en solo contre l'IA (graine), minuteur, score final par camp, temps de détection  |
| Labs et format          | `.slab` v14, labs 31 à 35 (compromission, durcissement, sujet Red / Blue), mode examen et éditeur |

Hors périmètre (v2.6 et v2.6.1) : tout exploit réel ou code offensif utilisable hors du simulateur,
attaques web (OWASP), reverse engineering, forensic disque, EDR, SIEM réel (pistes v2.7).

## v2.8 — Révision E6 et serveurs Linux

Deux volets. **Révision E6** : mesurer la progression, s'entraîner sur des sujets complets chronométrés
et produire la fiche de recette du dossier d'épreuve. **Serveurs Linux** : un serveur Debian/Ubuntu
simulé avec ses services usuels (Samba, messagerie, DNS/DHCP, web, SSH, pare-feu), interopérable avec
les rôles Windows. Les règles de fidélité de la v2.7 s'appliquent (sortie de référence sourcée, tests golden).

| Fonctionnalité     | Critère d'acceptation                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| Progression        | Historique des tentatives et scores par lab et par domaine, export JSON                        |
| Sujets E6          | 5 sujets chronométrés en mode examen, barème par compétence                                    |
| Fiche de recette   | PDF des tests réalisés et de leurs résultats, joint au dossier d'épreuve                       |
| Serveur Linux      | Nouveau type d'équipement : `systemctl`, `apt`, comptes, droits ; un service arrêté a un effet |
| Samba              | Partages utilisables depuis Windows et Linux, jonction au domaine AD                           |
| Messagerie         | Postfix + Dovecot, envoi entre serveurs via MX, rebonds réalistes                              |
| DNS / DHCP Linux   | BIND9 et ISC DHCP sur le même moteur que les rôles Windows                                     |
| Web, SSH, pare-feu | Apache/Nginx, OpenSSH, `ufw` / `iptables` filtrant le trafic simulé, audit CIS / ANSSI Linux   |
| Labs et fidélité   | Labs Linux, sujet mixte Windows + Linux, captures `docs/captures/bash/`, tests golden          |

Hors périmètre : conteneurs (Docker), orchestration, serveurs de bases de données, tout service
nécessitant l'exécution réelle de code.

## Points d'attention (audit v1.0)

- Le dépôt est désormais public : les mises à jour automatiques fonctionnent. La bibliothèque
  communautaire attend la publication du dépôt `serverlab-labs` (index encore absent, audit v2.6.2).
- Hyper-V (équipements imbriqués), VLAN (refonte du L2) et client Linux (nouveau type d'équipement
  et nouveau shell) sont les plus gros changements de modèle.
- Le bundle de l'interface tient en un seul bloc de 1,9 Mo ; les chaînes sont en français codé en dur.
