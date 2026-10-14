/**
 * Réplication Active Directory entre contrôleurs : topologie calculée comme par le KCC
 * (connexions entre tous les contrôleurs d'un site ; entre sites, têtes de pont reliées par
 * l'arbre de liens de sites de moindre coût), tentative par connexion (le partenaire doit être
 * joignable), état consulté par repadmin, et réplication des zones DNS intégrées à AD.
 *
 * Simplification : le contenu de l'annuaire (comptes, groupes, GPO) est commun à tous les
 * contrôleurs ; seules les zones DNS intégrées à AD sont des copies répliquées.
 */
import type { Draft } from 'immer'
import { logEvent } from '../../core/eventlog'
import { raise, transact, type EngineResult } from '../../core/result'
import type { Domain, LabState, ReplicationStatus } from '../../model/schema'
import type { DnsRecord, DnsZone } from '../dns/schema'
import { dnsServerOf } from '../dns/state'
import { serverExchange } from './locator'
import { requireDomain } from './objects'
import { addressOf, dcSite, siteControllers } from './sites'

/** Erreur Windows d'un partenaire injoignable : « Le serveur RPC n'est pas disponible. » */
export const RPC_UNAVAILABLE = 1722

/** Connexion de réplication entrante (le contrôleur `dcId` tire les modifications de `partnerId`). */
export interface ReplicationConnection {
  dcId: string
  partnerId: string
  /** Lien de sites emprunté (connexion entre sites), ou null dans un site. */
  siteLink: string | null
}

/** Arbre couvrant de moindre coût des sites ayant des contrôleurs (liens de sites pontés). */
function siteTree(domain: Domain, sites: string[]): { a: string; b: string; link: string }[] {
  const edges = domain.siteLinks
    .flatMap((link) =>
      link.sites.flatMap((a, i) =>
        link.sites.slice(i + 1).map((b) => ({ a, b, link: link.name, cost: link.cost }))
      )
    )
    .filter((e) => sites.includes(e.a) && sites.includes(e.b))
    .sort((x, y) => x.cost - y.cost || x.link.localeCompare(y.link))
  const parent = new Map(sites.map((s) => [s, s]))
  const root = (s: string): string => {
    let r = s
    while (parent.get(r) !== r) r = parent.get(r) ?? r
    return r
  }
  const tree: { a: string; b: string; link: string }[] = []
  for (const e of edges) {
    const [ra, rb] = [root(e.a), root(e.b)]
    if (ra === rb) continue
    parent.set(ra, rb)
    tree.push({ a: e.a, b: e.b, link: e.link })
  }
  return tree
}

/** Sites ayant des contrôleurs. */
function populatedSites(domain: Domain): string[] {
  return [...new Set(domain.controllers.map((id) => dcSite(domain, id)))]
}

/** Topologie de réplication du domaine (connexions entrantes). */
export function replicationConnections(domain: Domain): ReplicationConnection[] {
  const connections: ReplicationConnection[] = []
  const sites = populatedSites(domain)
  for (const site of sites) {
    const dcs = siteControllers(domain, site)
    for (const dcId of dcs)
      for (const partnerId of dcs)
        if (dcId !== partnerId) connections.push({ dcId, partnerId, siteLink: null })
  }
  // Têtes de pont : premier contrôleur de chaque site
  const bridgehead = (site: string) => siteControllers(domain, site)[0] ?? ''
  for (const edge of siteTree(domain, sites)) {
    const [a, b] = [bridgehead(edge.a), bridgehead(edge.b)]
    connections.push({ dcId: a, partnerId: b, siteLink: edge.link })
    connections.push({ dcId: b, partnerId: a, siteLink: edge.link })
  }
  return connections
}

/** Sites ayant des contrôleurs qu'aucun lien de sites ne relie aux autres. */
export function isolatedSites(domain: Domain): string[] {
  const sites = populatedSites(domain)
  if (sites.length < 2) return []
  const linked = new Set(siteTree(domain, sites).flatMap((e) => [e.a, e.b]))
  return sites.filter((s) => !linked.has(s))
}

