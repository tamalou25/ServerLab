# Parcours, progression, bilan et transfert vers le réel

Ce document décrit ce que ServerLab apporte à partir de la version en cours (post-2.11, « v2.12 ») pour
apprendre à **administrer et dépanner** une infrastructure : des validations qui jugent le fonctionnement
réel, un bilan de dépannage fondé sur le résultat, un parcours cohérent autour d'une PME, une mission
transversale, une progression enregistrée, et des exercices équivalents sur de vraies machines.

Code : `src/engine/labs/pathway.ts` (parcours), `src/engine/labs/progress.ts` (progression),
`src/engine/troubleshoot/summary.ts` (bilan), `src/engine/roles/files/smbprobe.ts` et
`src/engine/labs/linuxcriteria.ts` (validations), `labs/lab-60-mission-compta.json` (mission),
`src/main/progress.ts` (persistance). Tests : `tests/engine/labs/progress.test.ts`,
`tests/engine/labs/lab-48-samba-validation.test.ts`, `tests/engine/labs/lab-60-mission-compta.test.ts`,
`tests/engine/troubleshoot/summary.test.ts`, `tests/e2e/pathway.spec.ts`.

## 1. Ce que font les autres outils, et ce qu'on en retient

Lecture rapide des approches voisines (sources officielles consultées le 2026-11-06) :

