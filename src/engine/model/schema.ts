/**
 * Modèle de données du moteur, défini une seule fois sous forme de schémas zod.
 * Les types TypeScript sont inférés de ces schémas : le format des fichiers .slab
 * et le typage du code ne peuvent donc pas diverger.
 *
 * Règle : tout nouveau champ ajouté au modèle doit avoir une valeur par défaut
 * (`.default(...)`) pour rester compatible avec les fichiers existants.
 */
import { z } from 'zod'
import { DEVICE_KINDS } from './kinds'
import { IOS_ROUTER_MODELS, IOS_SWITCH_MODELS } from '../ios/models'
import { DhcpExclusionSchema, DhcpServerSchema } from './dhcp'

// Messages de validation en français (fichiers .slab et labs importés) : locale fournie par zod
z.config(z.locales.fr())

/** Position d'un équipement sur le canvas (simple donnée, sans dépendance UI). */
export const PositionSchema = z.object({ x: z.number(), y: z.number() })

/** Bail DHCP obtenu par une carte réseau cliente. */
export const DhcpClientLeaseSchema = z.object({
  address: z.string(),
  prefixLength: z.number().int().min(0).max(32),
  gateway: z.string().nullable().default(null),
  dnsServers: z.array(z.string()).default([]),
  dnsSuffix: z.string().nullable().default(null),
  serverId: z.string(),
  serverDeviceId: z.string(),
  obtainedAt: z.number(),
  expiresAt: z.number()
})

/** Numéro de VLAN 802.1Q utilisable (1 à 4094). */
export const VlanIdSchema = z.number().int().min(1).max(4094)

/** Configuration 802.1Q d'un port de switch (absente : port d'accès du VLAN 1). */
export const SwitchportSchema = z.object({
  mode: z.enum(['access', 'trunk']).default('access'),
  /** VLAN d'un port d'accès (trames non étiquetées). */
  accessVlan: VlanIdSchema.default(1),
  /** VLAN natif d'un trunk : ses trames circulent sans étiquette. */
  nativeVlan: VlanIdSchema.default(1),
  /** VLAN autorisés sur le trunk (null : tous). */
  allowedVlans: z.array(VlanIdSchema).nullable().default(null),
  /**
   * VLAN atteint par un hôte après un saut de VLAN (scénario cyber, v2.6.1) : état simulé du port,
   * la configuration (accessVlan) reste inchangée. null : aucun saut.
   */
  hoppedVlan: VlanIdSchema.nullable().default(null)
})

/**
 * Sous-interface de routeur (Gi0/0.10) : carte physique parente et VLAN de l'encapsulation dot1Q
 * (null : sous-interface IOS créée, pas encore d'encapsulation).
 */
export const SubinterfaceSchema = z.object({ parent: z.string(), vlan: VlanIdSchema.nullable() })

/** VLAN de la base d'un switch. */
export const VlanSchema = z.object({ id: VlanIdSchema, name: z.string() })

/** Carte réseau / port d'un équipement. */
export const NetInterfaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  mac: z.string(),
  enabled: z.boolean().default(true),
  /** false pour les ports de switch (niveau 2 uniquement). */
  l3: z.boolean(),
  /** Mode d'adressage IPv4 (statique ou DHCP). */
  addressing: z.enum(['static', 'dhcp']).default('static'),
  address: z.string().nullable().default(null),
  prefixLength: z.number().int().min(0).max(32).nullable().default(null),
  gateway: z.string().nullable().default(null),
  /** DNS : saisis manuellement ou obtenus par DHCP. */
  dnsMode: z.enum(['static', 'dhcp']).default('static'),
  dnsServers: z.array(z.string()).default([]),
  dhcpLease: DhcpClientLeaseSchema.nullable().default(null),
  /** Bail libéré manuellement (ipconfig /release) : plus d'adresse jusqu'au prochain renouvellement. */
  dhcpReleased: z.boolean().default(false),
  /**
   * Carte physique liée à un commutateur virtuel externe Hyper-V (identifiant du commutateur) :
   * elle ne porte plus d'adresse IP et transmet les trames du commutateur sur son câble.
   */
  bridge: z.string().nullable().default(null),
  /** Port de switch : mode accès ou trunk 802.1Q (absent : accès, VLAN 1). */
  switchport: SwitchportSchema.optional(),
  /** Sous-interface de routeur (sans câble propre : elle utilise celui de sa carte parente). */
  subinterface: SubinterfaceSchema.optional(),
  /** Interface de routeur : serveurs DHCP vers lesquels relayer les diffusions (ip helper-address). */
  helperAddresses: z.array(z.string()).optional(),
  /** Interface VLAN d'un switch IOS (SVI, interface vlan 10) : membre du domaine de diffusion du VLAN. */
  svi: z.object({ vlan: VlanIdSchema }).optional()
})

/** Entrée du journal d'événements (Observateur d'événements simplifié). */
export const EventLogEntrySchema = z.object({
  id: z.number().int(),
  time: z.number(),
  level: z.enum(['information', 'warning', 'error']),
  log: z.enum(['Système', 'Application', 'Sécurité', 'Service d’annuaire', 'Serveur DNS']).default('Système'),
  source: z.string(),
  eventId: z.number().int(),
  message: z.string(),
  /** Compte concerné (DOMAINE\\nom), pour les filtres et la corrélation des événements de sécurité. */
  account: z.string().optional()
})

/** Route statique d'un routeur. */
export const StaticRouteSchema = z.object({
  network: z.string(),
  prefixLength: z.number().int().min(0).max(32),
  nextHop: z.string()
})

/** Utilisateur connecté (session interactive). `domain` null = compte local. */
export const HostSessionSchema = z.object({
  user: z.string(),
  domain: z.string().nullable().default(null),
  /** Contrôleur qui a authentifié la session de domaine (%LOGONSERVER%). */
  logonServer: z.string().optional()
})

/** Lecteur réseau connecté manuellement (net use, « Connecter un lecteur réseau »). */
export const MappedDriveSchema = z.object({
  /** Lettre sans les deux-points (Z). */
  letter: z.string(),
  /** Chemin UNC (\\SRV1\Commun). */
  path: z.string(),
  /** Compte de la session qui a connecté le lecteur (LAB\jdupont). */
  account: z.string(),
  /** Reconnecté à l'ouverture de session suivante. */
  persistent: z.boolean().default(true)
})

/** SID bien connus utilisés dans les listes de contrôle d'accès. */
export const WELL_KNOWN_SIDS = {
  everyone: 'S-1-1-0',
  creatorOwner: 'S-1-3-0',
  authenticatedUsers: 'S-1-5-11',
  system: 'S-1-5-18',
  administrators: 'S-1-5-32-544',
  users: 'S-1-5-32-545'
} as const

// ---------------------------------------------------------------------------
// Stratégies de groupe : paramètres simulés
// ---------------------------------------------------------------------------

/** État d'un paramètre de modèle d'administration. */
export const POLICY_STATES = ['NotConfigured', 'Enabled', 'Disabled'] as const
export const PolicyStateSchema = z.enum(POLICY_STATES)

// ---------------------------------------------------------------------------
// Pare-feu Windows Defender (profils, règles locales et de stratégie de groupe)
// ---------------------------------------------------------------------------

/** Profils du pare-feu : réseau du domaine, privé ou public. */
export const FIREWALL_PROFILES = ['Domain', 'Private', 'Public'] as const
export const FIREWALL_PROTOCOLS = ['Any', 'TCP', 'UDP', 'ICMPv4'] as const

/** Règle de pare-feu (créée localement, par stratégie de groupe, ou prédéfinie). */
export const FirewallRuleSchema = z.object({
  /** Nom unique de la règle (Name de New-NetFirewallRule). */
  id: z.string(),
  displayName: z.string(),
  /** Groupe de règles (DisplayGroup), vide pour une règle personnalisée. */
  group: z.string().default(''),
  direction: z.enum(['Inbound', 'Outbound']),
  action: z.enum(['Allow', 'Block']),
  enabled: z.boolean().default(true),
  protocol: z.enum(FIREWALL_PROTOCOLS).default('Any'),
  /** Ports locaux (vide : tous). */
  localPorts: z.array(z.number().int().min(1).max(65535)).default([]),
  /** Adresses distantes, adresse ou réseau CIDR (vide : toutes). */
  remoteAddresses: z.array(z.string()).default([]),
  /** Profils auxquels la règle s'applique (vide : tous). */
  profiles: z.array(z.enum(FIREWALL_PROFILES)).default([])
})

