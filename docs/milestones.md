# Journal des milestones v2.1 → v2.6

Suivi de la réalisation de la roadmap (`ROADMAP.md`), une issue = une branche `feat/<num>-<slug>` = une PR.
Ce journal permet à une nouvelle session de reprendre le travail là où il s'est arrêté.

## Conventions retenues

- **Format .slab** : une seule version de format par milestone. La première issue qui modifie le format
  incrémente `CURRENT_SCHEMA_VERSION` et écrit `fixtures/vN.slab` ; les issues suivantes du même milestone
  ajoutent des champs avec valeurs par défaut (le fichier de référence de la version reste valable).
  v2.1 → format 5 ; v2.2 → format 6 ; v2.3 → format 7 ; v2.4 → format 8 ; v2.5 → format 9 ; v2.6 → format 10 ; v2.6.1 → formats 11 à 14
  (migration écrite dans la dernière issue : champs IOS facultatifs avec valeurs par défaut).
- **Fidélité** : un comportement de Windows Server non sourcé est noté dans `docs/fidelite.md` (« à vérifier »).
- **Fin de milestone** : `CHANGELOG.md`, version de `package.json`, tag `vX.Y.0` poussé par Gary.

## v2.1 — Nouveaux rôles serveur

| Issue | Sujet                    | Branche          | PR  | État     |
| ----- | ------------------------ | ---------------- | --- | -------- |
| #15   | Rôle WSUS                | `feat/15-wsus`   | #74 | fusionné |
| #16   | Rôle IIS                 | `feat/16-iis`    | #75 | fusionné |
| #17   | Rôle RDS                 | `feat/17-rds`    | #76 | fusionné |
| #18   | Rôle Hyper-V             | `feat/18-hyperv` | #77 | fusionné |
| #19   | Rôle AD CS               | `feat/19-adcs`   | #78 | fusionné |
| #20   | Rôle DFS                 | `feat/20-dfs`    | #79 | fusionné |
| #21   | Sauvegarde, corbeille AD | `feat/21-backup` | #80 | fusionné |

Milestone terminé : `CHANGELOG.md` [2.1.0], `package.json` 2.1.0 ; tag `v2.1.0` à pousser par Gary.

### #15 WSUS

- Moteur : `src/engine/roles/wsus/` (catalogue fictif KB91xxxxx, post-installation, synchronisation,
  classifications, groupes, ciblage serveur/client, approbations, refus) ; client : `wsusClientStatus`
  (stratégie appliquée → résolution DNS → échange HTTP 8530 tracé → groupe → mises à jour approuvées).
- GPO : « Spécifier l'emplacement intranet du service de mise à jour Microsoft » et « Autoriser le ciblage
  côté client » (Composants Windows > Windows Update). Protocole `HTTP` ajouté aux traces.
- Cmdlets : Get-WsusServer, Get-WsusClassification, Set-WsusClassification, Get-WsusUpdate,
  Approve-WsusUpdate, Deny-WsusUpdate, Get-WsusComputer, Add-WsusComputer.
- Interface : console « Services WSUS » (wsus.msc), page Windows Update des postes (ms-settings:windowsupdate).
- Lab `lab-06-wsus`, critères `wsusSynchronized`, `wsusApproval`, `wsusComputerGroup`, `wsusClientUpdate`.

### #16 IIS