/** Tentative de réplication : le contrôleur joint-il son partenaire ? (aussi utilisée par dcdiag) */
export function replicationAttempt(state: LabState, dcId: string, partnerId: string): boolean {
  const ip = addressOf(state, partnerId)
  if (!ip || !state.devices[dcId]?.powered || !state.devices[partnerId]?.powered) return false
  return serverExchange(state, dcId, ip, {
    protocol: 'LDAP',
    port: 389,
    request: 'Réplication AD : demande des modifications',
    reply: 'Réplication AD : modifications',
    fields: []
  }).ok
}

const recordKey = (r: DnsRecord) => JSON.stringify([r.name, r.type, r.data, r.ttl, r.dynamic])
const recordOf = (key: string): DnsRecord => {
  const [name, type, data, ttl, dynamic] = JSON.parse(key) as [
    string,
    DnsRecord['type'],
    string,
    number,
    boolean
  ]
  return { name, type, data, ttl, dynamic }
}

/**
 * Réplique les zones DNS intégrées à AD entre contrôleurs connectés : on part du contenu de la
 * réplication la plus récente, puis on applique les ajouts et suppressions faits sur chaque
 * contrôleur depuis sa propre dernière réplication.
 */
function syncZones(draft: Draft<LabState>, domain: Draft<Domain>, group: string[]): void {
  const servers = group.flatMap((id) => {
    const dns = dnsServerOf(draft.devices[id])
    return dns ? [{ id, dns }] : []
  })
  if (servers.length < 2) return
  const zoneNames = [
    ...new Set(servers.flatMap((s) => s.dns.zones.filter((z) => z.adIntegrated).map((z) => z.name)))
  ]
  const rep = domain.replication
  for (const zoneName of zoneNames) {
    const template = servers
      .map((s) => s.dns.zones.find((z) => z.name === zoneName && z.adIntegrated))
      .find((z): z is DnsZone => !!z)
    if (!template) continue
    const copies = servers.map((s) => {
      let zone = s.dns.zones.find((z) => z.name === zoneName)
      if (!zone) {
        zone = { ...JSON.parse(JSON.stringify(template)), records: [] } as DnsZone
        s.dns.zones.push(zone)
      }
      return { id: s.id, zone: zone as Draft<DnsZone> }
    })
    // Contenu de référence : base de la réplication la plus récente (sinon, union des copies)
    const withBase = copies
      .filter((c) => rep.dnsBase[c.id]?.[zoneName])
      .sort((a, b) => (rep.syncedAt[b.id] ?? 0) - (rep.syncedAt[a.id] ?? 0))
    const result = new Set<string>(withBase[0] ? (rep.dnsBase[withBase[0].id]?.[zoneName] ?? []) : [])
    for (const c of copies) {
      const current = c.zone.records.map(recordKey)
      const base = rep.dnsBase[c.id]?.[zoneName]
      if (!base) {
        for (const k of current) result.add(k)
        continue
      }
      const baseSet = new Set(base)
      const currentSet = new Set(current)
      for (const k of current) if (!baseSet.has(k)) result.add(k)
      for (const k of base) if (!currentSet.has(k)) result.delete(k)
    }
    const keys = [...result]
    for (const c of copies) {
      if (c.zone.records.map(recordKey).join('\n') !== keys.join('\n')) c.zone.records = keys.map(recordOf)
      ;(rep.dnsBase[c.id] ??= {})[zoneName] = keys
    }
  }
  for (const s of servers) rep.syncedAt[s.id] = draft.clock
}