export const FirewallProfileSchema = z.object({
  enabled: z.boolean().default(true),
  defaultInbound: z.enum(['Block', 'Allow']).default('Block'),
  defaultOutbound: z.enum(['Block', 'Allow']).default('Allow')
})

const defaultFirewallProfile = () => ({
  enabled: true,
  defaultInbound: 'Block' as const,
  defaultOutbound: 'Allow' as const
})

/** Pare-feu d'un ordinateur : configuration locale (les stratégies de groupe s'y ajoutent). */
export const FirewallSchema = z.object({
  profiles: z
    .object({
      Domain: FirewallProfileSchema.default(defaultFirewallProfile),
      Private: FirewallProfileSchema.default(defaultFirewallProfile),
      Public: FirewallProfileSchema.default(defaultFirewallProfile)
    })
    .default(() => ({
      Domain: defaultFirewallProfile(),
      Private: defaultFirewallProfile(),
      Public: defaultFirewallProfile()
    })),
  /** Catégorie du réseau hors domaine (Public par défaut). */
  networkCategory: z.enum(['Public', 'Private']).default('Public'),
  /** Règles prédéfinies activées ou désactivées par l'administrateur (nom → activée). */
  predefined: z.record(z.string(), z.boolean()).default({}),
  /** Règles créées localement. */
  rules: z.array(FirewallRuleSchema).default([])
})

/** Connexion VPN configurée sur un ordinateur (Paramètres > Réseau > VPN, Add-VpnConnection). */
export const VpnConnectionSchema = z.object({
  name: z.string(),
  /** Nom ou adresse du serveur VPN. */
  server: z.string(),
  /** Connexion établie : adresse attribuée par le serveur (pool) et extrémité du tunnel. */
  connected: z
    .object({
      address: z.string(),
      serverDeviceId: z.string(),
      /** Adresse publique du serveur jointe par le client. */
      serverAddress: z.string(),
      /** Adresse du client vue par le serveur (extrémité du tunnel). */
      clientAddress: z.string(),
      user: z.string()
    })
    .nullable()
    .default(null)
})

/** Styles du papier peint (Remplir, Ajuster, Étirer, Vignette, Centrer, Étendre). */
export const WALLPAPER_STYLES = ['Fill', 'Fit', 'Stretch', 'Tile', 'Center', 'Span'] as const

/** « Papier peint du Bureau » (Configuration utilisateur > Modèles d'administration > Bureau > Bureau). */
export const WallpaperPolicySchema = z.object({
  state: PolicyStateSchema.default('NotConfigured'),
  /** Chemin local ou UNC de l'image. */
  path: z.string().default(''),
  style: z.enum(WALLPAPER_STYLES).default('Fill')
})

/**
 * « Spécifier l’emplacement intranet du service de mise à jour Microsoft »
 * (Configuration ordinateur > Modèles d'administration > Composants Windows > Windows Update).
 */
export const WuServerPolicySchema = z.object({
  state: PolicyStateSchema.default('NotConfigured'),
  /** Service intranet de détection des mises à jour (http://srv1.lab.local:8530). */
  url: z.string().default('')
})

/** « Autoriser le ciblage côté client » : groupe d'ordinateurs WSUS demandé par le poste. */
export const WuTargetGroupPolicySchema = z.object({
  state: PolicyStateSchema.default('NotConfigured'),
  group: z.string().default('')
})

/** Préférence « Lecteur mappé » (Configuration utilisateur > Préférences > Mappages de lecteurs). */
export const DriveMapSchema = z.object({
  action: z.enum(['Create', 'Replace', 'Update', 'Delete']).default('Update'),
  /** Lettre de lecteur, sans les deux-points (Z). */
  letter: z.string(),
  /** Emplacement UNC (\\SRV1\Commun). */
  path: z.string().default(''),
  /** Libellé affiché dans « Ce PC ». */
  label: z.string().default(''),
  reconnect: z.boolean().default(true)
})

/** Valeurs d'un paramètre de stratégie d'audit (Pas d'audit, Succès, Échec, les deux). */
export const AUDIT_SETTINGS = ['None', 'Success', 'Failure', 'SuccessAndFailure'] as const
export type AuditSetting = (typeof AUDIT_SETTINGS)[number]

/** Partie « Configuration ordinateur » d'une GPO (sous-ensemble simulé). */
export const GpoComputerSettingsSchema = z.object({
  /** Stratégie de mot de passe : longueur minimale (null = non défini). */
  minPasswordLength: z.number().int().min(0).max(14).nullable().default(null),
  /** Le mot de passe doit respecter des exigences de complexité (null = non défini). */
  passwordComplexity: z.boolean().nullable().default(null),
  /** Ouverture de session interactive : titre du message (null = non défini). */
  logonMessageTitle: z.string().nullable().default(null),
  /** Ouverture de session interactive : texte du message (null = non défini). */
  logonMessageText: z.string().nullable().default(null),
  /** Windows Update : serveur WSUS intranet. */
  wuServer: WuServerPolicySchema.default(() => ({ state: 'NotConfigured' as const, url: '' })),
  /** Windows Update : ciblage côté client (groupe WSUS). */
  wuTargetGroup: WuTargetGroupPolicySchema.default(() => ({ state: 'NotConfigured' as const, group: '' })),
  /** Client des services de certificats – Inscription automatique. */
  autoEnrollment: PolicyStateSchema.default('NotConfigured'),
  /** Pare-feu Windows Defender : protéger toutes les connexions réseau (profil du domaine). */
  firewallDomain: PolicyStateSchema.default('NotConfigured'),
  /** Pare-feu Windows Defender : protéger toutes les connexions réseau (profils privé et public). */
  firewallStandard: PolicyStateSchema.default('NotConfigured'),
  /** Règles de pare-feu déployées par la stratégie (s'ajoutent aux règles locales). */
  firewallRules: z.array(FirewallRuleSchema).default([]),
  /** Stratégie de verrouillage du compte : seuil (0 = jamais verrouillé), durée et réinitialisation (minutes). */
  lockoutThreshold: z.number().int().min(0).max(999).nullable().default(null),
  lockoutDuration: z.number().int().min(0).max(99999).nullable().default(null),
  lockoutReset: z.number().int().min(1).max(99999).nullable().default(null),
  /** Stratégie d'audit : événements de connexion, gestion des comptes (null = non défini). */
  auditLogon: z.enum(AUDIT_SETTINGS).nullable().default(null),
  auditAccountManagement: z.enum(AUDIT_SETTINGS).nullable().default(null)
})

/** Partie « Configuration utilisateur » d'une GPO (sous-ensemble simulé). */
export const GpoUserSettingsSchema = z.object({
  wallpaper: WallpaperPolicySchema.default(() => ({
    state: 'NotConfigured' as const,
    path: '',
    style: 'Fill' as const
  })),
  /** Interdire l'accès au Panneau de configuration et à l'application Paramètres du PC. */
  noControlPanel: PolicyStateSchema.default('NotConfigured'),
  /** Supprimer le menu Exécuter du menu Démarrer. */
  noRun: PolicyStateSchema.default('NotConfigured'),
  /** Désactiver l'accès à l'invite de commandes. */
  noCmd: PolicyStateSchema.default('NotConfigured'),
  driveMaps: z.array(DriveMapSchema).default([])
})

/** Paramètres vides (valeurs par défaut des schémas). */
const noComputerSettings = (): z.infer<typeof GpoComputerSettingsSchema> => ({
  minPasswordLength: null,
  passwordComplexity: null,
  logonMessageTitle: null,
  logonMessageText: null,
  wuServer: { state: 'NotConfigured', url: '' },
  wuTargetGroup: { state: 'NotConfigured', group: '' },
  autoEnrollment: 'NotConfigured',
  firewallDomain: 'NotConfigured',
  firewallStandard: 'NotConfigured',
  firewallRules: [],
  lockoutThreshold: null,
  lockoutDuration: null,
  lockoutReset: null,
  auditLogon: null,
  auditAccountManagement: null
})
const noUserSettings = (): z.infer<typeof GpoUserSettingsSchema> => ({
  wallpaper: { state: 'NotConfigured', path: '', style: 'Fill' },
  noControlPanel: 'NotConfigured',
  noRun: 'NotConfigured',
  noCmd: 'NotConfigured',
  driveMaps: []
})

/** GPO appliquée à un ordinateur ou à un utilisateur (résultat de stratégie). */
export const AppliedGpoSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Emplacement de la liaison (lab.local/Compta). */
  location: z.string().default('')
})

/** GPO de l'étendue non appliquée, avec la raison affichée par gpresult. */
export const FilteredGpoSchema = AppliedGpoSchema.extend({ reason: z.string() })

