/**
 * Localisation d'un contrôleur de domaine par un client (enregistrement SRV dans le DNS,
 * « ping » LDAP) et échanges applicatifs tracés avec un serveur (LDAP, Kerberos, SMB).
 */
import type { Domain, LabState } from '../../model/schema'
import { effectiveIpv4 } from '../../net/addressing'
import { initialTtl } from '../../net/routing'
import { createContext, sendIp, sourceAddressFor } from '../../sim/forward'
import { createRecorder, type PacketTrace, type PduLayer, type Protocol } from '../../sim/trace'
import { normalizeName } from '../dns/server'
import { firstAddress, resolveName } from '../dns/resolver'
import { dcAnswersClients } from './dcservices'
import { dcSite, siteControllers, siteOfAddress } from './sites'

/** Contrôleur de domaine localisé par le client. */
export interface LocatedDc {
  domain: Domain
  dcId: string
  dcIp: string
}

/** Échange applicatif à tracer entre un client et un serveur (LDAP, Kerberos, SMB). */
export interface ExchangeSpec {
  protocol: Protocol
  port: number
  request: string
  reply: string
  fields: [string, string][]
}

const APPLICATION_LAYER: Partial<Record<Protocol, string>> = {
  LDAP: 'LDAP',
  KERBEROS: 'Kerberos',
  SMB: 'SMB2',
  VPN: 'SSTP'
}

/**
 * Requête puis réponse entre un client et un serveur, routées comme de vrais paquets.
 * Kerberos (88), SMB (445) et LDAP (389 hors « ping » de localisation) passent par TCP.
 */
export function serverExchange(
  state: LabState,
  fromId: string,
  dstIp: string,
  spec: ExchangeSpec
): { trace: PacketTrace; ok: boolean; src: string | null } {
  const { protocol, port, request, reply, fields } = spec
  const rec = createRecorder()
  const ctx = createContext(state, rec)
  const from = state.devices[fromId]
  const src = from ? sourceAddressFor(state, from, dstIp) : null
  if (!from || !src) return { trace: { title: protocol, events: [] }, ok: false, src: null }
  const tcp = port !== 389 || !request.startsWith('LDAP ping')
  const layer = (kind: string): PduLayer[] => [
    { layer: 4, name: tcp ? 'TCP' : 'UDP', fields: [['Port destination', String(port)]] },
    { layer: 7, name: APPLICATION_LAYER[protocol] ?? protocol, fields: [['Message', kind], ...fields] }
  ]
  const ipProtocol = tcp ? '6 (TCP)' : '17 (UDP)'
  const req = sendIp(ctx, fromId, {
    src,
    dst: dstIp,
    ttl: initialTtl(from),
    protocol,
    ipProtocol,
    summary: request,
    upper: layer(request),
    transport: tcp ? 'TCP' : 'UDP',
    port
  })
  if (req.kind !== 'delivered')
    return { trace: { title: protocol, events: rec.events }, ok: false, src: null }
  const dc = state.devices[req.deviceId]
  if (!dc) return { trace: { title: protocol, events: rec.events }, ok: false, src: null }
  const rep = sendIp(ctx, dc.id, {
    src: dstIp,
    dst: req.src,
    ttl: initialTtl(dc),
    protocol,
    ipProtocol,
    summary: reply,
    upper: layer(reply),
    reply: true
  })
  return { trace: { title: protocol, events: rec.events }, ok: rep.kind === 'delivered', src: req.src }
}

export function exchange(
  state: LabState,
  fromId: string,
  dstIp: string,
  protocol: Protocol,
  port: number,
  request: string,
  reply: string,
  fields: [string, string][]
): { trace: PacketTrace; ok: boolean } {
  return serverExchange(state, fromId, dstIp, { protocol, port, request, reply, fields })
}

