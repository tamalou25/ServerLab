/**
 * État d'un pare-feu pfSense CE 2.7 simulé (équipement `kind: 'firewall'`, v2.10, format .slab 28).
 * Fichier du modèle (et non de la console) : le schéma .slab n'importe rien du shell.
 *
 * Le modèle prévoit déjà les données des issues suivantes de la v2.10 (règles #243, NAT #244, services #245,
 * interface web #246, console #247) ; seul l'état de base (interfaces logiques) est exploité par #242.
 * Tous les champs au-delà de `assignments` sont facultatifs ou ont une valeur par défaut vide, pour qu'un
 * pare-feu neuf reste compact et que les issues suivantes n'exigent pas de nouvelle migration.
 *
 * Vocabulaire : onglets Interfaces > Assignments (WAN, LAN, OPTx), Firewall > Rules, NAT, Aliases, Services >
 * DHCP Server / DNS Resolver (documentation Netgate, docs.netgate.com/pfsense).
 */
import { z } from 'zod'

/** Version de pfSense CE simulée. */
export const PFSENSE_VERSION = '2.7'

/** Identifiants logiques des interfaces : WAN, LAN, puis OPT1 (DMZ), OPT2… */
export const PF_IFACE_KEYS = ['wan', 'lan', 'opt1'] as const
export type PfIfaceKey = (typeof PF_IFACE_KEYS)[number]

/** Nom d'une interface logique tel qu'affiché par pfSense avant renommage (OPT1 est ici renommée DMZ). */
export const PF_IFACE_LABEL: Record<PfIfaceKey, string> = {
  wan: 'WAN',
  lan: 'LAN',
  opt1: 'OPT1'
}

/** Description donnée à l'interface OPT1 de la topologie (pfSense permet de renommer toute interface). */
export const PF_DMZ_DESCR = 'DMZ'

/** Adresse LAN d'un pare-feu neuf (à vérifier : docs/fidelite.md, P-01). */
export const PF_LAN_ADDRESS = '192.168.1.1'
export const PF_LAN_PREFIX = 24

/** Cartes physiques du pare-feu, dans l'ordre WAN, LAN, OPT1 (noms FreeBSD de l'équipement virtualisé). */
export const PF_PORTS = ['em0', 'em1', 'em2'] as const

/** Affectation d'une interface logique à une carte (Interfaces > Assignments). */
export const PfAssignmentSchema = z.object({
  key: z.enum(PF_IFACE_KEYS),
  /** Carte physique affectée (NetInterface.id du pare-feu) ; null : interface non affectée. */
  ifaceId: z.string().nullable(),
  /** Description (renommage de l'interface : WAN, LAN, DMZ…). */
  descr: z.string(),
  /** Case « Enable interface ». */
  enabled: z.boolean().default(true),
  /** Block private networks and loopback addresses (WAN par défaut). */
  blockPrivate: z.boolean().default(false),
  /** Block bogon networks (WAN par défaut). */
  blockBogons: z.boolean().default(false)
})
export type PfAssignment = z.infer<typeof PfAssignmentSchema>

// --- Règles (Firewall > Rules, #243) ---------------------------------------------------------------------

export const PF_RULE_ACTIONS = ['pass', 'block', 'reject'] as const
export const PF_PROTOCOLS = ['any', 'tcp', 'udp', 'tcp/udp', 'icmp'] as const

/** Source ou destination d'une règle : toutes adresses, adresse, réseau, alias ou réseau d'une interface. */
export const PfEndpointSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('any') }),
  z.object({ type: z.literal('address'), address: z.string() }),
  z.object({
    type: z.literal('network'),
    address: z.string(),
    prefixLength: z.number().int().min(0).max(32)
  }),
  z.object({ type: z.literal('alias'), name: z.string() }),
  /** « LAN net », « WAN address »… : réseau ou adresse d'une interface logique. */
  z.object({
    type: z.literal('interface'),
    key: z.enum(PF_IFACE_KEYS),
    what: z.enum(['net', 'address'])
  })
])
export type PfEndpoint = z.infer<typeof PfEndpointSchema>

/** Plage de ports (début = fin pour un port unique) ; null : tous les ports. */
export const PfPortRangeSchema = z
  .object({ from: z.number().int().min(1).max(65535), to: z.number().int().min(1).max(65535) })
  .nullable()
export type PfPortRange = z.infer<typeof PfPortRangeSchema>

/** Règle évaluée dans l'ordre sur l'interface d'entrée ; la première qui correspond s'applique. */
export const PfRuleSchema = z.object({
  id: z.string(),
  /** Interface sur laquelle la règle s'applique (trafic entrant). */
  iface: z.enum(PF_IFACE_KEYS),
  action: z.enum(PF_RULE_ACTIONS),
  disabled: z.boolean().default(false),
  protocol: z.enum(PF_PROTOCOLS).default('any'),
  source: PfEndpointSchema.default({ type: 'any' }),
  sourcePort: PfPortRangeSchema.default(null),
  destination: PfEndpointSchema.default({ type: 'any' }),
  destinationPort: PfPortRangeSchema.default(null),
  /** Journaliser les paquets qui correspondent (Log packets that are handled by this rule). */
  log: z.boolean().default(false),
  descr: z.string().default('')
})
export type PfRule = z.infer<typeof PfRuleSchema>

/** Alias (Firewall > Aliases) : hôtes, réseaux ou ports nommés. */
export const PfAliasSchema = z.object({
  name: z.string(),
  type: z.enum(['host', 'network', 'port']),
  /** Valeurs : adresses, CIDR ou numéros de ports selon le type. */
  values: z.array(z.string()),
  descr: z.string().default('')
})
export type PfAlias = z.infer<typeof PfAliasSchema>

