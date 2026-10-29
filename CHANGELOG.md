# Journal des modifications

Toutes les évolutions notables de ServerLab sont consignées ici.
Format : [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) · versions : [SemVer](https://semver.org/lang/fr/).
La planification des versions suivantes est dans [ROADMAP.md](ROADMAP.md).

## [Non publié]

## [2.11.0] — 2026-10-28

Interface v2 : refonte graphique du chrome de l'application (« console d'ingénierie »), sans changement du moteur,
du format `.slab` ni des raccourcis. Documentation : [docs/ui-v2.md](docs/ui-v2.md).

### Interface

- Tokens v2 sombre et clair, variantes de texte d'état AA, accent unique, échelle typographique 11 / 12 / 13 / 15 px,
  tableau des contrastes calculé (#293).
- Icônes d'équipements dessinées pour ServerLab, nœuds de 64 px, voyant d'état à double indice (couleur + forme),
  bandeau « IOS » des modèles Cisco (#294).
- Barre d'outils principale (fichier, annuler / rétablir, outils, zoom, Temps réel / Simulation) ; les raccourcis
  du canvas n'agissent plus depuis une fenêtre d'équipement (U-01) (#295).
- Palette à onglets par famille et vignettes de 48 px (#296).
- Câbles : voyants à forme, infobulle en texte (extrémités, débit, état) ; couleurs de protocoles en tokens, nom
  du protocole sur chaque enveloppe, légende en mode Simulation (#297).
- Inspecteur à onglets Résumé, Lab, Audit, Dépannage (#298).
- Panneau Simulation en bas de la fenêtre, rétractable : vitesse de lecture, table des événements (pas, couche,
  info), détail du PDU (#299).
- Barre de titre uniforme des fenêtres d'équipement (IP, accès rapides) et menu contextuel des nœuds accessible
  au clavier (#300).

### Qualité

- Tests visuels Playwright des écrans clés dans les deux thèmes ; nouveaux tests E2E de l'interface.
- Liens du dépôt mis à jour : `tamalou25/packetracer-windows` → `tamalou25/ServerLab` (#301).

## [2.10.0] — 2026-10-27

Pare-feu pfSense CE 2.7 simulé : règles, NAT, services, interface web, console. Format `.slab` 28 (migration 27 → 28,
#242) ; les autres issues n'ajoutent que des champs facultatifs de `pf`. Sorties et comportements non confirmés par
la documentation Netgate listés « à vérifier » dans `docs/fidelite.md` (section v2.10, P-01 à P-62).

Labs 54 à 59.

### v2.10 (pare-feu)

- Équipement pare-feu pfSense CE 2.7 (#242) : nouveau type de nœud `firewall` (préfixe `FW`, icône lucide `BrickWall`,
  groupe « Pare-feu » de la palette), trois cartes `em0` (WAN), `em1` (LAN, 192.168.1.1/24) et `em2` (OPT1 nommée DMZ),
  posable, câblable, copiable et enregistrable ; le nom d'hôte pfSense suit le nom de l'équipement.
- Modèle d'état `pf` (`src/engine/model/firewall.ts`) : affectations des interfaces, règles par interface (Pass,
  Block, Reject, protocole, source/destination, ports, journalisation), alias, NAT sortant et redirections de port,
  DHCP par interface, résolveur DNS, passerelles, routes statiques, journal et table d'états. Tous ces champs sont
  facultatifs ou vides : #243 à #248 les exploitent sans nouvelle migration.
- Format `.slab` 28 : migration 27 → 28 (seul le numéro change), fichier de référence `fixtures/v28.slab` (pare-feu
  FW1 câblé à SW1), tests dans `migrations.test.ts` et `tests/engine/model/firewall-device.test.ts`.
- `docs/fidelite.md` : section « À vérifier (v2.10 — pare-feu) », identifiants P-01 à P-06.
- Moteur de règles pfSense (#243) : filtrage à l'entrée de chaque interface branché sur le transit
  (`sim/forward.ts`, `net/pf.ts`) : première règle qui correspond, refus par défaut, table d'états (réponses
  autorisées), Pass / Block / Reject (TCP RST ou ICMP visible côté client), règle d'usine « Default allow LAN to any »,
  anti-verrouillage, blocage des réseaux privés et bogons du WAN, alias, journal `pf.log` plafonné ; commandes
  `pf.addRule`, `pf.updateRule`, `pf.removeRule`, `pf.moveRule`, `pf.setAlias`… ; règle appliquée visible dans la
  trace du mode Simulation ; `docs/fidelite.md` P-10 à P-17.
- Services du pare-feu pfSense (#245) : serveur DHCP par interface (étendues dérivées de `pf.dhcp`, baux attribués
  aux clients par le client DHCP existant), résolveur DNS Unbound (Host Overrides, résolution depuis les racines ou
  redirection vers `pf.dnsServers`, branché sur `roles/dns/resolver.ts`), passerelles (passerelle par défaut, WAN
  statique ou DHCP) et routes statiques dans la table de routage du pare-feu ; commandes `pf.setDhcp`,
  `pf.setGateway`, `pf.addStaticRoute`, `pf.setDnsResolver`, `pf.setHostOverride`… ; `docs/fidelite.md` P-30 à P-39.
- NAT pfSense (#244) : NAT sortant automatique, hybride, manuel ou désactivé (`net/pf-nat-transit.ts`), redirections
  de port avec règle de filtrage associée créée et suivie automatiquement (destination traduite avant le filtrage,
  serveur de la DMZ joignable depuis le WAN), traduction visible dans la trace du mode Simulation et dans la table
  d'états ; commandes `pf.setNatMode`, `pf.addOutboundNat`, `pf.addPortForward`… ; `docs/fidelite.md` P-20 à P-27.
- Console du pare-feu pfSense (#247) : menu numéroté 0 à 16 transcrit des scripts de pfSense CE 2.7.2 (affecter les
  interfaces, adresses IP, mot de passe du webConfigurator, valeurs d'usine, redémarrage, ping, shell) puis shell
  FreeBSD limité (`pfctl -sr` / `-ss` / `-si` / `-d` / `-e`, `ifconfig`, `netstat -rn`, `cat` / `tail` du journal
  `filter.log`, `ping`) ; commandes `pf.assignInterfaces`, `pf.setInterfaceFromConsole`, `pf.resetAdminPassword`,
  `pf.factoryReset`, `pf.reboot`, `pf.setFilterEnabled` ; captures `docs/captures/pfsense/` ; `docs/fidelite.md` P-50 à P-57.
- Interface web du pare-feu (#246) : le navigateur d'un poste joint `https://<adresse du pare-feu>` à travers le filtre (LAN par
  l'anti-verrouillage, WAN et DMZ selon les règles), page de connexion admin / pfsense, tableau de bord, Interfaces,
  Firewall > Rules / Aliases / NAT, Services > DHCP Server / DNS Resolver, System > Routing (Save puis Apply Changes), Status > System Logs > Firewall, Diagnostics > States ;
  commandes `pf.webRequest` et `pfAuthenticate` (`roles/iis/pfweb.ts`), `docs/fidelite.md` P-40 à P-48.
- Labs et pannes du pare-feu (#248) : labs 54 à 59 (règles LAN/DMZ, site de la DMZ publié, NAT sortant, DHCP et DNS, lab
  mixte Windows/Linux, dépannage), départ déclaratif `pf` des labs, critères `pfReachable`, `pfRuleExists`,
  `pfPortForward`, `pfNatMode`, `pfOutboundNat`, `pfAlias`, `pfDhcp`, `pfDnsResolver`, `pfGateway`, 8 pannes du domaine
  `pare-feu` (`pf.*`), `curl` et navigateur à travers une redirection de port ; `docs/fidelite.md` P-50 à P-52.

## [2.9.0] — 2026-10-27

Serveurs Linux (Debian 12, Ubuntu 24.04). Format `.slab` 27 (migration 26 → 27 : serveur Linux, #234) ; les autres
issues n'ajoutent que des champs facultatifs. Captures reconstituées depuis les pages de manuel et sources Debian
bookworm, sans VM : points listés « à vérifier » dans `docs/fidelite.md` (section v2.9).

Labs 46 à 53.

### v2.9 (serveurs Linux)

- Système de fichiers, utilisateurs et droits de la console bash (#235) : arborescence `/etc`, `/var/www`,
  `/var/log`, `/home` sur des fichiers simulés (`src/engine/shell/bash/linuxfs.ts`), droits Unix (rwx, propriétaire,
  groupe) appliqués à `cat`, `ls`, `touch`, `mkdir`, `tee`, `sed -i`, aux redirections `>` / `>>` (faites avec les
  droits de l'utilisateur, pas ceux de `sudo`) et à `cd` ; refus au message d'origine (`Permission denied`).
- Commandes : `cat`, `echo … >> f`, `tee`, `sed -i 's/a/b/'` (sous-ensemble), `chmod` (octal et symbolique), `chown`,
  `useradd`, `usermod -aG`, `groupadd`, `passwd`, `id`, `su`, `sudo` (règle `/etc/sudoers` : groupe `sudo`, `NOPASSWD`,
  mot de passe, jeton de 15 minutes), `ls -l -a -d`. `nano` : message honnête (console de lignes).
- Comptes lus dans `/etc/passwd`, `/etc/group`, `/etc/shadow` (marqueur `$sim$`, aucun hachage réel). État Linux dans
  le champ facultatif `host.linux.files` (format `.slab` 27 inchangé, schéma `model/linuxnode.ts`).
- Golden : console `bash` ajoutée à `tests/engine/golden/golden.ts`, 83 captures `docs/captures/bash/<commande>*.txt`
  (pages de manuel Debian, cas d'erreur réels) et `tests/engine/shell/bash-golden.test.ts` ; section « v2.9 — Serveurs
  Linux » et « À vérifier (v2.9 — Linux) » dans `docs/fidelite.md`.

### v2.9 (serveurs Linux) — format `.slab` 27

- Serveur Linux (#234) : `host.os = 'linux'` autorisé sur `kind: 'server'` (Debian 12 simulé, préfixe `LSRV`, carte
  `eth0`, compte `admin` avec sudo, aucune fonctionnalité Windows). Console bash, `ip`, montage SMB et `realm` du poste
  Linux réutilisés ; prédicat unique `isLinuxHost(device)` (`src/engine/model/host.ts`) à la place des tests
  `kind === 'client' && os === 'linux'`.
- Format `.slab` 27 : champ facultatif `host.linux { distro: 'debian12' | 'ubuntu2404' }` ; migration 26 → 27 (la version
  seule change), fichier de référence `v27.slab` (serveur LSRV1).
- Palette : entrée « Serveur Linux » (groupe Serveurs). Labs déclaratifs : champ facultatif `os: "linux"` d'un équipement.
- Administration Linux (#236) : `apt` (`update`, `install`, `remove`, `search`, `list --installed`) sur un catalogue local de
  13 paquets (`services/linuxcatalog.ts`) ; `apt update` et `install` échouent sans Internet simulé (« Temporary failure
  resolving »). `systemctl` (`start`, `stop`, `restart`, `reload`, `enable`, `disable`, `status`, `is-active`,
  `is-enabled`) avec effets réels sur l'état (`running/startType` ⇔ `active/enabled`, `host.services` des services
  Windows) et conflits de port ; `journalctl -u` lu depuis le journal de l'équipement ; `ss -tulpn` (écoutes dérivées
  des services actifs, aussi vues par `Test-NetConnection`) ; `ps aux`, `df -h`, `free -h`, `uname`, `hostnamectl`
  (valeurs dérivées ; non modélisé = « - » et message honnête) ; `traceroute`, `curl`, `nslookup`, `ip neigh`.
  Sur un serveur Debian 12, pas de `resolvectl` et `dig` interroge le DNS de la carte.
- Format `.slab` 27 inchangé : champ facultatif `host.linux.packages` (absent = paquets de base de la distribution).
- Fidélité : captures `docs/captures/bash/` (comparaison golden, console `bash` ajoutée à `golden.ts`), section v2.9 de
  `docs/fidelite.md` (L-40 à L-51) et « À vérifier (v2.9 — Linux) » (captures reconstituées d'après les manpages).
- SSH, fail2ban et rsyslog (#237) : `ssh` (consoles bash, cmd et PowerShell), `ssh-keygen`, `ssh-copy-id`, `fail2ban-client`
  (`status`, `set banip/unbanip`, `reload`…) et `logger`. `/etc/ssh/sshd_config` (`PermitRootLogin`, `PasswordAuthentication`,
  `PubkeyAuthentication`, `Port`) décide de l'accès, relu seulement au redémarrage du service ; fail2ban (prison `sshd`)
  bannit après `maxretry` échecs saisis par l'élève (bannissement abstrait, aucune attaque générée) ; `/var/log/auth.log`,
  `/var/log/syslog` et `/var/log/fail2ban.log` sont calculés depuis le journal de l'ordinateur ; rsyslog envoie les
  journaux à un collecteur (`*.* @@hôte:514`). `scp`, `sftp`, `sshd` : message honnête de non-simulation.
  Format `.slab` 27 inchangé : champs facultatifs `host.linux.loaded`, `bans` et `knownHosts` ; 34 captures `docs/captures/bash/`
  (L-60 à L-67 de `docs/fidelite.md`) comparées par `tests/engine/shell/bash-ssh-golden.test.ts`. Correction : `apt install` et
  l'écriture d'un fichier (`tee`, `sed -i`) ne s'effacent plus mutuellement dans `host.linux`.
- Apache2 sur serveur Linux (#238) : `a2ensite`, `a2dissite`, `a2enmod`, `a2dismod`, `a2enconf`, `a2disconf` (port du script
  Debian, liens symboliques réels, dépendances et conflits de modules), `apache2ctl` / `apachectl` (`configtest` avec les
  vrais messages d'Apache, `-S`, `-M`, `-v`, `start`/`stop`/`restart`/`graceful`), configuration relue seulement au
  `reload` / `restart`, hôtes virtuels (nom, port, adresse), `DocumentRoot`, `Require`, `Options`, `Redirect`, HTTPS
  (certificat auto-signé), `access.log` / `error.log`, conflit de port ; visible par `curl` (bash) et par le navigateur et
  `Invoke-WebRequest` d'un poste Windows. État en champs facultatifs de `host.linux` (format `.slab` 27 inchangé, nœud
  de fichier `link`), 59 captures `docs/captures/bash`, tests golden et de comportement, L-70 à L-79 dans `docs/fidelite.md`.
- Samba sur serveur Linux et interopérabilité Windows (#239) : `smb.conf` du paquet Debian (relu au `restart` / `reload`),
  `testparm` (messages de `testparm.c`, paramètres inconnus), `smbpasswd -a/-x/-d/-e/-n`, `pdbedit -L/-x`, `smbstatus`,
  `smbclient -L` et `-c ls/cd/mkdir` ; partages (`path`, `read only`, `valid users`, `guest ok`, `write list`, `force user`,
  `hosts allow`, `[homes]`…) avec les droits Unix du compte appliqués ; accès depuis un poste Windows (`net use`, `net view`,
  Explorateur, `dir`, `type`, `mkdir`, `echo >`, `del`). État en champs facultatifs de `host.linux` (format `.slab` 27
  inchangé), 39 captures `docs/captures/bash`, tests golden et de comportement, L-80 à L-89 dans `docs/fidelite.md`.
- Bind9 et isc-dhcp-server sur serveur Linux (#240) : `named.conf*` du paquet Debian (relu au `restart` / `rndc reload`),
  `named-checkconf [-z]`, `named-checkzone`, `rndc status|reload [zone]|reconfig|flush`, `host` ; zones directe et inverse
  réellement servies aux clients Windows et Linux (`dig`, `host`, `nslookup`, `ping`), `allow-query` / `recursion`, redirecteurs
  dans les deux sens avec le DNS Windows ; `dhcpd.conf` / `INTERFACESv4` / `dhcpd -t`, démarrage refusé si la configuration est
  invalide, baux réellement attribués aux postes (écrits dans `dhcpd.leases`, journal `dhcpd[pid]: DHCPDISCOVER…`), réservations,
  renouvellement, libération, conflit avec un autre serveur DHCP. État en champs facultatifs de `host.linux` (format `.slab` 27
  inchangé), captures `docs/captures/bash`, tests golden et de comportement, L-90 à L-99 dans `docs/fidelite.md`.

- Labs Linux et pannes Linux (#241) : labs 46 à 52 (SSH et fail2ban, Apache2, Samba, Bind9, isc-dhcp-server, et deux labs
  mixtes Windows / Linux : partage Samba utilisé par un poste Windows, DHCP et DNS Linux pour un poste Windows), lab 53 de
  dépannage Linux ; 14 pannes du domaine `linux` (service arrêté ou désactivé, port de sshd, `PermitRootLogin`, IP bannie par
  fail2ban, syntaxe et hôte virtuel Apache, droits du DocumentRoot, chemin et droits d'un partage Samba, syntaxe de named,
  enregistrement DNS manquant, `INTERFACESv4` vide, syntaxe de dhcpd.conf) cassées et réparées par des lignes de la console
  bash. Départ déclaratif : champs `packages` et `bash` d'un équipement Linux (commande `linux.installPackages`) ; critères
  `linuxServiceActive`, `linuxFileContains`, `linuxFileMode`, `linuxPortListening`, `linuxPackageInstalled`. Format `.slab` 27
  inchangé, aucune fixture modifiée.

## [2.8.0] — 2026-10-19

Services à état et mode panne. Format `.slab` 26 (migration 25 → 26 : horloge par ordinateur). Les sorties sans source
publiée complète restent listées « à vérifier » dans `docs/fidelite.md` (section v2.8).

Labs 42 à 45.

### Chantier D de la v2.8 (mode panne)

- Modèle de panne (#228) : `src/engine/troubleshoot/` (`FaultDef`, registre, `startTroubleshooting`, PRNG partagé `core/prng.ts`).
  Une panne est une transformation déterministe de l'état par commandes nommées ; l'état cassé est le point de départ
  (rien à annuler), même graine = mêmes pannes.
- Champ facultatif `troubleshooting` sur `LabState` et sur la définition d'un lab (format `.slab` 26 inchangé),
  commande nommée annulable `troubleshoot.useHint`, critère de lab `faultRepaired`, `buildLabState`.
- Catalogue initial : `windows.service-stopped` (DNS) et `net.wrong-mask` ; test de réparabilité sur 100 graines.
- Documentation : [docs/depannage.md](docs/depannage.md).
- Pannes réseau (#229) : onze pannes `net.*` s'ajoutent à `net.wrong-mask` (12 au total) — `wrong-gateway`, `duplicate-ip`,
  `cable-unplugged`, `wrong-vlan`, `trunk-missing-vlan`, `port-err-disabled`, `acl-blocking`, `wrong-nat`,
  `missing-route`, `wrong-stp-root`, `etherchannel-down`. Aucune sortie de console nouvelle : symptômes observés avec
  `ping`, `ipconfig`, `show vlan`, `show interfaces trunk`, `show spanning-tree`, `show etherchannel summary`…
  Injection et réparation par commandes nommées (dont `shell.exec` pour la configuration IOS) ; test de réparabilité
  sur 100 graines et sept labs sains de référence.
- Pannes Windows (#230), domaine `windows`, aucune sortie de console nouvelle (symptômes des consoles déjà sourcées) :
  `windows.service-stopped` étendue (DNS, DHCPServer, LanmanServer, W3SVC, Netlogon), `win.service-disabled`,
  `win.service-failed`, `win.dependency-stopped`, `win.dns-wrong-a`, `win.dhcp-scope-disabled`,
  `win.dhcp-scope-exhausted`, `win.trust-broken`, `win.account-locked`, `win.account-disabled`, `win.gpo-unlinked`,
  `win.gpo-filtered`, `win.ntfs-rights`, `win.share-acl`, `win.clock-skew`.
- Pannes composées (`win.combo.*`, 6) : deux causes dont la première masque la seconde (`troubleshoot/composite.ts`) ;
  tirage de plusieurs pannes limité aux pannes qui restent réparables ensemble.
- Compte « expiré » non ajouté (non modélisé) : voir `docs/fidelite.md`, D-27. Format `.slab` 26 inchangé.
- Interface du dépannage (#232) : Fichier > « Lancer un dépannage… » (ou bouton du sélecteur de labs) sur le lab ouvert —
  difficulté maximale, domaine (réseau, Windows, aléatoire), nombre de pannes (1 ou 2), graine affichée pour rejouer.
  Ticket utilisateur sans la cause, trois niveaux d'indices (commande `troubleshoot.useHint`, comptés dans le bilan),
  « J'ai réparé » (« Le problème persiste. » sans dire quoi) et « Abandonner » (cause et correction officielle).
- Bilan calculé par le moteur (`troubleshoot/summary.ts`) : cause, symptôme, commandes de la réparation officielle
  comparées à celles jouées par l'élève (« chemin le plus court »), indices, durée, score sur 100.
- Dépannage chronométré : réutilise la session et la note du mode examen (durée imposée, indices désactivés,
  vérification unique) ; le bilan affiche aussi la note d'examen. Annuler ne revient jamais avant l'injection.
- Tirage contrôlé (#231) : audit de `startTroubleshooting` (déterministe : PRNG seedé, ordre stable), règle de compatibilité
  des pannes tirées (même cible ou symptôme masqué : candidate écartée), message d'erreur FR précis quand le nombre de pannes
  demandé est impossible. Tests : réparabilité de tout tirage valide (labs de base × graines × 1 à 3 pannes × domaines, deux
  ordres de réparation), même graine = même tirage, diversité, erreurs métier.
- Trois labs de dépannage d'exemple (#233), lancés directement depuis la bibliothèque (départ sain, pannes fixées par
  `troubleshooting.faults` et une graine, injectées par `buildLabState`) : lab 43 « Dépannage réseau : Internet ne répond
  plus » (`net.wrong-vlan` + `net.wrong-gateway`), lab 44 « Dépannage Windows : les postes n'ouvrent plus de session »
  (`win.clock-skew` + `windows.service-stopped`), lab 45 « Dépannage composé : deux causes qui se masquent »
  (`win.combo.dns-stopped-wrong-a`). L'ouverture, la reprise et le mode examen d'un lab passent par `buildLabState`.

### Chantier A de la v2.8 (services à état)

- Dépendances entre services (#223) : table sourcée dans le moteur (`W3SVC` → `WAS`, `Netlogon` → `LanmanWorkstation` et `LanmanServer`), sans changement du format `.slab`.
- `Stop-Service` / `Restart-Service` refusés sans `-Force` si des dépendants tournent, avec `-Force` les dépendants sont arrêtés d'abord ; `sc stop` : erreur 1051 ; `net stop` : message honnête (invite non simulée).
- `Start-Service`, `net start` et `sc start` démarrent d'abord les dépendances ; une dépendance désactivée fait échouer le démarrage (erreur 1068).
- `Get-Service -DependentServices` / `-RequiredServices` et propriétés `DependentServices` / `ServicesDependedOn` calculées depuis le modèle (plus de « non simulé »).
- Commandes `service.stop` et `service.restart` : argument optionnel `force`.
- Horloge par ordinateur (`host.clockOffsetSeconds`, format 26, migration 25 → 26) : `Get-Date`, `Set-Date -Date` / `-Adjust`,
  commandes nommées `host.setClock` et `host.resyncClock` (annulables) (#219).
- `w32tm /query /status [/verbose]`, `w32tm /resync` et `net time \\serveur [/set /y]`, sorties sourcées (`docs/captures/cmd/`).
- Kerberos : un écart d'horloge de plus de 5 minutes avec le contrôleur de domaine refuse la session de domaine
  (événements 4771 et 4625) et l'accès aux partages du domaine (erreur 1398) ; `w32tm /resync` (service Temps Windows
  démarré) ou `Set-Date` le répare.
- Critère de lab `clockOffset` (ordinateur, écart maximal en secondes).
- Services : échec au démarrage et options de récupération (#224). Champs facultatifs `failure` et `recovery` sur l'état d'un
  service (format 26 inchangé), commandes nommées annulables `service.setFailure`, `service.clearFailure` et
  `service.setRecovery` (point d'appui de l'injection de panne du mode panne).
- Un service en échec refuse de démarrer (`Start-Service`, `Restart-Service`, `net start`, `sc start` : erreur 1066 ou 1053)
  jusqu'à la réparation de sa configuration ; un service qui en dépend ne démarre pas non plus (1068) ; la panne survit à un
  redémarrage.
- Journal Système : évènements 7000 (démarrage refusé), 7034 (arrêt inattendu) et 7031 (arrêt inattendu avec action corrective).
- `sc failure` et `sc qfailure` (reset, reboot, command, actions), sorties calculées depuis l'état, captures et tests golden.
- NTDS et Netlogon (#220) : un contrôleur de domaine dont l'un des deux services est arrêté ne répond plus aux clients.
  Session de domaine refusée (erreur 1311, événement NETLOGON 5719 sur le poste), `gpupdate` en échec, `nltest /dsgetdc`
  en erreur 1355 (golden), jonction au domaine impossible. Avec plusieurs contrôleurs, le client utilise celui qui répond ;
  redémarrer le service (`service.start`) rétablit tout.
- Autres services (#222) : `CertSvc` arrêté (plus de délivrance, d'inscription automatique ni de révocation, erreur 1722),
  `TermService` arrêté (port 3389 fermé, Bureau à distance refusé), `WsusService` arrêté (clients injoignables, synchronisation
  refusée, code 0x80244022), `MpsSvc` arrêté (le pare-feu ne filtre plus), nouveau service `Spooler` (Spouleur d'impression,
  démarrage automatique). Format `.slab` inchangé (v26), goldens `certsvc-arrete` et `wsusservice-arrete`.
- Les issues suivantes de la v2.8 n'ajoutent que des champs facultatifs, sans nouvelle version du format.
- `sc qc <service>` (#225) : START_TYPE, DISPLAY_NAME et DEPENDENCIES calculés depuis l'état, disposition de l'exemple Learn (Netlogon, golden) ; autres services : message honnête, aucune valeur inventée. `tasklist /svc` : message honnête dédié (services par processus non modélisés). `net stop` avec dépendants : inchangé (invite exacte introuvable).
- Interface (#226) : Snap-in Services (`services.msc`) : liste des services (Nom, État, Type de démarrage), démarrer, arrêter, redémarrer par les commandes `service.*` (annulables), propriétés
  (type de démarrage modifiable, onglet Dépendances calculé depuis le modèle ; pas de pause) (#226).
- Gestionnaire de serveur : les services arrêtés dont le démarrage est automatique sont signalés en rouge et
  rendent l'indicateur « Services » des vignettes rouge (#226).
- Lab 42 « Diagnostic de services Windows » (#227) : départ cassé (DNS arrêté en démarrage manuel, service Serveur arrêté sur un
  serveur membre, horloge d'un poste décalée de 15 minutes), causes non données dans l'énoncé. Champ facultatif `clockOffsetSeconds`
  des équipements de départ des labs (format `.slab` inchangé).

## [2.7.0] — 2026-10-14

Fidélité des consoles au caractère près (CMD, PowerShell, Cisco IOS 15.x) : chaque sortie est comparée à une
référence sourcée (`docs/captures/`, tests « golden »). Formats `.slab` 15 à 25. Les sorties sans source publiée
restent listées « à vérifier » dans `docs/fidelite.md`.

Lot 0 de la v2.7 (bugs).

### Corrigé

- B1 : `Get-WindowsFeature | Where Installed` filtre sur la propriété `Installed` (#199).
- B2 : liaison par pipeline de `-Identity` sur les cmdlets Active Directory (#198).
- B3 : `Get-ADUser -Properties MemberOf` renvoie la propriété demandée (#200).
- B6 : expansion des variables `%VAR%` en invite de commandes (#197).
- B7 : mot-clé `log` dans les ACL IOS (#201).
- B8 : `logging synchronous` sur `line con` et `line vty` (#202).

### Ajouté

- Infrastructure de tests « golden » : sorties de référence comparées ligne par ligne (#196).
- Lab 36 « Fidélité des consoles : scripts et équipements ».
- Format `.slab` 15 (ACL avec `log`) et 16 (`logging synchronous`).

Lot 1 de la v2.7 :

- Contenu des fichiers simulés, format `.slab` 17 (#204) ; cmdlets de fichiers et `Import-Csv` / `Export-Csv` (#205) ;
  évaluateur d'expressions PowerShell (#207) ; filtres de sortie IOS `| include`, `exclude`, `begin`, `section`, `count` (#206).
- Lab 37 « Création d'utilisateurs par CSV » (fichiers de départ déclarables dans les labs via `files`).

Lot 2 de la v2.7 :

- Lab 41 « Services et comptes locaux en PowerShell » : critères `serviceState` et `localAccount`, état initial des services déclarable dans les labs via `services`.

Lot 3 de la v2.7 :

- Administration en ligne de commande CMD : `net user` / `localgroup` / `group`, `&&`, redirection `>`, `copy`, `dcdiag`, `dsadd`… (#211).
- Lab 39 « Administration en ligne de commande (CMD) » et critère de lab `fileExists` (fichier présent, contenu facultatif).

Lot 4 de la v2.7 :

- Routeur Cisco : configuration système, RIP / OSPF, services et diagnostic (`show ip protocols`, NTP, `clock`, `show standby`…) (#214) ; formats `.slab` 21 à 23.
- Lab 40 « Routage dynamique RIPv2 et administration du routeur » (critères existants `iosRoute`, `iosRunning`, `iosStartup`, `ping`).

Lot 5 de la v2.7 :

- Switch Catalyst 2960 : bases, STP, EtherChannel, VTP, CDP (#210) et `interface range` (#209).
- Critères IOS `iosStpRoot` (pont racine calculé) et `iosEtherchannel` (canal monté, SU/P).
- Lab 38 « STP et EtherChannel ».
- Formats `.slab` 18, 19 et 20 (état des switchs : STP, EtherChannel, VTP).

## [2.6.2] — 2026-10-13

Version de stabilisation issue de l'audit complet du code (`docs/audit-v2.6.2.md`, label `audit-v2.6.2`).
Aucune nouvelle fonctionnalité ; format `.slab` inchangé (14).

### Sécurité

- Navigation limitée à la page de l'application : un fichier glissé ne remplace plus l'interface (#147).
- Fuses Electron : `RunAsNode` et `NODE_OPTIONS` désactivés, asar seul et vérifié, cookies chiffrés (#148).
- `release.yml` à droits minimaux : aucun script npm exécuté avec un jeton en écriture (#150).
- Risque accepté des mises à jour non signées documenté (#149) ; correctifs mineurs (#167).

### Corrigé

- Boucle de routage : TTL expiré au lieu d'un délai dépassé (#155).
- Raccourcis du canvas inactifs derrière un dialogue modal (#159) ; dialogues accessibles : titre relié,
  focus confiné, Échap (#160) ; contrastes AA des tokens (#161) ; accessibilité clavier et chaînes traduites (#170).
- Commandes réelles non simulées signalées comme telles (#162) ; fidélité : TTL DNS, `ip addr show`,
  `traceroute` IOS (#168).

### Performances

- `canvasStatus` linéaire après une modification réseau (793 ms → quelques ms à 610 équipements) (#157).
- Bundle du renderer minifié : 3,2 Mo → 1,86 Mo (#158).

### Tests et qualité

- Tests : critère `iosPortSecurity` (#154), listes d'accès IOS (#156), critères des labs faux au départ (#153),
  garde-fou cyber (#168).
- Règles ESLint avec information de type (#152) ; usages réels entre rôles déclarés et vérifiés (#151).
- Documentation : README, CHANGELOG, journal des milestones, CLAUDE.md (#145, #164, #171).

## [2.6.1] — 2026-10-08

Milestone « v2.6.1 — Cybersécurité, volet attaque » de la roadmap. Format `.slab` 14 (les labs 2.6 s'ouvrent ;
une version 2.6 refuse les labs 2.6.1). Les attaques sont simulées de façon **abstraite** : seul l'effet d'une
faiblesse de configuration sur l'état simulé est modélisé, jamais l'exploit (`docs/fidelite.md`).

### Ajouté

- Moteur de scénarios : format déclaratif (précondition, effet en cas de succès ou d'échec, événements), registre,
  commande `cyber.playStep`, chronologie dans le panneau Simulation (#139).
- Scénarios « annuaire » : authentification répétée, compte de service mal configuré, réutilisation d'un accès
  déjà obtenu ; format `.slab` 11 (#140).
- Scénarios « réseau » : usurpation d'adresse (inspection ARP), changement de VLAN (négociation de trunk, VLAN
  natif), `show logging` IOS, protocole de trace `DTP` ; format `.slab` 12 (#141).
- Mode Red / Blue : contre-mesures, partie solo contre l'IA seedée, minuteur, score par camp, temps de détection,
  écran de fin ; format `.slab` 13 (#142).
- Labs 31 (compromission de l'annuaire), 32 (durcissement de l'annuaire), 33 (attaque réseau L2), 34 (durcissement
  réseau) et 35 (sujet Red / Blue, mode examen et éditeur) ; critères `accountCompromised`, `machineControlled`,
  `trafficIntercepted`, `vlanHopped`, `scenarioOutcome` ; scénarios activés, paramètres de durcissement et camp
  de l'IA par lab ; format `.slab` 14.
- Documentation : récapitulatif du garde-fou et écarts avec les vraies techniques d'attaque (`docs/fidelite.md`).

## [2.6.0] — 2026-10-08

Milestone « v2.6 — Cybersécurité défensive » de la roadmap. Format `.slab` 10 (les labs 2.5 s'ouvrent ;
une version 2.5 refuse les labs 2.6). Le volet attaque (scénarios abstraits, mode Red / Blue) est reporté
en v2.6.1.

### Ajouté

- Détection dans les journaux : compte inscrit sur les événements de sécurité, ticket de service 4769,
  affichages personnalisés de l'Observateur, corrélations « échecs puis succès » et « hors horaires »,
  critère de lab `detectionAlert` (#128).
- Contre-mesures L2 des switchs Cisco : DHCP snooping, inspection ARP dynamique, `switchport nonegotiate` ;
  règles d'audit IOS (DHCP snooping, inspection ARP, DTP, VLAN natif, port-security) (#129).
- Audit adossé aux référentiels : références ANSSI et CIS Controls v8 par règle, section Référentiels
  cochée dans le rapport PDF, badges dans l'onglet Audit (#130).
- Labs 29 (durcissement L2 Cisco) et 30 (durcissement AD complet) ; format `.slab` 10 (#132).

### Corrigé

- README reformaté (Prettier).

## [2.5.0] — 2026-10-08

Milestone « v2.5 — Équipements Cisco IOS » de la roadmap. Format `.slab` 9 (les labs 2.4 s'ouvrent ;
une version 2.4 refuse les labs 2.5). Écarts connus avec le vrai IOS : `docs/fidelite.md` (I1 à I38).

### Ajouté

- Routeurs Cisco 1921 et 2811, switchs Catalyst 2960 et 9200 : se posent, se câblent, s'enregistrent ;
  console IOS au double-clic, branchée sur le moteur réseau existant (#103).
- Moteur de CLI IOS : modes, abréviations, `?`, Tab, `no`, `do`, erreurs fidèles (#105).
- Configuration de base : `running-config` / `startup-config`, `copy`, `write`, `reload`, bannières,
  `enable secret`, `show version` (#106).
- Commutation : VLAN, trunk 802.1Q, router-on-a-stick, SVI sur Catalyst 9200 (#107).
- Routage : statique, OSPF monozone, `show ip route` / `show ip ospf neighbor` (#108).
- Services IP : relais DHCP, serveur DHCP IOS, NAT / PAT visible en mode Simulation (#109).
- HSRP : passerelle virtuelle, priorité, préemption (#110).
- Sécurité : ACL standard / étendues visibles en mode Simulation, port-security (`err-disabled`), SSH,
  chiffrement des mots de passe (#111).
- Labs notés `lab-22` à `lab-28` (base, VLAN, OSPF, DHCP / NAT, HSRP, sécurité, sujet E6 complet à deux
  sites), disponibles en mode examen et dans l'éditeur de labs ; critères `ios*` lisant l'état IOS (#112).

### Modifié

- Format `.slab` 9 : modèle et état IOS des équipements Cisco (migration 8 → 9 sans transformation).

## [2.4.0] — 2026-10-08

Milestone « v2.4 — Pédagogie avancée » de la roadmap. Format `.slab` 8 (les labs 2.3 s'ouvrent ;
une version 2.3 refuse les labs 2.4). Écarts connus : `docs/fidelite.md` (F97 à F105).

### Ajouté

- Éditeur de labs intégré : énoncé Markdown, départ capturé, critères sans code testés aussitôt, indices
  progressifs, import / export JSON (#33).
- Mode examen : chronomètre, sans indice, vérification finale unique, note sur 20 exportable, sorties
  signalées (#34).
- Bibliothèque communautaire de labs : index vérifié, empreinte SHA-256 ; dépôt public
  `tamalou25/serverlab-labs` à créer (`docs/bibliotheque.md`) (#35).
- Poste Linux simulé : console bash, `realm join`, montage CIFS selon les droits NTFS (#36).
- Interface FR / EN : Affichage › Langue (langue du système par défaut) (#37).

## [2.3.0] — 2026-10-07

Milestone « v2.3 — Cybersécurité (défensif) » de la roadmap. Format `.slab` 7 (les labs 2.2 s'ouvrent ;
une version 2.2 refuse les labs 2.3). Écarts connus avec Windows Server : `docs/fidelite.md` (F87 à F96).

### Ajouté

- **Mode Audit** : onglet Audit du panneau latéral, score de sécurité sur 100 et recommandations classées
  par gravité (SMB 1.0, Admins du domaine, partage Tout le monde : Contrôle total, pare-feu désactivé,
  stratégie de mot de passe faible, mots de passe sans expiration, comptes inactifs), objets en cause et
  correction suggérée (#28).
- **Labs de durcissement** : trois labs (19 à 21, Active Directory, partages, pare-feu) et critères
  « score d'audit » et « règle respectée » (#29).
- **Journaux de sécurité** : évènements 4624, 4625, 4672, 4720, 4728/4729, 4732/4733, 4756/4757 ; filtre de
  l'Observateur d'événements (ID, niveau, source, période) et `Get-WinEvent -FilterHashtable` (#30).
- **Verrouillage des comptes et stratégie d'audit par GPO** : seuil, durée et réinitialisation ;
  évènement 4740 ; déverrouillage depuis la console AD, `Unlock-ADAccount`, `Search-ADAccount` ; stratégie
  d'audit (connexions, gestion des comptes) qui conditionne les évènements (#31).
- **Rapport d'audit PDF** : export depuis l'onglet Audit (dialogue d'enregistrement natif), avec lab, date,
  score et recommandations corrigées ou non depuis l'ouverture (#32).

### Corrigé

- Éditeur de stratégies de groupe : un double-clic sur un paramètre non sélectionné ouvre sa fenêtre (#93).

## [2.2.0] — 2026-10-07

Milestone « v2.2 — Réseau d'entreprise » de la roadmap. Format `.slab` 6 (les labs 2.1 s'ouvrent ;
une version 2.1 refuse les labs 2.2). Écarts connus avec Windows Server : `docs/fidelite.md` (F53 à F86).

### Ajouté

- **VLAN** : base VLAN des switchs, ports d'accès et trunk (VLAN natif, VLAN autorisés), sous-interfaces
  de routeur (router-on-a-stick), en-tête 802.1Q visible en mode Simulation (#22).
- **Relais DHCP** : `ip helper-address` sur les interfaces de routeur, étendue choisie d'après le champ
  giaddr, échange relayé tracé (#23).
- **Pare-feu Windows Defender** : profils domaine/privé/public, règles prédéfinies des rôles, règles
  locales et par GPO, console `wf.msc`, cmdlets NetSecurity et `netsh advfirewall` ; paquets bloqués
  expliqués en Simulation (#24).
- **Accès à distance (RRAS)** : NAT vers Internet (traduction expliquée en Simulation), serveur VPN SSTP
  avec pool d'adresses, client VPN (Paramètres › VPN, `Add-VpnConnection`, `rasdial`) (#25).
- **NPS / RADIUS** : clients RADIUS, stratégies réseau par groupe AD, authentification RADIUS des clients
  VPN, journal Sécurité 6272 / 6273, console `nps.msc` (#26).
- **Multi-sites AD** : sites, sous-réseaux et liens de sites (`dssite.msc`), contrôleur supplémentaire
  (`Install-ADDSDomainController`), réplication (`repadmin`), rôles FSMO (`netdom query fsmo`, transfert,
  prise de force), authentification auprès du contrôleur du site du client (#27).
- Six nouveaux labs (13 à 18), un par fonctionnalité.

### Corrigé

- `$env:LOGONSERVER` désigne le contrôleur qui a authentifié la session (et non le nom du domaine).
- Événement RemoteAccess 20271 et message de l'erreur VPN 691 conformes au texte de Windows.
- Résolution DNS insensible à la casse des noms.

## [2.1.0] — 2026-10-06

Milestone « v2.1 — Nouveaux rôles serveur » de la roadmap. Format `.slab` 5 (les labs 2.0 s'ouvrent ;
une version 2.0 refuse les labs 2.1). Écarts connus avec Windows Server : `docs/fidelite.md` (F23 à F52).

### Ajouté

- **WSUS** : post-installation, synchronisation d'un catalogue fictif, classifications, groupes d'ordinateurs,
  approbations ; ciblage par GPO (Windows Update), client « Paramètres > Windows Update » (#15).
- **IIS** : sites, liaisons HTTP/HTTPS, document par défaut, certificats auto-signés, navigateur simulé avec
  erreurs 403/404 et avertissements TLS (#16).
- **Services Bureau à distance** : collections, RemoteApp, connexion Bureau à distance (mstsc), groupe
  Utilisateurs du Bureau à distance, journaux 4624/4625 de type 10 (#17).
- **Hyper-V** : commutateurs virtuels (externe, interne, privé), machines virtuelles visibles sur le canevas,
  démarrage/arrêt, cartes réseau des VM (#18).
- **AD CS** : autorité racine d'entreprise, modèles, demandes, révocation et liste de révocation,
  inscription automatique par GPO, `certutil`, certificats de domaine pour IIS (#19).
- **DFS** : espaces de noms de domaine (dossiers, cibles, bascule), réplication DFSR entre serveurs (#20).
- **Sauvegarde Windows Server** (planification, sauvegarde unique, récupération, `wbadmin`) et **Corbeille
  Active Directory** (restauration avec attributs et groupes, Centre d'administration Active Directory) (#21).
- Sept nouveaux labs (6 à 12), un par rôle.

## [2.0.1] — 2026-10-06

Version de stabilisation de la 2.0.0 : corrections uniquement, aucune fonctionnalité nouvelle.
Détail de la démarche dans `docs/stabilisation.md` ; écarts avec Windows Server dans `docs/fidelite.md`.

### Corrigé

- Console PowerShell : une expression régulière invalide (`-match '('`, `-notmatch`) affiche une
  erreur au lieu de bloquer la console (#54).
- `Get-Command -Name` et `Get-WindowsFeature -Name` suivent les jokers PowerShell (`*`, `?`) ; un
  caractère spécial comme `(` ne bloque plus la console (#56).
- `-in`, `-notin`, `-contains` et `-notcontains` acceptent une liste (`'a','b'`) dans `Where-Object`
  et les filtres (#55).
- `Get-ADUser -Properties` affiche les propriétés demandées, `*` pour toutes (#69).
- `net share` signale un compte inconnu par l'erreur système 1332 (#53).
- GPMC : l'entrée d'un compte supprimé peut être retirée du filtrage de sécurité (#61).
- Onglet Sécurité NTFS : l'entrée d'un compte supprimé peut être retirée (#62).
- Fichiers : noms réservés (`CON`, `NUL.txt`, `COM1`…) refusés ; points et espaces finaux retirés,
  `Data.` désigne `Data` (#63).
- Fichier `.slab` ou lab invalide : message d'erreur entièrement en français (#67).

### Modifié

- Tests : chaque commande, cmdlet et outil de console du moteur est exercé ; équivalence interface ⇔
  PowerShell ⇔ cmd ; réouverture `.slab` après chaque commande ; couverture du moteur mesurée par
  `npm run test:coverage` (lignes : 78 % → 90 %).

## [2.0.0] — 2026-10-06

Milestone « v1.1 — Consolider » de la roadmap, publié sous le numéro 2.0.0 : nouvelle
architecture du moteur, ergonomie et premier lancement guidé.

### Ajouté

- Écran d'accueil au lancement : labs récents (nom, dossier, date ; fichier introuvable signalé
  et retirable), Nouveau lab, Ouvrir…, labs fournis avec difficulté et durée ; Fichier > Accueil.
- Tutoriel interactif « premier ping » : placer un serveur et un poste, câbler, adresser, pinger ;
  zones mises en évidence, chaque étape validée par l'état réel du lab ; Aide > Tutoriel interactif.
- Annuler / rétablir sur tout le journal de commandes (Ctrl+Z / Ctrl+Y), libellés dans le menu
  Édition, aussi depuis les consoles.
- Aide > Signaler un bug… : issue GitHub préremplie (version, système, Electron), sans donnée du
  lab ni donnée personnelle ; seule cette adresse peut être ouverte (liste blanche).
- Thème « Système » (par défaut) qui suit l'OS en direct ; Affichage > Thème.
- Liste unique des raccourcis clavier (menus et Aide > Raccourcis clavier).

### Modifié

- Rôles serveur (DHCP, DNS, AD DS, GPO, fichiers) regroupés en modules déclarés dans un registre
  unique ; format `.slab` v4 (migration automatique des anciens fichiers).
- Toute modification du lab passe par des commandes nommées (dispatch, journal, rejeu).
- Topologie de 100 équipements fluide (caches par réseau, tâches de fond incrémentales, rendus
  ciblés).
- Logique métier des fenêtres déplacée dans le moteur.

### Sécurité

- Tout fichier importé est validé par un schéma zod ; un fichier `.slab` de référence par version
  du format garantit l'ouverture des anciens labs.
- Adresses externes ouvertes uniquement par le process principal, après liste blanche.

## [1.0.0] — 2026-10-05

Première version stable : mêmes fonctionnalités que la 0.1.1, numérotation alignée sur la roadmap.

### Ajouté

- Roadmap v1.1 → v5.0 (`ROADMAP.md`), milestones, labels et issues synchronisés depuis
  `.github/roadmap/roadmap.json` par le workflow « Roadmap sync ».
- Règles de travail (une issue = une branche = une PR) dans `CLAUDE.md`.

### Modifié

- Actions GitHub passées à Node 24 (`checkout@v5`, `setup-node@v5`, `upload-artifact@v5`).

## [0.1.1] — 2026-10-05

Première release publique (installeur Windows NSIS et AppImage Linux).

### Ajouté

- Topologie : palette, câblage port à port, voyants d'état, annuler/rétablir, fichiers `.slab`
  (récents, récupération automatique, association de fichiers).
- Moteur réseau : IPv4, routage statique, ARP, `ping` / `tracert`, mode Simulation pas à pas.
- Consoles PowerShell et Invite de commandes simulées en français, complétion Tab.
- Rôles : DHCP, DNS, AD DS (forêt, jonction, ouverture de session), stratégies de groupe (GPMC,
  éditeur, `gpupdate`, `gpresult`), fichiers et partages (NTFS, SMB, accès effectif).
- Bureau façon serveur : Gestionnaire de serveur, assistants, consoles MMC, Explorateur.
- Mode Labs : cinq labs vérifiables avec indices.
- Thèmes sombre et clair, interface compacte.
- Mises à jour automatiques (electron-updater) et workflow de release sur tag.

[2.11.0]: https://github.com/tamalou25/ServerLab/compare/v2.10.0...v2.11.0
[2.8.0]: https://github.com/tamalou25/ServerLab/compare/v2.7.0...v2.8.0
[2.7.0]: https://github.com/tamalou25/ServerLab/compare/v2.6.2...v2.7.0
[2.6.2]: https://github.com/tamalou25/ServerLab/compare/v2.6.1...v2.6.2
[2.6.1]: https://github.com/tamalou25/ServerLab/compare/v2.6.0...v2.6.1
[2.6.0]: https://github.com/tamalou25/ServerLab/compare/v2.5.0...v2.6.0
[2.5.0]: https://github.com/tamalou25/ServerLab/compare/v2.4.0...v2.5.0
[2.4.0]: https://github.com/tamalou25/ServerLab/compare/v2.3.0...v2.4.0
[2.3.0]: https://github.com/tamalou25/ServerLab/compare/cbfd1a9...v2.3.0
[2.2.0]: https://github.com/tamalou25/ServerLab/compare/0111fcc...cbfd1a9
[2.1.0]: https://github.com/tamalou25/ServerLab/compare/v2.0.1...0111fcc
[2.0.1]: https://github.com/tamalou25/ServerLab/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/tamalou25/ServerLab/compare/dc9b76c...v2.0.0
[1.0.0]: https://github.com/tamalou25/ServerLab/compare/v0.1.1...dc9b76c
[0.1.1]: https://github.com/tamalou25/ServerLab/releases/tag/v0.1.1
