/**
 * Cmdlets réseau et système (v2.7, Lot 2c) : Get-NetRoute, Get-NetNeighbor, Get-NetTCPConnection,
 * Disable/Enable-NetAdapter, Get-EventLog, Get-ComputerInfo, Test-ComputerSecureChannel.
 * Sorties calculées depuis l'état du lab.
 *
 * Sourcé Microsoft Learn :
 * - Get-NetRoute (NetTCPIP) : -DestinationPrefix « 0.0.0.0/0 » + NextHop = passerelle par défaut
 *   (exemple 4), -InterfaceIndex (exemple 3), -AddressFamily.
 * - Get-NetNeighbor : cache des voisins, -State Reachable (exemple 4), -AddressFamily.
 * - Get-NetTCPConnection : -State, -LocalPort, -OwningProcess (exemples 2 et 4).
 * - Disable-NetAdapter : -Name avec caractères génériques (exemples 1 et 3), confirmation
 *   « Are you sure you want to perform this action? » sauf -Confirm:$False (exemple 4) ;
 *   Enable-NetAdapter -Name.
 * - Get-EventLog (PowerShell 5.1) : -LogName, -Newest, -EntryType, -Source, -InstanceId,
 *   colonnes « Index Time EntryType Source InstanceID Message » (exemples 2, 4, 5), -List (exemple 1).
 * - Get-ComputerInfo : -Property avec caractères génériques (exemple 2 « *Version »).
 * - Test-ComputerSecureChannel : renvoie True / False (exemples 2, 5), -Repair (exemple 3),
 *   -Verbose (exemple 4 : « The secure channel between … is alive and working correctly »).
 * Libellés et mises en page françaises : docs/fidelite.md, « À vérifier (Lot 2) ».
 */
import { formatShortDate } from '../../../core/clock'
import type { EventLogEntry, NetInterface } from '../../../model/schema'
import { routingTable } from '../../../net/routing'
import { repairSecureChannel, secureChannelStatus } from '../../../roles/adds/objects'
import { listeningPorts } from '../../../services/listening'
import { setInterfaceEnabled } from '../../../topology/actions'
import { neighborCache, portOwner } from '../../tools/diag'
import { unsimulatedParameterMessage } from '../../unsimulated'
import { psError } from '../errors'
import type { CmdContext } from '../interpreter'
import type { BoundArgs, CmdletDef } from '../registry'
import { flatten, psObject, psToString, wildcardToRegExp, type PsObject, type PsValue } from '../values'
import { ifIndexOf, interfaceNames } from './helpers'

const str = (v: PsValue | undefined) => psToString(v)
const list = (v: PsValue | undefined) => (v === undefined ? [] : flatten([v]).map(psToString))
const ints = (v: PsValue | undefined) => list(v).map(Number)

/** Seule la famille IPv4 est simulée. */
function ipv4Only(cmd: string, args: BoundArgs): boolean {
  const family = args['AddressFamily'] === undefined ? 'IPv4' : str(args['AddressFamily'])
  if (family.toLowerCase() === 'ipv6') return false
  if (family.toLowerCase() !== 'ipv4')
    throw psError(unsimulatedParameterMessage(cmd, 'AddressFamily'), 'NotImplemented', 'UnsimulatedParameter')
  return true
}

function notFound(cmd: string, what: string) {
  return psError(
    `Aucun objet ${what} n’a été trouvé correspondant aux critères.`,
    'ObjectNotFound',
    `CmdletizationQuery_NotFound,${cmd}`
  )
}

/** Cartes désignées par -Name (caractères génériques) ou -InterfaceAlias. */
function adapters(ctx: CmdContext, args: BoundArgs, param = 'Name'): NetInterface[] {
  const patterns = list(args[param])
  const all = ctx.host.interfaces.filter((i) => i.l3)
  if (patterns.length === 0) return all
  const out: NetInterface[] = []
  for (const p of patterns) {
    const re = wildcardToRegExp(p)
    const found = all.filter((i) => re.test(i.name))
    if (found.length === 0)
      throw psError(
        `Aucun objet MSFT_NetAdapter trouvé avec la propriété « Name » égale à « ${p} ». Vérifiez la valeur de la propriété et réessayez.`,
        'ObjectNotFound',
        'CmdletizationQuery_NotFound_Name',
        p
      )
    for (const i of found) if (!out.includes(i)) out.push(i)
  }
  return out
}

