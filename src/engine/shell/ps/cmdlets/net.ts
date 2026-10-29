/**
 * Cmdlets réseau (module NetTCPIP / DnsClient).
 */
import type { HostDevice } from '../../../model/schema'
import { serverExchange } from '../../../roles/adds/locator'
import { tcpListening } from '../../../services/listening'
import type { Protocol } from '../../../sim/trace'
import { effectiveIpv4 } from '../../../net/addressing'
import { clearInterfaceAddress, setInterfaceIpv4 } from '../../../net/config'
import { ipConflicts } from '../../../net/conflicts'
import { ping } from '../../../net/diagnostics'
import { isIpv4 } from '../../../net/ipv4'
import { carrierUp } from '../../../net/segment'
import type { NetInterface } from '../../../model/schema'
import { resolveForTool } from '../../tools/net'
import { psError } from '../errors'
import type { CmdContext } from '../interpreter'
import type { CmdletDef } from '../registry'
import { flatten, psObject, psToString, type PsValue } from '../values'
import { findInterface, ifIndexOf, interfaceNames } from './helpers'

const ifaceParams = [
  { name: 'InterfaceAlias', type: 'string' as const, aliases: ['ifAlias'], complete: interfaceNames },
  { name: 'InterfaceIndex', type: 'int' as const, aliases: ['ifIndex'] }
]

function adapterStatus(ctx: CmdContext, iface: NetInterface): string {
  if (!iface.enabled) return 'Disabled'
  return carrierUp(ctx.state, { deviceId: ctx.deviceId, ifaceId: iface.id }) ? 'Up' : 'Disconnected'
}

function ipAddressObject(ctx: CmdContext, iface: NetInterface): PsValue {
  const eff = effectiveIpv4(iface)
  if (!eff) return null
  const conflict = ipConflicts(ctx.state).has(`${ctx.deviceId}/${iface.id}`)
  const origin = eff.source === 'static' ? 'Manual' : eff.source === 'dhcp' ? 'Dhcp' : 'WellKnown'
  return psObject(
    'NetIPAddress',
    {
      IPAddress: eff.address,
      InterfaceIndex: ifIndexOf(ctx, iface),
      InterfaceAlias: iface.name,
      AddressFamily: 'IPv4',
      Type: 'Unicast',
      PrefixLength: eff.prefixLength,
      PrefixOrigin: origin,
      SuffixOrigin: eff.source === 'apipa' ? 'Link' : origin,
      AddressState: conflict ? 'Duplicate' : 'Preferred',
      ValidLifetime: eff.source === 'dhcp' ? '8.00:00:00' : 'Infinite ([TimeSpan]::MaxValue)',
      PreferredLifetime: eff.source === 'dhcp' ? '8.00:00:00' : 'Infinite ([TimeSpan]::MaxValue)',
      SkipAsSource: false,
      PolicyStore: 'ActiveStore'
    },
    {
      kind: 'list',
      props: [
        'IPAddress',
        'InterfaceIndex',
        'InterfaceAlias',
        'AddressFamily',
        'Type',
        'PrefixLength',
        'PrefixOrigin',
        'SuffixOrigin',
        'AddressState',
        'ValidLifetime',
        'PreferredLifetime',
        'SkipAsSource',
        'PolicyStore'
      ]
    }
  )
}

function loopbackObject(): PsValue {
  return psObject(
    'NetIPAddress',
    {
      IPAddress: '127.0.0.1',
      InterfaceIndex: 1,
      InterfaceAlias: 'Loopback Pseudo-Interface 1',
      AddressFamily: 'IPv4',
      Type: 'Unicast',
      PrefixLength: 8,
      PrefixOrigin: 'WellKnown',
      SuffixOrigin: 'WellKnown',
      AddressState: 'Preferred',
      ValidLifetime: 'Infinite ([TimeSpan]::MaxValue)',
      PreferredLifetime: 'Infinite ([TimeSpan]::MaxValue)',
      SkipAsSource: false,
      PolicyStore: 'ActiveStore'
    },
    {
      kind: 'list',
      props: [
        'IPAddress',
        'InterfaceIndex',
        'InterfaceAlias',
        'AddressFamily',
        'Type',
        'PrefixLength',
        'PrefixOrigin',
        'SuffixOrigin',
        'AddressState',
        'ValidLifetime',
        'PreferredLifetime',
        'SkipAsSource',
        'PolicyStore'
      ]
    }
  )
}

