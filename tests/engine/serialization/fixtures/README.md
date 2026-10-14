# Fichiers .slab de référence

Un fichier par version du format (`schemaVersion`), produit **par le code de cette version** avec le
même scénario (`../reference-lab.ts`) : contrôleur de domaine `lab.local` (DNS, DHCP autorisé),
switch, routeur, poste en DHCP joint au domaine, poste statique, OU, utilisateur et groupe.

| Fichier    | Format | Produit avec                                                                            |
| ---------- | ------ | --------------------------------------------------------------------------------------- |
| `v1.slab`  | 1      | commit `6da8368` (Bureau façon serveur, avant GPO)                                      |
| `v2.slab`  | 2      | commit `4379438` (GPO + fichiers, avant les labs)                                       |
| `v3.slab`  | 3      | ServerLab 1.0.0 (`npm run fixture:slab`)                                                |
| `v4.slab`  | 4      | modules de rôles, données dans `roles` (issue #4)                                       |
| `v5.slab`  | 5      | ServerLab 2.1 : WSUS, stratégies Windows Update                                         |
| `v9.slab`  | 9      | ServerLab 2.5 : équipements Cisco IOS (CR1, CSW1)                                       |
| `v10.slab` | 10     | ServerLab 2.6 : sécurité L2 de CSW1 (DHCP snooping, inspection ARP, DTP)                |
| `v14.slab` | 14     | ServerLab 2.6.1 : labs de cybersécurité (scénarios activés, durcissement, camp de l'IA) |
| `v13.slab` | 13     | ServerLab 2.6.1 : mode Red/Blue (réglages de partie)                                    |
| `v12.slab` | 12     | ServerLab 2.6.1 : scénarios réseau (saut de VLAN, interception, syslog IOS)             |
| `v11.slab` | 11     | ServerLab 2.6.1 : scénarios de cybersécurité (SPN, compromission, `cyber`)              |
| `v17.slab` | 17     | ServerLab 2.7 : contenu texte des fichiers (`C:\Scripts\users.csv` de SRV1)             |
| `v21.slab` | 21     | ServerLab 2.7 : horloge et NTP de CR1 (clock timezone, ntp server, exec-timeout)        |
| `v22.slab` | 22     | ServerLab 2.7 : RIP v2 de CR1, default-information originate d'OSPF                     |

Ces fichiers ne doivent **jamais** être modifiés ni régénérés : ils représentent les fichiers que
des utilisateurs ont réellement enregistrés. `../migrations.test.ts` vérifie que chacun s'ouvre,
migre jusqu'au format courant et reste utilisable.