const EVENT_LOGS: Record<string, EventLogEntry['log']> = {
  system: 'Système',
  système: 'Système',
  application: 'Application',
  security: 'Sécurité',
  sécurité: 'Sécurité',
  'directory service': 'Service d’annuaire',
  'dns server': 'Serveur DNS'
}
const LOG_NAMES: Record<EventLogEntry['log'], string> = {
  Système: 'System',
  Application: 'Application',
  Sécurité: 'Security',
  'Service d’annuaire': 'Directory Service',
  'Serveur DNS': 'DNS Server'
}
const ENTRY_TYPES: Record<EventLogEntry['level'], string> = {
  error: 'Error',
  warning: 'Warning',
  information: 'Information'
}

/** Rôle de l'ordinateur dans le domaine (Win32_ComputerSystem.DomainRole). */
function domainRole(ctx: CmdContext): string {
  const h = ctx.host
  const server = h.kind === 'server'
  const domain = h.host.domain ? ctx.state.domains[h.host.domain] : undefined
  if (domain?.controllers.includes(h.id)) {
    const pdc = domain.fsmo['PDCEmulator'] ?? domain.controllers[0]
    return pdc === h.id ? 'PrimaryDomainController' : 'BackupDomainController'
  }
  if (h.host.domain) return server ? 'MemberServer' : 'MemberWorkstation'
  return server ? 'StandaloneServer' : 'StandaloneWorkstation'
}