/** Composantes connexes des contrôleurs reliés par une réplication réussie. */
function components(dcs: string[], ok: { dcId: string; partnerId: string }[]): string[][] {
  const parent = new Map(dcs.map((d) => [d, d]))
  const root = (d: string): string => {
    let r = d
    while (parent.get(r) !== r) r = parent.get(r) ?? r
    return r
  }
  for (const c of ok) parent.set(root(c.dcId), root(c.partnerId))
  const groups = new Map<string, string[]>()
  for (const d of dcs) groups.set(root(d), [...(groups.get(root(d)) ?? []), d])
  return [...groups.values()].filter((g) => g.length > 1)
}

/** Réplique un domaine (brouillon) : état des connexions, zones DNS, événements. */
function replicateDomain(draft: Draft<LabState>, domain: Draft<Domain>, state: LabState): void {
  if (domain.controllers.length < 2) return
  const connections = replicationConnections(domain)
  const succeeded: ReplicationConnection[] = []
  const status: ReplicationStatus[] = []
  for (const c of connections) {
    const previous = domain.replication.status.find((s) => s.dcId === c.dcId && s.partnerId === c.partnerId)
    const ok = replicationAttempt(state, c.dcId, c.partnerId)
    if (ok) succeeded.push(c)
    status.push({
      dcId: c.dcId,
      partnerId: c.partnerId,
      lastAttempt: draft.clock,
      lastSuccess: ok ? draft.clock : (previous?.lastSuccess ?? null),
      result: ok ? 0 : RPC_UNAVAILABLE,
      failures: ok ? 0 : (previous?.failures ?? 0) + 1
    })
    // Premier échec : événement du KCC sur le contrôleur de destination
    if (!ok && (previous?.failures ?? 0) === 0)
      logEvent(draft, c.dcId, {
        level: 'warning',
        source: 'NTDS KCC',
        eventId: 1925,
        log: 'Service d’annuaire',
        message: `La tentative d’établissement d’un lien de réplication avec ${state.devices[c.partnerId]?.name ?? c.partnerId} a échoué. Erreur ${RPC_UNAVAILABLE} : le serveur RPC n’est pas disponible.`
      })
  }
  if (JSON.stringify(domain.replication.status) !== JSON.stringify(status)) domain.replication.status = status
  for (const group of components(domain.controllers, succeeded)) syncZones(draft, domain, group)
}

/** Réplique tous les domaines (tâche de fond). */
export function replicateDirectory(state: LabState): { state: LabState; traces: [] } {
  const r = transact(state, (draft) => {
    for (const domain of Object.values(draft.domains)) {
      replicateDomain(draft, domain, state)
      // Site sans lien vers les autres : le KCC ne peut pas créer de connexion (signalé une fois)
      for (const site of isolatedSites(domain as Domain))
        for (const dcId of siteControllers(domain as Domain, site)) {
          const host = draft.devices[dcId]
          const log = host?.kind === 'server' ? host.host.eventLog : []
          const lastKcc = [...log].reverse().find((e) => e.source === 'NTDS KCC')
          if (lastKcc?.eventId === 1311) continue
          logEvent(draft, dcId, {
            level: 'error',
            source: 'NTDS KCC',
            eventId: 1311,
            log: 'Service d’annuaire',
            message: `Le vérificateur de cohérence des connaissances (KCC) a détecté des problèmes : le site ${site} n’est relié à aucun autre site par un lien de sites ; la réplication avec les contrôleurs des autres sites est impossible.`
          })
        }
    }
    return undefined
  })
  return { state: r.ok ? r.state : state, traces: [] }
}

/** Réplication immédiate de tous les contrôleurs du domaine (repadmin /syncall, « Répliquer maintenant »). */
export function syncDomain(
  state: LabState,
  domainName: string
): EngineResult<{ errors: ReplicationStatus[] }> {
  return transact(state, (draft) => {
    const domain = requireDomain(draft, domainName)
    if (domain.controllers.length < 2)
      raise('SingleController', 'Le domaine ne compte qu’un contrôleur : rien à répliquer.')
    replicateDomain(draft, domain, state)
    return { errors: domain.replication.status.filter((s) => s.result !== 0) }
  })
}
