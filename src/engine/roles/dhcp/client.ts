/**
 * Client DHCP : obtention (DORA), renouvellement et libération d'un bail.
 * Chaque échange est enregistré dans une trace rejouable en mode Simulation.
 */
import { logEvent } from '../../core/eventlog'
import { transact } from '../../core/result'
import type { Device, HostDevice, LabState } from '../../model/schema'
import type { DhcpScope } from './schema'
import { effectiveIpv4 } from '../../net/addressing'
import { formatIpv4, inNetwork, parseIpv4, prefixToMask } from '../../net/ipv4'
import { iosL2Inspect } from '../../ios/registry'
import { carrierUp, l2Segment, reversePath, type PortRef, type SegmentMember } from '../../net/segment'
import {
  createContext,
  recordBroadcast,
  recordUnicast,
  sendIp,
  setLastOutcome,
  sourceAddressFor,
  type SimContext
} from '../../sim/forward'
import {
  BROADCAST_MAC,
  createRecorder,
  ethernetLayer,
  ipv4Layer,
  type PacketTrace,
  type PduLayer
} from '../../sim/trace'
import { registerHostDns } from '../adds/join'
import { effectiveOptions, inScopeRange, isExcluded, formatLeaseDuration } from './server'
import { dhcpServiceOf, dhcpServiceStopped } from './state'
import { pfLeaseGranted, pfLeaseReleased, pfLeaseRenewed } from '../../net/pf-services'
import { leaseGranted, leaseReleased, leaseRenewed, type LinuxLeaseInfo } from '../../services/linuxdhcplease'

/** Informations d'un bail pour dhcpd.leases d'un serveur Linux (v2.9, #240) ; null pour un autre serveur. */
function linuxLease(
  now: number,
  server: Device,
  client: Device,
  ip: string,
  mac: string,
  ends: number
): LinuxLeaseInfo | null {
  if (server.kind !== 'server' || server.host.os !== 'linux') return null
  const iface = server.interfaces.find((i) => {
    const eff = effectiveIpv4(i)
    return !!eff && inNetwork(ip, eff.address, eff.prefixLength)
  })
  const eff = iface ? effectiveIpv4(iface) : null
  return {
    ip,
    mac,
    hostName: client.name,
    serverIp: eff?.address ?? '',
    via: iface?.name ?? 'eth0',
    now,
    ends
  }
}

export type DhcpOutcome = 'bound' | 'renewed' | 'released' | 'failed' | 'not-dhcp' | 'no-carrier'

export interface DhcpOperation {
  state: LabState
  trace: PacketTrace
  outcome: DhcpOutcome
  address: string | null
  /** Message explicatif (échec). */
  message: string
}

function udpLayer(src: number, dst: number): PduLayer {
  return {
    layer: 4,
    name: 'UDP',
    fields: [
      ['Port source', String(src)],
      ['Port destination', String(dst)]
    ]
  }
}

function dhcpLayer(type: string, fields: [string, string][]): PduLayer {
  return { layer: 7, name: 'DHCP', fields: [['Type de message', type], ...fields] }
}

function hostFqdn(device: HostDevice): string {
  return device.host.domain ? `${device.name}.${device.host.domain}` : device.name
}

/** Le serveur DHCP est-il autorisé à distribuer des adresses ? */
export function dhcpAuthorized(server: Device): boolean {
  // Serveur DHCP IOS : aucune autorisation Active Directory
  if (server.kind !== 'server') return true
  return !server.host.domain || !!dhcpServiceOf(server)?.authorized
}

/** Étendue active desservant le réseau sur lequel le serveur reçoit la requête. */
function scopeFor(server: Device, port: PortRef): DhcpScope | null {
  const iface = server.interfaces.find((i) => i.id === port.ifaceId)
  const eff = iface ? effectiveIpv4(iface) : null
  const dhcp = dhcpServiceOf(server)
  if (!eff || eff.source !== 'static' || !dhcp) return null
  return (
    dhcp.scopes.find((s) => s.state === 'Active' && inNetwork(eff.address, s.scopeId, s.prefixLength)) ?? null
  )
}

/** Options effectives d'une étendue (options du serveur complétées par celles de l'étendue). */
function scopeOptions(server: Device, scope: DhcpScope) {
  return effectiveOptions(
    dhcpServiceOf(server) ?? {
      authorized: true,
      configured: true,
      scopes: [],
      serverOptions: { router: [], dnsServers: [], dnsDomain: null }
    },
    scope
  )
}

