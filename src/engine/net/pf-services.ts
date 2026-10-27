/**
 * Services d'un pare-feu pfSense CE 2.7 simulé (v2.10, #245) : serveur DHCP par interface (Services >
 * DHCP Server), résolveur DNS Unbound (Services > DNS Resolver), serveurs DNS généraux (System > General
 * Setup), passerelles (System > Routing > Gateways) et routes statiques (System > Routing > Static Routes).
 *
 * Les actions sont pures (immer) et appelées par les commandes nommées `pf.*`. Les lectures
 * (`pfDhcpServer`, `pfRoutes`) alimentent le client DHCP existant (roles/dhcp), la table de routage
 * (net/routing.ts) et le résolveur DNS (roles/dns/resolver.ts) : aucune logique n'est dupliquée.
 * Comportements sourcés ou « à vérifier » : docs/fidelite.md, P-30 et suivants.
 */
import type { Draft } from 'immer'
import type { z } from 'zod'
import { raise, transact, type EngineResult } from '../core/result'
import { PF_IFACE_KEYS, PF_IFACE_LABEL, PfDhcpSchema, type PfIfaceKey } from '../model/firewall'
import type { Device, LabState } from '../model/schema'
import type { DhcpScope, DhcpServer } from '../model/dhcp'
import { effectiveIpv4 } from './addressing'
import { inNetwork, isIpv4, networkAddress, parseIpv4 } from './ipv4'
import { requirePf } from './pf-rules'
import type { Route } from './routing'

type PfDevice = Extract<Device, { kind: 'firewall' }>
export type PfDhcp = z.infer<typeof PfDhcpSchema>

/** Carte et adresse (statique ou obtenue) d'une interface logique du pare-feu. */
function nicOf(device: PfDevice, key: PfIfaceKey) {
  const id = device.pf.assignments.find((a) => a.key === key)?.ifaceId
  const nic = id ? device.interfaces.find((i) => i.id === id) : undefined
  const eff = nic ? effectiveIpv4(nic) : null
  return nic && eff ? { nic, eff } : null
}

// --- Lecture : DHCP ------------------------------------------------------------------------------

/**
 * Vue « serveur DHCP » du pare-feu, au format du rôle DHCP : une étendue par interface activée.
 * Les options suivent pfSense : passerelle = adresse de l'interface par défaut, DNS = ceux de
 * l'interface, sinon l'interface elle-même si le résolveur est actif, sinon les DNS généraux.
 * Les baux sont ceux de `pf.dhcp[iface].leases` (écriture par `pfLeaseGranted`).
 */
export function pfDhcpServer(device: Device | undefined): DhcpServer | null {
  if (!device || device.kind !== 'firewall' || !device.powered) return null
  const pf = device.pf
  const scopes: DhcpScope[] = []
  for (const key of PF_IFACE_KEYS) {
    const cfg = pf.dhcp[key]
    const where = nicOf(device, key)
    if (!cfg?.enabled || !cfg.rangeFrom || !cfg.rangeTo || !where) continue
    const { eff } = where
    const dns = cfg.dnsServers.length
      ? cfg.dnsServers
      : pf.dnsResolver.enabled
        ? [eff.address]
        : pf.dnsServers
    scopes.push({
      scopeId: networkAddress(eff.address, eff.prefixLength),
      name: PF_IFACE_LABEL[key],
      description: pf.assignments.find((a) => a.key === key)?.descr ?? '',
      start: cfg.rangeFrom,
      end: cfg.rangeTo,
      prefixLength: eff.prefixLength,
      state: 'Active',
      leaseDurationSec: cfg.leaseSeconds,
      exclusions: [],
      reservations: [],
      leases: cfg.leases.map((l) => ({
        ip: l.ip,
        mac: l.mac,
        hostName: l.hostname,
        expiresAt: l.expires,
        state: 'Active' as const
      })),
      options: { router: [cfg.gateway ?? eff.address], dnsServers: [...dns], dnsDomain: pf.domain || null }
    })
  }
  if (scopes.length === 0) return null
  return {
    authorized: true,
    configured: true,
    scopes,
    serverOptions: { router: [], dnsServers: [], dnsDomain: null }
  }
}

/** Interface logique dont le sous-réseau contient l'adresse. */
function keyOfAddress(device: PfDevice, ip: string): PfIfaceKey | null {
  for (const key of PF_IFACE_KEYS) {
    const w = nicOf(device, key)
    if (w && inNetwork(ip, w.eff.address, w.eff.prefixLength)) return key
  }
  return null
}