export const netSysCmdlets: CmdletDef[] = [
  {
    name: 'Get-NetRoute',
    module: 'NetTCPIP',
    synopsis: 'Affiche la table de routage IP (routes connectées et passerelle par défaut).',
    params: [
      { name: 'DestinationPrefix', type: 'string[]', position: 0 },
      { name: 'InterfaceIndex', type: 'int' },
      { name: 'InterfaceAlias', type: 'string', complete: interfaceNames },
      { name: 'NextHop', type: 'string[]' },
      { name: 'AddressFamily', type: 'string', validateSet: ['IPv4', 'IPv6'] }
    ],
    run(ctx, args) {
      if (!ipv4Only('Get-NetRoute', args)) return []
      const prefixes = list(args['DestinationPrefix'])
      const hops = list(args['NextHop'])
      const host = ctx.host
      const rows = routingTable(ctx.state, host).flatMap((r) => {
        const iface = host.interfaces.find((i) => i.id === r.ifaceId)
        if (!iface) return []
        const prefix = `${r.network}/${r.prefixLength}`
        const nextHop = r.gateway ?? '0.0.0.0'
        const index = ifIndexOf(ctx, iface)
        if (prefixes.length > 0 && !prefixes.some((p) => wildcardToRegExp(p).test(prefix))) return []
        if (args['InterfaceIndex'] !== undefined && Number(args['InterfaceIndex']) !== index) return []
        if (
          args['InterfaceAlias'] !== undefined &&
          iface.name.toLowerCase() !== str(args['InterfaceAlias']).toLowerCase()
        )
          return []
        if (hops.length > 0 && !hops.includes(nextHop)) return []
        return [
          psObject(
            'Microsoft.Management.Infrastructure.CimInstance#ROOT/StandardCimv2/MSFT_NetRoute',
            {
              ifIndex: index,
              DestinationPrefix: prefix,
              NextHop: nextHop,
              InterfaceAlias: iface.name,
              AddressFamily: 'IPv4',
              PolicyStore: 'ActiveStore'
            },
            { kind: 'table', props: ['ifIndex', 'DestinationPrefix', 'NextHop', 'PolicyStore'] }
          )
        ]
      })
      if (rows.length === 0 && (prefixes.length > 0 || args['InterfaceIndex'] !== undefined))
        throw notFound('Get-NetRoute', 'MSFT_NetRoute')
      return rows
    }
  },
  {
    name: 'Get-NetNeighbor',
    module: 'NetTCPIP',
    synopsis: 'Affiche le cache des voisins (ARP) : voisins joignables du segment.',
    params: [
      { name: 'IPAddress', type: 'string[]', position: 0 },
      { name: 'InterfaceIndex', type: 'int' },
      { name: 'InterfaceAlias', type: 'string', complete: interfaceNames },
      {
        name: 'State',
        type: 'string[]',
        validateSet: ['Unreachable', 'Incomplete', 'Probe', 'Delay', 'Stale', 'Reachable', 'Permanent']
      },
      { name: 'AddressFamily', type: 'string', validateSet: ['IPv4', 'IPv6'] }
    ],
    run(ctx, args) {
      if (!ipv4Only('Get-NetNeighbor', args)) return []
      const ips = list(args['IPAddress'])
      const states = list(args['State']).map((s) => s.toLowerCase())
      const rows: PsObject[] = []
      for (const entry of neighborCache(ctx)) {
        const index = ifIndexOf(ctx, entry.iface)
        if (args['InterfaceIndex'] !== undefined && Number(args['InterfaceIndex']) !== index) continue
        if (
          args['InterfaceAlias'] !== undefined &&
          entry.iface.name.toLowerCase() !== str(args['InterfaceAlias']).toLowerCase()
        )
          continue
        const items = [
          ...entry.neighbors.map((n) => ({ ip: n.ip, mac: n.mac.toUpperCase(), state: 'Reachable' })),
          { ip: entry.broadcast, mac: 'FF-FF-FF-FF-FF-FF', state: 'Permanent' }
        ]
        for (const n of items) {
          if (ips.length > 0 && !ips.some((p) => wildcardToRegExp(p).test(n.ip))) continue
          if (states.length > 0 && !states.includes(n.state.toLowerCase())) continue
          rows.push(
            psObject(
              'Microsoft.Management.Infrastructure.CimInstance#ROOT/StandardCimv2/MSFT_NetNeighbor',
              {
                ifIndex: index,
                IPAddress: n.ip,
                LinkLayerAddress: n.mac,
                State: n.state,
                PolicyStore: 'ActiveStore',
                InterfaceAlias: entry.iface.name,
                AddressFamily: 'IPv4'
              },
              { kind: 'table', props: ['ifIndex', 'IPAddress', 'LinkLayerAddress', 'State', 'PolicyStore'] }
            )
          )
        }
      }
      if (rows.length === 0 && ips.length > 0) throw notFound('Get-NetNeighbor', 'MSFT_NetNeighbor')
      return rows
    }
  },
  {
    name: 'Get-NetTCPConnection',
    module: 'NetTCPIP',
    synopsis: 'Affiche les connexions TCP (ports en écoute des rôles dont le service est démarré).',
    params: [
      { name: 'LocalAddress', type: 'string[]', position: 0 },
      { name: 'LocalPort', type: 'string[]', position: 1 },
      { name: 'RemoteAddress', type: 'string[]' },
      { name: 'RemotePort', type: 'string[]' },
      { name: 'State', type: 'string[]' },
      { name: 'OwningProcess', type: 'string[]' },
      { name: 'AppliedSetting', type: 'string[]' }
    ],
    run(ctx, args) {
      const ports = ints(args['LocalPort'])
      const states = list(args['State']).map((s) => s.toLowerCase())
      const pids = ints(args['OwningProcess'])
      const locals = list(args['LocalAddress'])
      // Aucune connexion établie n'est simulée : seules les écoutes (Listen) existent
      const rows = listeningPorts(ctx.host)
        .filter((p) => p.protocol === 'TCP')
        .map((p) => ({ port: p.port, pid: portOwner(ctx, p.port) }))
        .filter(
          (r) =>
            (ports.length === 0 || ports.includes(r.port)) &&
            (states.length === 0 || states.includes('listen')) &&
            (pids.length === 0 || pids.includes(r.pid)) &&
            (locals.length === 0 || locals.includes('0.0.0.0')) &&
            args['RemoteAddress'] === undefined &&
            args['RemotePort'] === undefined &&
            args['AppliedSetting'] === undefined
        )
        .map((r) =>
          psObject(
            'Microsoft.Management.Infrastructure.CimInstance#ROOT/StandardCimv2/MSFT_NetTCPConnection',
            {
              LocalAddress: '0.0.0.0',
              LocalPort: r.port,
              RemoteAddress: '0.0.0.0',
              RemotePort: 0,
              State: 'Listen',
              AppliedSetting: null,
              OwningProcess: r.pid
            },
            {
              kind: 'table',
              props: [
                'LocalAddress',
                'LocalPort',
                'RemoteAddress',
                'RemotePort',
                'State',
                'AppliedSetting',
                'OwningProcess'
              ]
            }
          )
        )
      if (rows.length === 0) throw notFound('Get-NetTCPConnection', 'MSFT_NetTCPConnection')
      return rows
    }
  },
  {
    name: 'Disable-NetAdapter',
    module: 'NetAdapter',
    synopsis: 'Désactive une carte réseau.',
    params: [
      {
        name: 'Name',
        type: 'string[]',
        position: 0,
        mandatory: true,
        aliases: ['ifAlias', 'InterfaceAlias'],
        complete: interfaceNames
      },
      { name: 'PassThru', type: 'switch' }
    ],
    run(ctx, args) {
      for (const iface of adapters(ctx, args))
        if (ctx.confirm(iface.name, 'Disable-NetAdapter'))
          ctx.apply(setInterfaceEnabled(ctx.state, ctx.deviceId, iface.id, false))
    }
  },
  {
    name: 'Enable-NetAdapter',
    module: 'NetAdapter',
    synopsis: 'Active une carte réseau.',
    params: [
      {
        name: 'Name',
        type: 'string[]',
        position: 0,
        mandatory: true,
        aliases: ['ifAlias', 'InterfaceAlias'],
        complete: interfaceNames
      },
      { name: 'PassThru', type: 'switch' }
    ],
    run(ctx, args) {
      for (const iface of adapters(ctx, args))
        ctx.apply(setInterfaceEnabled(ctx.state, ctx.deviceId, iface.id, true))
    }
  },
  {
    name: 'Get-EventLog',
    module: 'Microsoft.PowerShell.Management',
    synopsis: 'Lit un journal des événements classique (System, Application, Security).',
    params: [
      { name: 'LogName', type: 'string', position: 0 },
      { name: 'InstanceId', type: 'string[]', position: 1 },
      { name: 'Newest', type: 'int' },
      {
        name: 'EntryType',
        type: 'string[]',
        validateSet: ['Error', 'Information', 'FailureAudit', 'SuccessAudit', 'Warning']
      },
      { name: 'Source', type: 'string[]' },
      { name: 'Message', type: 'string' },
      { name: 'List', type: 'switch' },
      { name: 'ComputerName', type: 'string[]' }
    ],
    run(ctx, args) {
      if (args['ComputerName'] !== undefined)
        throw psError(
          unsimulatedParameterMessage('Get-EventLog', 'ComputerName'),
          'NotImplemented',
          'UnsimulatedParameter'
        )
      const log = ctx.host.host.eventLog
      if (args['List'] === true) {
        const names: EventLogEntry['log'][] = ['Application', 'Sécurité', 'Système']
        return names.map((l) =>
          psObject(
            'System.Diagnostics.EventLog',
            { Entries: log.filter((e) => e.log === l).length, Log: LOG_NAMES[l] },
            { kind: 'table', props: ['Entries', 'Log'] }
          )
        )
      }
      if (args['LogName'] === undefined)
        throw psError(
          'Le paramètre -LogName est obligatoire (System, Application, Security).',
          'InvalidArgument',
          'ParameterBindingException'
        )
      const name = str(args['LogName'])
      const target = EVENT_LOGS[name.toLowerCase()]
      if (!target)
        throw psError(
          `Le journal « ${name} » n’existe pas sur l’ordinateur « . ».`,
          'InvalidOperation',
          'System.InvalidOperationException',
          name
        )
      const types = list(args['EntryType']).map((t) => t.toLowerCase())
      const sources = list(args['Source']).map((s) => wildcardToRegExp(s))
      const ids = ints(args['InstanceId'])
      const message = args['Message'] === undefined ? null : wildcardToRegExp(str(args['Message']))
      let entries = log
        .filter((e) => e.log === target)
        .filter((e) => types.length === 0 || types.includes(ENTRY_TYPES[e.level].toLowerCase()))
        .filter((e) => sources.length === 0 || sources.some((r) => r.test(e.source)))
        .filter((e) => ids.length === 0 || ids.includes(e.eventId))
        .filter((e) => !message || message.test(e.message))
        .reverse()
      if (args['Newest'] !== undefined) entries = entries.slice(0, Number(args['Newest']))
      if (entries.length === 0)
        throw psError(
          'Aucune correspondance trouvée.',
          'ObjectNotFound',
          'GetEventLogNoEntriesFound',
          name,
          'ArgumentException'
        )
      return entries.map((e) =>
        psObject(
          'System.Diagnostics.EventLogEntry',
          {
            Index: e.id,
            Time: formatShortDate(e.time),
            EntryType: ENTRY_TYPES[e.level],
            Source: e.source,
            InstanceID: e.eventId,
            Message: e.message
          },
          { kind: 'table', props: ['Index', 'Time', 'EntryType', 'Source', 'InstanceID', 'Message'] }
        )
      )
    }
  },
  {
    name: 'Get-ComputerInfo',
    aliases: ['gin'],
    module: 'Microsoft.PowerShell.Management',
    synopsis: 'Propriétés système de l’ordinateur (sous-ensemble simulé).',
    params: [{ name: 'Property', type: 'string[]', position: 0 }],
    run(ctx, args) {
      const h = ctx.host
      const server = h.kind === 'server'
      const props: Record<string, PsValue> = {
        CsName: h.name,
        CsDomain: h.host.domain ?? h.host.workgroup,
        CsPartOfDomain: !!h.host.domain,
        CsWorkgroup: h.host.domain ? null : h.host.workgroup,
        CsDomainRole: domainRole(ctx),
        CsNetworkAdapters: `{${h.interfaces.map((i) => i.name).join(', ')}}`,
        OsName: server ? 'Système serveur (simulé) Standard' : 'Système client (simulé)',
        OsLastBootUpTime: formatShortDate(h.host.bootedAt),
        LogonServer: `\\\\${h.host.session?.logonServer ?? h.name}`
      }
      const patterns = list(args['Property']).map((p) => wildcardToRegExp(p))
      const keys = Object.keys(props).filter((k) => patterns.length === 0 || patterns.some((r) => r.test(k)))
      return [
        psObject(
          'Microsoft.PowerShell.Commands.ComputerInfo',
          Object.fromEntries(keys.map((k) => [k, props[k] ?? null])),
          { kind: 'list', props: keys }
        )
      ]
    }
  },
  {
    name: 'Test-ComputerSecureChannel',
    module: 'Microsoft.PowerShell.Management',
    synopsis: 'Teste (ou répare) le canal sécurisé entre l’ordinateur et son domaine.',
    params: [
      { name: 'Repair', type: 'switch' },
      { name: 'Server', type: 'string' },
      { name: 'Credential', type: 'credential' }
    ],
    run(ctx, args) {
      const h = ctx.host
      const status = secureChannelStatus(ctx.state, ctx.deviceId)
      if (status === 'notDomainMember')
        throw psError(
          `Impossible de vérifier le canal sécurisé de l’ordinateur local : l’ordinateur « ${h.name} » n’est pas joint à un domaine.`,
          'InvalidOperation',
          'ComputerNotInDomain',
          h.name
        )
      if (status === 'noDc')
        throw psError(
          `Impossible de vérifier le canal sécurisé : le domaine ${h.host.domain ?? ''} n’a pas pu être contacté.`,
          'OperationStopped',
          'FailToTestSecureChannel',
          h.name
        )
      let ok = status === 'ok'
      if (args['Repair'] === true && !ok) {
        ctx.apply(repairSecureChannel(ctx.state, ctx.deviceId))
        ok = secureChannelStatus(ctx.state, ctx.deviceId) === 'ok'
      }
      if (args['Verbose'] === true)
        ctx.write(
          ok
            ? `COMMENTAIRES : Le canal sécurisé entre « ${h.name} » et « ${h.host.domain ?? ''} » fonctionne correctement.`
            : `COMMENTAIRES : Le canal sécurisé entre « ${h.name} » et « ${h.host.domain ?? ''} » est rompu.`,
          'warning'
        )
      return [ok]
    }
  }
]