/** Contrôleur désigné par un enregistrement SRV (cible résolue en adresse puis contactée). */
function contactDc(
  state: LabState,
  clientId: string,
  domain: Domain,
  srvName: string,
  traces: PacketTrace[]
): (LocatedDc & { clientSite: string | null }) | null {
  const srv = resolveName(state, clientId, srvName, 'SRV')
  traces.push(srv.trace)
  if (srv.result.kind !== 'answer') return null
  // Plusieurs contrôleurs : le client essaie chaque cible SRV jusqu'à ce qu'un contrôleur réponde
  // (NTDS et Netlogon démarrés, sinon il ne répond pas au « ping » de localisation)
  const targets = [
    ...new Set(srv.result.records.filter((r) => r.type === 'SRV').map((r) => r.data.split(' ')[3] ?? ''))
  ].filter((t) => t)
  for (const target of targets) {
    const found = pingTarget(state, clientId, domain, target, traces)
    if (found) return found
  }
  return null
}

/** Résout une cible SRV puis « ping » LDAP du contrôleur, qui indique le site du client. */
function pingTarget(
  state: LabState,
  clientId: string,
  domain: Domain,
  target: string,
  traces: PacketTrace[]
): (LocatedDc & { clientSite: string | null }) | null {
  const a = resolveName(state, clientId, normalizeName(target), 'A')
  traces.push(a.trace)
  const dcIp = firstAddress(a)
  if (!dcIp) return null
  const dc = Object.values(state.devices).find(
    (d) => d.powered && d.interfaces.some((i) => effectiveIpv4(i)?.address === dcIp)
  )
  if (!dc || !domain.controllers.includes(dc.id) || !dcAnswersClients(dc)) return null
  // Le contrôleur indique au client son site, d'après le sous-réseau de son adresse
  const from = state.devices[clientId]
  const clientIp = from ? sourceAddressFor(state, from, dcIp) : null
  const clientSite = clientIp ? siteOfAddress(domain, clientIp) : null
  const ldap = exchange(
    state,
    clientId,
    dcIp,
    'LDAP',
    389,
    'LDAP ping (recherche du DC)',
    'LDAP réponse : contrôleur disponible',
    [
      ['Domaine', domain.name],
      ['Site du contrôleur', dcSite(domain, dc.id)],
      ['Site du client', clientSite ?? '(aucun sous-réseau correspondant)']
    ]
  )
  traces.push(ldap.trace)
  return ldap.ok ? { domain, dcId: dc.id, dcIp, clientSite } : null
}

/**
 * Localise un contrôleur du domaine via le DNS du client puis le contacte (ping LDAP). Le
 * contrôleur trouvé indique le site du client : s'il n'en fait pas partie et que ce site a un
 * contrôleur, le client interroge l'enregistrement SRV du site et s'adresse à celui-ci.
 */
export function locateDc(
  state: LabState,
  clientId: string,
  domainName: string,
  traces: PacketTrace[]
): LocatedDc | null {
  const domain = Object.values(state.domains).find(
    (d) => d.name === normalizeName(domainName) || d.netbios.toLowerCase() === domainName.toLowerCase()
  )
  if (!domain) {
    // Requête tracée même pour un domaine inconnu (le client ne le sait pas encore)
    const srv = resolveName(state, clientId, `_ldap._tcp.dc._msdcs.${domainName}`, 'SRV')
    traces.push(srv.trace)
    return null
  }
  const first = contactDc(state, clientId, domain, `_ldap._tcp.dc._msdcs.${domain.name}`, traces)
  if (!first) return null
  const site = first.clientSite
  if (site && dcSite(domain, first.dcId) !== site && siteControllers(domain, site).length > 0) {
    const close = contactDc(
      state,
      clientId,
      domain,
      `_ldap._tcp.${site}._sites.dc._msdcs.${domain.name}`,
      traces
    )
    if (close) return { domain, dcId: close.dcId, dcIp: close.dcIp }
  }
  return { domain, dcId: first.dcId, dcIp: first.dcIp }
}