/** Enregistre (ou remplace) le bail d'un client dans le serveur DHCP du pare-feu. */
export function pfLeaseGranted(
  draft: Draft<LabState>,
  firewallId: string,
  lease: { ip: string; mac: string; hostname: string; expires: number }
): void {
  const fw = draft.devices[firewallId]
  if (fw?.kind !== 'firewall') return
  const key = keyOfAddress(fw as PfDevice, lease.ip)
  const cfg = key ? fw.pf.dhcp[key] : undefined
  if (!cfg) return
  cfg.leases = cfg.leases.filter((l) => l.mac !== lease.mac && l.ip !== lease.ip)
  cfg.leases.push(lease)
}

/** Prolonge le bail d'un client (renouvellement). */
export function pfLeaseRenewed(
  draft: Draft<LabState>,
  firewallId: string,
  mac: string,
  expires: number
): void {
  const fw = draft.devices[firewallId]
  if (fw?.kind !== 'firewall') return
  for (const key of PF_IFACE_KEYS)
    for (const l of fw.pf.dhcp[key]?.leases ?? []) if (l.mac === mac) l.expires = expires
}

/** Supprime le bail d'un client (libération). */
export function pfLeaseReleased(draft: Draft<LabState>, firewallId: string, mac: string): void {
  const fw = draft.devices[firewallId]
  if (fw?.kind !== 'firewall') return
  for (const key of PF_IFACE_KEYS) {
    const cfg = fw.pf.dhcp[key]
    if (cfg) cfg.leases = cfg.leases.filter((l) => l.mac !== mac)
  }
}

// --- Lecture : routage ---------------------------------------------------------------------------

/**
 * Routes du pare-feu en plus des réseaux connectés : routes statiques actives (passerelle joignable
 * directement) puis route par défaut (passerelle par défaut, sinon passerelle de la carte WAN,
 * statique ou obtenue en DHCP).
 */
export function pfRoutes(device: PfDevice, connected: Route[]): Route[] {
  const routes: Route[] = []
  const onLink = (ip: string) => connected.find((r) => inNetwork(ip, r.network, r.prefixLength))
  for (const r of device.pf.staticRoutes) {
    const g = device.pf.gateways.find((x) => x.name === r.gateway)
    const via = g ? onLink(g.address) : undefined
    if (r.disabled || !g || !via) continue
    routes.push({
      network: networkAddress(r.network, r.prefixLength),
      prefixLength: r.prefixLength,
      gateway: g.address,
      ifaceId: via.ifaceId,
      source: 'static'
    })
  }
  const def = device.pf.gateways.find((g) => g.isDefault)
  const address = def?.address ?? nicOf(device, 'wan')?.eff.gateway ?? null
  const via = address ? onLink(address) : undefined
  if (address && via)
    routes.push({
      network: '0.0.0.0',
      prefixLength: 0,
      gateway: address,
      ifaceId: via.ifaceId,
      source: 'default'
    })
  return routes
}

// --- Actions : DHCP ------------------------------------------------------------------------------

export interface PfDhcpPatch {
  enabled?: boolean
  rangeFrom?: string | null
  rangeTo?: string | null
  dnsServers?: string[]
  gateway?: string | null
  leaseSeconds?: number
}

/** Services > DHCP Server > <interface> : plage, passerelle, DNS, durée du bail, activation. */
export function setPfDhcp(
  state: LabState,
  deviceId: string,
  key: PfIfaceKey,
  patch: PfDhcpPatch
): EngineResult<void> {
  return transact(state, (draft) => {
    const pf = requirePf(draft, deviceId)
    const fw = draft.devices[deviceId] as PfDevice
    const label = PF_IFACE_LABEL[key]
    if (!pf.assignments.some((a) => a.key === key))
      raise('InterfaceNotFound', `L’interface « ${key} » n’existe pas sur ce pare-feu.`)
    if (key === 'wan')
      raise(
        'InvalidDhcp',
        'Le serveur DHCP ne peut pas être activé sur le WAN : l’interface n’est pas un réseau local.'
      )
    const where = nicOf(fw, key)
    const cfg: PfDhcp = { ...PfDhcpSchema.parse({}), ...(pf.dhcp[key] ?? {}), ...patch }
    for (const [what, ip] of [
      ['de début', cfg.rangeFrom],
      ['de fin', cfg.rangeTo],
      ['de la passerelle', cfg.gateway]
    ] as const)
      if (ip && !isIpv4(ip))
        raise('InvalidAddress', `L’adresse ${what} « ${ip} » n’est pas une adresse IPv4 valide.`)
    for (const dns of cfg.dnsServers)
      if (!isIpv4(dns))
        raise('InvalidAddress', `Le serveur DNS « ${dns} » n’est pas une adresse IPv4 valide.`)
    if (cfg.enabled) {
      if (!where)
        raise(
          'NoInterfaceAddress',
          `L’interface ${label} n’a pas d’adresse IPv4 : le serveur DHCP ne peut pas démarrer.`
        )
      if (!cfg.rangeFrom || !cfg.rangeTo)
        raise('InvalidRange', 'La plage d’adresses (Range) du serveur DHCP doit être renseignée.')
    }
    if (cfg.rangeFrom && cfg.rangeTo) {
      const a = parseIpv4(cfg.rangeFrom) ?? 0
      const b = parseIpv4(cfg.rangeTo) ?? 0
      if (a > b)
        raise('InvalidRange', `La plage est invalide : ${cfg.rangeFrom} est supérieur à ${cfg.rangeTo}.`)
      if (where) {
        const { address, prefixLength } = where.eff
        if (
          !inNetwork(cfg.rangeFrom, address, prefixLength) ||
          !inNetwork(cfg.rangeTo, address, prefixLength)
        )
          raise(
            'InvalidRange',
            `La plage doit appartenir au sous-réseau de l’interface ${label} (${networkAddress(address, prefixLength)}/${prefixLength}).`
          )
        const own = parseIpv4(address) ?? 0
        if (own >= a && own <= b)
          raise('InvalidRange', `La plage ne doit pas contenir l’adresse de l’interface (${address}).`)
      }
    }
    if (!(cfg.leaseSeconds > 0)) raise('InvalidLease', 'La durée du bail doit être supérieure à zéro.')
    pf.dhcp[key] = cfg
  })
}

