/**
 * Migrations du format .slab.
 * Chaque entrée transforme un document de la version N vers N+1.
 * Pour faire évoluer le format : incrémenter CURRENT_SCHEMA_VERSION et ajouter une migration.
 */
import { DEFAULT_DC_POLICY_ID, DEFAULT_DOMAIN_POLICY_ID, defaultDomainGpos } from '../roles/gpo/defaults'

export const CURRENT_SCHEMA_VERSION = 22

type RawDocument = Record<string, unknown>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Version 2 : stratégies de groupe. Les domaines existants reçoivent les deux GPO par défaut
 * (Default Domain Policy liée au domaine, Default Domain Controllers Policy liée à l'OU des DC).
 */
function addDefaultGpos(doc: RawDocument): RawDocument {
  const lab = doc['lab']
  if (isRecord(lab) && isRecord(lab['domains'])) {
    const clock = typeof lab['clock'] === 'number' ? lab['clock'] : 0
    for (const domain of Object.values(lab['domains'])) {
      if (!isRecord(domain) || Array.isArray(domain['gpos'])) continue
      domain['gpos'] = defaultDomainGpos(clock)
      domain['gpLinks'] = [{ gpoId: DEFAULT_DOMAIN_POLICY_ID, enabled: true, enforced: false }]
      const containers = Array.isArray(domain['containers']) ? domain['containers'] : []
      const dcs = containers.find(
        (c): c is Record<string, unknown> =>
          isRecord(c) && c['name'] === 'Domain Controllers' && c['parentId'] === null
      )
      if (dcs && !Array.isArray(dcs['gpLinks']))
        dcs['gpLinks'] = [{ gpoId: DEFAULT_DC_POLICY_ID, enabled: true, enforced: false }]
    }
  }
  return { ...doc, schemaVersion: 2 }
}

/** Version 3 : identifiant du lab pédagogique en cours (métadonnées). */
function addLabId(doc: RawDocument): RawDocument {
  const meta = isRecord(doc['meta']) ? doc['meta'] : {}
  return {
    ...doc,
    meta: { ...meta, labId: typeof meta['labId'] === 'string' ? meta['labId'] : '' },
    schemaVersion: 3
  }
}

/**
 * Version 4 : données des rôles stockées de façon générique, par identifiant de module.
 * `services: { dhcp, dns }` (null = rôle jamais installé) devient `roles: { dhcp?, dns? }`.
 */
function moveServicesToRoles(doc: RawDocument): RawDocument {
  const lab = doc['lab']
  if (isRecord(lab) && isRecord(lab['devices'])) {
    for (const device of Object.values(lab['devices'])) {
      if (!isRecord(device) || device['kind'] !== 'server') continue
      const services = isRecord(device['services']) ? device['services'] : {}
      const roles: Record<string, unknown> = isRecord(device['roles']) ? { ...device['roles'] } : {}
      for (const [key, value] of Object.entries(services))
        if (value !== null && value !== undefined && roles[key] === undefined) roles[key] = value
      device['roles'] = roles
      delete device['services']
    }
  }
  return { ...doc, schemaVersion: 4 }
}

/**
 * Version 5 (ServerLab 2.1) : rôles de la v2.1 (WSUS…) et nouveaux paramètres de stratégie
 * (Windows Update). Rien à transformer : les nouveaux champs reçoivent les valeurs par défaut de
 * leur schéma ; le numéro de version empêche une version 2.0 d'ouvrir (et de tronquer) ces labs.
 */
function addV21Roles(doc: RawDocument): RawDocument {
  return { ...doc, schemaVersion: 5 }
}

/**
 * Version 6 (ServerLab 2.2) : VLAN (base des switchs, ports d'accès et trunks 802.1Q,
 * sous-interfaces de routeur) et fonctionnalités réseau de la v2.2. Rien à transformer : un
 * switch sans base reçoit le VLAN 1 par défaut, un port sans configuration est un port d'accès
 * du VLAN 1 ; le numéro de version empêche une version 2.1 d'ouvrir (et de tronquer) ces labs.
 */
function addV22Network(doc: RawDocument): RawDocument {
  return { ...doc, schemaVersion: 6 }
}

/**
 * Version 7 (ServerLab 2.3) : sécurité (expiration des mots de passe, dernière ouverture de
 * session et date de création des comptes, protocole SMB 1.0). Rien à transformer : les
 * nouveaux champs reçoivent les valeurs par défaut de leur schéma ; le numéro de version
 * empêche une version 2.2 d'ouvrir (et de tronquer) ces labs.
 */
function addV23Security(doc: RawDocument): RawDocument {
  return { ...doc, schemaVersion: 7 }
}

/**
 * Version 8 (ServerLab 2.4) : postes Linux (système de l'ordinateur, partages montés). Rien à
 * transformer : un ordinateur sans système est un ordinateur Windows ; le numéro de version
 * empêche une version 2.3 d'ouvrir (et de tronquer) ces labs.
 */
function addV24Linux(doc: RawDocument): RawDocument {
  return { ...doc, schemaVersion: 8 }
}

/**
 * Version 9 (ServerLab 2.5) : équipements Cisco IOS (modèle, état `ios` : configuration, VLAN,
 * OSPF, DHCP, NAT, ACL, HSRP, sécurité). Rien à transformer : un routeur ou un switch sans modèle
 * est un équipement générique ; le numéro de version empêche une version 2.4 d'ouvrir (et de
 * tronquer) ces labs.
 */
function addV25Ios(doc: RawDocument): RawDocument {
  return { ...doc, schemaVersion: 9 }
}

/**
 * Version 10 (ServerLab 2.6) : cybersécurité défensive (compte des événements de sécurité, DHCP
 * snooping, inspection ARP et DTP des switchs IOS). Rien à transformer : champs facultatifs ou
 * valeurs par défaut ; le numéro de version empêche une version 2.5 d'ouvrir (et de tronquer) ces labs.
 */
function addV26Cyber(doc: RawDocument): RawDocument {
  return { ...doc, schemaVersion: 10 }
}

/**
 * Version 11 : scénarios de cybersécurité. Les valeurs par défaut des schémas (SPN, date de dernier
 * changement de mot de passe, compromission, accès administrateur, paramètres `cyber`) suffisent :
 * seul le numéro de version change.
 */
function addV261Scenarios(doc: RawDocument): RawDocument {
  return { ...doc, schemaVersion: 11 }
}

/**
 * Version 12 : scénarios « réseau » de cybersécurité (saut de VLAN, usurpation ARP, tampon syslog
 * IOS). Les valeurs par défaut des schémas suffisent : seul le numéro de version change.
 */
function addV261Network(doc: RawDocument): RawDocument {
  return { ...doc, schemaVersion: 12 }
}

/**
 * Version 13 : mode Red/Blue (réglages de partie dans `cyber.game`). Les valeurs par défaut des
 * schémas suffisent : seul le numéro de version change.
 */
function addV261Game(doc: RawDocument): RawDocument {
  return { ...doc, schemaVersion: 13 }
}

/**
 * Version 14 : labs de cybersécurité (scénarios activés par lab, paramètres de durcissement, camp
 * imposé à l'IA du mode Red/Blue). Les valeurs par défaut des schémas suffisent : seul le numéro de
 * version change.
 */
function addV261Labs(doc: RawDocument): RawDocument {
  return { ...doc, schemaVersion: 14 }
}

/**
 * Version 15 : journalisation des entrées d'ACL IOS (`log`, `log-input`, champ `log` des entrées).
 * La valeur par défaut du schéma (aucune journalisation) suffit : seul le numéro de version change.
 */
function addV27AclLog(doc: RawDocument): RawDocument {
  return { ...doc, schemaVersion: 15 }
}

/**
 * Version 16 : `logging synchronous` sur les lignes IOS (champ `loggingSync`). La valeur par défaut
 * du schéma (désactivé) suffit : seul le numéro de version change.
 */
function addV27LoggingSync(doc: RawDocument): RawDocument {
  return { ...doc, schemaVersion: 16 }
}

/**
 * Version 17 : contenu texte des fichiers simulés (champ optionnel `content` des éléments du
 * stockage). Les fichiers existants n'ont pas de contenu : seul le numéro de version change.
 */
function addV27FileContent(doc: RawDocument): RawDocument {
  return { ...doc, schemaVersion: 17 }
}

/**
 * Version 18 : switch 2960 (ip default-gateway, cdp run, table d'adresses MAC). Champs IOS
 * facultatifs à valeur par défaut (passerelle absente, CDP actif, table vide) : seul le numéro de
 * version change.
 */
function addV27SwitchBasics(doc: RawDocument): RawDocument {
  return { ...doc, schemaVersion: 18 }
}

/**
 * Version 19 : spanning-tree des switchs IOS (mode, priorités par VLAN, portfast, BPDU Guard).
 * Valeurs par défaut (PVST, 32768, désactivés) : seul le numéro de version change.
 */
function addV27Stp(doc: RawDocument): RawDocument {
  return { ...doc, schemaVersion: 19 }
}

/**
 * Version 20 : EtherChannel (channel-group, interfaces Port-channel) et VTP (mode, domaine) des
 * switchs IOS. Valeurs par défaut (aucun groupe, serveur sans domaine) : seul le numéro change.
 */
function addV27EtherChannelVtp(doc: RawDocument): RawDocument {
  return { ...doc, schemaVersion: 20 }
}

/**
 * Version 21 : administration du système IOS (v2.7, lot 4a) — clock timezone, ntp server,
 * exec-timeout des lignes et horloge réglée par clock set. Champs facultatifs (valeurs par défaut
 * du schéma : UTC, aucun serveur, 10 0, horloge jamais réglée) : seule la version change.
 */
function addV27SystemAdmin(doc: RawDocument): RawDocument {
  return { ...doc, schemaVersion: 21 }
}

/**
 * Version 22 : routage dynamique du routeur (v2.7, lot 4b) — processus RIP (router rip) et
 * default-information originate d'OSPF. Champs facultatifs (aucun RIP, aucune route par défaut
 * annoncée) : seule la version change.
 */
function addV27RipOspfDefault(doc: RawDocument): RawDocument {
  return { ...doc, schemaVersion: 22 }
}

/** migrations[n] migre un document de la version n vers n + 1. */
export const migrations: Record<number, (doc: RawDocument) => RawDocument> = {
  1: addDefaultGpos,
  2: addLabId,
  3: moveServicesToRoles,
  4: addV21Roles,
  5: addV22Network,
  6: addV23Security,
  7: addV24Linux,
  8: addV25Ios,
  9: addV26Cyber,
  10: addV261Scenarios,
  11: addV261Network,
  12: addV261Game,
  13: addV261Labs,
  14: addV27AclLog,
  15: addV27LoggingSync,
  16: addV27FileContent,
  17: addV27SwitchBasics,
  18: addV27Stp,
  19: addV27EtherChannelVtp,
  20: addV27SystemAdmin,
  21: addV27RipOspfDefault
}

export type MigrationResult = { ok: true; doc: RawDocument } | { ok: false; message: string }

/** Amène un document brut à la version courante du format. */
export function migrateDocument(doc: RawDocument): MigrationResult {
  const version = doc['schemaVersion']
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { ok: false, message: 'Champ « schemaVersion » absent ou invalide.' }
  }
  if (version > CURRENT_SCHEMA_VERSION) {
    return {
      ok: false,
      message: `Ce fichier a été créé avec une version plus récente de ServerLab (format ${version}). Mettez l’application à jour.`
    }
  }
  let current = doc
  for (let v = version; v < CURRENT_SCHEMA_VERSION; v++) {
    const migrate = migrations[v]
    if (!migrate) return { ok: false, message: `Migration manquante depuis le format ${v}.` }
    current = migrate(current)
  }
  return { ok: true, doc: current }
}