const policyResultBase = {
  /** Horloge du lab lors du traitement. */
  time: z.number(),
  /** Contrôleur de domaine ayant fourni les stratégies (FQDN). */
  source: z.string().default(''),
  /** Nom distinctif de l'ordinateur ou de l'utilisateur traité. */
  dn: z.string().default(''),
  /** GPO appliquées, de la plus prioritaire à la moins prioritaire. */
  applied: z.array(AppliedGpoSchema).default([]),
  filtered: z.array(FilteredGpoSchema).default([])
}

/** Stratégie d'ordinateur résultante (appliquée au démarrage ou par gpupdate). */
export const ComputerPolicyResultSchema = z.object({
  ...policyResultBase,
  /** Démarrage (bootedAt) au cours duquel la stratégie a été traitée. */
  boot: z.number().default(0),
  settings: GpoComputerSettingsSchema.default(noComputerSettings)
})

/** Stratégie utilisateur résultante (appliquée à l'ouverture de session ou par gpupdate). */
export const UserPolicyResultSchema = z.object({
  ...policyResultBase,
  /** Compte traité (LAB\jdupont). */
  account: z.string(),
  settings: GpoUserSettingsSchema.default(noUserSettings)
})

/** Stratégies de groupe appliquées sur un ordinateur. */
export const HostPolicySchema = z.object({
  computer: ComputerPolicyResultSchema.nullable().default(null),
  user: UserPolicyResultSchema.nullable().default(null),
  /** Dernier traitement automatique tenté (« démarrage|compte ») : évite de réessayer en boucle. */
  attempt: z.string().nullable().default(null)
})

/**
 * Certificat du magasin de l'ordinateur (Cert:\LocalMachine\My ou Root).
 * Chaîne de confiance : un certificat est approuvé si son émetteur est dans le magasin Root.
 */
export const CertificateSchema = z.object({
  /** Empreinte (40 caractères hexadécimaux, dérivée de state.seq). */
  thumbprint: z.string(),
  /** Sujet (CN=intranet.lab.local). */
  subject: z.string(),
  issuer: z.string(),
  /** Noms DNS couverts (extension Autre nom de l'objet). */
  dnsNames: z.array(z.string()).default([]),
  notBefore: z.number().default(0),
  notAfter: z.number().default(0),
  store: z.enum(['My', 'Root']).default('My'),
  /** Certificat d'autorité de certification. */
  ca: z.boolean().default(false),
  /** Empreinte du certificat émetteur (null = auto-signé). */
  issuerThumbprint: z.string().nullable().default(null)
})

/** Bureau à distance (Propriétés système > Utilisation à distance). */
export const RemoteDesktopSchema = z.object({
  /** « Autoriser les connexions à distance à cet ordinateur ». */
  enabled: z.boolean().default(false),
  /** Groupe local « Utilisateurs du Bureau à distance » (comptes DOMAINE\nom). */
  users: z.array(z.string()).default([])
})

/** Session Bureau à distance ouverte sur l'ordinateur (ouverture de session de type 10). */
export const RemoteSessionSchema = z.object({
  id: z.number().int(),
  /** Compte DOMAINE\nom. */
  account: z.string(),
  /** Ordinateur client. */
  from: z.string(),
  /** Programme RemoteApp (null : bureau complet). */
  app: z.string().nullable().default(null),
  at: z.number().default(0)
})

/**
 * État d'un service système modifié par l'administrateur (Stop-Service, Set-Service, net stop,
 * sc config). Un service absent de la table est démarré, en démarrage automatique (v2.7, .slab 24).
 */
export const SERVICE_STATUSES = ['Running', 'Stopped'] as const
export const SERVICE_START_TYPES = ['Automatic', 'Manual', 'Disabled'] as const
export const ServiceStateSchema = z.object({
  status: z.enum(SERVICE_STATUSES).default('Running'),
  startType: z.enum(SERVICE_START_TYPES).default('Automatic')
})
export type ServiceState = z.infer<typeof ServiceStateSchema>

/**
 * Compte d'utilisateur local (base SAM d'un serveur membre ou d'un poste, v2.7 Lot 2b, .slab 25).
 * Les comptes intégrés (Administrateur, Invité) ne sont stockés que s'ils sont modifiés.
 */
export const LocalUserSchema = z.object({
  name: z.string(),
  fullName: z.string().default(''),
  description: z.string().default(''),
  enabled: z.boolean().default(true),
  password: z.string().default(''),
  passwordNeverExpires: z.boolean().default(false),
  userMayChangePassword: z.boolean().default(true)
})
export type LocalUser = z.infer<typeof LocalUserSchema>

/**
 * Groupe local : groupe créé (New-LocalGroup) ou membres ajoutés à un groupe intégré
 * (Administrateurs, Utilisateurs, Invités). Membres : comptes locaux (nom) ou DOMAINE\nom.
 */
export const LocalGroupSchema = z.object({
  name: z.string(),
  description: z.string().default(''),
  members: z.array(z.string()).default([])
})
export type LocalGroup = z.infer<typeof LocalGroupSchema>

/** Partie « système d'exploitation » commune aux serveurs et postes clients. */
/** Système d'un ordinateur : Windows (serveur, poste) ou poste Ubuntu simulé. */
export const HOST_OS = ['windows', 'linux'] as const
export type HostOs = (typeof HOST_OS)[number]

/** Partage SMB monté sur un poste Linux (mount -t cifs). */
export const CifsMountSchema = z.object({
  /** Source au format Linux (//srv1/Compta). */
  source: z.string(),
  /** Point de montage (/mnt/compta). */
  target: z.string(),
  /** Compte utilisé pour toutes les opérations du montage (LAB\jdupont). */
  account: z.string()
})
export type CifsMount = z.infer<typeof CifsMountSchema>

export const HostSchema = z.object({
  os: z.enum(HOST_OS).default('windows'),
  workgroup: z.string().default('WORKGROUP'),
  /** Domaine AD rejoint (FQDN) ou null si groupe de travail. */
  domain: z.string().nullable().default(null),
  /** Rôles et fonctionnalités installés (noms techniques : DHCP, DNS, AD-Domain-Services…). */
  features: z.array(z.string()).default([]),
  pendingReboot: z.boolean().default(false),
  /** Nouveau nom appliqué au prochain redémarrage (Rename-Computer). */
  pendingName: z.string().nullable().default(null),
  /** Domaine rejoint, effectif au prochain redémarrage (Add-Computer) ; '' = retour en groupe de travail. */
  pendingDomain: z.string().nullable().default(null),
  /** Mot de passe du compte Administrateur local. */
  localAdminPassword: z.string().default('P@ssw0rd'),
  /** Machines vers lesquelles les sessions de cet ordinateur disposent d'un accès administrateur. */
  adminTargets: z.array(z.string()).default([]),
  /** Accès administrateur obtenu sur cet ordinateur par un scénario de cybersécurité (v2.6.1). */
  controlled: z.boolean().default(false),
  /** Session ouverte (null = écran de connexion). */
  session: HostSessionSchema.nullable().default(null),
  /** Horloge du lab au dernier démarrage (redémarrage, mise sous tension). */
  bootedAt: z.number().default(0),
  /** Stratégies de groupe appliquées (ordinateur et utilisateur de la session). */
  policy: HostPolicySchema.default(() => ({ computer: null, user: null, attempt: null })),
  /** Lecteurs réseau connectés (net use). */
  drives: z.array(MappedDriveSchema).default([]),
  /** Magasins de certificats de l'ordinateur (Personnel et Autorités de certification racines). */
  certificates: z.array(CertificateSchema).default([]),
  remoteDesktop: RemoteDesktopSchema.default(() => ({ enabled: false, users: [] })),
  remoteSessions: z.array(RemoteSessionSchema).default([]),
  firewall: FirewallSchema.default(() => FirewallSchema.parse({})),
  vpnConnections: z.array(VpnConnectionSchema).default([]),
  /** Protocole SMB 1.0 accepté par le serveur SMB (EnableSMB1Protocol). */
  smb1: z.boolean().default(false),
  eventLog: z.array(EventLogEntrySchema).default([]),
  /** Services dont l'état diffère du défaut (démarré, automatique), par nom court (DNS, LanmanServer…). */
  services: z.record(z.string(), ServiceStateSchema).default({}),
  /** Base de comptes locale (SAM) : utilisateurs et groupes locaux créés ou modifiés. */
  localUsers: z.array(LocalUserSchema).default([]),
  localGroups: z.array(LocalGroupSchema).default([]),
  /** Poste Linux : partages SMB montés. */
  mounts: z.array(CifsMountSchema).default([])
})

// ---------------------------------------------------------------------------
// Fichiers : volume C:, autorisations NTFS, partages SMB
// ---------------------------------------------------------------------------