| Outil               | Approche                                                                                                                                                                                                                                                                                       | Ce qu'on en retient pour ServerLab                                                                                                                                                                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cisco Packet Tracer | L'[Activity Wizard](https://tutorials.ptnetacad.net/help/default/activityWizard.htm) décrit une activité par des instructions, un réseau initial et un **réseau réponse** ; l'arbre d'évaluation compare l'état de l'élève à la réponse, un modèle de score programmable peut le remplacer.    | Comparer des **états**, pas des frappes. Mais un réseau réponse unique impose la configuration exacte : ServerLab préfère des critères **fonctionnels** (l'usage marche, l'interdit reste interdit) qui acceptent les solutions alternatives.                           |
| GNS3 / EVE-NG       | Émulation de vraies images (GNS3 fait tourner de vraies images Cisco IOS par Dynamips, des VM par QEMU ; EVE-NG [compare](https://www.eve-ng.net/index.php/features-compare/) ses éditions par nombre de nœuds, utilisateurs et laboratoires partagés). Pas d'évaluation pédagogique intégrée. | La fidélité vient du vrai logiciel ; ServerLab simule, donc **documente ses écarts** (`docs/fidelite.md`) et propose un exercice réel équivalent (section 7).                                                                                                           |
| TryHackMe           | Parcours = suites de salles ; salles guidées (tâches, indices) puis défis moins assistés ; [points](https://help.tryhackme.com/en/articles/6563910-points-explained) selon le type et la difficulté de la salle, retenus par l'anti-triche si la cible n'a pas été réellement utilisée.        | Progression **guidé → défi**, indices sans honte, et une règle que ServerLab reprend : la réussite doit venir d'une **interaction réelle** avec la cible (la sonde SMB, le `ping`, la requête HTTP depuis le poste), pas d'un fichier qui ressemble à la bonne réponse. |
| HTB Academy         | Modules théoriques avec exercices, terminés par une **Skills Assessment** : un scénario proche du réel qu'il faut réussir pour clore le module ([aide HTB](https://help.hackthebox.com/en/articles/12741910-academy-modules-paths)).                                                           | Séparer **exercice terminé** et **compétence démontrée** : la mission transversale et la révision différée en examen jouent le rôle de l'évaluation de compétence.                                                                                                      |

Limite : les pages d'aide de HTB Academy et TryHackMe n'ont été lues qu'en partie (certaines renvoient 403/404 depuis
l'environnement de travail) ; la comparaison guide quelques décisions, elle n'est pas une étude.

## 2. Fiabiliser les validations

Un critère ne doit jamais valider une configuration qui ne fonctionne pas. Pour un service, on distingue :

| Niveau                                 | Ce qui est jugé                                                                     | Critères                                                                                                                       |
| -------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Configuration **enregistrée**          | Le fichier ou l'objet de configuration (ce que `testparm`, `cat` ou la console lit) | `linuxFileContains`, `linuxFileMode`, `dhcpScope`, `dnsRecord`, `share`…                                                       |
| Configuration **appliquée**            | Ce que le service garde en mémoire (relu au redémarrage ou au rechargement)         | `linuxConfigApplied` (ssh, apache2, smbd, named, isc-dhcp-server, fail2ban, rsyslog)                                           |
| **Fonctionnement depuis le client**    | L'usage attendu, rejoué à travers le réseau simulé                                  | `smbAccess`, `httpResponse`, `nslookup`, `dhcpLease`, `uncReachable`, `pfReachable`, `ping`                                    |
| **Droits de l'utilisateur**            | Le compte attendu obtient le droit attendu, pas plus                                | `smbAccess` (`write`), `effectiveAccess` (`allow` / `deny`), `gpoApplied`                                                      |
| **Accès qui doivent rester interdits** | Les autres comptes, l'invité, l'autre réseau                                        | `smbAccess` avec `success: false`, `effectiveAccess` avec `deny`, `pfReachable` avec `success: false`, `ping` `success: false` |

Défaut reproduit et corrigé (lab 48) : 6 critères sur 6 étaient validés sans compte Samba ni redémarrage de
smbd, alors que `smbclient` échouait (`NT_STATUS_BAD_NETWORK_NAME`). Cause commune : les critères Linux ne
lisaient que les fichiers, jamais la configuration **en vigueur** ni l'accès depuis le poste. La sonde
`smbProbe` rejoue, sans modifier l'état, exactement ce que fait `smbclient` ou `net use` : joignabilité du
port 445, service actif avec sa configuration en vigueur, authentification sur la base Samba (avec
`map to guest = bad user`, un compte inconnu est traité en invité), connexion au partage (`valid users`,
`hosts allow`, `read only`…), droits Unix du compte effectif, écriture à blanc. Les labs 46, 47 et 51 ont
reçu les mêmes garde-fous (`linuxConfigApplied`, invité en lecture seule, non-régression du partage existant).

Règles d'écriture d'un critère :

- une exigence **explicite du sujet** (ex. `valid users = @compta`) peut être vérifiée sur la configuration,
  en acceptant les écritures équivalentes (`@compta` ou `+compta`, espaces libres) ;
- une **préférence de la correction** (ex. `read only = no` plutôt que `writable = yes`) ne se vérifie jamais
  sur le texte : on vérifie l'effet (`smbAccess` avec `write: true`) ;
- chaque lab de service comporte au moins un critère **depuis le client** et un critère **d'accès interdit** ;
- un critère vrai au départ est une **contrainte** (non-régression) : il doit être listé avec sa justification
  dans `tests/engine/labs/start-criteria.test.ts`.

## 3. Bilan du dépannage

Règles complètes dans `docs/depannage.md` (section Interface, point 6). En résumé : le résultat sur 100 vient
du **rétablissement** (60), de l'**usage attendu** vérifié depuis les postes (25) et des **contraintes
préservées** (15) ; l'**autonomie** (indices) est affichée à part et ne retire aucun point en entraînement ;
durée, nombre de commandes et longueur de la correction de référence sont **descriptifs**. Le bilan présente le
symptôme signalé, la **chaîne des causes** (panne composée : la masquante puis la masquée), les changements
effectués (journal), les vérifications fonctionnelles (objectifs du lab), les contraintes préservées ou
dégradées, l'explication de la correction de référence (« une réparation qui fonctionne », jamais « le chemin
le plus court »), une piste de révision et ses propres limites (il ne mesure ni la compréhension ni la qualité
du compte rendu). Il s'exporte en texte pour servir de **compte rendu d'intervention**.

Les labs de dépannage fournis (44, 45, 53, 59, 60) ouvrent désormais une session de dépannage en plus de leur
énoncé : indices comptés, « J'ai réparé », bilan avec les objectifs du lab (usages et contraintes).

## 4. Parcours PME « Atelier Lambert »

Fil rouge : l'Atelier Lambert (ferronnerie, 30 salariés) et ses utilisateurs identifiables (Marie Martin,
direction ; Jean Dupont et Sophie Leroy, comptabilité ; alice côté Linux ; Bob, commercial ; Paul Durand,
atelier). Douze étapes réutilisent dix labs existants et la mission (lab 60) :

| Étape | Lab                        | Phase             | Aide                         | Prérequis                     | Compétences                                        | Résultat concret attendu                                                     |
| ----- | -------------------------- | ----------------- | ---------------------------- | ----------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1     | lab-01 Adressage           | guidé             | pas à pas                    | —                             | IPv4, routage / passerelle                         | PC1 et PC2 se répondent à travers R1                                         |
| 2     | lab-02 DHCP                | guidé             | pas à pas                    | 1                             | DHCP, IPv4                                         | baux avec passerelle et DNS                                                  |
| 3     | lab-03 DNS                 | moins guidé       | objectifs + indices          | 2                             | DNS                                                | résolution directe et inverse depuis un poste                                |
| 4     | lab-04 AD + GPO            | moins guidé       | objectifs + indices          | 3                             | annuaire, GPO                                      | session de domaine, GPO appliquée                                            |
| 5     | lab-05 NTFS                | moins guidé       | objectifs + indices          | 4                             | groupes / droits / partages, annuaire              | droits effectifs de jdupont, mmartin, pdurand                                |
| 6     | lab-48 Samba               | moins guidé       | objectifs + indices          | 5                             | services Linux, groupes / droits / partages        | alice écrit, bob et l'invité refusés, smbd a relu sa configuration           |
| 7     | lab-13 VLAN                | moins guidé       | objectifs + indices          | 1                             | segmentation, routage                              | deux VLAN qui ne communiquent que par le routeur                             |
| 8     | lab-54 pfSense LAN / DMZ   | moins guidé       | objectifs + indices          | 7                             | pare-feu, segmentation                             | flux attendus passés, flux interdits bloqués                                 |
| 9     | lab-44 Dépannage Windows   | incident inconnu  | ticket seul, indices comptés | 4                             | méthode de diagnostic, DNS, annuaire               | sessions rétablies, deux causes identifiées                                  |
| 10    | lab-60 Mission compta      | incident inconnu  | ticket seul, indices comptés | 5, 9                          | méthode, groupes / droits / partages, compte rendu | compta en écriture, direction en lecture seule, atelier exclu, bilan exporté |
| 11    | lab-45 Dépannage composé   | incident inconnu  | ticket seul, indices comptés | 10                            | méthode, DNS                                       | deux causes corrigées dans l'ordre                                           |
| 12    | lab-05 NTFS en mode examen | révision différée | examen (sans indice)         | 10 ; ≥ 1 jour après l'étape 5 | groupes / droits / partages, annuaire              | 20/20 sans indice                                                            |

Le parcours **aide à choisir sans bloquer** : chaque étape s'ouvre quand on veut (onglet Parcours du sélecteur,
`Ctrl+L`, ou bouton « Parcours » de l'accueil, qui affiche la prochaine étape conseillée). La mission propose
des **variantes** par graine (même histoire, cibles différentes) ; toutes sont solubles par la réparation de
référence (test sur dix graines).

## 5. Progression enregistrée

Fichier `progress.json` dans le dossier de données de l'application (à côté de `settings.json`), écrit de
façon atomique par le process principal, validé par le schéma zod du moteur (`AttemptSchema`). Le renderer
n'écrit jamais le fichier : il envoie une tentative, le main la valide et la conserve (au plus 2 000, les plus
récentes). Un fichier absent, corrompu, trop gros ou d'un autre format donne une progression vide ; une entrée
invalide est écartée sans toucher aux autres. Les anciennes sauvegardes `.slab`, `settings.json` et `recent.json`
ne sont pas concernées.

Une **tentative** est enregistrée quand un lab est vérifié à 100 %, quand un examen se termine (fin, temps
écoulé, abandon) et quand un bilan de dépannage est produit (vérification à 100 % et bilan d'un même lab dans les
dix minutes ne comptent qu'une fois). Elle garde : lab, mode (lab, examen, dépannage), horodatages, critères
validés, réussite, indices utilisés et disponibles, abandon, résultat du bilan, compétences travaillées, étape
du parcours, graine de la variante.

Règles (`progress.ts`, testées) :

- **Exercice terminé** : au moins une réussite sur le lab de l'étape, dans le mode exigé (examen pour la révision).
- **Compétence travaillée** : au moins une réussite d'une étape qui la travaille.
- **Compétence démontrée** : une réussite **autonome** (aucun indice, pas d'abandon) **et** une seconde réussite,
  soit dans une **autre étape** qui travaille la compétence (transfert), soit sur la **même étape au moins un jour
  plus tard** (révision différée). Une seule réussite guidée ne suffit jamais.
- **Prochaine étape recommandée** : la première étape non terminée dont les prérequis sont terminés et dont la
  date de révision est atteinte ; parcours terminé : une étape **à revoir** (terminée il y a plus de 7 jours,
  compétence non démontrée) ; sinon rien à recommander.

Ce que la progression ne sait pas : si le travail a été fait par la personne elle-même, ni ce qu'elle a compris.
Elle mesure des résultats vérifiables et l'aide utilisée, rien de plus.

## 6. Mission transversale (lab 60)

« La comptabilité ne peut plus enregistrer ses documents. La direction doit conserver un accès en lecture.
Rétablissez le service sans ouvrir le dossier aux autres salariés, puis rendez compte de l'intervention. »

- **Contexte** : l'Atelier Lambert, le domaine `lab.local`, un tableau des droits attendus par service.
- **Symptômes reproductibles** : depuis PC1 (jdupont) et PC2 (sleroy), `\\SRV1\Compta` refuse l'accès alors que
  le serveur répond et que le lecteur réseau est connecté.
- **Observations qui départagent** : état du service Serveur, `Get-SmbShareAccess`, onglet Sécurité / Accès
  effectif, `Get-Acl`. Deux causes se cumulent : les autorisations du partage rabaissées à Lecture et l'entrée
  NTFS de `GG_Compta` disparue ; corriger la seconde seule rouvre le dossier mais laisse l'écriture refusée.
- **Réparations acceptables** : remettre le partage à son état d'origine, ou accorder Modification à `GG_Compta`
  et Lecture à `GG_Direction` sur le partage ; dans les deux cas remettre l'entrée NTFS. Le raccourci « Tout le
  monde en modification » rétablit l'écriture mais dégrade deux contraintes (direction, atelier) : le bilan le dit
  (« résolu avec réserves »).
- **Indices progressifs** : ceux des pannes (symptôme, zone, piste) et ceux des critères ; aucun ne nomme la cause
  dans le titre, l'énoncé ou le premier indice.
- **Validation** : causes corrigées, accès de la compta en écriture, direction en lecture seule, atelier sans
  accès, administrateurs conservés.
- **Bilan** : chaîne des causes, changements, vérifications, contraintes, export texte à compléter par l'élève.
- **Variantes** : graines 11, 2, 5, 8, 13 (poste observé et compte différents).

Limite honnête : le compte rendu écrit n'est pas évalué automatiquement. Le bilan exporté en est le support ; sa
qualité relève du formateur.

## 7. Transfert vers le réel

Environnement de test recommandé : trois VM VMware sur un réseau **hôte seul** (aucun lien avec le réseau de
l'école ou du domicile) : Windows Server 2022 (évaluation), Windows 11 (évaluation) et Debian 12 ; un pfSense CE
2.7 en VM pour l'étape 8 ; pour les VLAN, un switch administrable réel ou un second switch virtuel. **N'exécutez
aucune de ces commandes sur votre machine de travail** : elles créent des comptes, modifient des droits et des
services. Les écarts cités (`F…`, `L-…`, `P-…`, `D-…`) renvoient à `docs/fidelite.md` ; seuls les écarts encore
d'actualité sont repris (les points de la section « Corrigés pendant la stabilisation » ne le sont pas).

| Compétence                       | Simulé / simplifié dans ServerLab                                                                                                                         | Différences importantes avec un vrai système                                                                                                                                                                                      | Exercice équivalent sur VM                                                                                                                                                                                     | Résultat attendu et vérification                                                                                                                                                           |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Adressage IPv4, passerelle       | Cartes, routes et ARP calculés par le moteur ; `ping`, `tracert`, `ipconfig` sourcés.                                                                     | Pare-feu Windows réel : le ping entrant est **bloqué par défaut** sur un profil Public (ici seules les règles simulées comptent, F64) ; délais ARP et TTL réels.                                                                  | Deux VM sur deux sous-réseaux, une VM routeur (Windows Server avec routage activé, ou Debian avec `sysctl net.ipv4.ip_forward=1`) ; adresses statiques et passerelles.                                         | `ping` dans les deux sens après avoir autorisé ICMPv4 entrant (`New-NetFirewallRule -Protocol ICMPv4`) ; `tracert` montre le routeur.                                                      |
| DHCP                             | Étendue, options 3 / 6 / 15, exclusions, réservations ; bail renouvelé par tâche de fond.                                                                 | Baux et timers T1/T2 réels ; une étendue désactivée conserve le bail jusqu'à expiration (F14) ; autorisation du serveur dans AD ; conflits avec un DHCP de l'hyperviseur.                                                         | Rôle DHCP sur Windows Server (ou `isc-dhcp-server` sur Debian), étendue 192.168.10.100-200, options passerelle et DNS, client en DHCP.                                                                         | `ipconfig /all` montre le serveur DHCP et les options ; `Get-DhcpServerv4Lease` (ou `dhcpd.leases`) liste le bail ; renouveler avec `ipconfig /renew`.                                     |
| DNS                              | Zones directe et inverse, A / CNAME / PTR, résolution acheminée comme de vrais paquets ; Bind9 avec `named-checkconf` / `rndc`.                           | Zones `_msdcs` et enregistrements SRV d'un vrai DC (F1) ; cache client (`ipconfig /flushdns`) ; glue et section ADDITIONAL absentes (L-96).                                                                                       | Zone `lab.local` sur le DC + zone inverse ; un A et un CNAME ; côté Debian, une zone Bind9 avec son fichier.                                                                                                   | `nslookup www.lab.local` et `nslookup 192.168.10.20` depuis un client ; `dig @srv www.lab.local +short` ; `named-checkzone`.                                                               |
| Annuaire et comptes              | OU, utilisateurs, groupes, jonction, session de domaine, verrouillage ; Kerberos sensible à l'écart d'heure.                                              | Pas de date d'expiration de compte (D-27) ; canal sécurisé rompu sans effet sur la session (D-25) ; préparation réelle (`sysprep`, DNS du client vers le DC) indispensable à la jonction.                                         | Promotion d'un DC (`Install-ADDSForest`), OU Societe, comptes jdupont / mmartin / pdurand, groupes GG_Compta / GG_Direction, jonction du poste Windows 11.                                                     | Session `LAB\jdupont` sur le poste ; `whoami /groups` ; `Get-ADUser jdupont -Properties MemberOf` ; `nltest /dsgetdc:lab.local`.                                                           |
| Groupes, droits NTFS et partages | ACL NTFS avec héritage, autorisations de partage, droit effectif = partage ∩ NTFS, onglet Accès effectif, lecteurs réseau, projection d'un partage Samba. | Droits NTFS réels plus fins (autorisations avancées, propriétaire, audit) ; renommer / copier / déplacer vers un partage Samba non simulés (L-87) ; entrées orphelines affichées autrement (F16).                                 | Dossier `C:\Partages\Compta` partagé en Tout le monde Contrôle total ; héritage désactivé, Utilisateurs retiré, GG_Compta Modification, GG_Direction Lecture ; lecteur `S:` sur le poste.                      | `icacls C:\Partages\Compta` ; `Get-SmbShareAccess Compta` ; onglet Accès effectif pour jdupont, mmartin, pdurand ; création d'un fichier depuis la session de jdupont, refus pour mmartin. |
| Stratégies de groupe             | GPO liées à des OU, quelques paramètres reliés à des effets (panneau de configuration, exécuter, cmd), `gpupdate` / `gpresult`.                           | Des milliers de paramètres réels, intervalle de rafraîchissement (90 min ± 30), traitement en boucle de retour, `ModificationTime` (F5), blocage d'héritage à la racine (F15).                                                    | GPO « GPO-Compta » liée à l'OU, paramètre Utilisateur « Interdire l'accès au Panneau de configuration ».                                                                                                       | `gpupdate /force` puis `gpresult /r` sur le poste : la GPO apparaît dans les objets appliqués ; le Panneau de configuration est refusé pour jdupont.                                       |
| Services Linux                   | Fichiers de configuration réels des paquets Debian 12, relecture au redémarrage / rechargement, droits Unix, `systemctl`, `ss`, `testparm`, `smbclient`.  | Aucun hachage réel des mots de passe (L-13, L-80) ; smbd réel relit `smb.conf` périodiquement (L-80) ; `sudo` sans mot de passe pour le compte par défaut (L-14) ; messages d'erreur à comparer à une vraie sortie (L-13 à L-17). | Debian 12 : `apt install samba`, groupe `compta`, `alice` et `bob`, `/srv/compta` en `root:compta` 770, section `[compta]`, `smbpasswd -a alice`, `systemctl restart smbd`.                                    | `testparm -s` ; `ss -tlnp \| grep 445` ; `smbclient //srv/compta -U alice -c ls` réussit et `-U bob` échoue (`NT_STATUS_ACCESS_DENIED`) ; `smbclient -N` refusé.                           |
| Segmentation VLAN                | VLAN, trunk 802.1Q explicite des deux côtés, sous-interfaces `dot1Q`, SVI.                                                                                | Pas de DTP ni VTP (F53, F54) ; VLAN 1002-1005 absents ; VLAN natif géré différemment (F56).                                                                                                                                       | Switch administrable réel (Catalyst 2960 / 9200) : VLAN 10 et 20, deux ports d'accès, un trunk vers un routeur « on a stick » (ou un routeur Linux avec `ip link add link eth0 name eth0.10 type vlan id 10`). | `show vlan brief`, `show interfaces trunk` ; ping entre VLAN seulement via le routeur ; `show mac address-table` par VLAN.                                                                 |
| Pare-feu                         | Règles pfSense par interface, première correspondance, table d'états, NAT, journal ; profils et règles du pare-feu Windows.                               | Ports sources non modélisés (P-17, P-23) ; expiration des états non simulée (P-11) ; liste de bogons approximative (P-16) ; règle d'usine et anti-verrouillage à confirmer (P-13, P-14).                                          | pfSense CE 2.7 en VM avec WAN / LAN / OPT1 : règle LAN → OPT1 TCP 80 seulement, aucune règle OPT1 → LAN, journalisation activée.                                                                               | Depuis le LAN : `curl http://web-dmz` répond, `ping web-dmz` échoue ; depuis la DMZ : rien vers le LAN ; Status > System Logs > Firewall montre les refus.                                 |
| Méthode de diagnostic            | Pannes injectées par commandes nommées, symptômes lus par les mêmes fonctions que les consoles, indices progressifs, bilan.                               | Dans la réalité la cause n'est jamais tirée d'un catalogue ; journaux plus riches (Observateur d'évènements complet, `journalctl` réel) ; pannes matérielles possibles.                                                           | Faire casser une VM par un camarade (service arrêté, droit retiré, mauvaise passerelle) sans dire quoi ; diagnostiquer avec le même protocole : reproduire, observer, hypothèses, corriger, re-tester.         | Compte rendu : symptôme exact, observations et outils, cause, changement, vérification finale ; comparer avec ce que le camarade a cassé.                                                  |
| Compte rendu d'intervention      | Bilan exporté (texte) : symptôme, causes, changements, vérifications, limites.                                                                            | Non évalué automatiquement ; en entreprise, le ticket et la base de connaissances imposent un format.                                                                                                                             | Rédiger le compte rendu de l'exercice précédent dans le format du ticket de l'alternance (contexte, actions, résultat, suite).                                                                                 | Relecture par le tuteur ou le formateur : un tiers doit pouvoir rejouer la vérification à partir du compte rendu seul.                                                                     |

## 8. Ce qui reste ouvert

- Les labs 43, 53, 59 et les labs IOS / cyber gardent leurs critères d'origine ; la grille de la section 2 n'a été
  appliquée qu'aux labs Linux 46 à 48 et 51 et à la mission 60. Les autres labs à critères « fichier seul » sont
  à revoir avec la même méthode (le test `start-criteria.test.ts` et les tests de solution existants restent la
  garantie minimale).
- Un seul parcours est défini ; les étapes réseau Cisco (labs 22 à 28) et cyber (29 à 35) pourraient former un
  second parcours.
- Le niveau d'aide « ticket seul » s'appuie sur l'énoncé du lab : un mode qui masquerait les objectifs jusqu'à la
  première vérification n'existe pas encore.
- Les bilans ne sont pas conservés dans le `.slab` ni dans `progress.json` (seuls leurs résultats agrégés le sont).
