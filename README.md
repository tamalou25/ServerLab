# ServerLab

Simulateur desktop d'administration de serveurs, pensé pour réviser l'**épreuve E6 du BTS SIO SISR**.
On construit une topologie (serveurs, postes, switchs, routeurs, Internet), puis on configure
les rôles serveur (AD DS, DNS, DHCP, GPO, partages) via une interface graphique ou des consoles
PowerShell / CMD simulées.

> Tout est **simulé** : aucune machine virtuelle, aucune commande système n'est exécutée.
> Projet indépendant, sans affiliation avec un éditeur de logiciels.

## Installation

Téléchargez la dernière version dans les
[Releases](https://github.com/tamalou25/packetracer-windows/releases) du dépôt :

| Système             | Fichier                           | Installation                                                                                                             |
| ------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Windows 10/11 (x64) | `ServerLab-Setup-X.Y.Z.exe`       | Assistant : pour vous seul ou pour tous, dossier au choix, raccourcis Bureau et menu Démarrer, fichiers `.slab` associés |
| Linux (x64)         | `ServerLab-X.Y.Z-x86_64.AppImage` | `chmod +x ServerLab-*.AppImage` puis lancer le fichier                                                                   |

> **Avertissement SmartScreen** : l'installeur n'est pas signé (un certificat de signature de code
> est payant). Au premier lancement, Windows affiche « Windows a protégé votre ordinateur » : cliquez
> sur **Informations complémentaires** puis **Exécuter quand même**.

### Mises à jour

L'application installée vérifie les mises à jour au démarrage et via **Aide > Rechercher des mises
à jour…** : la nouvelle version se télécharge en arrière-plan (progression dans la barre des
tâches), puis ServerLab propose de **redémarrer** — la question « Enregistrer les modifications ? »
est posée avant — ou l'installe à la fermeture. Les fichiers `.slab` et les préférences sont conservés.

> Les mises à jour lisent les releases **publiques** du dépôt, sans aucun jeton embarqué.
>
> **Risque accepté (installeur non signé)** : sans signature de code, Windows ne peut pas vérifier
> l'éditeur d'une mise à jour. Seule l'empreinte SHA-512 publiée avec la release (`latest.yml`) est
> contrôlée : l'authenticité repose donc sur le compte GitHub du projet et sur le workflow de
> publication, réduit au strict nécessaire (droits minimaux, aucun script npm exécuté avec un jeton
> en écriture). La signature de code est suivie dans l'issue #38.

### Signaler un bug

**Aide > Signaler un bug…** ouvre le navigateur sur une issue GitHub préremplie : version de
ServerLab, système, versions d'Electron et de Chromium, et les rubriques à compléter (étapes pour
reproduire, résultat attendu, résultat obtenu). Rien d'autre n'est transmis : ni le lab en cours,
ni le nom d'utilisateur ou de la machine. Joignez vous-même un fichier `.slab` si besoin.

## Développement

Prérequis : **Node.js 22+** et npm.

```bash
npm ci            # installe les dépendances
npm run dev       # lance l'application en mode développement
npm run lint      # ESLint + Prettier
npm run typecheck # vérification TypeScript
npm test          # tests du moteur (Vitest)
npm run test:e2e  # build + tests E2E (Playwright)
npm run dist      # installeur du système courant dans dist/ (NSIS ou AppImage)
npm run dist:dir  # application décompressée dans dist/ (test rapide, sans installeur)
```

Sous Linux sans écran (CI, conteneur) : `xvfb-run -a npm run test:e2e`.

Le workflow **Release** ([`.github/workflows/release.yml`](.github/workflows/release.yml)) :

1. vérifie le dépôt (lint, types, tests du moteur) puis crée la release **en brouillon** ;
2. construit en parallèle l'installeur Windows (`windows-latest`) et l'AppImage (`ubuntu-latest`)
   avec electron-builder, version alignée sur le tag, et les envoie dans la release avec
   `latest.yml` / `latest-linux.yml` (lus par les mises à jour automatiques) ;