/** Autorisations NTFS de base (onglet Sécurité). */
export const NTFS_RIGHTS = [
  'FullControl',
  'Modify',
  'ReadAndExecute',
  'ListDirectory',
  'Read',
  'Write'
] as const

/** Entrée de contrôle d'accès NTFS explicite. */
export const NtfsAceSchema = z.object({
  /** SID bien connu (S-1-…) ou identifiant d'objet de l'annuaire. */
  principal: z.string(),
  type: z.enum(['Allow', 'Deny']).default('Allow'),
  rights: z.enum(NTFS_RIGHTS)
})

/**
 * Taille maximale du contenu texte d'un fichier simulé (caractères) : de quoi tenir un script ou un
 * CSV d'exercice sans alourdir le fichier .slab (limite propre au simulateur).
 */
export const MAX_FILE_CONTENT = 65536

/** Dossier ou fichier du volume C: d'un serveur. */
export const FsNodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Dossier parent (null = racine du volume C:\). */
  parentId: z.string().nullable(),
  kind: z.enum(['folder', 'file']),
  /** Taille en octets (fichiers). */
  size: z.number().int().nonnegative().default(0),
  /**
   * Contenu texte d'un fichier (format .slab v17) : absent = fichier dont le contenu n'est pas
   * simulé (taille seule). Écrit par Set-Content, Add-Content, Out-File…
   */
  content: z.string().max(MAX_FILE_CONTENT).optional(),
  /** Autorisations explicites ; les autorisations héritées sont calculées depuis les parents. */
  acl: z.array(NtfsAceSchema).default([]),
  /** Hérite des autorisations du dossier parent. */
  inherits: z.boolean().default(true),
  owner: z.string().default(WELL_KNOWN_SIDS.administrators),
  modifiedAt: z.number().default(0),
  /** Dossier du système (non supprimable). */
  system: z.boolean().default(false)
})

/** Autorisations de partage (Contrôle total, Modifier, Lecture). */
export const SHARE_RIGHTS = ['Full', 'Change', 'Read'] as const

export const ShareAceSchema = z.object({
  principal: z.string(),
  type: z.enum(['Allow', 'Deny']).default('Allow'),
  rights: z.enum(SHARE_RIGHTS)
})

/** Dossier partagé (SMB). */
export const SmbShareSchema = z.object({
  /** Nom du partage (Compta, Compta$ pour un partage masqué). */
  name: z.string(),
  folderId: z.string(),
  description: z.string().default(''),
  /** Par défaut : Tout le monde, Lecture. */
  acl: z
    .array(ShareAceSchema)
    .default(() => [{ principal: WELL_KNOWN_SIDS.everyone, type: 'Allow' as const, rights: 'Read' as const }])
})

/** Autorisations de la racine C:\ : Administrateurs et SYSTEM (contrôle total), Utilisateurs (lecture). */
export function defaultRootAcl(): z.infer<typeof NtfsAceSchema>[] {
  return [
    { principal: WELL_KNOWN_SIDS.administrators, type: 'Allow', rights: 'FullControl' },
    { principal: WELL_KNOWN_SIDS.system, type: 'Allow', rights: 'FullControl' },
    { principal: WELL_KNOWN_SIDS.users, type: 'Allow', rights: 'ReadAndExecute' }
  ]
}

/** Dossiers présents sur un serveur neuf. */
export function defaultFsNodes(): z.infer<typeof FsNodeSchema>[] {
  const folder = (id: string, name: string, parentId: string | null) => ({
    id,
    name,
    parentId,
    kind: 'folder' as const,
    size: 0,
    acl: [],
    inherits: true,
    owner: WELL_KNOWN_SIDS.administrators,
    modifiedAt: 0,
    system: true
  })
  return [
    folder('fs-perflogs', 'PerfLogs', null),
    folder('fs-programfiles', 'Program Files', null),
    folder('fs-users', 'Users', null),
    folder('fs-users-admin', 'Administrateur', 'fs-users'),
    folder('fs-users-public', 'Public', 'fs-users'),
    folder('fs-windows', 'Windows', null)
  ]
}

/** Stockage d'un serveur : volume C: et partages. */
export const StorageSchema = z.object({
  rootAcl: z.array(NtfsAceSchema).default(defaultRootAcl),
  nodes: z.array(FsNodeSchema).default(defaultFsNodes),
  shares: z.array(SmbShareSchema).default([])
})

/**
 * Données des rôles serveur, par identifiant de rôle (`roles.dhcp`, `roles.dns`…). Chaque module
 * de rôle déclare le schéma de ses données (`RoleModule.state`) : elles sont validées à
 * l'ouverture d'un fichier .slab (`serialization/slab.ts`) et lues par des accesseurs typés.
 */
export const RoleStatesSchema = z.record(z.string(), z.unknown())

// ---------------------------------------------------------------------------
// Équipements Cisco IOS : configuration hors adressage (déjà porté par les interfaces du moteur) et
// configuration de démarrage. La running-config n'est jamais stockée en texte : `show running-config`
// la génère depuis l'état (src/engine/ios).
// ---------------------------------------------------------------------------

/** Données IOS d'une interface (description). */
/** Port-security d'un port de switch (switchport port-security). */
export const PortSecuritySchema = z.object({
  /** switchport port-security (les sous-commandes peuvent être saisies avant). */
  enabled: z.boolean().default(false),
  maximum: z.number().int().min(1).max(132).default(1),
  violation: z.enum(['shutdown', 'restrict', 'protect']).default('shutdown'),
  sticky: z.boolean().default(false),
  /** Adresses MAC configurées (switchport port-security mac-address H.H.H). */
  staticMacs: z.array(z.string()).default([]),
  /** Adresses apprises et collées dans la configuration (mac-address sticky). */
  stickyMacs: z.array(z.string()).default([]),
  /** Adresses apprises dynamiquement (perdues au redémarrage). */
  dynamicMacs: z.array(z.string()).default([]),
  violations: z.number().int().nonnegative().default(0),
  /** Dernière adresse source en violation (évite de compter deux fois la même). */
  lastViolation: z.string().nullable().default(null)
})

/** Compte local (username … secret). */
export const IosUserSchema = z.object({
  name: z.string(),
  privilege: z.number().int().min(0).max(15).default(1),
  secret: z.string()
})

/** Lignes d'accès (line con 0, line vty 0 4) : mot de passe, authentification, transport. */
export const IosLineSchema = z.object({
  type: z.enum(['console', 'vty']),
  first: z.number().int().min(0),
  last: z.number().int().min(0),
  password: z.string().nullable().default(null),
  /** none : pas d'authentification ; line : mot de passe de la ligne ; local : comptes locaux. */
  login: z.enum(['none', 'line', 'local']).default('none'),
  /** logging synchronous : messages de la console resynchronisés avec la saisie (v16). */
  loggingSync: z.boolean().default(false),
  /** Délai d'inactivité (exec-timeout minutes secondes, v21) ; null : valeur d'usine 10 0. */
  execTimeout: z
    .object({ minutes: z.number().int().min(0), seconds: z.number().int().min(0) })
    .nullable()
    .default(null),
  /** Protocoles autorisés (transport input) ; null : valeur d'usine. */
  transport: z
    .array(z.enum(['ssh', 'telnet']))
    .nullable()
    .default(null)
})

/** Groupe HSRP d'une interface (standby 1 ip …, priority, preempt). */
export const HsrpGroupSchema = z.object({
  group: z.number().int().min(0).max(255),
  ip: z.string().nullable().default(null),
  priority: z.number().int().min(0).max(255).default(100),
  preempt: z.boolean().default(false)
})

export const IosInterfaceSchema = z.object({
  description: z.string().nullable().default(null),
  /** Rôle NAT de l'interface (ip nat inside / outside). */
  nat: z.enum(['inside', 'outside']).nullable().default(null),
  /** Groupes HSRP de l'interface (standby). */
  hsrp: z.array(HsrpGroupSchema).default([]),
  /** Listes d'accès appliquées (ip access-group … in / out). */
  aclIn: z.string().nullable().default(null),
  aclOut: z.string().nullable().default(null),
  /** Port-security d'un port de switch (null : désactivée). */
  portSecurity: PortSecuritySchema.nullable().default(null),
  /** Port désactivé sur violation (err-disabled) : rétabli par shutdown puis no shutdown. */
  errDisabled: z.boolean().default(false),
  /** Port de confiance du DHCP snooping (ip dhcp snooping trust). */
  dhcpSnoopingTrust: z.boolean().default(false),
  /** Port de confiance de l'inspection ARP (ip arp inspection trust). */
  arpInspectionTrust: z.boolean().default(false),
  /** Négociation DTP désactivée (switchport nonegotiate). */
  nonegotiate: z.boolean().default(false),
  /** Port d'extrémité spanning-tree (spanning-tree portfast). */
  portfast: z.boolean().default(false),
  /** BPDU Guard du port (spanning-tree bpduguard enable) : err-disabled si un BPDU est reçu. */
  bpduGuard: z.boolean().default(false),
  /** Groupe EtherChannel du port (channel-group N mode …) ; null : aucun. */
  channelGroup: z
    .object({
      group: z.number().int().min(1).max(6),
      mode: z.enum(['active', 'passive', 'desirable', 'auto', 'on'])
    })
    .nullable()
    .default(null)
})