// --- Actions : passerelles et routes -------------------------------------------------------------

/** System > Routing > Gateways : ajoute ou remplace une passerelle (le nom est l'identifiant). */
export function setPfGateway(
  state: LabState,
  deviceId: string,
  gateway: { name: string; iface: PfIfaceKey; address: string; isDefault?: boolean }
): EngineResult<void> {
  return transact(state, (draft) => {
    const pf = requirePf(draft, deviceId)
    const fw = draft.devices[deviceId] as PfDevice
    const label = PF_IFACE_LABEL[gateway.iface]
    if (!/^[A-Za-z0-9_]{1,31}$/.test(gateway.name))
      raise(
        'InvalidName',
        'Le nom de la passerelle ne peut contenir que des lettres, des chiffres et « _ » (31 caractères au plus).'
      )
    if (!isIpv4(gateway.address))
      raise(
        'InvalidAddress',
        `L’adresse de passerelle « ${gateway.address} » n’est pas une adresse IPv4 valide.`
      )
    const where = nicOf(fw, gateway.iface)
    if (!where) raise('NoInterfaceAddress', `L’interface ${label} n’a pas d’adresse IPv4.`)
    if (!inNetwork(gateway.address, where.eff.address, where.eff.prefixLength))
      raise(
        'GatewayNotOnLink',
        `La passerelle ${gateway.address} n’est pas dans le sous-réseau de l’interface ${label}.`
      )
    if (gateway.address === where.eff.address)
      raise('InvalidAddress', 'La passerelle ne peut pas être l’adresse de l’interface elle-même.')
    const isDefault = gateway.isDefault ?? pf.gateways.length === 0
    if (isDefault) for (const g of pf.gateways) g.isDefault = false
    const entry = { name: gateway.name, iface: gateway.iface, address: gateway.address, isDefault }
    const index = pf.gateways.findIndex((g) => g.name === gateway.name)
    if (index >= 0) pf.gateways[index] = entry
    else pf.gateways.push(entry)
  })
}

/** Supprime une passerelle, sauf si une route statique l'utilise. */
export function removePfGateway(state: LabState, deviceId: string, name: string): EngineResult<void> {
  return transact(state, (draft) => {
    const pf = requirePf(draft, deviceId)
    const index = pf.gateways.findIndex((g) => g.name === name)
    if (index < 0) raise('GatewayNotFound', `La passerelle « ${name} » n’existe pas.`)
    if (pf.staticRoutes.some((r) => r.gateway === name))
      raise(
        'GatewayInUse',
        `La passerelle « ${name} » est utilisée par une route statique : supprimez la route d’abord.`
      )
    pf.gateways.splice(index, 1)
  })
}

/** Désigne la passerelle par défaut (System > Routing > Default gateway). */
export function setPfDefaultGateway(
  state: LabState,
  deviceId: string,
  name: string | null
): EngineResult<void> {
  return transact(state, (draft) => {
    const pf = requirePf(draft, deviceId)
    if (name !== null && !pf.gateways.some((g) => g.name === name))
      raise('GatewayNotFound', `La passerelle « ${name} » n’existe pas.`)
    for (const g of pf.gateways) g.isDefault = g.name === name
  })
}