function applyWarnings(ctx: CmdContext, warnings: string[]): void {
  for (const w of warnings) ctx.warn(w)
}

export const netCmdlets: CmdletDef[] = [
  {
    name: 'Get-NetAdapter',
    module: 'NetAdapter',
    synopsis: 'Liste les cartes réseau.',
    params: [{ name: 'Name', type: 'string', position: 0, complete: interfaceNames }],
    run(ctx, args) {
      const name = args['Name'] ? psToString(args['Name']).toLowerCase() : null
      const ifaces = ctx.host.interfaces.filter((i) => i.l3 && (!name || i.name.toLowerCase() === name))
      if (name && ifaces.length === 0)
        throw psError(
          `Aucun objet NetAdapter trouvé avec la propriété « Name » égale à « ${psToString(args['Name'])} ».`,
          'ObjectNotFound',
          'NetAdapter_NotFound'
        )
      return ifaces.map((i) =>
        psObject(
          'NetAdapter',
          {
            Name: i.name,
            InterfaceDescription: 'Carte réseau Ethernet virtuelle',
            ifIndex: ifIndexOf(ctx, i),
            Status: adapterStatus(ctx, i),
            MacAddress: i.mac,
            LinkSpeed: adapterStatus(ctx, i) === 'Up' ? '1 Gbps' : '0 bps'
          },
          {
            kind: 'table',
            props: ['Name', 'InterfaceDescription', 'ifIndex', 'Status', 'MacAddress', 'LinkSpeed']
          }
        )
      )
    }
  },
  {
    name: 'Get-NetIPAddress',
    module: 'NetTCPIP',
    synopsis: 'Affiche les adresses IP.',
    params: [
      { name: 'IPAddress', type: 'string', position: 0 },
      ...ifaceParams,
      { name: 'AddressFamily', type: 'string', validateSet: ['IPv4', 'IPv6'] }
    ],
    run(ctx, args) {
      if (args['AddressFamily'] === 'IPv6') return []
      const filtered = findInterface(ctx, args, false)
      const objects: PsValue[] = []
      for (const iface of ctx.host.interfaces.filter((i) => i.l3)) {
        if (filtered && filtered.id !== iface.id) continue
        const o = ipAddressObject(ctx, iface)
        if (o) objects.push(o)
      }
      if (!filtered) objects.push(loopbackObject())
      if (args['IPAddress']) {
        const ip = psToString(args['IPAddress'])
        const match = objects.filter(
          (o) =>
            typeof o === 'object' &&
            o !== null &&
            !Array.isArray(o) &&
            o.kind === 'object' &&
            o.props['IPAddress'] === ip
        )
        if (match.length === 0)
          throw psError(
            `Aucun objet NetIPAddress trouvé avec la propriété « IPAddress » égale à « ${ip} ».`,
            'ObjectNotFound',
            'CmdletizationQuery_NotFound_IPAddress',
            ip
          )
        return match
      }
      return objects
    }
  },
  {
    name: 'New-NetIPAddress',
    module: 'NetTCPIP',
    synopsis: 'Attribue une adresse IPv4 statique à une carte.',
    params: [
      { name: 'IPAddress', type: 'string', mandatory: true, position: 0 },
      ...ifaceParams,
      { name: 'PrefixLength', type: 'int' },
      { name: 'DefaultGateway', type: 'string' },
      { name: 'AddressFamily', type: 'string', validateSet: ['IPv4', 'IPv6'] }
    ],
    run(ctx, args) {
      const iface = findInterface(ctx, args) as NetInterface
      const ip = psToString(args['IPAddress'])
      if (!isIpv4(ip))
        throw psError(
          `Impossible de convertir « ${ip} » en adresse IP.`,
          'InvalidArgument',
          'InvalidIPAddress',
          ip
        )
      const prefix = typeof args['PrefixLength'] === 'number' ? args['PrefixLength'] : 8
      if (iface.addressing === 'static' && iface.address) {
        if (iface.address === ip)
          throw psError('L’objet existe déjà.', 'ResourceExists', 'SystemError5010', 'NetIPAddress')
        throw psError(
          `La carte ${iface.name} possède déjà l’adresse ${iface.address}. Le simulateur gère une seule adresse IPv4 par carte : supprimez-la d’abord avec Remove-NetIPAddress.`,
          'ResourceExists',
          'SingleAddressPerInterface',
          iface.name
        )
      }
      const gateway = args['DefaultGateway'] ? psToString(args['DefaultGateway']) : null
      if (gateway && iface.gateway)
        throw psError('Instance DefaultGateway already exists', 'InvalidArgument', 'DefaultGatewayExists')
      const result = ctx.apply(
        setInterfaceIpv4(ctx.state, ctx.deviceId, iface.id, {
          addressing: 'static',
          address: ip,
          mask: String(prefix),
          gateway,
          dnsMode: 'static',
          dnsServers: iface.dnsServers
        })
      )
      applyWarnings(ctx, result.warnings)
      const updated = ctx.host.interfaces.find((i) => i.id === iface.id) as NetInterface
      return [ipAddressObject(ctx, updated)]
    }
  },
  {
    name: 'Remove-NetIPAddress',
    module: 'NetTCPIP',
    synopsis: 'Supprime une adresse IP.',
    params: [
      { name: 'IPAddress', type: 'string', position: 0 },
      ...ifaceParams,
      { name: 'AddressFamily', type: 'string' }
    ],
    run(ctx, args) {
      const ip = args['IPAddress'] ? psToString(args['IPAddress']) : null
      const byIface = findInterface(ctx, args, false)
      const targets = ctx.host.interfaces.filter(
        (i) =>
          i.l3 &&
          i.addressing === 'static' &&
          i.address &&
          (!ip || i.address === ip) &&
          (!byIface || byIface.id === i.id)
      )
      if (targets.length === 0)
        throw psError(
          `Aucun objet NetIPAddress trouvé avec la propriété « IPAddress » égale à « ${ip ?? '*'} ».`,
          'ObjectNotFound',
          'CmdletizationQuery_NotFound_IPAddress'
        )
      for (const iface of targets) {
        if (
          !ctx.confirm(
            `IPAddress: ${iface.address} DefaultGateway: ${iface.gateway ?? ''} InterfaceAlias: ${iface.name}`,
            'Delete'
          )
        )
          continue
        ctx.apply(clearInterfaceAddress(ctx.state, ctx.deviceId, iface.id))
      }
    }
  },
  {
    name: 'Set-NetIPInterface',
    module: 'NetTCPIP',
    synopsis: 'Active ou désactive le DHCP sur une carte.',
    params: [
      ...ifaceParams,
      { name: 'Dhcp', type: 'string', validateSet: ['Enabled', 'Disabled'] },
      { name: 'AddressFamily', type: 'string' }
    ],
    run(ctx, args) {
      const iface = findInterface(ctx, args) as NetInterface
      if (args['Dhcp'] === 'Enabled')
        ctx.apply(
          setInterfaceIpv4(ctx.state, ctx.deviceId, iface.id, { addressing: 'dhcp', dnsMode: iface.dnsMode })
        )
    }
  },
  {
    name: 'Set-DnsClientServerAddress',
    module: 'DnsClient',
    synopsis: 'Définit les serveurs DNS d’une carte.',
    params: [
      ...ifaceParams,
      { name: 'ServerAddresses', type: 'string[]', aliases: ['Addresses'] },
      { name: 'ResetServerAddresses', type: 'switch' }
    ],
    run(ctx, args) {
      const iface = findInterface(ctx, args) as NetInterface
      const servers =
        args['ResetServerAddresses'] === true ? [] : flatten([args['ServerAddresses'] ?? []]).map(psToString)
      for (const s of servers)
        if (!isIpv4(s))
          throw psError(
            `« ${s} » n’est pas une adresse de serveur DNS valide.`,
            'InvalidArgument',
            'InvalidDnsServer',
            s
          )
      const reset = args['ResetServerAddresses'] === true
      ctx.apply(
        setInterfaceIpv4(ctx.state, ctx.deviceId, iface.id, {
          addressing: iface.addressing,
          address: iface.address,
          mask: iface.prefixLength !== null ? String(iface.prefixLength) : '',
          gateway: iface.gateway,
          dnsMode: reset && iface.addressing === 'dhcp' ? 'dhcp' : 'static',
          dnsServers: servers
        })
      )
    }
  },
  {
    name: 'Get-DnsClientServerAddress',
    module: 'DnsClient',
    synopsis: 'Affiche les serveurs DNS de chaque carte.',
    params: [...ifaceParams, { name: 'AddressFamily', type: 'string', validateSet: ['IPv4', 'IPv6'] }],
    run(ctx, args) {
      const filtered = findInterface(ctx, args, false)
      return ctx.host.interfaces
        .filter((i) => i.l3 && (!filtered || filtered.id === i.id))
        .map((i) =>
          psObject(
            'DNSClientServerAddress',
            {
              InterfaceAlias: i.name,
              'Interface Index': ifIndexOf(ctx, i),
              AddressFamily: 'IPv4',
              ServerAddresses: effectiveIpv4(i)?.dnsServers ?? []
            },
            {
              kind: 'table',
              props: ['InterfaceAlias', 'Interface Index', 'AddressFamily', 'ServerAddresses']
            }
          )
        )
    }
  },
  {
    name: 'Get-NetIPConfiguration',
    aliases: ['gip'],
    module: 'NetTCPIP',
    synopsis: 'Affiche la configuration IP de chaque carte.',
    params: [...ifaceParams, { name: 'Detailed', type: 'switch' }],
    run(ctx, args) {
      const filtered = findInterface(ctx, args, false)
      return ctx.host.interfaces
        .filter((i) => i.l3 && (!filtered || filtered.id === i.id))
        .map((i) => {
          const eff = effectiveIpv4(i)
          return psObject(
            'NetIPConfiguration',
            {
              InterfaceAlias: i.name,
              InterfaceIndex: ifIndexOf(ctx, i),
              InterfaceDescription: 'Carte réseau Ethernet virtuelle',
              IPv4Address: eff?.address ?? '',
              IPv4DefaultGateway: eff?.gateway ?? '',
              DNSServer: eff?.dnsServers ?? []
            },
            {
              kind: 'list',
              props: [
                'InterfaceAlias',
                'InterfaceIndex',
                'InterfaceDescription',
                'IPv4Address',
                'IPv4DefaultGateway',
                'DNSServer'
              ]
            }
          )
        })
    }
  },
  {
    name: 'Test-Connection',
    module: 'Management',
    synopsis: 'Envoie des requêtes d’écho ICMP.',
    params: [
      { name: 'ComputerName', type: 'string', position: 0, mandatory: true, aliases: ['CN', 'IPAddress'] },
      { name: 'Count', type: 'int' },
      { name: 'Quiet', type: 'switch' }
    ],
    run(ctx, args) {
      const target = psToString(args['ComputerName'])
      const resolved = resolveForTool(ctx, target)
      const fail = () =>
        psError(
          `Échec du test de connexion à l’ordinateur « ${target} » : Délai d’attente de la demande dépassé`,
          'ResourceUnavailable',
          'TestConnectionException',
          target
        )
      if (!resolved) {
        if (args['Quiet'] === true) return [false]
        throw psError(
          `Échec du test de connexion à l’ordinateur « ${target} » : Hôte inconnu`,
          'ResourceUnavailable',
          'TestConnectionException',
          target
        )
      }
      const count = typeof args['Count'] === 'number' ? args['Count'] : 4
      const result = ping(ctx.state, ctx.deviceId, resolved.ip, { count })
      if (!result.ok) throw fail()
      ctx.addTrace(result.value.trace)
      if (args['Quiet'] === true) return [result.value.success]
      const replies = result.value.outcomes.filter((o) => o.kind === 'reply')
      if (replies.length === 0) throw fail()
      return replies.map((r) =>
        psObject(
          'PingStatus',
          {
            Source: ctx.host.name,
            Destination: target,
            IPV4Address: resolved.ip,
            IPV6Address: '',
            Bytes: 32,
            'Time(ms)': r.kind === 'reply' ? r.time : 0
          },
          {
            kind: 'table',
            props: ['Source', 'Destination', 'IPV4Address', 'IPV6Address', 'Bytes', 'Time(ms)']
          }
        )
      )
    }
  },
  {
    name: 'Test-NetConnection',
    aliases: ['tnc'],
    module: 'NetTCPIP',
    synopsis: 'Diagnostic de connectivité (ping, ou connexion TCP avec -Port).',
    params: [
      { name: 'ComputerName', type: 'string', position: 0 },
      { name: 'Port', type: 'int' }
    ],
    run(ctx, args) {
      const target = args['ComputerName'] ? psToString(args['ComputerName']) : '8.8.8.8'
      const resolved = resolveForTool(ctx, target)
      if (!resolved) {
        ctx.warn(`Échec de la résolution du nom ${target}`)
        return [
          psObject(
            'TestNetConnectionResult',
            { ComputerName: target, RemoteAddress: '', PingSucceeded: false },
            { kind: 'list', props: ['ComputerName', 'RemoteAddress', 'PingSucceeded'] }
          )
        ]
      }
      const egress = ctx.host.interfaces.find((i) => effectiveIpv4(i))
      // -Port (Learn, exemple 3) : connexion TCP ; réussie si le port écoute sur la cible (rôle
      // installé, service démarré) et si le pare-feu et les listes d'accès IOS du chemin la laissent passer
      if (args['Port'] !== undefined) {
        const port = Number(args['Port'])
        const tcp = tcpTest(ctx, resolved.ip, port)
        const base = {
          ComputerName: target,
          RemoteAddress: resolved.ip,
          RemotePort: port,
          InterfaceAlias: egress?.name ?? '',
          SourceAddress: egress ? (effectiveIpv4(egress)?.address ?? '') : ''
        }
        if (tcp)
          return [
            psObject(
              'TestNetConnectionResult',
              { ...base, TcpTestSucceeded: true },
              { kind: 'list', props: [...Object.keys(base), 'TcpTestSucceeded'] }
            )
          ]
        ctx.warn(`Échec de la connexion TCP à (${resolved.ip} : ${port})`)
        const pinged = ping(ctx.state, ctx.deviceId, resolved.ip, { count: 1 })
        if (pinged.ok) ctx.addTrace(pinged.value.trace)
        const pong = pinged.ok ? pinged.value.outcomes.find((o) => o.kind === 'reply') : undefined
        if (!pong) ctx.warn(`Échec du ping vers ${target} (${resolved.ip})`)
        return [
          psObject(
            'TestNetConnectionResult',
            {
              ...base,
              PingSucceeded: !!pong,
              'PingReplyDetails (RTT)': pong && pong.kind === 'reply' ? `${pong.time} ms` : '0 ms',
              TcpTestSucceeded: false
            },
            {
              kind: 'list',
              props: [...Object.keys(base), 'PingSucceeded', 'PingReplyDetails (RTT)', 'TcpTestSucceeded']
            }
          )
        ]
      }
      const result = ping(ctx.state, ctx.deviceId, resolved.ip, { count: 1 })
      if (!result.ok) throw psError(result.error.message, 'InvalidOperation', result.error.code)
      ctx.addTrace(result.value.trace)
      const reply = result.value.outcomes.find((o) => o.kind === 'reply')
      if (!reply) ctx.warn(`Échec du ping vers ${target} (${resolved.ip})`)
      return [
        psObject(
          'TestNetConnectionResult',
          {
            ComputerName: target,
            RemoteAddress: resolved.ip,
            InterfaceAlias: egress?.name ?? '',
            SourceAddress: egress ? (effectiveIpv4(egress)?.address ?? '') : '',
            PingSucceeded: !!reply,
            'PingReplyDetails (RTT)': reply && reply.kind === 'reply' ? `${reply.time} ms` : '0 ms'
          },
          {
            kind: 'list',
            props: [
              'ComputerName',
              'RemoteAddress',
              'InterfaceAlias',
              'SourceAddress',
              'PingSucceeded',
              'PingReplyDetails (RTT)'
            ]
          }
        )
      ]
    }
  }
]