/** Entrée d'une liste d'accès IOS (standard : source seule ; étendue : protocole, destination, port). */
export const AclEntrySchema = z.object({
  action: z.enum(['permit', 'deny']),
  protocol: z.enum(['ip', 'icmp', 'tcp', 'udp']).default('ip'),
  /** Source : adresse et masque générique (any : 0.0.0.0 255.255.255.255). */
  src: z.string(),
  srcWildcard: z.string(),
  dst: z.string().default('0.0.0.0'),
  dstWildcard: z.string().default('255.255.255.255'),
  /** Port de destination (eq) d'une entrée TCP/UDP. */
  dstPort: z.number().int().min(0).max(65535).nullable().default(null),
  /** Journalisation des correspondances (mot-clé final « log » ou « log-input », v15). */
  log: z.enum(['log', 'log-input']).nullable().default(null),
  /** Numéro de séquence (10, 20…). */
  seq: z.number().int().positive()
})

/** Liste d'accès numérotée ou nommée. */
export const AclSchema = z.object({
  name: z.string(),
  type: z.enum(['standard', 'extended']),
  entries: z.array(AclEntrySchema).default([])
})

/** Règle NAT : dynamique (liste d'accès + interface, overload) ou statique (local ↔ global). */
export const NatRuleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('dynamic'), acl: z.string(), iface: z.string(), overload: z.boolean() }),
  z.object({ kind: z.literal('static'), local: z.string(), global: z.string() })
])

/** Traduction NAT établie par le trafic (show ip nat translations). */
export const NatTranslationSchema = z.object({
  protocol: z.enum(['icmp', 'tcp', 'udp', '---']),
  insideGlobal: z.string(),
  insideLocal: z.string(),
  outsideLocal: z.string(),
  outsideGlobal: z.string()
})

/** Instruction network d'un processus OSPF (network 10.0.0.0 0.0.0.255 area 0). */
export const OspfNetworkSchema = z.object({
  network: z.string(),
  wildcard: z.string(),
  area: z.number().int().min(0)
})

/** Processus OSPF d'un équipement IOS. */
export const OspfProcessSchema = z.object({
  process: z.number().int().min(1).max(65535),
  routerId: z.string().nullable().default(null),
  networks: z.array(OspfNetworkSchema).default([]),
  /** Interfaces passives (noms courts) ; `passive-interface default` les rend toutes passives. */
  passive: z.array(z.string()).default([]),
  passiveDefault: z.boolean().default(false),
  /** Exceptions à passive-interface default (no passive-interface Gi0/0). */
  active: z.array(z.string()).default([]),
  /** default-information originate [always] (v22) ; null : aucune route par défaut annoncée. */
  defaultOriginate: z.enum(['on', 'always']).nullable().default(null)
})

/** Processus RIP d'un équipement IOS (router rip, v22). */
export const RipProcessSchema = z.object({
  /** version 1 | 2 ; null : envoi en version 1, réception des versions 1 et 2. */
  version: z
    .union([z.literal(1), z.literal(2)])
    .nullable()
    .default(null),
  /** Réseaux de classe annoncés (network 10.0.0.0). */
  networks: z.array(z.string()).default([]),
  /** Résumé automatique aux frontières de classe (auto-summary, actif par défaut). */
  autoSummary: z.boolean().default(true),
  /** Interfaces passives (noms courts) : aucune mise à jour émise. */
  passive: z.array(z.string()).default([]),
  /** default-information originate : annonce de 0.0.0.0/0. */
  defaultOriginate: z.boolean().default(false)
})

/** Configuration IOS globale (running-config, hors interfaces du moteur). */
export const IosConfigSchema = z.object({
  /** Secret du mode privilégié (enable secret), en clair dans l'état ; affiché haché. */
  enableSecret: z.string().nullable().default(null),
  /** Bannière du jour (banner motd). */
  bannerMotd: z.string().nullable().default(null),
  /** Résolution DNS des mots inconnus (ip domain-lookup, actif par défaut). */
  domainLookup: z.boolean().default(true),
  /** Routage IP d'un switch de niveau 3 (ip routing ; toujours actif sur un routeur). */
  ipRouting: z.boolean().default(false),
  /** Processus OSPF (router ospf N). */
  ospf: z.array(OspfProcessSchema).default([]),
  /** Processus RIP (router rip, v22) ; null : non configuré. */
  rip: RipProcessSchema.nullable().default(null),
  /** Serveur DHCP IOS : pools (ip dhcp pool), une étendue par pool. */
  dhcpServer: DhcpServerSchema.nullable().default(null),
  /** Adresses exclues de tous les pools (ip dhcp excluded-address). */
  dhcpExcluded: z.array(DhcpExclusionSchema).default([]),
  /** Listes d'accès (access-list, ip access-list). */
  acls: z.array(AclSchema).default([]),
  /** Règles NAT (ip nat inside source …). */
  natRules: z.array(NatRuleSchema).default([]),
  /** Nom de domaine (ip domain-name), nécessaire aux clés RSA. */
  domainName: z.string().nullable().default(null),
  /** Clés RSA générées (crypto key generate rsa) : taille du module, null : aucune. */
  rsaBits: z.number().int().nullable().default(null),
  /** Version SSH imposée (ip ssh version 2) ; null : 1.99 (compatibilité). */
  sshVersion: z.number().int().nullable().default(null),
  /** Comptes locaux. */
  users: z.array(IosUserSchema).default([]),
  /** Lignes configurées. */
  lines: z.array(IosLineSchema).default([]),
  /** Chiffrement des mots de passe affichés (service password-encryption). */
  passwordEncryption: z.boolean().default(false),
  /** DHCP snooping activé globalement (ip dhcp snooping). */
  dhcpSnooping: z.boolean().default(false),
  /** VLAN surveillés par le DHCP snooping (ip dhcp snooping vlan). */
  dhcpSnoopingVlans: z.array(z.number().int().min(1).max(4094)).default([]),
  /** VLAN soumis à l'inspection ARP dynamique (ip arp inspection vlan). */
  arpInspectionVlans: z.array(z.number().int().min(1).max(4094)).default([]),
  /** Passerelle par défaut d'un switch sans routage IP (ip default-gateway). */
  defaultGateway: z.string().nullable().default(null),
  /** Protocole spanning-tree (spanning-tree mode pvst | rapid-pvst). */
  stpMode: z.enum(['pvst', 'rapid-pvst']).default('pvst'),
  /** Priorités de pont par VLAN (clé : numéro de VLAN ; absente : 32768). */
  stpPriorities: z.record(z.string(), z.number().int().min(0).max(61440)).default({}),
  /** Interfaces Port-channel créées (numéros de groupe). */
  portChannels: z.array(z.number().int().min(1).max(6)).default([]),
  /** Mode VTP (vtp mode) et nom de domaine (vtp domain, vide par défaut). */
  vtpMode: z.enum(['server', 'client', 'transparent']).default('server'),
  vtpDomain: z.string().default(''),
  /** Fuseau horaire (clock timezone, v21) ; null : UTC. */
  clockTimezone: z
    .object({
      zone: z.string(),
      hours: z.number().int().min(-23).max(23),
      minutes: z.number().int().min(0).max(59)
    })
    .nullable()
    .default(null),
  /** Serveurs NTP (ntp server, v21), synchronisation non simulée. */
  ntpServers: z.array(z.string()).default([]),
  /** CDP actif globalement (cdp run, actif par défaut). */
  cdpRun: z.boolean().default(true),
  /** Données IOS par interface (clé : nom court Gi0/0). */
  interfaces: z.record(z.string(), IosInterfaceSchema).default({})
})

/** Adresse MAC apprise par un switch sur un port (table d'adresses MAC, état de fonctionnement). */
export const MacEntrySchema = z.object({
  vlan: z.number().int().min(1).max(4094),
  /** Adresse au format du moteur (00-11-22-33-44-55). */
  mac: z.string(),
  /** Port d'apprentissage (nom court Fa0/1). */
  port: z.string()
})