/** Champs DHCP d'une offre ou d'un accusé de réception (adresse et options). */
function offerFields(server: Device, scope: DhcpScope, ip: string, serverIp: string): [string, string][] {
  const opts = scopeOptions(server, scope)
  return [
    ['Adresse proposée', ip],
    ['Masque (option 1)', prefixToMask(scope.prefixLength)],
    ['Routeur (option 003)', opts.router.join(', ') || '—'],
    ['Serveurs DNS (option 006)', opts.dnsServers.join(', ') || '—'],
    ['Domaine DNS (option 015)', opts.dnsDomain ?? '—'],
    ['Durée du bail', formatLeaseDuration(scope.leaseDurationSec)],
    ['Serveur DHCP', serverIp]
  ]
}

/** Trajet routé entre l'agent de relais et le serveur DHCP (UDP 67 → 67, giaddr renseigné). */
function relayLeg(
  ctx: SimContext,
  from: string,
  packet: {
    src: string
    dst: string
    type: string
    summary: string
    giaddr: string
    fields: [string, string][]
  }
) {
  return sendIp(ctx, from, {
    src: packet.src,
    dst: packet.dst,
    ttl: 128,
    protocol: 'DHCP',
    ipProtocol: '17 (UDP)',
    summary: packet.summary,
    upper: [
      udpLayer(67, 67),
      dhcpLayer(packet.type, [...packet.fields, ['Agent relais (giaddr)', packet.giaddr]])
    ]
  })
}

/** Étendue active qui couvre l'adresse de l'agent de relais (giaddr). */
function scopeForRelay(server: Device, giaddr: string): DhcpScope | null {
  return (
    dhcpServiceOf(server)?.scopes.find(
      (s) => s.state === 'Active' && inNetwork(giaddr, s.scopeId, s.prefixLength)
    ) ?? null
  )
}

/** Interface de routeur, agent de relais DHCP (ip helper-address), atteinte par la diffusion. */
interface Relay {
  member: SegmentMember
  /** Adresse de l'interface du relais : champ giaddr, choix de l'étendue par le serveur. */
  giaddr: string
  helpers: string[]
}

function relayOf(state: LabState, member: SegmentMember): Relay | null {
  const dev = state.devices[member.port.deviceId]
  // Routeur, ou interface VLAN d'un switch de niveau 3
  if (dev?.kind !== 'router' && dev?.kind !== 'switch') return null
  const iface = dev.interfaces.find((i) => i.id === member.port.ifaceId)
  const giaddr = iface ? effectiveIpv4(iface)?.address : undefined
  const helpers = iface?.helperAddresses ?? []
  return giaddr && helpers.length > 0 ? { member, giaddr, helpers } : null
}

/** Adresse utilisée sur le segment par un autre hôte que le client. */
function inUse(state: LabState, serverPort: PortRef, clientMac: string, ip: string): boolean {
  return (
    l2Segment(state, serverPort).some((m) => {
      const iface = state.devices[m.port.deviceId]?.interfaces.find((i) => i.id === m.port.ifaceId)
      return !!iface && iface.mac !== clientMac && effectiveIpv4(iface)?.address === ip
    }) ||
    state.devices[serverPort.deviceId]?.interfaces.some((i) => effectiveIpv4(i)?.address === ip) === true
  )
}

interface Pick {
  ip: string | null
  /** Adresses détectées comme déjà utilisées (marquées BAD_ADDRESS). */
  bad: string[]
}

/** Choix de l'adresse à proposer (réservation, bail existant, adresse demandée, puis première libre). */
function pickAddress(
  state: LabState,
  scope: DhcpScope,
  serverPort: PortRef,
  mac: string,
  requested: string | null
): Pick {
  const reservation = scope.reservations.find((r) => r.mac === mac)
  if (reservation) return { ip: reservation.ip, bad: [] }
  const taken = new Set<string>([
    ...scope.reservations.filter((r) => r.mac !== mac).map((r) => r.ip),
    ...scope.leases.filter((l) => l.mac !== mac || l.state === 'BadAddress').map((l) => l.ip)
  ])
  const free = (ip: string) => inScopeRange(scope, ip) && !isExcluded(scope, ip) && !taken.has(ip)
  const bad: string[] = []
  const existing = scope.leases.find((l) => l.mac === mac && l.state === 'Active')
  for (const candidate of [existing?.ip, requested]) {
    if (candidate && free(candidate) && !inUse(state, serverPort, mac, candidate))
      return { ip: candidate, bad }
  }
  const start = parseIpv4(scope.start) ?? 0
  const end = parseIpv4(scope.end) ?? -1
  for (let v = start; v <= end; v++) {
    const ip = formatIpv4(v)
    if (!free(ip)) continue
    if (inUse(state, serverPort, mac, ip)) {
      bad.push(ip)
      continue
    }
    return { ip, bad }
  }
  return { ip: null, bad }
}

