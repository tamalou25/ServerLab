/**
 * Cmdlets DNS : module DnsServer (outils RSAT-DNS-Server) et Resolve-DnsName (DnsClient).
 */
import type { ServerDevice } from '../../model/schema'
import type { DnsRecordType, DnsServer } from './schema'
import { addPrimaryZone, addRecord, normalizeName, removeRecord, removeZone, setForwarders } from './server'
import { resolveName, reverseLookup } from './resolver'
import { psError } from '../../shell/ps/errors'
import type { CmdContext } from '../../shell/ps/interpreter'
import type { CmdletDef } from '../../shell/ps/registry'
import { flatten, psObject, psToString, type PsValue } from '../../shell/ps/values'
import { hasFeature } from '../../shell/ps/cmdlets/helpers'
import { dnsServerOf } from './state'

/** TTL en secondes → hh:mm:ss (1 h par défaut si absent). */
function formatTtl(ttl: number | undefined): string {
  const t = Math.max(0, Math.floor(ttl ?? 3600))
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(Math.floor(t / 3600))}:${p(Math.floor((t % 3600) / 60))}:${p(t % 60)}`
}

const available = (ctx: CmdContext) => hasFeature(ctx, 'RSAT-DNS-Server')
const str = (v: PsValue | undefined): string => psToString(v)

function dnsOf(ctx: CmdContext): { server: ServerDevice; dns: DnsServer } {
  const d = ctx.device
  const dns = dnsServerOf(d)
  if (d.kind !== 'server' || !d.host.features.includes('DNS') || !dns)
    throw psError(
      `Échec de l’énumération des zones sur le serveur ${d.name} : le service Serveur DNS n’est pas installé.`,
      'ObjectNotFound',
      'WIN32 1722',
      d.name
    )
  return { server: d, dns }
}

function zoneNames(ctx: CmdContext): string[] {
  const d = ctx.state.devices[ctx.session.deviceId]
  return d?.kind === 'server' ? (dnsServerOf(d)?.zones.map((z) => z.name) ?? []) : []
}

const zoneParam = { name: 'ZoneName', type: 'string' as const, mandatory: true, complete: zoneNames }

function warnAll(ctx: CmdContext, warnings: string[]): void {
  for (const w of warnings) ctx.warn(w)
}

export const dnsCmdlets: CmdletDef[] = [
  {
    name: 'Add-DnsServerPrimaryZone',
    module: 'DnsServer',
    synopsis: 'Crée une zone principale (directe ou inverse).',
    available,
    params: [
      { name: 'Name', type: 'string', position: 0 },
      { name: 'NetworkId', type: 'string' },
      { name: 'ZoneFile', type: 'string' },
      { name: 'ReplicationScope', type: 'string', validateSet: ['Forest', 'Domain', 'Legacy', 'Custom'] },
      { name: 'DynamicUpdate', type: 'string', validateSet: ['None', 'Secure', 'NonsecureAndSecure'] },
      { name: 'ComputerName', type: 'string' }
    ],
    run(ctx, args) {
      dnsOf(ctx)
      if (!args['Name'] && !args['NetworkId'])
        throw psError(
          'Spécifiez le nom de la zone (-Name) ou l’identificateur réseau d’une zone inverse (-NetworkId).',
          'InvalidArgument',
          'ZoneNameRequired'
        )
      if (!args['ZoneFile'] && !args['ReplicationScope'])
        throw psError(
          'Le jeu de paramètres ne peut pas être résolu à l’aide des paramètres nommés spécifiés : indiquez -ZoneFile (zone stockée dans un fichier) ou -ReplicationScope (zone intégrée à Active Directory).',
          'InvalidArgument',
          'AmbiguousParameterSet'
        )
      ctx.apply(
        addPrimaryZone(ctx.state, ctx.deviceId, {
          ...(args['Name'] ? { name: str(args['Name']) } : {}),
          ...(args['NetworkId'] ? { networkId: str(args['NetworkId']) } : {}),
          adIntegrated: !!args['ReplicationScope'],
          ...(args['DynamicUpdate']
            ? { dynamicUpdate: str(args['DynamicUpdate']) as 'None' | 'Secure' | 'NonsecureAndSecure' }
            : {})
        })
      )
    }
  },
  {
    name: 'Get-DnsServerZone',
    module: 'DnsServer',
    synopsis: 'Liste les zones du serveur DNS.',
    available,
    params: [{ name: 'Name', type: 'string', position: 0, complete: zoneNames }],
    run(ctx, args) {
      const { dns } = dnsOf(ctx)
      const name = args['Name'] ? normalizeName(str(args['Name'])) : null
      const zones = dns.zones.filter((z) => !name || z.name === name)
      if (name && zones.length === 0)
        throw psError(
          `La zone ${name} est introuvable sur le serveur ${ctx.device.name}.`,
          'ObjectNotFound',
          'WIN32 9601',
          name
        )
      return zones.map((z) =>
        psObject(
          'DnsServerZone',
          {
            ZoneName: z.name,
            ZoneType: 'Primary',
            IsAutoCreated: false,
            IsDsIntegrated: z.adIntegrated,
            IsReverseLookupZone: z.reverse,
            IsSigned: false
          },
          {
            kind: 'table',
            props: [
              'ZoneName',
              'ZoneType',
              'IsAutoCreated',
              'IsDsIntegrated',
              'IsReverseLookupZone',
              'IsSigned'
            ]
          }
        )
      )
    }
  },
  {
    name: 'Remove-DnsServerZone',
    module: 'DnsServer',
    synopsis: 'Supprime une zone.',
    available,
    params: [
      { name: 'Name', type: 'string', position: 0, mandatory: true, complete: zoneNames },
      { name: 'Force', type: 'switch' }
    ],
    run(ctx, args) {
      dnsOf(ctx)
      if (ctx.confirm(`Zone ${str(args['Name'])}`, 'Supprimer la zone'))
        ctx.apply(removeZone(ctx.state, ctx.deviceId, str(args['Name'])))
    }
  },
  {
    name: 'Add-DnsServerResourceRecordA',
    module: 'DnsServer',
    synopsis: 'Ajoute un enregistrement d’hôte (A).',
    available,
    params: [
      { name: 'Name', type: 'string', mandatory: true },
      zoneParam,
      { name: 'IPv4Address', type: 'string', mandatory: true },
      { name: 'CreatePtr', type: 'switch' },
      { name: 'TimeToLive', type: 'string' }
    ],
    run(ctx, args) {
      dnsOf(ctx)
      const r = ctx.apply(
        addRecord(ctx.state, ctx.deviceId, str(args['ZoneName']), {
          name: str(args['Name']),
          type: 'A',
          data: str(args['IPv4Address']),
          createPtr: args['CreatePtr'] === true
        })
      )
      warnAll(ctx, r.warnings)
    }
  },
  {
    name: 'Add-DnsServerResourceRecordCName',
    module: 'DnsServer',
    synopsis: 'Ajoute un alias (CNAME).',
    available,
    params: [
      { name: 'Name', type: 'string', mandatory: true },
      zoneParam,
      { name: 'HostNameAlias', type: 'string', mandatory: true }
    ],
    run(ctx, args) {
      dnsOf(ctx)
      ctx.apply(
        addRecord(ctx.state, ctx.deviceId, str(args['ZoneName']), {
          name: str(args['Name']),
          type: 'CNAME',
          data: str(args['HostNameAlias'])
        })
      )
    }
  },
  {
    name: 'Add-DnsServerResourceRecordPtr',
    module: 'DnsServer',
    synopsis: 'Ajoute un pointeur (PTR) dans une zone inverse.',
    available,
    params: [
      { name: 'Name', type: 'string', mandatory: true },
      zoneParam,
      { name: 'PtrDomainName', type: 'string', mandatory: true }
    ],
    run(ctx, args) {
      dnsOf(ctx)
      ctx.apply(
        addRecord(ctx.state, ctx.deviceId, str(args['ZoneName']), {
          name: str(args['Name']),
          type: 'PTR',
          data: str(args['PtrDomainName'])
        })
      )
    }
  },
  {
    name: 'Get-DnsServerResourceRecord',
    module: 'DnsServer',
    synopsis: 'Liste les enregistrements d’une zone.',
    available,
    params: [
      { ...zoneParam, position: 0 },
      { name: 'Name', type: 'string' },
      { name: 'RRType', type: 'string', validateSet: ['A', 'PTR', 'CNAME', 'NS', 'SOA', 'SRV'] }
    ],
    run(ctx, args) {
      const { dns } = dnsOf(ctx)
      const zone = dns.zones.find((z) => z.name === normalizeName(str(args['ZoneName'])))
      if (!zone)
        throw psError(
          `La zone ${str(args['ZoneName'])} est introuvable sur le serveur ${ctx.device.name}.`,
          'ObjectNotFound',
          'WIN32 9601'
        )
      const name = args['Name'] ? str(args['Name']).toLowerCase() : null
      const type = args['RRType'] ? str(args['RRType']) : null
      return zone.records
        .filter((r) => (!name || r.name === name) && (!type || r.type === type))
        .map((r) =>
          psObject(
            'DnsServerResourceRecord',
            {
              HostName: r.name,
              RecordType: r.type,
              Type: { A: 1, NS: 2, CNAME: 5, SOA: 6, PTR: 12, SRV: 33 }[r.type],
              Timestamp: r.dynamic ? '05/01/2026 08:00:00' : '0',
              TimeToLive: formatTtl(r.ttl),
              RecordData: r.data
            },
            {
              kind: 'table',
              props: ['HostName', 'RecordType', 'Type', 'Timestamp', 'TimeToLive', 'RecordData']
            }
          )
        )
    }
  },
  {
    name: 'Remove-DnsServerResourceRecord',
    module: 'DnsServer',
    synopsis: 'Supprime un enregistrement.',
    available,
    params: [
      zoneParam,
      { name: 'Name', type: 'string', mandatory: true },
      { name: 'RRType', type: 'string', mandatory: true, validateSet: ['A', 'PTR', 'CNAME', 'NS', 'SRV'] },
      { name: 'RecordData', type: 'string' },
      { name: 'Force', type: 'switch' }
    ],
    run(ctx, args) {
      dnsOf(ctx)
      if (!ctx.confirm(`${str(args['Name'])} (${str(args['RRType'])})`, 'Supprimer l’enregistrement')) return
      ctx.apply(
        removeRecord(
          ctx.state,
          ctx.deviceId,
          str(args['ZoneName']),
          str(args['Name']),
          str(args['RRType']) as DnsRecordType,
          args['RecordData'] ? str(args['RecordData']) : undefined
        )
      )
    }
  },
  {
    name: 'Add-DnsServerForwarder',
    module: 'DnsServer',
    synopsis: 'Ajoute des redirecteurs.',
    available,
    params: [{ name: 'IPAddress', type: 'string[]', mandatory: true, position: 0 }],
    run(ctx, args) {
      const { dns } = dnsOf(ctx)
      ctx.apply(
        setForwarders(ctx.state, ctx.deviceId, [
          ...dns.forwarders,
          ...flatten([args['IPAddress'] ?? []]).map(psToString)
        ])
      )
    }
  },
  {
    name: 'Set-DnsServerForwarder',
    module: 'DnsServer',
    synopsis: 'Remplace les redirecteurs.',
    available,
    params: [
      { name: 'IPAddress', type: 'string[]', mandatory: true, position: 0 },
      { name: 'UseRootHint', type: 'bool' }
    ],
    run(ctx, args) {
      dnsOf(ctx)
      ctx.apply(setForwarders(ctx.state, ctx.deviceId, flatten([args['IPAddress'] ?? []]).map(psToString)))
    }
  },
  {
    name: 'Get-DnsServerForwarder',
    module: 'DnsServer',
    synopsis: 'Affiche les redirecteurs.',
    available,
    params: [],
    run(ctx) {
      const { dns } = dnsOf(ctx)
      return [
        psObject(
          'DnsServerForwarder',
          {
            UseRootHint: dns.useRootHints,
            Timeout: '(s) 3',
            EnableReordering: true,
            IPAddress: dns.forwarders,
            ReorderedIPAddress: dns.forwarders
          },
          {
            kind: 'list',
            props: ['UseRootHint', 'Timeout', 'EnableReordering', 'IPAddress', 'ReorderedIPAddress']
          }
        )
      ]
    }
  },
  {
    name: 'Resolve-DnsName',
    module: 'DnsClient',
    synopsis: 'Résout un nom DNS.',
    params: [
      { name: 'Name', type: 'string', mandatory: true, position: 0 },
      { name: 'Type', type: 'string', position: 1, validateSet: ['A', 'PTR', 'CNAME', 'NS', 'SOA', 'SRV'] },
      { name: 'Server', type: 'string' }
    ],
    run(ctx, args) {
      const name = str(args['Name'])
      const server = args['Server'] ? str(args['Server']) : undefined
      const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(name)
      const resolution = isIp
        ? reverseLookup(ctx.state, ctx.deviceId, name, server)
        : resolveName(
            ctx.state,
            ctx.deviceId,
            name,
            (args['Type'] ? str(args['Type']) : 'A') as DnsRecordType,
            server
          )
      ctx.addTrace(resolution.trace)
      const r = resolution.result
      if (r.kind === 'nxdomain')
        throw psError(
          `${name} : Nom DNS inexistant`,
          'ResourceUnavailable',
          'DNS_ERROR_RCODE_NAME_ERROR',
          name
        )
      if (r.kind === 'timeout')
        throw psError(
          `${name} : Délai d’attente de l’opération dépassé`,
          'OperationTimeout',
          'ERROR_TIMEOUT',
          name
        )
      if (r.kind === 'servfail')
        throw psError(
          `${name} : Échec du serveur DNS`,
          'ResourceUnavailable',
          'DNS_ERROR_RCODE_SERVER_FAILURE',
          name
        )
      return r.records.map((rec) =>
        psObject(
          `DnsRecord.${rec.type}`,
          {
            Name: rec.name,
            Type: rec.type,
            TTL: rec.ttl,
            Section: 'Answer',
            [rec.type === 'A' ? 'IPAddress' : 'NameHost']: normalizeName(rec.data)
          },
          {
            kind: 'table',
            props: ['Name', 'Type', 'TTL', 'Section', rec.type === 'A' ? 'IPAddress' : 'NameHost']
          }
        )
      )
    }
  },
  {
    name: 'Clear-DnsClientCache',
    module: 'DnsClient',
    synopsis: 'Vide le cache du client DNS.',
    params: [],
    run() {
      return []
    }
  }
]