/** Interface dans une configuration enregistrée (repérée par son nom). */
export const SnapshotInterfaceSchema = z.object({
  name: z.string(),
  enabled: z.boolean(),
  address: z.string().nullable(),
  prefixLength: z.number().int().min(0).max(32).nullable(),
  switchport: SwitchportSchema.optional(),
  /** Sous-interface : nom de la carte parente et VLAN de l'encapsulation. */
  subinterface: z
    .object({ parent: z.string(), vlan: z.number().int().min(1).max(4094).nullable() })
    .optional(),
  helperAddresses: z.array(z.string()).optional(),
  /** Interface VLAN (SVI) d'un switch. */
  svi: z.object({ vlan: z.number().int().min(1).max(4094) }).optional()
})

/** Configuration enregistrée (startup-config) : de quoi reconstruire la running-config. */
export const IosSnapshotSchema = z.object({
  hostname: z.string(),
  config: IosConfigSchema,
  interfaces: z.array(SnapshotInterfaceSchema),
  routes: z.array(StaticRouteSchema).optional()
})

/** État IOS d'un équipement : running-config (hors interfaces) et startup-config. */
export const IosStateSchema = IosConfigSchema.extend({
  /** startup-config (null : absente, « startup-config is not present »). */
  startup: IosSnapshotSchema.nullable().default(null),
  /** Traductions NAT dynamiques établies par le trafic (perdues au redémarrage). */
  natTranslations: z.array(NatTranslationSchema).default([]),
  /** Compteurs des entrées de listes d'accès (clé « liste|séquence »). */
  aclCounters: z.record(z.string(), z.number().int().nonnegative()).default({}),
  /** État HSRP par groupe (clé « Gi0/0|1 ») : Active, Standby, Listen, Init. */
  hsrpStates: z.record(z.string(), z.enum(['Active', 'Standby', 'Listen', 'Init'])).default({}),
  /** Tampon de journalisation (show logging), perdu au redémarrage. */
  syslog: z.array(z.string()).default([]),
  /** Table d'adresses MAC apprises par les trames simulées, perdue au redémarrage. */
  macTable: z.array(MacEntrySchema).default([]),
  /**
   * Horloge réglée par clock set (v21) : écart en ms avec l'horloge du lab ; null : jamais réglée
   * (heure non fiable, « * » de show clock). Conservée au redémarrage (calendrier matériel).
   */
  clockOffset: z.number().int().nullable().default(null),
  /** Compteurs de trafic par interface (show interfaces, v23), remis à zéro au redémarrage. */
  ifaceCounters: z
    .record(
      z.string(),
      z.object({
        inPackets: z.number().int().nonnegative(),
        inBytes: z.number().int().nonnegative(),
        inBroadcasts: z.number().int().nonnegative(),
        outPackets: z.number().int().nonnegative(),
        outBytes: z.number().int().nonnegative(),
        /** Horloge du lab de la dernière trame reçue / émise. */
        lastIn: z.number().nullable(),
        lastOut: z.number().nullable()
      })
    )
    .default({}),
  /** Cache ARP appris par les trames simulées (show ip arp, v23), perdu au redémarrage. */
  arpTable: z
    .array(z.object({ ip: z.string(), mac: z.string(), iface: z.string(), at: z.number() }))
    .default([]),
  /** Paquets traduits par le NAT (Hits de show ip nat statistics, v23). */
  natHits: z.number().int().nonnegative().default(0),
  /** Débogages actifs (debug ip packet, debug ip ospf events, v23), perdus au redémarrage. */
  debugs: z.array(z.enum(['ip packet', 'ip ospf events'])).default([])
})

const deviceBase = {
  id: z.string(),
  name: z.string(),
  position: PositionSchema,
  powered: z.boolean().default(true),
  interfaces: z.array(NetInterfaceSchema),
  /** Hôte Hyper-V d'une machine virtuelle ou d'un commutateur virtuel (null : équipement physique). */
  hostedBy: z.string().nullable().default(null)
}

export const ServerDeviceSchema = z.object({
  ...deviceBase,
  kind: z.literal('server'),
  host: HostSchema,
  roles: RoleStatesSchema.default({}),
  /** Volume C: et dossiers partagés. */
  storage: StorageSchema.default(() => ({ rootAcl: defaultRootAcl(), nodes: defaultFsNodes(), shares: [] }))
})
export const ClientDeviceSchema = z.object({ ...deviceBase, kind: z.literal('client'), host: HostSchema })
export const SwitchDeviceSchema = z.object({
  ...deviceBase,
  kind: z.literal('switch'),
  /** Base des VLAN (VLAN 1 « default » toujours présent). */
  vlans: z.array(VlanSchema).default(() => [{ id: 1, name: 'default' }]),
  /** Routes statiques d'un switch IOS de niveau 3 (ip route). */
  routes: z.array(StaticRouteSchema).optional(),
  /** Switch Cisco IOS (CLI IOS) ; absent : switch générique configuré par l'interface. */
  model: z.enum(IOS_SWITCH_MODELS).optional(),
  /** Configuration IOS (équipement Cisco ; absente : valeurs d'usine). */
  ios: IosStateSchema.optional()
})
export const RouterDeviceSchema = z.object({
  ...deviceBase,
  kind: z.literal('router'),
  routes: z.array(StaticRouteSchema).default([]),
  /** Routeur Cisco IOS (CLI IOS) ; absent : routeur générique configuré par l'interface. */
  model: z.enum(IOS_ROUTER_MODELS).optional(),
  /** Configuration IOS (équipement Cisco ; absente : valeurs d'usine). */
  ios: IosStateSchema.optional()
})
export const CloudDeviceSchema = z.object({ ...deviceBase, kind: z.literal('cloud') })

export const DeviceSchema = z.discriminatedUnion('kind', [
  ServerDeviceSchema,
  ClientDeviceSchema,
  SwitchDeviceSchema,
  RouterDeviceSchema,
  CloudDeviceSchema
])

/** Extrémité d'un câble : un port précis d'un équipement. */
export const LinkEndSchema = z.object({ deviceId: z.string(), ifaceId: z.string() })

export const LinkSchema = z.object({
  id: z.string(),
  a: LinkEndSchema,
  b: LinkEndSchema,
  /** Liaison virtuelle à l'intérieur d'un hôte Hyper-V (carte de VM ou vEthernet ↔ commutateur virtuel). */
  virtual: z.boolean().default(false)
})

// ---------------------------------------------------------------------------
// Active Directory
// ---------------------------------------------------------------------------

/** Liaison d'une GPO à la racine du domaine ou à une unité d'organisation (attribut gPLink). */
export const GpLinkSchema = z.object({
  gpoId: z.string(),
  /** Lien activé. */
  enabled: z.boolean().default(true),
  /** Appliqué : ne peut pas être bloqué et l'emporte sur les GPO des OU enfants. */
  enforced: z.boolean().default(false)
})

/** Unité d'organisation ou conteneur (CN=Users, CN=Computers…). */
export const AdContainerSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Conteneur parent (null = racine du domaine). */
  parentId: z.string().nullable(),
  kind: z.enum(['ou', 'container']),
  description: z.string().default(''),
  /** Protéger contre la suppression accidentelle. */
  protected: z.boolean().default(false),
  builtin: z.boolean().default(false),
  /** GPO liées (ordre de liaison : la première est prioritaire). Réservé aux OU. */
  gpLinks: z.array(GpLinkSchema).default([]),
  /** Bloquer l'héritage des GPO des conteneurs parents (sauf liaisons appliquées). */
  blockInheritance: z.boolean().default(false)
})

export const GPO_STATUSES = [
  'AllSettingsEnabled',
  'UserSettingsDisabled',
  'ComputerSettingsDisabled',
  'AllSettingsDisabled'
] as const

/** SID bien connu « Utilisateurs authentifiés » (filtrage de sécurité par défaut). */
export const AUTHENTICATED_USERS_SID = WELL_KNOWN_SIDS.authenticatedUsers

/**
 * Valeur de registre d'une stratégie (Set-GPRegistryValue, v2.7 Lot 2b, .slab 25) : HKLM dans la
 * Configuration ordinateur, HKCU dans la Configuration utilisateur. `Delete` : valeur supprimée sur
 * le client (paramètre -Disable).
 */