interface Chosen {
  /** Membre du segment du client qui répond : le serveur, ou l'agent de relais. */
  member: SegmentMember
  server: Device
  scope: DhcpScope
  ip: string
  bad: string[]
  /** Échange relayé : agent de relais et adresse du serveur. */
  relay: { giaddr: string; serverIp: string } | null
}

function noChange(state: LabState, outcome: DhcpOutcome, message: string): DhcpOperation {
  return { state, trace: { title: 'DHCP', events: [] }, outcome, address: null, message }
}

function clientPort(state: LabState, clientId: string, ifaceId: string) {
  const client = state.devices[clientId]
  if (!client || (client.kind !== 'server' && client.kind !== 'client')) return null
  const iface = client.interfaces.find((i) => i.id === ifaceId)
  return iface ? { client, iface } : null
}

/**
 * Obtention d'un bail par diffusion (DHCPDISCOVER → OFFER → REQUEST → ACK).
 * `log` : journalise les anomalies côté serveur (désactivé pour les tentatives automatiques).
 */
export function dhcpAcquire(
  state: LabState,
  clientId: string,
  ifaceId: string,
  options: { log?: boolean } = {}
): DhcpOperation {
  const found = clientPort(state, clientId, ifaceId)
  if (!found) return noChange(state, 'failed', 'Carte introuvable.')
  const { client, iface } = found
  if (iface.addressing !== 'dhcp')
    return noChange(state, 'not-dhcp', `L’adaptateur ${iface.name} n’est pas activé pour DHCP.`)
  const origin: PortRef = { deviceId: clientId, ifaceId }
  if (!client.powered || !carrierUp(state, origin))
    return noChange(
      state,
      'no-carrier',
      `Aucune opération ne peut être effectuée sur ${iface.name} lorsque son média est déconnecté.`
    )

  const rec = createRecorder()
  const ctx: SimContext = createContext(state, rec)
  const xid = `0x${((state.seq * 2654435761) >>> 0).toString(16).padStart(8, '0')}`
  const requested = iface.dhcpLease?.address ?? null
  const title = `DHCP ${client.name} (${iface.name})`

  // Conteneur : la sélection est faite dans le rappel de diffusion
  const selection: { chosen: Chosen | null } = { chosen: null }
  const unauthorized: string[] = []
  const exhausted: { serverId: string; scopeId: string }[] = []
  const relays: Relay[] = []
  const discoverFields: [string, string][] = [
    ['Transaction', xid],
    ['MAC client', iface.mac],
    ['Adresse demandée', requested ?? '—'],
    ['Nom d’hôte', client.name]
  ]

  recordBroadcast(
    ctx,
    origin,
    {
      protocol: 'DHCP',
      summary: `DHCP Discover (${iface.mac})`,
      layers: [
        ethernetLayer(iface.mac, BROADCAST_MAC, 'IPv4'),
        ipv4Layer('0.0.0.0', '255.255.255.255', 128, '17 (UDP)'),
        udpLayer(68, 67),
        dhcpLayer('DHCPDISCOVER', discoverFields)
      ]
    },
    (member) => {
      const dev = state.devices[member.port.deviceId]
      const name = dev?.name ?? '?'
      const relay = relayOf(state, member)
      if (relay) {
        relays.push(relay)
        return {
          outcome: 'delivered',
          note: `${name} est agent de relais DHCP (ip helper-address) : il retransmet la requête en unicast à ${relay.helpers.join(', ')}, en indiquant son adresse ${relay.giaddr} (giaddr).`
        }
      }
      if (dhcpServiceStopped(dev))
        return {
          outcome: 'ignored',
          note: `Le service Serveur DHCP de ${name} est arrêté : la diffusion est ignorée.`
        }
      if (!dev || !dhcpServiceOf(dev))
        return { outcome: 'ignored', note: `${name} n’est pas un serveur DHCP : la diffusion est ignorée.` }
      const scope = scopeFor(dev, member.port)
      if (!dhcpAuthorized(dev)) {
        unauthorized.push(dev.id)
        return {
          outcome: 'dropped',
          note: `${name} n’est pas autorisé dans Active Directory : son service DHCP ne distribue aucune adresse.`
        }
      }
      if (!scope) {
        const portIface = dev.interfaces.find((i) => i.id === member.port.ifaceId)
        const eff = portIface ? effectiveIpv4(portIface) : null
        return {
          outcome: 'ignored',
          note:
            eff && eff.source !== 'static'
              ? `${name} n’écoute que sur ses cartes à adresse IP statique : la requête est ignorée.`
              : `${name} n’a aucune étendue active pour ce réseau : la requête est ignorée.`
        }
      }
      // DHCP snooping : l'offre du serveur est rejetée par un switch si elle arrive sur un port non fiable
      const snooped = iosL2Inspect(state, reversePath(member.path), { kind: 'dhcp-server' })
      if (snooped) return { outcome: 'dropped', note: `${name} répond par une offre, mais ${snooped.reason}` }
      if (selection.chosen)
        return {
          outcome: 'delivered',
          note: `${name} pourrait répondre, mais le client retiendra la première offre reçue.`
        }
      const pick = pickAddress(state, scope, member.port, iface.mac, requested)
      if (!pick.ip) {
        exhausted.push({ serverId: dev.id, scopeId: scope.scopeId })
        return {
          outcome: 'dropped',
          note: `${name} n’a plus d’adresse disponible dans l’étendue ${scope.scopeId}.`
        }
      }
      selection.chosen = { member, server: dev, scope, ip: pick.ip, bad: pick.bad, relay: null }
      return {
        outcome: 'delivered',
        note: `${name} dispose de l’étendue « ${scope.name} » : il réserve ${pick.ip} et prépare une offre.`
      }
    }
  )

  // Aucun serveur sur le segment : les agents de relais transmettent la découverte
  for (const relay of selection.chosen ? [] : relays) {
    for (const helper of relay.helpers) {
      if (selection.chosen) break
      const delivery = relayLeg(ctx, relay.member.port.deviceId, {
        src: relay.giaddr,
        dst: helper,
        type: 'DHCPDISCOVER',
        summary: `DHCP Discover relayé (giaddr ${relay.giaddr})`,
        giaddr: relay.giaddr,
        fields: discoverFields
      })
      if (delivery.kind !== 'delivered') continue
      const dev = state.devices[delivery.deviceId]
      const name = dev?.name ?? '?'
      if (!dev || !dhcpServiceOf(dev)) {
        setLastOutcome(
          ctx,
          'dropped',
          dhcpServiceStopped(dev)
            ? `Le service Serveur DHCP de ${name} est arrêté : la requête relayée est rejetée.`
            : `${name} n’est pas un serveur DHCP : la requête relayée est rejetée.`
        )
        continue
      }
      if (!dhcpAuthorized(dev)) {
        unauthorized.push(dev.id)
        setLastOutcome(
          ctx,
          'dropped',
          `${name} n’est pas autorisé dans Active Directory : son service DHCP ne distribue aucune adresse.`
        )
        continue
      }
      const scope = scopeForRelay(dev, relay.giaddr)
      if (!scope) {
        setLastOutcome(
          ctx,
          'dropped',
          `${name} n’a aucune étendue active pour le réseau de l’agent de relais ${relay.giaddr} : la requête est ignorée.`
        )
        continue
      }
      const pick = pickAddress(state, scope, relay.member.port, iface.mac, requested)
      if (!pick.ip) {
        exhausted.push({ serverId: dev.id, scopeId: scope.scopeId })
        setLastOutcome(
          ctx,
          'dropped',
          `${name} n’a plus d’adresse disponible dans l’étendue ${scope.scopeId}.`
        )
        continue
      }
      setLastOutcome(
        ctx,
        'delivered',
        `${name} choisit l’étendue « ${scope.name} » (${scope.scopeId}) d’après l’adresse de l’agent de relais ${relay.giaddr} : il réserve ${pick.ip}.`
      )
      // L'offre repart vers l'agent de relais : le serveur doit avoir une route vers son réseau
      const serverIp = sourceAddressFor(state, dev, relay.giaddr)
      const offer = serverIp
        ? relayLeg(ctx, dev.id, {
            src: serverIp,
            dst: relay.giaddr,
            type: 'DHCPOFFER',
            summary: `DHCP Offer ${pick.ip} (vers l’agent de relais)`,
            giaddr: relay.giaddr,
            fields: [['Transaction', xid], ...offerFields(dev, scope, pick.ip, serverIp)]
          })
        : null
      // DHCP snooping : l'agent de relais retransmet l'offre au client par un port de switch non fiable
      const relayed =
        offer?.kind === 'delivered'
          ? iosL2Inspect(state, reversePath(relay.member.path), { kind: 'dhcp-server' })
          : null
      if (relayed) {
        setLastOutcome(ctx, 'dropped', `L’offre relayée vers ${client.name} est rejetée : ${relayed.reason}`)
        continue
      }
      if (!serverIp || offer?.kind !== 'delivered') {
        if (!serverIp)
          setLastOutcome(
            ctx,
            'dropped',
            `${name} n’a aucune route vers l’agent de relais ${relay.giaddr} (passerelle par défaut ?) : son offre ne peut pas partir.`
          )
        continue
      }
      selection.chosen = {
        member: relay.member,
        server: dev,
        scope,
        ip: pick.ip,
        bad: pick.bad,
        relay: { giaddr: relay.giaddr, serverIp }
      }
    }
  }

  const pickResult = selection.chosen
  const logAnomalies = (draft: Parameters<Parameters<typeof transact>[1]>[0]) => {
    if (!options.log) return
    for (const id of new Set(unauthorized)) {
      const d = draft.devices[id]
      logEvent(draft, id, {
        level: 'error',
        source: 'DhcpServer',
        eventId: 1046,
        message: `Le service Serveur DHCP de l’ordinateur local, membre du domaine ${d && d.kind === 'server' ? d.host.domain : ''}, a déterminé qu’il n’est pas autorisé à démarrer. Il n’a servi aucun client.`
      })
    }
    for (const ex of exhausted) {
      logEvent(draft, ex.serverId, {
        level: 'warning',
        source: 'DhcpServer',
        eventId: 1063,
        message: `Aucune adresse IP n’est disponible pour un bail dans l’étendue ${ex.scopeId}.`
      })
    }
  }

  if (!pickResult) {
    const result = transact(state, (draft) => {
      const d = draft.devices[clientId]
      const target = d?.interfaces.find((i) => i.id === ifaceId)
      if (target) {
        target.dhcpLease = null
        target.dhcpReleased = false
      }
      logAnomalies(draft)
      return undefined
    })
    return {
      state: result.ok ? result.state : state,
      trace: { title, events: rec.events },
      outcome: 'failed',
      address: null,
      message: `Impossible de contacter votre serveur DHCP. Le délai d’attente de la demande a expiré.`
    }
  }

  const { member, server, scope, ip, bad, relay } = pickResult
  // Sur le segment du client, l'interlocuteur est le serveur ou l'agent de relais
  const peerIface = state.devices[member.port.deviceId]?.interfaces.find((i) => i.id === member.port.ifaceId)
  const peerIp = peerIface ? (effectiveIpv4(peerIface)?.address ?? '') : ''
  const serverIp = relay ? relay.serverIp : peerIp
  const serverMac = peerIface?.mac ?? ''
  const relayName = state.devices[member.port.deviceId]?.name ?? '?'
  const opts = scopeOptions(server, scope)
  const optionFields = offerFields(server, scope, ip, serverIp)
  const back = reversePath(member.path)
  recordUnicast(
    ctx,
    back,
    {
      protocol: 'DHCP',
      summary: `DHCP Offer ${ip} (de ${serverIp})`,
      layers: [
        ethernetLayer(serverMac, iface.mac, 'IPv4'),
        ipv4Layer(relay ? peerIp : serverIp, '255.255.255.255', 128, '17 (UDP)'),
        udpLayer(67, 68),
        dhcpLayer('DHCPOFFER', [['Transaction', xid], ...optionFields])
      ]
    },
    'delivered',
    relay
      ? `${client.name} reçoit l’offre ${ip} de ${server.name}, retransmise par l’agent de relais ${relayName}.`
      : `${client.name} reçoit l’offre ${ip} de ${server.name}.`
  )
  recordBroadcast(
    ctx,
    origin,
    {
      protocol: 'DHCP',
      summary: `DHCP Request ${ip} (serveur ${serverIp})`,
      layers: [
        ethernetLayer(iface.mac, BROADCAST_MAC, 'IPv4'),
        ipv4Layer('0.0.0.0', '255.255.255.255', 128, '17 (UDP)'),
        udpLayer(68, 67),
        dhcpLayer('DHCPREQUEST', [
          ['Transaction', xid],
          ['Adresse demandée', ip],
          ['Identificateur du serveur', serverIp]
        ])
      ]
    },
    (m) => {
      const dev = state.devices[m.port.deviceId]
      if (relay && dev && dev.id === member.port.deviceId && m.port.ifaceId === member.port.ifaceId)
        return {
          outcome: 'delivered',
          note: `${dev.name} retransmet la requête à ${server.name} (${serverIp}).`
        }
      if (dev && dev.id === server.id && m.port.ifaceId === member.port.ifaceId)
        return {
          outcome: 'delivered',
          note: `${dev.name} est le serveur choisi : il valide le bail de ${ip}.`
        }
      if (dev && dhcpServiceOf(dev))
        return {
          outcome: 'ignored',
          note: `${dev.name} n’a pas été choisi : il libère l’adresse qu’il avait réservée.`
        }
      return { outcome: 'ignored', note: `${dev?.name ?? '?'} ignore la requête DHCP.` }
    }
  )
  if (relay) {
    relayLeg(ctx, member.port.deviceId, {
      src: relay.giaddr,
      dst: serverIp,
      type: 'DHCPREQUEST',
      summary: `DHCP Request ${ip} relayé`,
      giaddr: relay.giaddr,
      fields: [
        ['Transaction', xid],
        ['Adresse demandée', ip],
        ['Identificateur du serveur', serverIp]
      ]
    })
    setLastOutcome(ctx, 'delivered', `${server.name} valide le bail de ${ip}.`)
    relayLeg(ctx, server.id, {
      src: serverIp,
      dst: relay.giaddr,
      type: 'DHCPACK',
      summary: `DHCP Ack ${ip} (vers l’agent de relais)`,
      giaddr: relay.giaddr,
      fields: [['Transaction', xid], ...optionFields]
    })
  }
  recordUnicast(
    ctx,
    back,
    {
      protocol: 'DHCP',
      summary: `DHCP Ack ${ip}`,
      layers: [
        ethernetLayer(serverMac, iface.mac, 'IPv4'),
        ipv4Layer(relay ? peerIp : serverIp, ip, 128, '17 (UDP)'),
        udpLayer(67, 68),
        dhcpLayer('DHCPACK', [['Transaction', xid], ...optionFields])
      ]
    },
    'delivered',
    `${client.name} configure ${iface.name} : ${ip}/${scope.prefixLength}, passerelle ${opts.router[0] ?? 'aucune'}.`
  )

  const result = transact(state, (draft) => {
    const srv = draft.devices[server.id]
    const cli = draft.devices[clientId]
    const srvDhcp = dhcpServiceOf(srv)
    if (!srv || !srvDhcp || !cli || (cli.kind !== 'server' && cli.kind !== 'client')) return undefined
    const sc = srvDhcp.scopes.find((s) => s.scopeId === scope.scopeId)
    if (!sc) return undefined
    const expiresAt = draft.clock + scope.leaseDurationSec * 1000
    for (const b of bad) {
      if (!sc.leases.some((l) => l.ip === b))
        sc.leases.push({ ip: b, mac: '', hostName: 'BAD_ADDRESS', expiresAt, state: 'BadAddress' })
    }
    sc.leases = sc.leases.filter((l) => !(l.mac === iface.mac && l.state === 'Active'))
    sc.leases.push({ ip, mac: iface.mac, hostName: hostFqdn(cli), expiresAt, state: 'Active' })
    const granted = linuxLease(draft.clock, srv, cli, ip, iface.mac, expiresAt)
    if (granted && srv.kind === 'server') leaseGranted(draft, srv, granted)
    if (srv.kind === 'firewall')
      pfLeaseGranted(draft, srv.id, { ip, mac: iface.mac, hostname: cli.name, expires: expiresAt })
    const target = cli.interfaces.find((i) => i.id === ifaceId)
    if (target) {
      target.dhcpLease = {
        address: ip,
        prefixLength: scope.prefixLength,
        gateway: opts.router[0] ?? null,
        dnsServers: [...opts.dnsServers],
        dnsSuffix: opts.dnsDomain,
        serverId: serverIp,
        serverDeviceId: server.id,
        obtainedAt: draft.clock,
        expiresAt
      }
      target.dhcpReleased = false
    }
    // Un membre du domaine inscrit sa nouvelle adresse dans le DNS
    registerHostDns(draft, cli)
    logAnomalies(draft)
    return undefined
  })
  return {
    state: result.ok ? result.state : state,
    trace: { title, events: rec.events },
    outcome: 'bound',
    address: ip,
    message: ''
  }
}

