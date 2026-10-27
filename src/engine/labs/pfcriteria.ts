/**
 * Critères de lab du pare-feu pfSense (v2.10, #248) : règles, redirections de port, NAT sortant,
 * alias, DHCP, résolveur et joignabilité. Chaque évaluateur lit l'état simulé : la configuration par les
 * mêmes données que l'interface web, la joignabilité par la sonde `pfProbe` (le moteur de paquets,
 * filtrage et NAT compris, comme `ping` ou `curl` depuis le poste). Les critères jugent le résultat
 * plutôt que le chemin : plusieurs configurations valides sont acceptées.
 */
import { z } from 'zod'
import { PF_IFACE_KEYS, PF_NAT_MODES, type PfEndpoint, type PfState } from '../model/firewall'
import type { Device, LabState } from '../model/schema'
import { describeEndpoint, endpointMatches } from '../net/pf'
import { pfProbe } from '../net/pf-probe'
import { defineCriterion, type CriterionType } from '../roles/types'
import { byName, sameName, targetIp } from './lookup'

/** Pare-feu pfSense d'un lab, par nom. */
function pfOf(state: LabState, name: string): (Device & { kind: 'firewall' }) | undefined {
  const d = byName(state, name)
  return d?.kind === 'firewall' ? d : undefined
}

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase()

/** Le point de terminaison correspond-il au texte attendu (« any », « LAN net », « 172.16.0.10 », alias) ? */
const endpointIs = (pf: PfState, endpoint: PfEndpoint, text: string): boolean =>
  same(describeEndpoint(pf, endpoint), text)

const portIn = (range: { from: number; to: number } | null, port: number): boolean =>
  range !== null && range.from <= port && port <= range.to

const IFACE = z.enum(PF_IFACE_KEYS)