3. publie la release une fois les deux installeurs envoyés. Un tag de préversion (`v0.2.0-beta.1`)
   donne une _pre-release_, ignorée par les mises à jour automatiques.

Seul le jeton `GITHUB_TOKEN` du workflow est utilisé (permission `contents: write`) : aucun secret à
configurer. La configuration d'empaquetage est dans [`electron-builder.yml`](electron-builder.yml) ;
la CI la vérifie à chaque push (application empaquetée puis démarrée).

## Architecture

| Dossier        | Rôle                                                                     |
| -------------- | ------------------------------------------------------------------------ |
| `src/main`     | Process principal Electron : fenêtre, menu natif, fichiers, mises à jour |
| `src/preload`  | Pont sécurisé (`contextBridge`) exposant une API minimale                |
| `src/renderer` | Interface React (canvas React Flow, panneaux, consoles)                  |
| `src/engine`   | Moteur de simulation **pur TypeScript** (testable seul)                  |
| `labs`         | Labs pédagogiques au format JSON                                         |
| `tests`        | Tests Vitest (moteur) et Playwright (E2E)                                |

Sécurité : `contextIsolation`, `sandbox`, pas de `nodeIntegration`, CSP stricte, navigation bloquée.

Voir [`CLAUDE.md`](./CLAUDE.md) pour les conventions détaillées.

## Stratégies de groupe (GPO)

- Console **Gestion des stratégies de groupe** (`gpmc.msc`, menu Outils du Gestionnaire de serveur) :
  création et liaison de GPO au domaine ou aux OU, ordre des liens, **Appliqué**, lien activé,
  **blocage de l'héritage**, état GPO, filtrage de sécurité, onglets Étendue / Détails / Paramètres.
- **Éditeur de gestion des stratégies de groupe** : stratégie de mot de passe (Default Domain Policy),
  message avant ouverture de session, papier peint, interdiction du Panneau de configuration, du menu
  Exécuter et de l'invite de commandes, mappage de lecteurs réseau (préférences).
- Application réaliste : stratégie d'ordinateur au démarrage, stratégie utilisateur à l'ouverture
  de session, `gpupdate /force`, `gpresult /r` (GPO appliquées et filtrées avec leur raison :
  sécurité, lien désactivé, GPO désactivée, vide), événements GroupPolicy, échanges LDAP/SMB visibles
  en mode Simulation.
- PowerShell : `New-GPO`, `Get-GPO`, `Rename-GPO`, `Remove-GPO`, `New-GPLink`, `Set-GPLink`,
  `Remove-GPLink`, `Get-GPInheritance`, `Set-GPInheritance`, `Get-GPPermission`, `Set-GPPermission`,
  `Invoke-GPUpdate`.

![Console Gestion des stratégies de groupe](docs/captures/gpo/1-console-heritage.webp)

## Fichiers, partages et NTFS

- Volume `C:` simulé sur chaque serveur : **Explorateur de fichiers** (dossiers, fichiers, lecteurs
  réseau), `dir`, `mkdir`, `rmdir`, `del`, `cd`, `Get-ChildItem`, `New-Item`, `Remove-Item`.
- Autorisations **NTFS** explicites et héritées (onglet Sécurité, `icacls`, `Get-Acl`), désactivation
  de l'héritage (conversion ou suppression), ordre canonique : refus explicite prioritaire.
- **Partages SMB** : Partage avancé, assistant Nouveau partage du Gestionnaire de serveur,
  `New-SmbShare`, `Grant/Revoke/Block-SmbShareAccess`, `net share`, partages administratifs (`C$`…).
- **Accès effectif** : droits d'un utilisateur ou d'un groupe, avec ce qui les limite (partage ou NTFS) ;
  accès réseau = le plus restrictif des deux.