/** System > Routing > Static Routes : ajoute une route vers un réseau via une passerelle. */
export function addPfStaticRoute(
  state: LabState,
  deviceId: string,
  route: { network: string; prefixLength: number; gateway: string; disabled?: boolean }
): EngineResult<void> {
  return transact(state, (draft) => {
    const pf = requirePf(draft, deviceId)
    if (!isIpv4(route.network))
      raise('InvalidAddress', `Le réseau « ${route.network} » n’est pas une adresse IPv4 valide.`)
    if (!Number.isInteger(route.prefixLength) || route.prefixLength < 0 || route.prefixLength > 32)
      raise('InvalidPrefix', 'La longueur du préfixe doit être comprise entre 0 et 32.')
    if (!pf.gateways.some((g) => g.name === route.gateway))
      raise(
        'GatewayNotFound',
        `La passerelle « ${route.gateway} » n’existe pas : créez-la dans System > Routing > Gateways.`
      )
    const network = networkAddress(route.network, route.prefixLength)
    if (pf.staticRoutes.some((r) => r.network === network && r.prefixLength === route.prefixLength))
      raise('RouteExists', `Une route vers ${network}/${route.prefixLength} existe déjà.`)
    pf.staticRoutes.push({
      network,
      prefixLength: route.prefixLength,
      gateway: route.gateway,
      disabled: route.disabled ?? false
    })
  })
}

/** Supprime une route statique. */
export function removePfStaticRoute(
  state: LabState,
  deviceId: string,
  network: string,
  prefixLength: number
): EngineResult<void> {
  return transact(state, (draft) => {
    const pf = requirePf(draft, deviceId)
    const index = pf.staticRoutes.findIndex((r) => r.network === network && r.prefixLength === prefixLength)
    if (index < 0) raise('RouteNotFound', `La route vers ${network}/${prefixLength} n’existe pas.`)
    pf.staticRoutes.splice(index, 1)
  })
}

// --- Actions : DNS -------------------------------------------------------------------------------

/** Services > DNS Resolver : activation et redirection (Enable Forwarding Mode). */
export function setPfDnsResolver(
  state: LabState,
  deviceId: string,
  patch: { enabled?: boolean; forwarding?: boolean }
): EngineResult<void> {
  return transact(state, (draft) => {
    const pf = requirePf(draft, deviceId)
    if (patch.enabled !== undefined) pf.dnsResolver.enabled = patch.enabled
    if (patch.forwarding !== undefined) pf.dnsResolver.forwarding = patch.forwarding
  })
}

/** System > General Setup : serveurs DNS généraux (utilisés en mode redirection). */
export function setPfDnsServers(state: LabState, deviceId: string, servers: string[]): EngineResult<void> {
  return transact(state, (draft) => {
    const pf = requirePf(draft, deviceId)
    for (const s of servers)
      if (!isIpv4(s)) raise('InvalidAddress', `Le serveur DNS « ${s} » n’est pas une adresse IPv4 valide.`)
    pf.dnsServers = [...servers]
  })
}

/** Host Overrides : associe un nom (hôte + domaine) à une adresse. */
export function setPfHostOverride(
  state: LabState,
  deviceId: string,
  entry: { host: string; domain: string; address: string }
): EngineResult<void> {
  return transact(state, (draft) => {
    const pf = requirePf(draft, deviceId)
    const host = entry.host.trim().toLowerCase()
    const domain = entry.domain.trim().toLowerCase()
    if (!domain) raise('InvalidName', 'Le domaine du Host Override est obligatoire.')
    if (!isIpv4(entry.address))
      raise('InvalidAddress', `L’adresse « ${entry.address} » n’est pas une adresse IPv4 valide.`)
    const index = pf.dnsResolver.hostOverrides.findIndex((o) => o.host === host && o.domain === domain)
    const next = { host, domain, address: entry.address }
    if (index >= 0) pf.dnsResolver.hostOverrides[index] = next
    else pf.dnsResolver.hostOverrides.push(next)
  })
}

/** Supprime un Host Override. */
export function removePfHostOverride(
  state: LabState,
  deviceId: string,
  host: string,
  domain: string
): EngineResult<void> {
  return transact(state, (draft) => {
    const pf = requirePf(draft, deviceId)
    const h = host.trim().toLowerCase()
    const d = domain.trim().toLowerCase()
    const index = pf.dnsResolver.hostOverrides.findIndex((o) => o.host === h && o.domain === d)
    if (index < 0) raise('OverrideNotFound', `Le Host Override « ${h ? `${h}.` : ''}${d} » n’existe pas.`)
    pf.dnsResolver.hostOverrides.splice(index, 1)
  })
}