export const PF_CRITERIA: CriterionType[] = [
  defineCriterion(
    z.object({
      type: z.literal('pfReachable'),
      /** Machine qui émet. */
      from: z.string(),
      /** Machine ou adresse visée (pour une redirection : l'adresse WAN du pare-feu). */
      to: z.string(),
      protocol: z.enum(['icmp', 'tcp', 'udp']).default('icmp'),
      /** Port de destination (TCP / UDP). */
      port: z.number().int().min(1).max(65535).optional(),
      /** false : l'échange doit être bloqué (isolement, filtrage). */
      success: z.boolean().default(true)
    }),
    (state, check) => {
      const from = byName(state, check.from)
      const ip = targetIp(state, check.to)
      if (!from || !ip) return false
      const protocol = check.protocol ?? 'icmp'
      if (protocol !== 'icmp' && check.port === undefined) return false
      return pfProbe(state, from.id, ip, protocol, check.port) === (check.success !== false)
    },
    'Joignabilité à travers le pare-feu (ping, TCP, UDP)'
  ),
  defineCriterion(
    z.object({
      type: z.literal('pfRuleExists'),
      device: z.string(),
      iface: IFACE,
      action: z.enum(['pass', 'block', 'reject']).optional(),
      protocol: z.enum(['any', 'tcp', 'udp', 'tcp/udp', 'icmp']).optional(),
      /** Port de destination couvert par la règle. */
      port: z.number().int().min(1).max(65535).optional(),
      /** Source et destination comme dans la liste des règles : « any », « LAN net », « 172.16.0.10 », alias. */
      source: z.string().optional(),
      destination: z.string().optional(),
      /** false : aucune règle active de ce type ne doit exister. */
      enabled: z.boolean().default(true)
    }),
    (state, check) => {
      const fw = pfOf(state, check.device)
      if (!fw) return false
      const found = fw.pf.rules.some(
        (r) =>
          !r.disabled &&
          r.iface === check.iface &&
          (check.action === undefined || r.action === check.action) &&
          (check.protocol === undefined || r.protocol === check.protocol) &&
          (check.port === undefined || portIn(r.destinationPort, check.port)) &&
          (check.source === undefined || endpointIs(fw.pf, r.source, check.source)) &&
          (check.destination === undefined || endpointIs(fw.pf, r.destination, check.destination))
      )
      return found === (check.enabled !== false)
    },
    'Règle de filtrage du pare-feu'
  ),
  defineCriterion(
    z.object({
      type: z.literal('pfPortForward'),
      device: z.string(),
      /** Port de destination du paquet entrant (côté WAN). */
      port: z.number().int().min(1).max(65535),
      protocol: z.enum(['tcp', 'udp', 'tcp/udp']).default('tcp'),
      /** Adresse de la machine interne. */
      target: z.string(),
      /** Port de la machine interne (par défaut : le même que le port entrant). */
      targetPort: z.number().int().min(1).max(65535).optional(),
      /** La règle de filtrage associée doit exister. */
      associatedRule: z.boolean().optional()
    }),
    (state, check) => {
      const fw = pfOf(state, check.device)
      if (!fw) return false
      return fw.pf.nat.portForwards.some(
        (f) =>
          !f.disabled &&
          f.targetAddress === check.target &&
          portIn(f.destinationPort, check.port) &&
          (f.protocol === (check.protocol ?? 'tcp') || f.protocol === 'tcp/udp') &&
          (f.targetPort ?? f.destinationPort?.from) === (check.targetPort ?? check.port) &&
          (check.associatedRule === undefined ||
            check.associatedRule === fw.pf.rules.some((r) => r.id === f.ruleId && !r.disabled))
      )
    },
    'Redirection de port (NAT) du pare-feu'
  ),
  defineCriterion(
    z.object({ type: z.literal('pfNatMode'), device: z.string(), mode: z.enum(PF_NAT_MODES) }),
    (state, check) => pfOf(state, check.device)?.pf.nat.outboundMode === check.mode,
    'Mode de NAT sortant du pare-feu'
  ),
  defineCriterion(
    z.object({
      type: z.literal('pfOutboundNat'),
      device: z.string(),
      /** Adresse d'une machine que la règle manuelle doit traduire (sa source la couvre). */
      covers: z.string(),
      /** Adresse de traduction attendue (absent : toute adresse, y compris celle de l'interface). */
      translation: z.string().optional()
    }),
    (state, check) => {
      const fw = pfOf(state, check.device)
      return (
        !!fw &&
        fw.pf.nat.outbound.some(
          (r) =>
            !r.disabled &&
            endpointMatches(fw, r.source, check.covers) &&
            (check.translation === undefined || r.translation === check.translation)
        )
      )
    },
    'Règle de NAT sortant manuelle'
  ),
  defineCriterion(
    z.object({
      type: z.literal('pfAlias'),
      device: z.string(),
      name: z.string(),
      aliasType: z.enum(['host', 'network', 'port']).optional(),
      /** Valeurs attendues (ensemble, sans ordre). */
      values: z.array(z.string()).optional()
    }),
    (state, check) => {
      const alias = pfOf(state, check.device)?.pf.aliases.find((a) => a.name === check.name)
      if (!alias || (check.aliasType !== undefined && alias.type !== check.aliasType)) return false
      if (!check.values) return true
      const have = [...alias.values].sort()
      const want = [...check.values].sort()
      return have.length === want.length && have.every((v, i) => v === want[i])
    },
    'Alias du pare-feu'
  ),
  defineCriterion(
    z.object({
      type: z.literal('pfDhcp'),
      device: z.string(),
      iface: IFACE,
      rangeFrom: z.string().optional(),
      rangeTo: z.string().optional(),
      /** Passerelle distribuée aux clients (absent : adresse de l'interface). */
      gateway: z.string().optional(),
      dnsServer: z.string().optional()
    }),
    (state, check) => {
      const cfg = pfOf(state, check.device)?.pf.dhcp[check.iface]
      return (
        !!cfg?.enabled &&
        (check.rangeFrom === undefined || cfg.rangeFrom === check.rangeFrom) &&
        (check.rangeTo === undefined || cfg.rangeTo === check.rangeTo) &&
        (check.gateway === undefined || cfg.gateway === check.gateway) &&
        (check.dnsServer === undefined || cfg.dnsServers.includes(check.dnsServer))
      )
    },
    'Serveur DHCP du pare-feu'
  ),
  defineCriterion(
    z.object({
      type: z.literal('pfDnsResolver'),
      device: z.string(),
      /** Résolveur (Unbound) activé. */
      enabled: z.boolean().default(true),
      /** Remplacement d'hôte attendu. */
      hostOverride: z.object({ host: z.string(), domain: z.string(), address: z.string() }).optional()
    }),
    (state, check) => {
      const dns = pfOf(state, check.device)?.pf.dnsResolver
      if (!dns || dns.enabled !== (check.enabled !== false)) return false
      const o = check.hostOverride
      return (
        !o ||
        dns.hostOverrides.some(
          (h) => sameName(h.host, o.host) && sameName(h.domain, o.domain) && h.address === o.address
        )
      )
    },
    'Résolveur DNS du pare-feu'
  ),
  defineCriterion(
    z.object({
      type: z.literal('pfGateway'),
      device: z.string(),
      /** Adresse de la passerelle de sortie. */
      address: z.string(),
      /** Passerelle par défaut du système (System > Routing). */
      isDefault: z.boolean().default(true)
    }),
    (state, check) => {
      const fw = pfOf(state, check.device)
      return (
        !!fw && fw.pf.gateways.some((g) => g.address === check.address && (!check.isDefault || g.isDefault))
      )
    },
    'Passerelle du pare-feu'
  )
]