export const GP_REGISTRY_TYPES = [
  'String',
  'ExpandString',
  'Binary',
  'DWord',
  'MultiString',
  'QWord'
] as const
export const GpRegistryValueSchema = z.object({
  hive: z.enum(['HKLM', 'HKCU']),
  /** Chemin relatif à la ruche (Software\Policies\Microsoft\…). */
  key: z.string(),
  valueName: z.string(),
  type: z.enum(GP_REGISTRY_TYPES).default('String'),
  value: z.union([z.string(), z.number(), z.array(z.string())]).default(''),
  state: z.enum(['Set', 'Delete']).default('Set')
})
export type GpRegistryValue = z.infer<typeof GpRegistryValueSchema>

/** Objet de stratégie de groupe (GPO). */
export const GpoSchema = z.object({
  /** GUID de l'objet ({31B2F340-016D-11D2-945F-00C04FB984F9}). */
  id: z.string(),
  name: z.string(),
  comment: z.string().default(''),
  status: z.enum(GPO_STATUSES).default('AllSettingsEnabled'),
  /**
   * Filtrage de sécurité (droit « Appliquer la stratégie de groupe ») : SID bien connu
   * des Utilisateurs authentifiés ou identifiants d'objets de l'annuaire.
   */
  securityFilter: z.array(z.string()).default(() => [AUTHENTICATED_USERS_SID]),
  createdAt: z.number().default(0),
  modifiedAt: z.number().default(0),
  /** Versions incrémentées à chaque modification (0 = partie vide). */
  userVersion: z.number().int().nonnegative().default(0),
  computerVersion: z.number().int().nonnegative().default(0),
  computer: GpoComputerSettingsSchema.default(noComputerSettings),
  user: GpoUserSettingsSchema.default(noUserSettings),
  /** Valeurs de registre sans paramètre simulé correspondant (Set-GPRegistryValue). */
  registry: z.array(GpRegistryValueSchema).default([])
})

export const AdUserSchema = z.object({
  id: z.string(),
  /** Nom d'ouverture de session (pré-Windows 2000). */
  sam: z.string(),
  /** Nom complet (CN). */
  name: z.string(),
  givenName: z.string().default(''),
  surname: z.string().default(''),
  upn: z.string().default(''),
  parentId: z.string(),
  password: z.string().default(''),
  enabled: z.boolean().default(true),
  mustChangePassword: z.boolean().default(false),
  description: z.string().default(''),
  builtin: z.boolean().default(false),
  /** Le mot de passe n'expire jamais (PasswordNeverExpires). */
  passwordNeverExpires: z.boolean().default(false),
  /** Horloge de la création du compte (whenCreated). */
  whenCreated: z.number().default(0),
  /** Horloge de la dernière ouverture de session (lastLogonTimestamp) ; null : jamais. */
  lastLogon: z.number().nullable().default(null),
  /** Mots de passe erronés consécutifs (badPwdCount) et horloge du dernier. */
  badPwdCount: z.number().int().default(0),
  lastBadPassword: z.number().nullable().default(null),
  /** Compte verrouillé (lockoutTime) ; null : non verrouillé. */
  lockoutTime: z.number().nullable().default(null),
  /** Noms de principal de service (servicePrincipalName) : non vide = compte de service. */
  spns: z.array(z.string()).default([]),
  /** Horloge du dernier changement de mot de passe (pwdLastSet). */
  passwordLastSet: z.number().default(0),
  /** Compte marqué compromis par un scénario de cybersécurité (état simulé, v2.6.1). */
  compromised: z.boolean().default(false)
})

export const AdGroupSchema = z.object({
  id: z.string(),
  sam: z.string(),
  name: z.string(),
  parentId: z.string(),
  scope: z.enum(['DomainLocal', 'Global', 'Universal']),
  category: z.enum(['Security', 'Distribution']).default('Security'),
  /** Identifiants des membres (utilisateurs, groupes, ordinateurs). */
  members: z.array(z.string()).default([]),
  description: z.string().default(''),
  builtin: z.boolean().default(false)
})

export const AdComputerSchema = z.object({
  id: z.string(),
  name: z.string(),
  parentId: z.string(),
  /** Équipement du lab correspondant (null si l'ordinateur n'existe plus). */
  deviceId: z.string().nullable(),
  enabled: z.boolean().default(true),
  dnsHostName: z.string().default('')
})

/** Objet supprimé conservé par la Corbeille Active Directory (attributs et appartenances). */
export const DeletedAdObjectSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('user'),
    obj: AdUserSchema,
    memberOf: z.array(z.string()).default([]),
    deletedAt: z.number().default(0)
  }),
  z.object({
    kind: z.literal('group'),
    obj: AdGroupSchema,
    memberOf: z.array(z.string()).default([]),
    deletedAt: z.number().default(0)
  }),
  z.object({
    kind: z.literal('computer'),
    obj: AdComputerSchema,
    memberOf: z.array(z.string()).default([]),
    deletedAt: z.number().default(0)
  }),
  z.object({
    kind: z.literal('container'),
    obj: AdContainerSchema,
    memberOf: z.array(z.string()).default([]),
    deletedAt: z.number().default(0)
  })
])

/** Site créé avec la forêt. */
export const DEFAULT_AD_SITE = 'Default-First-Site-Name'
/** Lien de sites créé avec la forêt (transport IP). */
export const DEFAULT_AD_SITE_LINK = 'DEFAULTIPSITELINK'

/** Site Active Directory (Sites et services Active Directory). */
export const AdSiteSchema = z.object({
  name: z.string(),
  description: z.string().default('')
})

/** Sous-réseau associé à un site (192.168.20.0/24). */
export const AdSubnetSchema = z.object({
  prefix: z.string(),
  site: z.string(),
  description: z.string().default('')
})

/** Lien de sites (transport IP) : coût et intervalle de réplication en minutes. */
export const AdSiteLinkSchema = z.object({
  name: z.string(),
  sites: z.array(z.string()).default([]),
  cost: z.number().int().default(100),
  interval: z.number().int().default(180)
})

/** Rôles de maître d'opérations (FSMO), noms de Move-ADDirectoryServerOperationMasterRole. */
export const FSMO_ROLES = [
  'SchemaMaster',
  'DomainNamingMaster',
  'PDCEmulator',
  'RIDMaster',
  'InfrastructureMaster'
] as const

/** État d'une connexion de réplication entrante (contrôleur ← partenaire). */
export const ReplicationStatusSchema = z.object({
  dcId: z.string(),
  partnerId: z.string(),
  lastAttempt: z.number().nullable().default(null),
  lastSuccess: z.number().nullable().default(null),
  /** 0 : succès ; sinon code d'erreur Windows (1722 : serveur RPC indisponible). */
  result: z.number().int().default(0),
  failures: z.number().int().default(0)
})

export const ReplicationStateSchema = z.object({
  status: z.array(ReplicationStatusSchema).default([]),
  /**
   * Contenu des zones DNS intégrées à AD lors de la dernière réplication réussie de chaque
   * contrôleur (contrôleur → zone → clés « nom|type|données ») : base de la fusion multimaître.
   */
  dnsBase: z.record(z.string(), z.record(z.string(), z.array(z.string()))).default({}),
  /** Horloge de la dernière réplication réussie de chaque contrôleur (base la plus récente). */
  syncedAt: z.record(z.string(), z.number()).default({})
})

export const DomainSchema = z.object({
  /** Nom DNS du domaine (lab.local). */
  name: z.string(),
  /** Nom NetBIOS (LAB). */
  netbios: z.string(),
  /** Contrôleurs de domaine (identifiants d'équipements). */
  controllers: z.array(z.string()).default([]),
  containers: z.array(AdContainerSchema).default([]),
  users: z.array(AdUserSchema).default([]),
  groups: z.array(AdGroupSchema).default([]),
  computers: z.array(AdComputerSchema).default([]),
  /** Objets de stratégie de groupe du domaine. */
  gpos: z.array(GpoSchema).default([]),
  /** GPO liées à la racine du domaine (ordre de liaison). */
  gpLinks: z.array(GpLinkSchema).default([]),
  /** Corbeille Active Directory activée (irréversible). */
  recycleBin: z.boolean().default(false),
  /** Objets supprimés restaurables (Corbeille activée). */
  deletedObjects: z.array(DeletedAdObjectSchema).default([]),
  sites: z.array(AdSiteSchema).default(() => [{ name: DEFAULT_AD_SITE, description: '' }]),
  subnets: z.array(AdSubnetSchema).default([]),
  siteLinks: z
    .array(AdSiteLinkSchema)
    .default(() => [{ name: DEFAULT_AD_SITE_LINK, sites: [DEFAULT_AD_SITE], cost: 100, interval: 180 }]),
  /** Site de chaque contrôleur (identifiant d'équipement → site ; absent : premier site). */
  dcSites: z.record(z.string(), z.string()).default({}),
  /** Détenteur de chaque rôle FSMO (rôle → identifiant d'équipement ; absent : premier contrôleur). */
  fsmo: z.record(z.string(), z.string()).default({}),
  replication: ReplicationStateSchema.default(() => ({ status: [], dnsBase: {}, syncedAt: {} }))
})