- Depuis un poste : `\\serveur\partage` dans l'Explorateur, **Connecter un lecteur réseau**, `net use`,
  `net view`, erreurs réalistes (53, 67, 5), échanges SMB visibles en mode Simulation ; papier peint
  de stratégie lu sur un partage.

![Accès effectif au travers d'un partage](docs/captures/fichiers/2-acces-effectif.webp)

## Écran d'accueil

Au lancement sans fichier, l'accueil propose **Nouveau lab**, **Ouvrir…**, les labs récents (nom,
dossier, date ; un fichier déplacé ou supprimé est signalé « Introuvable » et peut être retiré de
la liste) et les labs fournis avec leur difficulté et leur durée. Il reste accessible par
**Fichier > Accueil** ; la case « Afficher l'accueil au démarrage » permet de démarrer directement
sur le canvas.

## Tutoriel interactif

Au premier lancement, un tutoriel guide jusqu'au premier ping : placer un serveur et un poste,
les câbler, leur donner une adresse IP fixe dans le même réseau, puis tester avec `ping` (console
ou outil PDU simple). La zone à utiliser est entourée et chaque étape se valide d'elle-même dès
que le lab est dans le bon état (pas de bouton « Suivant »). Le tutoriel peut être passé, n'est
plus proposé une fois réussi (ou si la case « Proposer le tutoriel au démarrage » est décochée)
et se relance par **Aide > Tutoriel interactif**.

## Labs pédagogiques

L'accueil et **Fichier > Ouvrir un lab…** (`Ctrl+L`) proposent vingt-huit labs prêts à l'emploi, du plus simple au
plus complet : adressage et routage, DHCP, DNS, Active Directory + GPO, partages et NTFS, puis un lab par rôle de la
2.1 (WSUS, IIS, Bureau à distance, Hyper-V, AD CS, DFS, sauvegarde et Corbeille AD), par fonctionnalité réseau
de la 2.2 (VLAN, relais DHCP, pare-feu, NAT et VPN, NPS/RADIUS, multi-sites AD) et trois labs de durcissement
de la 2.3 (Active Directory, partages, pare-feu) et sept labs Cisco de la 2.5 (base, VLAN, OSPF, DHCP / NAT, HSRP, sécurité,
sujet E6 complet à deux sites). Chaque lab
construit sa topologie de départ ; l'onglet **Lab** affiche l'énoncé et les objectifs, et
**Vérifier** valide chaque critère (✅ / ❌) avec un indice qui oriente sans donner la solution.
Le lab en cours est conservé dans le fichier `.slab` enregistré.

Les labs sont des fichiers JSON du dossier [`labs/`](labs) (énoncé Markdown, topologie de départ,
critères typés). Chaque lab est couvert par un test qui applique sa solution et exige 100 %.

**Créer un lab…** (dans le sélecteur de labs) ouvre l'éditeur : énoncé Markdown avec aperçu, topologie de
départ capturée sur le lab courant, critères construits sans code et testés aussitôt, indices à plusieurs
niveaux. Le lab s'exporte en JSON et se partage ; **Importer un lab…** l'ouvre comme un lab fourni.

L'onglet **Bibliothèque** du sélecteur liste les labs partagés par la communauté (dépôt public, voir
[`docs/bibliotheque.md`](docs/bibliotheque.md)) : chaque lab est vérifié (empreinte SHA-256, format) avant
ouverture. Le dépôt de labs communautaire n'est pas encore publié : l'onglet reste vide d'ici là.

Le **mode examen** (onglet Lab › Examen) reproduit les conditions d'épreuve : chronomètre, aucun indice,
une seule vérification finale, note sur 20 détaillée par critère et exportable ; toute sortie de
l'application ou abandon est signalé dans le résultat.