// --- NAT (Firewall > NAT, #244) ------------------------------------------------------------------------

export const PF_NAT_MODES = ['automatic', 'hybrid', 'manual', 'disabled'] as const

export const PfOutboundNatSchema = z.object({
  id: z.string(),
  /** Interface de sortie (en pratique le WAN). */
  iface: z.enum(PF_IFACE_KEYS),
  source: PfEndpointSchema,
  destination: PfEndpointSchema.default({ type: 'any' }),
  /** Adresse de traduction : null = adresse de l'interface (Interface address). */
  translation: z.string().nullable().default(null),
  disabled: z.boolean().default(false),
  descr: z.string().default('')
})

export const PfPortForwardSchema = z.object({
  id: z.string(),
  /** Interface d'arrivée (en pratique le WAN). */
  iface: z.enum(PF_IFACE_KEYS),
  protocol: z.enum(['tcp', 'udp', 'tcp/udp']),
  /** Destination du paquet entrant (par défaut : adresse du WAN). */
  destination: PfEndpointSchema.default({ type: 'interface', key: 'wan', what: 'address' }),
  destinationPort: PfPortRangeSchema,
  /** Adresse et port de la machine interne (NAT IP / NAT Port). */
  targetAddress: z.string(),
  targetPort: z.number().int().min(1).max(65535).nullable().default(null),
  /** Crée la règle de filtrage associée (Filter rule association : Add associated filter rule). */
  associatedRule: z.boolean().default(true),
  disabled: z.boolean().default(false),
  descr: z.string().default('')
})

export const PfNatSchema = z.object({
  /** Mode de NAT sortant : automatique par défaut. */
  outboundMode: z.enum(PF_NAT_MODES).default('automatic'),
  outbound: z.array(PfOutboundNatSchema).default([]),
  portForwards: z.array(PfPortForwardSchema).default([])
})

// --- Services (#245) -------------------------------------------------------------------------------------

/** Serveur DHCP d'une interface (Services > DHCP Server). */
export const PfDhcpSchema = z.object({
  enabled: z.boolean().default(false),
  rangeFrom: z.string().nullable().default(null),
  rangeTo: z.string().nullable().default(null),
  dnsServers: z.array(z.string()).default([]),
  gateway: z.string().nullable().default(null),
  leaseSeconds: z.number().int().positive().default(7200),
  /** Baux accordés : adresse, MAC, date d'expiration (horloge du lab, ms). */
  leases: z
    .array(
      z.object({ ip: z.string(), mac: z.string(), hostname: z.string().default(''), expires: z.number() })
    )
    .default([])
})

export const PfGatewaySchema = z.object({
  name: z.string(),
  iface: z.enum(PF_IFACE_KEYS),
  address: z.string(),
  isDefault: z.boolean().default(false)
})

export const PfStaticRouteSchema = z.object({
  network: z.string(),
  prefixLength: z.number().int().min(0).max(32),
  /** Nom de la passerelle (Firewall gateways). */
  gateway: z.string(),
  disabled: z.boolean().default(false)
})

export const PfDnsResolverSchema = z.object({
  enabled: z.boolean().default(true),
  /** Mode résolveur (racines) ou, si true, redirection vers les serveurs DNS généraux. */
  forwarding: z.boolean().default(false),
  /** Remplacements d'hôtes (Host Overrides). */
  hostOverrides: z.array(z.object({ host: z.string(), domain: z.string(), address: z.string() })).default([])
})

// --- Journal et table d'états (#243, #246, #247) ---------------------------------------------------------

/** Entrée du journal du pare-feu (Status > System Logs > Firewall). */
export const PfLogEntrySchema = z.object({
  /** Horloge du lab (ms). */
  at: z.number(),
  ruleId: z.string().nullable(),
  action: z.enum(PF_RULE_ACTIONS),
  iface: z.enum(PF_IFACE_KEYS),
  protocol: z.string(),
  src: z.string(),
  dst: z.string()
})

/** Entrée de la table d'états (Diagnostics > States) : autorise les réponses d'une connexion acceptée. */
export const PfStateEntrySchema = z.object({
  iface: z.enum(PF_IFACE_KEYS),
  protocol: z.string(),
  src: z.string(),
  dst: z.string(),
  createdAt: z.number()
})

/** Plafond du journal (les plus anciennes entrées sont éliminées) : borne la taille d'un fichier .slab. */
export const PF_LOG_LIMIT = 500

export const PfStateSchema = z.object({
  /** Version de pfSense CE simulée. */
  version: z.string().default(PFSENSE_VERSION),
  /** System > General Setup : nom d'hôte et domaine. */
  hostname: z.string(),
  domain: z.string().default(''),
  assignments: z.array(PfAssignmentSchema),
  rules: z.array(PfRuleSchema).default([]),
  aliases: z.array(PfAliasSchema).default([]),
  nat: PfNatSchema.default(() => ({ outboundMode: 'automatic' as const, outbound: [], portForwards: [] })),
  /** Serveur DHCP par interface logique. */
  dhcp: z.partialRecord(z.enum(PF_IFACE_KEYS), PfDhcpSchema).default({}),
  dnsResolver: PfDnsResolverSchema.default(() => ({
    enabled: true,
    forwarding: false,
    hostOverrides: []
  })),
  /** Serveurs DNS généraux (System > General Setup). */
  dnsServers: z.array(z.string()).default([]),
  gateways: z.array(PfGatewaySchema).default([]),
  staticRoutes: z.array(PfStaticRouteSchema).default([]),
  log: z.array(PfLogEntrySchema).default([]),
  states: z.array(PfStateEntrySchema).default([])
})
export type PfState = z.infer<typeof PfStateSchema>