/** ipconfig /renew : renouvellement unicast si le serveur du bail répond, sinon nouvelle découverte. */
export function dhcpRenew(state: LabState, clientId: string, ifaceId: string): DhcpOperation {
  const found = clientPort(state, clientId, ifaceId)
  if (!found) return noChange(state, 'failed', 'Carte introuvable.')
  const { client, iface } = found
  const lease = iface.dhcpLease
  if (iface.addressing !== 'dhcp' || !lease || iface.dhcpReleased)
    return dhcpAcquire(state, clientId, ifaceId, { log: true })
  const origin: PortRef = { deviceId: clientId, ifaceId }
  if (!client.powered || !carrierUp(state, origin))
    return dhcpAcquire(state, clientId, ifaceId, { log: true })
  const member = l2Segment(state, origin).find((m) => m.port.deviceId === lease.serverDeviceId)
  const server = state.devices[lease.serverDeviceId]
  const scope =
    server && member
      ? dhcpServiceOf(server)?.scopes.find((s) =>
          s.leases.some((l) => l.mac === iface.mac && l.ip === lease.address && l.state === 'Active')
        )
      : undefined
  if (
    !member ||
    !server ||
    !dhcpServiceOf(server) ||
    !scope ||
    !dhcpAuthorized(server) ||
    !server.powered ||
    scope.state !== 'Active' ||
    // DHCP snooping : la réponse du serveur du bail serait rejetée (port non fiable)
    iosL2Inspect(state, reversePath(member.path), { kind: 'dhcp-server' })
  )
    return dhcpAcquire(state, clientId, ifaceId, { log: true })

  const rec = createRecorder()
  const ctx = createContext(state, rec)
  const serverIface = server.interfaces.find((i) => i.id === member.port.ifaceId)
  const serverMac = serverIface?.mac ?? ''
  recordUnicast(
    ctx,
    member.path,
    {
      protocol: 'DHCP',
      summary: `DHCP Request (renouvellement de ${lease.address})`,
      layers: [
        ethernetLayer(iface.mac, serverMac, 'IPv4'),
        ipv4Layer(lease.address, lease.serverId, 128, '17 (UDP)'),
        udpLayer(68, 67),
        dhcpLayer('DHCPREQUEST', [['Adresse client', lease.address]])
      ]
    },
    'delivered',
    `${server.name} retrouve le bail de ${lease.address} et le prolonge.`
  )
  recordUnicast(
    ctx,
    reversePath(member.path),
    {
      protocol: 'DHCP',
      summary: `DHCP Ack ${lease.address}`,
      layers: [
        ethernetLayer(serverMac, iface.mac, 'IPv4'),
        ipv4Layer(lease.serverId, lease.address, 128, '17 (UDP)'),
        udpLayer(67, 68),
        dhcpLayer('DHCPACK', [
          ['Adresse', lease.address],
          ['Durée du bail', formatLeaseDuration(scope.leaseDurationSec)]
        ])
      ]
    },
    'delivered',
    `${client.name} conserve ${lease.address} pour une nouvelle durée de bail.`
  )
  const result = transact(state, (draft) => {
    const srv = draft.devices[server.id]
    const cli = draft.devices[clientId]
    const expiresAt = draft.clock + scope.leaseDurationSec * 1000
    if (srv) {
      const l = dhcpServiceOf(srv)
        ?.scopes.find((s) => s.scopeId === scope.scopeId)
        ?.leases.find((x) => x.mac === iface.mac)
      if (l) l.expiresAt = expiresAt
      const renewed =
        srv && cli ? linuxLease(draft.clock, srv, cli, lease.address, iface.mac, expiresAt) : null
      if (renewed && srv?.kind === 'server') leaseRenewed(draft, srv, renewed)
      if (srv.kind === 'firewall') pfLeaseRenewed(draft, srv.id, iface.mac, expiresAt)
    }
    const target = cli?.interfaces.find((i) => i.id === ifaceId)
    if (target?.dhcpLease) {
      target.dhcpLease.obtainedAt = draft.clock
      target.dhcpLease.expiresAt = expiresAt
      // Les options peuvent avoir changé côté serveur
      const srvDhcp = dhcpServiceOf(srv)
      const opts = srvDhcp ? effectiveOptions(srvDhcp, scope) : null
      if (opts) {
        target.dhcpLease.gateway = opts.router[0] ?? null
        target.dhcpLease.dnsServers = [...opts.dnsServers]
        target.dhcpLease.dnsSuffix = opts.dnsDomain
      }
    }
    return undefined
  })
  return {
    state: result.ok ? result.state : state,
    trace: { title: `DHCP ${client.name} (renouvellement)`, events: rec.events },
    outcome: 'renewed',
    address: lease.address,
    message: ''
  }
}