- Système de base : magasin de certificats des ordinateurs (`host.certificates`, Personnel et Root),
  `New-SelfSignedCertificate`, confiance par la chaîne (`services/certificates.ts`) — réutilisé par AD CS (#19).
- Contrat des rôles : crochet `onInstall` (préparation du serveur : `C:\inetpub\wwwroot\iisstart.htm`).
- Moteur : `roles/iis/` (sites, liaisons IP/port/en-tête d'hôte, certificat SSL, conflits de liaison) et
  client HTTP `httpGet` (DNS avec CNAME, TCP tracé, choix du site comme http.sys, document par défaut,
  403.14, 404.0, 400 nom d'hôte invalide, connexion refusée, avertissements de certificat).
- Cmdlets WebAdministration (Get/New/Remove/Start/Stop-Website, Get/New/Remove-WebBinding) et
  Invoke-WebRequest (alias iwr, curl, wget) ; console « Gestionnaire IIS » (inetmgr), Navigateur Web.
- Lab `lab-07-iis`, critères `iisSite` et `httpResponse`.

### #17 RDS

- Système de base : paramètre « Autoriser les connexions à distance » et groupe local Utilisateurs du
  Bureau à distance (`host.remoteDesktop`), sessions distantes (`host.remoteSessions`), protocole `RDP`
  dans les traces ; onglet « Utilisation à distance » des Propriétés système.
- Moteur : `roles/rds/` (déploiement à serveur unique : collections, groupes d'utilisateurs — Utilisateurs
  du domaine par défaut —, RemoteApp) et `rdpConnect` (DNS, TCP 3389 tracé, authentification,
  autorisation : administrateurs, groupes de la collection sur un hôte de session, sinon groupe local ;
  évènements 4624 / 4625 de type 10).
- Cmdlets RemoteDesktop (New/Get/Remove-RDSessionCollection, Set-RDSessionCollectionConfiguration,
  New/Get/Remove-RDRemoteApp, Get-RDUserSession) et Add/Remove/Get-LocalGroupMember (groupe
  Utilisateurs du Bureau à distance) ; console « Services Bureau à distance », Connexion Bureau à distance (mstsc).
- Lab `lab-08-rds`, critères `rdsCollection` et `rdpSession`.

### #18 Hyper-V

- Modèle (premier cas d'équipements imbriqués) : une VM est un serveur ou un poste du lab avec
  `hostedBy` = l'hôte ; un commutateur virtuel est un switch hébergé dont les ports sont créés à la
  demande ; les liaisons VM ↔ commutateur sont des câbles `virtual` (pointillés sur le canvas).
  Commutateur externe : la carte physique de l'hôte devient un pont (`bridge`, sans adresse IP) et sa
  configuration IP passe sur `vEthernet (Nom)` ; `l2Segment` traverse le pont.
- Garde-fous de topologie : pas de câble vers une VM ou un commutateur virtuel, pas de suppression
  directe (Gestionnaire Hyper-V) ; supprimer l'hôte supprime ses équipements virtuels ; éteindre l'hôte
  arrête ses VM.
- Moteur `roles/hyperv/` : New/Remove-VMSwitch, New/Remove/Start/Stop/Set-VM, Get-VM, cartes réseau
  (Get/Add/Connect/Disconnect-VMNetworkAdapter), MAC 00-15-5D ; critères `vmSwitch`, `virtualMachine`
  et option `success: false` du critère `ping` (isolement) ; lab `lab-09-hyperv`.
- Format .slab : champs `hostedBy`, `virtual`, `bridge` avec valeurs par défaut (format 5 du milestone).

### #19 AD CS

- Contrat des rôles : crochet `onComputerPolicy` appelé au traitement de la stratégie ordinateur d'un
  membre du domaine (démarrage, gpupdate).
- Moteur `roles/adcs/` : autorité racine d'entreprise (nom par défaut `LAB-SRV1-CA`, certificat d'AC
  5 ans), modèles publiés par défaut, demande/émission (modèles Ordinateur et Serveur Web), révocation
  (motifs de certutil) ; côté client : certificat racine ajouté au magasin Root des membres, inscription
  automatique (paramètre GPO « Client des services de certificats – Inscription automatique »).
- HTTPS (IIS) : certificat révoqué signalé par le navigateur ; Gestionnaire IIS « Créer un certificat de domaine ».
- Cmdlets Install-AdcsCertificationAuthority, Get/Add/Remove-CATemplate, Get-Certificate ; outil certutil
  (-revoke, -crl, -pulse, -store) ; console « Autorité de certification » ; critères `enterpriseCa`,
  `caTemplate`, `certificate` ; lab `lab-10-adcs`.
- Critères : valeurs par défaut (`success`, `status`, `opened`, `received`) lues de façon robuste hors zod.

### #20 DFS

- Contrat des rôles : crochet `resolveUnc` (référence d'un chemin réseau) appelé par `openUnc`.
- Moteur `roles/dfs/` : espaces de noms de domaine (`\\lab.local\Partages`, racine `C:\DFSRoots\<nom>`
  partagée, dossiers et cibles, référence vers la première cible en ligne) ; réplication (groupes, membres,
  dossiers répliqués, chemin local et membre principal). Synchronisation par instantané : ajouts copiés,
  suppressions propagées (éléments vus par membre), version la plus récente gagnante ; tâche de fond
  `dfs.replication` (immédiate en Temps réel, différée en Simulation) et `Sync-DfsReplicationGroup`.
- Cmdlets DFSN (New/Get/Remove-DfsnRoot, -DfsnFolder, -DfsnFolderTarget) et DFSR (New/Get/Remove-
  DfsReplicationGroup, Add-DfsrMember, New-DfsReplicatedFolder, Set/Get-DfsrMembership,
  Sync-DfsReplicationGroup) ; console « Gestion DFS » ; critères `dfsNamespace`, `uncReachable`,
  `dfsReplicated` ; lab `lab-11-dfs`.

### #21 Sauvegarde et Corbeille AD

- Format : domaine `recycleBin` et `deletedObjects` (objet copié, groupes d'appartenance, date de
  suppression), valeurs par défaut sans nouvelle version (v5 = milestone v2.1).
- Corbeille AD (module AD DS) : activation irréversible, objets supprimés conservés avec leurs attributs et
  appartenances, restauration à l'emplacement d'origine (parent supprimé → restaurer le parent d'abord) ou
  dans un autre conteneur ; cmdlets `Enable-ADOptionalFeature`, `Get-ADOptionalFeature`,
  `Get-ADObject -IncludeDeletedObjects`, `Restore-ADObject` ; console « Centre d'administration Active
  Directory » (`dsac.exe`), limitée à la Corbeille.
- Moteur `roles/backup/` : fonctionnalité Windows-Server-Backup, planification quotidienne (éléments, état du
  système, destination hors du volume sauvegardé), sauvegarde unique, versions, récupération (créer une
  copie, remplacer, ignorer) avec ACL et propriétaire ; `wbadmin` (start backup, enable backup, get versions,
  start recovery) ; console « Sauvegarde Windows Server » ; critères `backupPolicy`, `backupSet`,
  `adRecycleBin` ; lab `lab-12-sauvegarde`.

## v2.2 — Réseau d'entreprise

| Issue | Sujet                   | Branche              | PR  | État     |
| ----- | ----------------------- | -------------------- | --- | -------- |
| #22   | VLAN, trunk, inter-VLAN | `feat/22-vlan`       | #82 | fusionné |
| #23   | Relais DHCP             | `feat/23-dhcp-relay` | #83 | fusionné |
| #24   | Pare-feu simulé         | `feat/24-firewall`   | #84 | fusionné |
| #25   | RRAS : VPN et NAT       | `feat/25-rras`       | #85 | fusionné |
| #26   | NPS / RADIUS            | `feat/26-nps`        | #86 | fusionné |
| #27   | Multi-sites AD, FSMO    | `feat/27-ad-sites`   | #87 | fusionné |

Milestone terminé : `CHANGELOG.md` [2.2.0], `package.json` 2.2.0 ; tag `v2.2.0` à pousser par Gary.

### #22 VLAN

- Format 6 (migration 5 → 6 sans transformation, `fixtures/v6.slab` avec VLAN 20, trunk et sous-interface) :
  base des VLAN des switchs (`vlans`), configuration 802.1Q des ports (`switchport`, absente = accès VLAN 1),
  sous-interfaces de routeur (`subinterface` : carte parente, VLAN dot1Q).
- Couche 2 (`net/segment.ts`) : parcours par VLAN (ports d'accès, trunks, VLAN autorisés, VLAN natif, VLAN
  absent de la base = trame perdue) ; un routeur reçoit les trames étiquetées sur la sous-interface du VLAN ;
  chaque saut porte son étiquette, affichée en couche « 802.1Q » en mode Simulation.
- Actions `net/vlan.ts` et commandes `net.addVlan`, `net.renameVlan`, `net.removeVlan`, `net.setSwitchport`,
  `net.addSubinterface`, `net.removeSubinterface` ; onglet Config : pages « VLAN » (switch) et
  « Sous-interfaces » (routeur) ; critère `switchport` ; lab `lab-13-vlan`.

### #23 Relais DHCP

- Interface de routeur (ou sous-interface) : `helperAddresses` (ip helper-address), champ optionnel du format 6 ;
  action et commande `net.setHelperAddresses`, saisie dans l'onglet Config de l'interface.
- `dhcpAcquire` : sans serveur sur le segment, l'agent de relais retransmet Discover et Request en unicast
  (UDP 67, giaddr = adresse de l'interface) ; le serveur choisit l'étendue couvrant giaddr, répond à l'agent de
  relais (route nécessaire), qui remet Offer et Ack au client. Champ « Agent relais (giaddr) » et choix de
  l'étendue expliqués en mode Simulation.
- Lab `lab-14-relais-dhcp` ; e2e `dhcp-relay.spec.ts`.

### #24 Pare-feu

- Hôte : `firewall` (profils Domaine/Privé/Public : activé, actions par défaut entrant Bloquer / sortant
  Autoriser ; catégorie du réseau hors domaine ; état des règles prédéfinies ; règles locales). GPO
  ordinateur : « protéger toutes les connexions réseau » (profil du domaine, profil standard) et règles de
  trafic entrant. Champs avec valeurs par défaut (format 6).
- `services/firewall.ts` : règles prédéfinies des services installés (partage de fichiers ICMP/SMB, Bureau à
  distance selon l'autorisation des connexions, DNS, AD DS/Kerberos, DHCP, IIS 80/443, WSUS 8530, DFSR),
  profil actif (domaine si membre, sinon catégorie), évaluation (blocage prioritaire, action par défaut,
  pare-feu à états : réponses non filtrées), actions et commandes `firewall.*`.
- `sendIp` : filtrage entrant à la remise et sortant à l'émission ; paquet rejeté expliqué en mode Simulation
  (règle ou action par défaut, profil). Les échanges TCP portent leur port (IIS : port de l'URL).
- Cmdlets NetSecurity (Get/Set-NetFirewallProfile, Get/New/Set/Enable/Disable/Remove-NetFirewallRule,
  Get/Set-NetConnectionProfile), `netsh advfirewall` (show/set profils, firewall add/delete/set/show rule) ;
  console `wf.msc` ; éditeur GPO (modèles et règles de trafic entrant) ; critères `firewallProfile`,
  `firewallRule` ; lab `lab-15-pare-feu`.

### #25 RRAS (NAT, VPN)

- Contrat des rôles : crochets de transit `transit` (`sim/transit.ts`) appelés par `sendIp` : un serveur peut
  router, traduire les adresses (NAT), répondre en proxy ARP, encapsuler dans un tunnel ; `Delivery.src`
  donne l'adresse vue par le destinataire (les réponses la visent : NAT).
- Module `roles/rras/` : rôle Accès à distance (DirectAccess-VPN, Routage), assistant (NAT, VPN, VPN et NAT,
  routage LAN, deux interfaces requises), pool d'adresses ; NAT sur l'interface publique (traduction et
  retraduction expliquées en Simulation) ; VPN SSTP (TCP 443, règle de pare-feu prédéfinie) : authentification
  (compte local ou du domaine, `adds/credentials.ts` partagé avec RDS), adresse du pool, tunnel vers les
  réseaux privés du serveur, proxy ARP ; journaux RemoteAccess 20274 / 20271.
- Client VPN (tous les ordinateurs) : `vpnConnections` de l'hôte, Paramètres › Réseau › VPN, cmdlets
  `Add/Get/Remove-VpnConnection`, `rasdial` ; serveur : `Install-RemoteAccess`, `Uninstall-RemoteAccess`,
  `Get-RemoteAccess`, `Set-VpnIPAddressAssignment`, `Get-RemoteAccessConnectionStatistics`, console
  `rrasmgmt.msc` ; critères `natEnabled`, `vpnConnected` ; format des labs : `nics` et passerelle par carte ;
  lab `lab-16-acces-distant`.

### #26 NPS / RADIUS

- Module `roles/nps/` : rôle Services de stratégie et d'accès réseau (`NPAS`, outils `RSAT-NPAS`), clients
  RADIUS (nom convivial, adresse, secret partagé), stratégies réseau (condition « Groupes Windows », accès
  accordé ou refusé, ordre de traitement, activation ; nouvelle stratégie en tête ; les deux stratégies de
  refus créées avec le rôle). Console `nps.msc`, cmdlets `New/Get/Remove-NpsRadiusClient`, règle de pare-feu
  prédéfinie (UDP 1812/1645), critères `radiusClient`, `npsPolicy`, `npsAccess`.
- Authentification RADIUS (`nps/radius.ts`) : Access-Request du serveur d'accès (UDP 1812, protocole RADIUS
  en Simulation), client et secret vérifiés (événements NPS 13 / 18 sinon, sans réponse), authentification
  dans le domaine, première stratégie correspondante ; journal Sécurité 6272 (accordé) / 6273 (refusé, codes
  de raison 16, 34, 48, 65), réponse Access-Accept / Access-Reject.
- RRAS : serveurs RADIUS d'authentification (`Add/Get/Remove-RemoteAccessRadius`, console : Fournisseur
  d'authentification) ; sans réponse : événement 20073. Champ `radius` avec valeur par défaut (format 6).
- **Acceptation** : seuls les membres du groupe autorisé établissent le VPN (`tests/engine/roles/nps.test.ts`,
  lab `lab-17-nps-radius`, `tests/e2e/nps.spec.ts`).

### #27 Multi-sites AD, réplication et rôles FSMO

- Domaine : sites, sous-réseaux, liens de sites (coût, intervalle 15 min à 1 semaine par pas de 15),
  site de chaque contrôleur, détenteurs FSMO, état de réplication (valeurs par défaut, format 6).
  Console `dssite.msc` ; cmdlets `Get/New/Remove-ADReplicationSite`, `…-ADReplicationSubnet`,
  `Get/New/Set/Remove-ADReplicationSiteLink`, `Move-ADDirectoryServer`, `Get-ADDomainController`.
- `Install-ADDSDomainController` : DC localisé par le DNS, compte Admins du domaine, site du sous-réseau,
  zones DNS intégrées à AD copiées, enregistrements SRV génériques et de site.
- Réplication (tâche de fond, `repadmin /replsummary | /showrepl | /syncall`, « Répliquer maintenant ») :
  topologie KCC (DC d'un site entre eux ; têtes de pont sur l'arbre de liens de moindre coût), erreur 1722
  et événement 1925 si le partenaire est injoignable, événement 1311 pour un site isolé, fusion multimaître
  des zones DNS intégrées à AD.
- FSMO : `netdom query fsmo`, `Move-ADDirectoryServerOperationMasterRole` (transfert ; `-Force` : prise de
  force si le détenteur ne répond pas).
- Localisation : le DC contacté indique le site du client, qui interroge alors le SRV du site ;
  `%LOGONSERVER%` (contrôleur ayant authentifié la session), `nltest /dsgetdc:`. Résolution DNS insensible
  à la casse. Critères `adSite`, `siteLink`, `domainController`, `fsmoRole`, `logonServer` ; lab
  `lab-18-multi-sites`.

## v2.3 — Cybersécurité (défensif)

| Issue | Sujet                           | Branche                  | PR  | État     |
| ----- | ------------------------------- | ------------------------ | --- | -------- |
| #28   | Mode Audit                      | `feat/28-audit`          | #89 | fusionné |
| #29   | Labs de durcissement            | `feat/29-hardening-labs` | #90 | fusionné |
| #30   | Journaux de sécurité filtrables | `feat/30-security-logs`  | #91 | fusionné |
| #31   | Verrouillage et audit par GPO   | `feat/31-lockout-audit`  | #92 | fusionné |
| #32   | Rapport d'audit PDF             | `feat/32-audit-pdf`      | #95 | fusionné |

Bug relevé en cours de route : #93 (double-clic de l'éditeur GPO), PR #94.

Milestone terminé : `CHANGELOG.md` [2.3.0], `package.json` 2.3.0 ; tag `v2.3.0` à pousser par Gary.

### #28 Mode Audit

- Contrat des rôles : `RoleModule.auditRules` (règles déclaratives : identifiant, gravité, correction,
  `check(state)` → objets en cause) ; `audit/rules.ts` réunit les règles du système de base (pare-feu) et des
  rôles ; `audit/audit.ts` calcule le score (100 − poids des règles enfreintes : critique 25, élevée 15,
  moyenne 10, faible 5), trie les recommandations par gravité et compare deux audits (corrigé / non corrigé).
- Règles : SMB 1.0 (critique), plus de 2 Admins du domaine, partage Tout le monde : Contrôle total, pare-feu
  désactivé, stratégie de mot de passe < 12 caractères ou sans complexité (élevées), mots de passe sans
  expiration, comptes inactifs > 90 jours (moyennes).
- Format 7 : `passwordNeverExpires`, `whenCreated`, `lastLogon` des comptes ; `smb1` des ordinateurs.
  `Get/Set-SmbServerConfiguration`, `New/Set-ADUser -PasswordNeverExpires`, propriétés `LastLogonDate`,
  `whenCreated`. Onglet **Audit** du panneau latéral (score en direct, recommandations, objets, correction).

### #29 Labs de durcissement

- Critères `auditScore` (score ≥ N) et `auditRule` (règle respectée ou non) du système de base.
- Format des labs : `smb1`, `firewallDisabled`, `shares` (dossiers partagés et autorisations) par ordinateur ;
  `passwordNeverExpires`, `memberOf` (groupes existants), `createdDaysAgo`, `lastLogonDaysAgo` par compte ;
  `passwordPolicy` du domaine. Commandes `adds.setAccountActivity` (historique d'un compte) et
  `adds.setUserProperties` (case « Le mot de passe n'expire jamais » de la console AD, dernière ouverture de
  session affichée).
- Labs `lab-19-durcissement-ad`, `lab-20-durcissement-partages`, `lab-21-durcissement-pare-feu` : départ sous
  100 avec toutes les règles ciblées enfreintes (testé), solution appliquée par les consoles → 100 %.

### #30 Journaux de sécurité filtrables

- Évènements : 4624 / 4625 (ouverture de session interactive, locale ou de domaine, type 2), 4672
  (privilèges spéciaux : administrateur local ou du domaine), 4720 (création de compte), 4728 / 4729, 4732 /
  4733, 4756 / 4757 (membre ajouté / retiré d'un groupe de sécurité global, local, universel) ; 4740 :
  verrouillage, issue #31.
- `core/eventlog.ts` : `filterEvents` (ID, niveau, source, période). Observateur d'événements : « Filtrer le
  journal actuel… » (période, niveau, source, ID), « Effacer le filtre », nombre filtré.
- PowerShell : tables de hachage `@{ Clé = Valeur }` (lexer, analyseur, interpréteur) ; `Get-WinEvent`
  (-LogName, -FilterHashtable LogName / Id / Level / ProviderName / StartTime / EndTime, -MaxEvents, -Oldest,
  erreur « Aucun événement correspondant… ») ; `parseLabDate` (dates JJ/MM/AAAA ou AAAA-MM-JJ).

### #31 Verrouillage et audit par GPO

- GPO (paramètres d'ordinateur) : « Stratégie de verrouillage du compte » (seuil 0–999, durée 0–99 999 min,
  réinitialisation 1–99 999 min ≤ durée) et « Stratégie d'audit » (événements de connexion, gestion des
  comptes : Pas d'audit / Succès / Échec). Comme le mot de passe, le verrouillage vient des GPO liées à la
  racine du domaine ; l'audit suit les paramètres appliqués à l'ordinateur (gpupdate, démarrage).
- Comptes : `badPwdCount`, `lastBadPassword`, `lockoutTime` (valeurs par défaut du format 7). N échecs →
  compte verrouillé, 4740 sur l'émulateur PDC ; tentatives suivantes refusées (« Le compte référencé est
  actuellement verrouillé… », 4768 code 0x12) ; déverrouillage automatique après la durée (0 : manuel),
  compteur remis à zéro après le délai de réinitialisation ou une ouverture de session réussie.
- `roles/gpo/auditpolicy.ts` : 4624 / 4625 / 4634 / 4672 (connexion), 4720 / 4728… / 4740 / 4741 (gestion
  des comptes) inscrits seulement si l'ordinateur les audite (défaut sans GPO : connexions succès et échecs,
  gestion des comptes succès).
- Déverrouillage : commande `adds.unlockAccount` (case « Déverrouiller le compte » de la console AD),
  `Unlock-ADAccount`, `Search-ADAccount -LockedOut / -AccountDisabled`, propriétés `LockedOut`,
  `BadLogonCount`, `AccountLockoutTime`.

### #32 Rapport d'audit PDF

- Moteur : `audit/report.ts` (`buildAuditReport`) — lab, date, score, score de référence, recommandations
  « corrigé » / « non corrigé » (non corrigées d'abord, nouvelles signalées), compteurs. Référence : état au
  chargement du document (départ du lab), conservé par le store (`loadedLab`).
- `shared/auditReport.ts` : schéma zod du contenu (bornes), nom de fichier proposé, page HTML A4 (texte
  échappé, CSP `default-src 'none'`, aucun script). Main (`main/report.ts`) : contenu validé, dialogue
  natif « Enregistrer sous », impression par une fenêtre cachée sans JavaScript (`printToPDF`), fichier
  temporaire supprimé.
- Onglet Audit : score au chargement, nombre de recommandations corrigées, bouton **PDF**.

## v2.4 — Pédagogie avancée

| Issue | Sujet                      | Branche                | PR   | État     |
| ----- | -------------------------- | ---------------------- | ---- | -------- |
| #33   | Éditeur de labs intégré    | `feat/33-lab-editor`   | #97  | fusionné |
| #34   | Mode examen                | `feat/34-exam-mode`    | #98  | fusionné |
| #35   | Bibliothèque communautaire | `feat/35-lab-library`  | #100 | fusionné |
| #36   | Client Linux simulé        | `feat/36-linux-client` | #99  | fusionné |
| #37   | Interface FR / EN (i18n)   | `feat/37-i18n`         | #101 | fusionné |
| #38   | Signature de code          |                        |      | gelée    |

### #33 Éditeur de labs intégré

- Format des labs (compatible) : départ « instantané » `start.snapshot` (document .slab complet, validé et
  migré par `parseSlabValue` comme un fichier ouvert) en plus du départ déclaratif ; `hints` (indices
  suivants, révélés un à un) en plus de `hint`.
- Moteur (`labs/editor.ts`) : `criterionCatalog` (types de critères et champs déduits des schémas zod :
  texte, nombre, booléen, énumération, liste ; valeur par défaut ; suggestions par référence), libellé
  français obligatoire de chaque type (`defineCriterion(schéma, évaluateur, libellé)`), `labReferences`
  (équipements, comptes, groupes, domaines, GPO, sites du lab courant), `buildCheck` (formulaire → critère
  validé, erreurs en français), `testCheck`, `createLabDefinition` (instantané du départ capturé),
  `draftFromLab`, `serializeLab`.
- Interface : Fichier › Ouvrir un lab… › **Créer un lab…** (éditeur : énoncé Markdown avec aperçu, départ
  capturé sur le lab courant, critères testés aussitôt sur le lab courant, indices à plusieurs niveaux,
  Exporter / Importer / Essayer) et **Importer un lab…** ; onglet Lab : « Indice suivant ».
- Main (`main/labfiles.ts`) : import / export JSON par dialogues natifs, 1 Mo au plus.
- Limite : un lab importé n'est pas conservé dans le `.slab` enregistré (seuls les labs fournis le sont).

### #34 Mode examen

- Moteur (`labs/exam.ts`) : `startExam` (durée tirée de la durée indicative du lab : « 25 min », « 1 h 30 »),
  `remainingMs`, `recordExamEvent` (perte et retour du focus, une sortie par absence), `finishExam`
  (vérification finale unique, note sur 20 au dixième, détail par critère, fin : terminé, temps écoulé —
  durée bornée à l'échéance — ou abandon), `examResultText` (résultat exporté). Le temps réel est fourni
  par l'interface.
- Interface : onglet Lab › **Examen** (le lab repart de son départ), bandeau du chronomètre, indices et
  résultats intermédiaires masqués, **Terminer l'examen** ; résultat (note, critères, durée, fin, sorties
  horodatées) et **Exporter le résultat…** (texte, dialogue natif). Sorties signalées : fenêtre quittée
  (blur), lab fermé ou autre document ouvert (abandon, noté sur l'état d'avant), temps écoulé.

### #35 Bibliothèque communautaire de labs

- Moteur : `labs/sha256.ts` (SHA-256 en TypeScript pur, UTF-8, vecteurs FIPS 180-4), `labs/library.ts`
  (index strict : identifiants uniques, chemins `labs/<nom>.json`, empreinte ; `verifyLibraryLab` :
  empreinte, schéma des labs, identifiant).
- Main (`main/library.ts`, `shared/library.ts`) : `net.fetch` sur la racine du dépôt public uniquement,
  sans redirection, 15 s, 256 Ko (index) / 1 Mo (lab), UTF-8 strict ; serveur local de test par
  `SERVERLAB_LIBRARY_URL` (127.0.0.1 / localhost seulement).
- Interface : sélecteur de labs › onglet **Bibliothèque** (titre, auteur, difficulté, version ; Ouvrir ;
  erreurs claires, Réessayer).
- **Dépôt public `tamalou25/serverlab-labs` à créer par Gary** (procédure : `docs/bibliotheque.md`) : sans
  lui, l'onglet affiche « Fichier introuvable dans la bibliothèque (HTTP 404) ».

### #36 Client Linux simulé

- Format 8 : système de l'ordinateur `host.os` (`windows` par défaut, `linux`) et partages montés
  `host.mounts` ; migration 7 → 8 sans transformation, `fixtures/v8.slab`.
- Poste Linux = poste client `os: 'linux'` (`topology.addDevice` avec `os`) : nom LNX1, carte `eth0`, compte
  `etudiant`, TTL 64, pas de pare-feu Windows (ufw inactif), pas de stratégies de groupe, hors règle d'audit
  du pare-feu.
- Console bash (`shell/bash`) : guillemets, `sudo`, tube vers `grep`, `cd` / `pwd` ; commandes du système de
  base (`ip a|r|link`, `ip addr add`, `ip route add default`, `ping -c`, `dhclient`, `hostname`, `whoami`)
  et des modules de rôles (`RoleModule.bashTools`) : AD (`realm discover|join|list|leave`, `id`), DNS
  (`dig`, `resolvectl`), fichiers (`mount -t cifs`, `umount`, `smbclient -L / -c ls`, `ls`, `touch`, `mkdir`,
  `cat`) avec les autorisations partage ∩ NTFS du compte du montage.
- Interface : palette › Postes › **Poste Linux**, icône terminal, fenêtre Config + Console (bash, thème
  Ubuntu), sans Bureau Windows.
- Écarts : `docs/fidelite.md` F97 à F105.

### #37 Interface FR / EN (i18n)

- `shared/i18n` sans dépendance : `fr.ts` (référence) et `en.ts` (même type), paramètres `{nom}`, pluriels
  `Intl.PluralRules`, `rich()` pour le texte mis en forme ; `tests/shared/i18n.test.ts` échoue si une clé ou un
  paramètre manque dans une langue.
- Préférence `language` (Système par défaut, langue du système résolue en fr / en, anglais à défaut) ;
  Affichage › Langue ; menus, dialogues natifs et erreurs du main traduits ; au changement, l'interface est
  reconstruite (l'état vit dans les stores).
- Hors champ, en français : système simulé (Bureau, consoles, messages du moteur, libellés des commandes du
  journal), contenu des labs, rapport PDF et résultat d'examen exportés.

## v2.5 — Équipements Cisco IOS

| Issue | Sujet                                 | Branche                 | PR   | État     |
| ----- | ------------------------------------- | ----------------------- | ---- | -------- |
| #103  | Nœuds Cisco (1921, 2811, 2960, 9200)  | `feat/103-ios-noeuds`   | #113 | fusionné |
| #105  | Moteur de CLI IOS                     | `feat/105-ios-cli`      | #115 | fusionné |
| #106  | Configuration de base                 | `feat/106-ios-base`     | #117 | fusionné |
| #107  | Switching et VLAN                     | `feat/107-ios-vlan`     | #118 | fusionné |
| #108  | Routage statique et OSPF              | `feat/108-ios-routage`  | #119 | fusionné |
| #109  | Services IP (DHCP, NAT / PAT)         | `feat/109-ios-services` | #120 | fusionné |
| #110  | HSRP                                  | `feat/110-ios-hsrp`     | #121 | fusionné |
| #111  | Sécurité (ACL, port-security, SSH)    | `feat/111-ios-securite` | #122 | fusionné |
| #112  | Labs, format `.slab` 9, documentation | `feat/112-ios-labs`     |      | fusionné |

Correction en cours de route : #114 (formulaire d'interface de routeur, PR #116).

### #112 Labs, format .slab 9, documentation

- Format : `CURRENT_SCHEMA_VERSION` 9, `migrations[8]` (version seule), `fixtures/v9.slab` (routeur CR1 et
  switch CSW1 configurés en IOS), test de migration et de restitution de la configuration.
- Labs : `LabDevice.model` et `LabDevice.ios` (script de console exécuté à la construction du départ,
  `runIosScript`) ; critères `iosRunning`, `iosStartup`, `iosInterface`, `iosRoute`, `iosOspfNeighbors`,
  `iosHsrp`, `iosNat`, `iosDhcpBindings`, `iosPortSecurity` (`src/engine/ios/criteria.ts`) ; labs 22 à 28
  testés par `tests/engine/ios/labs.test.ts` (solution saisie en commandes IOS, 100 %).
- Documentation : `docs/fidelite.md` (I36 à I38), README (section Cisco), CHANGELOG [2.5.0].

## v2.6 — Cybersécurité défensive

| Issue | Sujet                                    | Branche                     | PR   | État     |
| ----- | ---------------------------------------- | --------------------------- | ---- | -------- |
| #128  | Détection dans les journaux              | `feat/128-cyber-detection`  | #135 | fusionné |
| #129  | Contre-mesures L2 Cisco                  | `feat/129-cyber-l2`         | #136 | fusionné |
| #130  | Audit adossé aux référentiels ANSSI, CIS | `feat/130-cyber-audit-refs` | #137 | fusionné |
| #132  | Labs, format `.slab` 10, documentation   | `feat/132-cyber-labs`       | #138 | fusionné |

Volet attaque (#126, #127, #131, #133, #134) et lab de détection reportés au milestone v2.6.1. Correction en cours de route :
README reformaté (Prettier), dans #135.

## v2.6.1 — Cybersécurité, volet attaque

| Issue | Sujet                                  | Branche                     | PR   | État     |
| ----- | -------------------------------------- | --------------------------- | ---- | -------- |
| #126  | Moteur de scénarios                    | `feat/1-moteur-scenarios`   | #139 | fusionné |
| #127  | Scénarios annuaire                     | `feat/2-scenarios-annuaire` | #140 | fusionné |
| #133  | Scénarios réseau                       | `feat/3-scenarios-reseau`   | #141 | fusionné |
| #131  | Mode Red / Blue                        | `feat/4-mode-red-blue`      | #142 | fusionné |
| #134  | Labs, format `.slab` 14, documentation | `feat/5-labs-cyber-docs`    | #143 | fusionné |

Le guide des formats : 11 (SPN, compromission, accès administrateur, paramètres `cyber`), 12 (saut de
VLAN, flux interceptés, tampon syslog IOS), 13 (réglages de partie Red / Blue), 14 (scénarios activés par
lab, paramètres de durcissement, camp de l'IA). Chaque version a son fichier de référence et son test de
migration.

### 5/5 Labs, format .slab 14, documentation

- Format : `CURRENT_SCHEMA_VERSION` 14, `migrations[13]` (version seule), `fixtures/v14.slab`, tests de migration.
- Moteur : départ de lab étendu (`cyber`, `logon`, `adminAccess`, `creationPolicy`, SPN, ancienneté du mot de
  passe), commandes `cyber.configure`, `cyber.setAdminAccess`, `adds.setServicePrincipalNames` ; critères
  `accountCompromised`, `machineControlled`, `trafficIntercepted`, `vlanHopped`, `scenarioOutcome`
  (évaluation à blanc, sans trace d'attaque) ; scénarios activés par lab (`scenariosOf`) ; camp imposé à l'IA.
- Labs 31 (compromission de l'annuaire), 32 (durcissement de l'annuaire), 33 (attaque réseau L2), 34
  (durcissement réseau), 35 (sujet Red / Blue : annuaire + réseau, minuteur, camp de l'IA imposé) ; tests
  `tests/engine/cyber/labs-attaque.test.ts` (solution à 100 %, examen, éditeur) et E2E `cyber-attack-labs.spec.ts`.
- Documentation : récapitulatif du garde-fou et écarts avec les vraies techniques (`docs/fidelite.md`),
  README (Cybersécurité), ROADMAP, CHANGELOG [2.6.1].

## v2.8 — Services à état et mode panne

Milestone terminé : `CHANGELOG.md` [2.8.0], `package.json` 2.8.0 ; tag `v2.8.0` à pousser par Gary.
Format `.slab` : v2.8 → format 26 (migration 25 → 26 écrite par l'issue #219, horloge par ordinateur) ; les autres
issues n'ont ajouté que des champs facultatifs.

| Issue | Sujet                                                           | Branche                         | PR   | État     |
| ----- | --------------------------------------------------------------- | ------------------------------- | ---- | -------- |
| #223  | Chantier A : dépendances réelles entre services                 | `feat/223-service-dependencies` | #260 | fusionné |
| #226  | Chantier A : snap-in Services, alertes du Gestionnaire          | `feat/226-snapin-services`      | #261 | fusionné |
| #219  | Chantier A : horloge par poste, W32Time et Kerberos             | `feat/219-horloge-kerberos`     | #262 | fusionné |
| #224  | Chantier A : échec au démarrage, options de récupération        | `feat/224-echec-service`        | #263 | fusionné |
| #220  | Chantier A : NTDS et Netlogon                                   | `feat/220-ntds-netlogon`        | #264 | fusionné |
| #225  | Chantier A : `sc qc`, cohérence des commandes CMD               | `feat/225-cmd-services`         | #265 | fusionné |
| #222  | Chantier A : CertSvc, TermService, WsusService, MpsSvc, Spooler | `feat/222-autres-services`      | #266 | fusionné |
| #228  | Chantier D : modèle de panne et catalogue                       | `feat/228-modele-panne`         | #267 | fusionné |
| #227  | Chantier A : lab 42 « Diagnostic de services Windows »          | `feat/227-lab-42`               | #268 | fusionné |
| #229  | Chantier D : 12 pannes réseau                                   | `feat/229-pannes-reseau`        | #269 | fusionné |
| #230  | Chantier D : pannes Windows et pannes composées                 | `feat/230-pannes-windows`       | #270 | fusionné |
| #232  | Chantier D : interface « Lancer un dépannage »                  | `feat/232-interface-depannage`  | #271 | fusionné |
| #231  | Chantier D : tirage par graine et réparabilité                  | `feat/231-tirage-graine`        | #272 | fusionné |
| #233  | Chantier D : 3 labs de dépannage (labs 43 à 45)                 | `feat/233-labs-depannage`       | #273 | fusionné |

## v2.9 — Serveurs Linux

Milestone terminé : `CHANGELOG.md` [2.9.0], `package.json` 2.9.0 ; tag `v2.9.0` à pousser par Gary.
Format `.slab` : v2.9 → format 27 (migration 26 → 27, issue #234) ; les autres issues n'ont ajouté que des champs
facultatifs de `host.linux`.

| Issue | Sujet                                               | Branche                          | PR   | État     |
| ----- | --------------------------------------------------- | -------------------------------- | ---- | -------- |
| #234  | Serveur Linux (Debian 12 / Ubuntu 24.04), format 27 | `feat/234-serveur-linux`         | #275 | fusionné |
| #235  | Fichiers, utilisateurs et droits                    | `feat/235-fichiers-droits-linux` | #276 | fusionné |
| #236  | apt, systemctl, journalctl, ss, diagnostic          | `feat/236-apt-systemctl`         | #277 | fusionné |
| #237  | SSH, fail2ban, rsyslog                              | `feat/237-ssh-fail2ban-rsyslog`  | #278 | fusionné |
| #238  | Apache2                                             | `feat/238-apache2`               | #279 | fusionné |
| #239  | Samba et interopérabilité Windows                   | `feat/239-samba`                 | #280 | fusionné |
| #240  | Bind9 et isc-dhcp-server                            | `feat/240-bind9-dhcp`            | #281 | fusionné |
| #241  | Labs 46 à 53 et pannes Linux                        | `feat/241-labs-pannes-linux`     | #282 | fusionné |

## v2.10 — Pare-feu pfSense

Milestone terminé : `CHANGELOG.md` [2.10.0], `package.json` 2.10.0 ; tag `v2.10.0` à pousser par Gary.
Format `.slab` : v2.10 → format 28 (migration 27 → 28, issue #242) ; les autres issues n'ont ajouté que des champs
facultatifs de `pf`.

| Issue | Sujet                           | Branche                           | PR   | État     |
| ----- | ------------------------------- | --------------------------------- | ---- | -------- |
| #242  | Équipement pare-feu, format 28  | `feat/242-equipement-pare-feu`    | #284 | fusionné |
| #243  | Moteur de règles                | `feat/243-moteur-regles`          | #285 | fusionné |
| #244  | NAT                             | `feat/244-nat-pare-feu`           | #286 | fusionné |
| #245  | Passerelles, routes, DHCP, DNS  | `feat/245-services-pare-feu`      | #287 | fusionné |
| #246  | Interface web                   | `feat/246-interface-web-pare-feu` | #288 | fusionné |
| #247  | Console                         | `feat/247-console-pare-feu`       | #289 | fusionné |
| #248  | Labs 54 à 59 et pannes pare-feu | `feat/248-labs-pannes-pare-feu`   | #290 | fusionné |

## v2.11 — Interface v2

Issues #292 (maquettes et plan) à #301 (finitions), une PR empilée par étape (#302 à #311). Refonte du chrome de
l'application sans changement du moteur ni du format `.slab` : tokens v2 et contrastes AA, icônes et nœuds de 64 px,
barre d'outils principale, palette à onglets, câbles et légende des protocoles, inspecteur à onglets, panneau
Simulation inférieur, fenêtres d'équipement et menu contextuel. Documentation : [ui-v2.md](ui-v2.md).

Milestone terminé : `CHANGELOG.md` [2.11.0], `package.json` 2.11.0 ; tag `v2.11.0` à pousser par Gary.