/** Protocole affiché dans la trace pour un port TCP connu. */
const PORT_PROTOCOL: Record<number, Protocol> = {
  88: 'KERBEROS',
  389: 'LDAP',
  445: 'SMB',
  3389: 'RDP',
  1723: 'VPN'
}

/**
 * Test de connexion TCP (Test-NetConnection -Port) : échange tracé SYN / SYN-ACK (ou RST si rien
 * n'écoute) acheminé comme un vrai paquet (pare-feu de la cible, listes d'accès des routeurs).
 */
function tcpTest(ctx: CmdContext, ip: string, port: number): boolean {
  const target = Object.values(ctx.state.devices).find(
    (d): d is HostDevice =>
      (d.kind === 'server' || d.kind === 'client') &&
      d.powered &&
      d.interfaces.some((i) => effectiveIpv4(i)?.address === ip)
  )
  const listening = !!target && tcpListening(target, port)
  const exchange = serverExchange(ctx.state, ctx.deviceId, ip, {
    protocol: PORT_PROTOCOL[port] ?? 'HTTP',
    port,
    request: `TCP SYN vers ${ip}:${port}`,
    reply: listening ? 'TCP SYN-ACK' : 'TCP RST (aucun service à l’écoute)',
    fields: [['Port', String(port)]]
  })
  ctx.addTrace(exchange.trace)
  return exchange.ok && listening
}