/** ipconfig /release : rend le bail au serveur ; la carte n'a plus d'adresse IPv4. */
export function dhcpRelease(state: LabState, clientId: string, ifaceId: string): DhcpOperation {
  const found = clientPort(state, clientId, ifaceId)
  if (!found) return noChange(state, 'failed', 'Carte introuvable.')
  const { client, iface } = found
  const lease = iface.dhcpLease
  const rec = createRecorder()
  if (lease) {
    const origin: PortRef = { deviceId: clientId, ifaceId }
    const member = carrierUp(state, origin)
      ? l2Segment(state, origin).find((m) => m.port.deviceId === lease.serverDeviceId)
      : undefined
    if (member) {
      const ctx = createContext(state, rec)
      const serverMac =
        state.devices[member.port.deviceId]?.interfaces.find((i) => i.id === member.port.ifaceId)?.mac ?? ''
      recordUnicast(
        ctx,
        member.path,
        {
          protocol: 'DHCP',
          summary: `DHCP Release ${lease.address}`,
          layers: [
            ethernetLayer(iface.mac, serverMac, 'IPv4'),
            ipv4Layer(lease.address, lease.serverId, 128, '17 (UDP)'),
            udpLayer(68, 67),
            dhcpLayer('DHCPRELEASE', [['Adresse libérée', lease.address]])
          ]
        },
        'delivered',
        `Le serveur supprime le bail de ${lease.address} : l’adresse redevient disponible.`
      )
    }
  }
  const result = transact(state, (draft) => {
    const srv = lease ? draft.devices[lease.serverDeviceId] : undefined
    const srvDhcp = dhcpServiceOf(srv)
    if (srvDhcp) {
      for (const sc of srvDhcp.scopes)
        sc.leases = sc.leases.filter((l) => !(l.mac === iface.mac && l.state === 'Active'))
    }
    const cliDev = draft.devices[clientId]
    const freed =
      srv && lease && cliDev
        ? linuxLease(draft.clock, srv, cliDev, lease.address, iface.mac, draft.clock)
        : null
    if (freed && srv?.kind === 'server' && srvDhcp) leaseReleased(draft, srv, freed)
    if (srv?.kind === 'firewall') pfLeaseReleased(draft, srv.id, iface.mac)
    const target = draft.devices[clientId]?.interfaces.find((i) => i.id === ifaceId)
    if (target) {
      target.dhcpLease = null
      target.dhcpReleased = true
    }
    return undefined
  })
  return {
    state: result.ok ? result.state : state,
    trace: { title: `DHCP ${client.name} (libération)`, events: rec.events },
    outcome: 'released',
    address: null,
    message: ''
  }
}

/**
 * Configuration automatique : les cartes en DHCP sans bail (et non libérées manuellement)
 * tentent d'obtenir une adresse, comme le fait le client DHCP en tâche de fond.
 */
export function autoConfigureDhcp(state: LabState): { state: LabState; traces: PacketTrace[] } {
  let current = state
  const traces: PacketTrace[] = []
  for (const device of Object.values(state.devices)) {
    if ((device.kind !== 'server' && device.kind !== 'client') || !device.powered) continue
    for (const iface of device.interfaces) {
      if (iface.addressing !== 'dhcp' || iface.dhcpLease || iface.dhcpReleased || !iface.enabled) continue
      if (!carrierUp(current, { deviceId: device.id, ifaceId: iface.id })) continue
      const op = dhcpAcquire(current, device.id, iface.id)
      if (op.outcome === 'bound') {
        current = op.state
        traces.push(op.trace)
      }
    }
  }
  return { state: current, traces }
}