![Vérification d'un lab](docs/captures/labs/2-verification.webp)

## Poste Linux

La palette propose un **Poste Linux** (Ubuntu simulé) avec une console bash : `ip a`, `ip route`, `ping`,
`dig`, `realm join` pour rejoindre le domaine Active Directory, `mount -t cifs` ou `smbclient` pour accéder
aux partages selon les autorisations NTFS du compte. Les sorties reprennent le format d'origine des outils
(en anglais).

## Équipements Cisco

La palette propose des routeurs **Cisco 1921** et **2811** et des switchs **Catalyst 2960** et **9200**. Un
double-clic ouvre la console IOS (modes utilisateur, privilégié, configuration ; abréviations, `?`, Tab,
`no`, `do`, `show`, `copy running-config startup-config`, `reload`). Ils partagent le moteur réseau des
autres équipements : un poste Windows, un serveur DHCP Windows et un routeur Cisco se câblent ensemble.

Pris en charge : VLAN et trunk 802.1Q, router-on-a-stick et SVI, routes statiques et OSPF monozone, relais
DHCP et serveur DHCP IOS, NAT / PAT, HSRP, ACL standard et étendues, port-security, SSH, chiffrement des mots de
passe, DHCP snooping, inspection ARP dynamique, `switchport nonegotiate`. Hors périmètre : STP, EtherChannel,
EIGRP, BGP, IPv6, QoS, VTP. Les écarts connus avec le vrai IOS sont listés dans
[`docs/fidelite.md`](docs/fidelite.md) (I1 à I41).

## Langue

Affichage › Langue : **langue du système** (par défaut), Français ou English. Menus, dialogues et interface
de l'application sont traduits ; le serveur simulé (Bureau, consoles, messages) reste installé en français,
comme le contenu des labs.

## Audit de sécurité

L'onglet **Audit** du panneau latéral note la sécurité du lab sur 100 et liste les recommandations par
gravité (objets en cause, correction suggérée), en direct. Il compte les recommandations corrigées depuis
l'ouverture du lab et exporte un **rapport PDF** (lab, date, score, recommandations corrigées ou non).
Les journaux de sécurité (ouvertures de session, gestion des comptes, verrouillages) se filtrent dans
l'Observateur d'événements ou avec `Get-WinEvent`.

## Cybersécurité

Deux volets complémentaires, **entièrement simulés** : aucune VM, aucun exploit, aucune charge utile
(garde-fou et écarts avec la réalité dans `docs/fidelite.md`).

**Défense (v2.6)**

- **Détection** : affichages personnalisés de l'Observateur d'événements (échecs d'ouverture de session,
  verrouillages, tickets Kerberos, sessions privilégiées) ; section **Détection** de l'onglet Audit
  (corrélations « plusieurs échecs puis un succès » et « activité hors horaires »).
- **Référentiels** : chaque règle d'audit cite le guide d'hygiène de l'ANSSI et les CIS Controls v8 ; le
  rapport PDF coche les recommandations satisfaites.
- **Switchs Cisco** : DHCP snooping, inspection ARP, DTP coupé, VLAN natif dédié, port-security, vérifiés
  par l'audit et visibles en mode Simulation.

**Attaque simulée (v2.6.1)**

- **Scénarios** : cinq scénarios abstraits, joués pas à pas depuis le panneau **Simulation > Scénarios**.
  Annuaire : authentification répétée, compte de service mal configuré, réutilisation d'un accès. Réseau :
  usurpation d'adresse sur le segment, changement de VLAN. Chaque scénario réussit si une faiblesse de
  configuration est présente et échoue sur un lab durci ; il journalise ses événements (Observateur, `show logging`).
- **Mode Red / Blue** : partie solo contre l'IA (graine reproductible), minuteur, contre-mesures limitées pour
  Blue ; écran de fin avec résultat, score par camp (scénarios réussis, attaques bloquées, temps de détection)
  et chronologie.
- **Labs** : 29 (durcissement L2 Cisco) et 30 (durcissement AD complet) ; 31 et 32 (compromission puis
  durcissement de l'annuaire) ; 33 et 34 (attaque puis durcissement réseau L2) ; 35 (sujet Red / Blue, annuaire et
  réseau), disponible en mode examen et dans l'éditeur de labs.