/** État complet d'un lab : source de vérité unique de l'application. */
/** Paramètres de durcissement des contre-mesures du mode Red/Blue. */
export const CyberHardeningSchema = z.object({
  /** Seuil de verrouillage de compte appliqué par la contre-mesure. */
  lockoutThreshold: z.number().int().min(1).max(999).default(3),
  /** Durée du verrouillage et délai de réinitialisation du compteur (minutes). */
  lockoutMinutes: z.number().int().min(1).max(99999).default(30)
})

/** Réglages d'une partie Red/Blue. */
export const CyberGameSchema = z.object({
  /** Nombre maximal de tours (un tour = un coup de chaque camp). */
  maxTurns: z.number().int().min(1).max(50).default(8),
  /** Minuteur de la partie en secondes ; null : sans minuteur. */
  timerSeconds: z.number().int().min(10).nullable().default(null),
  /** Nombre de contre-mesures que le camp Blue peut appliquer pendant la partie. */
  blueBudget: z.number().int().min(0).max(20).default(3),
  /** Camp imposé à l'IA (le joueur prend l'autre) ; null : le joueur choisit. */
  aiSide: z.enum(['red', 'blue']).nullable().default(null)
})

/** Paramètres des scénarios de cybersécurité, fournis par le lab (v2.6.1). */
export const CyberConfigSchema = z.object({
  /** sAMAccountName du compte visé par l'authentification répétée ; null : aucun. */
  targetAccount: z.string().nullable().default(null),
  /** Nombre de tentatives de la série d'authentifications. */
  attempts: z.number().int().min(1).max(100).default(5),
  /** Âge (jours) du mot de passe d'un compte de service au-delà duquel il est jugé négligé. */
  serviceMaxAgeDays: z.number().int().min(1).default(90),
  /** Usurpation ARP : noms des trois hôtes du segment (agresseur et deux victimes). */
  arpSpoof: z
    .object({ attacker: z.string(), victimA: z.string(), victimB: z.string() })
    .nullable()
    .default(null),
  /** Saut de VLAN : nom de l'hôte et VLAN visé. */
  vlanHop: z.object({ attacker: z.string(), toVlan: VlanIdSchema }).nullable().default(null),
  /** Scénarios activés dans ce lab (identifiants) ; null : tous les scénarios enregistrés. */
  scenarios: z.array(z.string()).nullable().default(null),
  /** Paramètres des contre-mesures de durcissement (stratégie de verrouillage appliquée par Blue). */
  hardening: CyberHardeningSchema.default(() => CyberHardeningSchema.parse({})),
  /** Mode Red/Blue : réglages de la partie, fournis par le lab. */
  game: CyberGameSchema.default(() => CyberGameSchema.parse({})),
  /** Trafic marqué comme intercepté (identifiants d'équipements) : A ↔ B passe par `by`. */
  intercepts: z.array(z.object({ a: z.string(), b: z.string(), by: z.string() })).default([])
})

export const LabStateSchema = z.object({
  devices: z.record(z.string(), DeviceSchema),
  links: z.record(z.string(), LinkSchema),
  /** Compteur servant à générer identifiants et adresses MAC de façon déterministe. */
  seq: z.number().int().nonnegative(),
  /** Horloge simulée (millisecondes). */
  clock: z.number().nonnegative().default(0),
  /** Domaines Active Directory (clé : nom DNS du domaine). */
  domains: z.record(z.string(), DomainSchema).default({}),
  /** Paramètres des scénarios de cybersécurité. */
  cyber: CyberConfigSchema.default(() => CyberConfigSchema.parse({}))
})

export const DeviceKindSchema = z.enum(DEVICE_KINDS)

export type CyberConfig = z.infer<typeof CyberConfigSchema>
export type Position = z.infer<typeof PositionSchema>
export type DhcpClientLease = z.infer<typeof DhcpClientLeaseSchema>
export type NetInterface = z.infer<typeof NetInterfaceSchema>
export type Switchport = z.infer<typeof SwitchportSchema>
export type FirewallRule = z.infer<typeof FirewallRuleSchema>
export type VpnConnection = z.infer<typeof VpnConnectionSchema>
export type AdSite = z.infer<typeof AdSiteSchema>
export type AdSubnet = z.infer<typeof AdSubnetSchema>
export type AdSiteLink = z.infer<typeof AdSiteLinkSchema>
export type FsmoRole = (typeof FSMO_ROLES)[number]
export type ReplicationStatus = z.infer<typeof ReplicationStatusSchema>
export type FirewallProfileName = (typeof FIREWALL_PROFILES)[number]
export type FirewallState = z.infer<typeof FirewallSchema>
export type Subinterface = z.infer<typeof SubinterfaceSchema>
export type Vlan = z.infer<typeof VlanSchema>
export type EventLogEntry = z.infer<typeof EventLogEntrySchema>
export type StaticRoute = z.infer<typeof StaticRouteSchema>
export type Host = z.infer<typeof HostSchema>
export type HostSession = z.infer<typeof HostSessionSchema>
export type ServerDevice = z.infer<typeof ServerDeviceSchema>
export type ClientDevice = z.infer<typeof ClientDeviceSchema>
export type SwitchDevice = z.infer<typeof SwitchDeviceSchema>
export type IosConfig = z.infer<typeof IosConfigSchema>
export type OspfProcess = z.infer<typeof OspfProcessSchema>
export type RipProcess = z.infer<typeof RipProcessSchema>
export type IosAcl = z.infer<typeof AclSchema>
export type IosAclEntry = z.infer<typeof AclEntrySchema>
export type NatRule = z.infer<typeof NatRuleSchema>
export type NatTranslation = z.infer<typeof NatTranslationSchema>
export type IosSnapshot = z.infer<typeof IosSnapshotSchema>
export type IosState = z.infer<typeof IosStateSchema>
export type RouterDevice = z.infer<typeof RouterDeviceSchema>
export type CloudDevice = z.infer<typeof CloudDeviceSchema>
export type Device = z.infer<typeof DeviceSchema>
export type AdContainer = z.infer<typeof AdContainerSchema>
export type AdUser = z.infer<typeof AdUserSchema>
export type AdGroup = z.infer<typeof AdGroupSchema>
export type AdComputer = z.infer<typeof AdComputerSchema>
export type Domain = z.infer<typeof DomainSchema>
export type PolicyState = z.infer<typeof PolicyStateSchema>
export type WallpaperStyle = (typeof WALLPAPER_STYLES)[number]
export type WallpaperPolicy = z.infer<typeof WallpaperPolicySchema>
export type DriveMap = z.infer<typeof DriveMapSchema>
export type GpoComputerSettings = z.infer<typeof GpoComputerSettingsSchema>
export type GpoUserSettings = z.infer<typeof GpoUserSettingsSchema>
export type GpLink = z.infer<typeof GpLinkSchema>
export type GpoStatus = (typeof GPO_STATUSES)[number]
export type Gpo = z.infer<typeof GpoSchema>
export type AppliedGpo = z.infer<typeof AppliedGpoSchema>
export type FilteredGpo = z.infer<typeof FilteredGpoSchema>
export type ComputerPolicyResult = z.infer<typeof ComputerPolicyResultSchema>
export type UserPolicyResult = z.infer<typeof UserPolicyResultSchema>
export type HostPolicy = z.infer<typeof HostPolicySchema>
export type MappedDrive = z.infer<typeof MappedDriveSchema>
export type Certificate = z.infer<typeof CertificateSchema>
export type DeletedAdObject = z.infer<typeof DeletedAdObjectSchema>
export type RemoteSession = z.infer<typeof RemoteSessionSchema>
export type NtfsRight = (typeof NTFS_RIGHTS)[number]
export type NtfsAce = z.infer<typeof NtfsAceSchema>
export type FsNode = z.infer<typeof FsNodeSchema>
export type ShareRight = (typeof SHARE_RIGHTS)[number]
export type ShareAce = z.infer<typeof ShareAceSchema>
export type SmbShare = z.infer<typeof SmbShareSchema>
export type Storage = z.infer<typeof StorageSchema>
export type HostDevice = ServerDevice | ClientDevice
export type LinkEnd = z.infer<typeof LinkEndSchema>
export type Link = z.infer<typeof LinkSchema>
export type RoleStates = z.infer<typeof RoleStatesSchema>
export type LabState = z.infer<typeof LabStateSchema>
