/**
 * Client DNS d'un poste Linux : dig (bind9-dnsutils) et resolvectl (systemd-resolved). Comme
 * sur Ubuntu, /etc/resolv.conf désigne le résolveur local 127.0.0.53 qui relaie vers les
 * serveurs DNS de la carte.
 */
import { LAB_EPOCH_MS } from '../../core/clock'
import { effectiveIpv4 } from '../../net/addressing'
import { isIpv4 } from '../../net/ipv4'
import { findPackage } from '../../services/linuxcatalog'
import { linuxRelease } from '../../services/linuxsystem'
import { ctimeDate } from '../../shell/bash/interpreter'
import type { ExecContext } from '../../shell/context'
import { CommandFailure } from '../../shell/context'
import type { ToolDef } from '../../shell/tools/types'
import { dnsServersOf, resolveName, reverseLookup } from './resolver'
import { DNS_RECORD_TYPES, type DnsRecordType } from './schema'

const DIG_VERSION = '9.18.18-0ubuntu0.22.04.2-Ubuntu'
const STUB = '127.0.0.53'

/**
 * Serveur Linux (v2.9) : version de dig selon la distribution (paquet bind9-dnsutils du catalogue) ;
 * Debian 12 n'a pas systemd-resolved, /etc/resolv.conf désigne directement le serveur DNS de la carte.
 */
function digVersion(ctx: ExecContext): string {
  if (ctx.host.kind !== 'server') return DIG_VERSION
  const release = linuxRelease(ctx.host)
  const full = findPackage('bind9-dnsutils')?.versions[release] ?? ''
  return `${full.replace(/^\d+:/, '')}-${release === 'debian12' ? 'Debian' : 'Ubuntu'}`
}

/** Résolveur interrogé par défaut : stub local (Ubuntu) ou premier serveur DNS de la carte (Debian). */
function defaultResolver(ctx: ExecContext): string {
  return ctx.host.kind === 'server' && linuxRelease(ctx.host) === 'debian12'
    ? (dnsServersOf(ctx.host)[0] ?? STUB)
    : STUB
}

const fqdn = (name: string) => (name.endsWith('.') ? name : `${name}.`)

/** Identifiant de requête déterministe (dérivé du nom et de l'horloge). */
function queryId(name: string, clock: number): number {
  let h = clock % 65536
  for (const c of name) h = (h * 33 + c.charCodeAt(0)) % 65536
  return h
}

const digTool: ToolDef = {
  name: 'dig',
  synopsis: 'Interroge un serveur DNS (dig nom [type] [@serveur] [+short], dig -x adresse).',
  run(ctx, args) {
    let server: string | undefined
    let short = false
    let reverse: string | undefined
    let qtype: DnsRecordType = 'A'
    let name: string | undefined
    for (let i = 0; i < args.length; i++) {
      const a = args[i] as string
      if (a.startsWith('@')) server = a.slice(1)
      else if (a === '+short') short = true
      else if (a.startsWith('+')) continue
      else if (a === '-x') reverse = args[++i]
      else if ((DNS_RECORD_TYPES as readonly string[]).includes(a.toUpperCase()) && name !== undefined)
        qtype = a.toUpperCase() as DnsRecordType
      else if (name === undefined) name = a
    }
    if (server !== undefined && !isIpv4(server))
      throw new CommandFailure(`dig: couldn't get address for '${server}': not found`, 'InvalidArgument')
    if (reverse !== undefined && !isIpv4(reverse))
      throw new CommandFailure(`dig: '${reverse}' is not a legal IPv4 address`, 'InvalidArgument')
    if (reverse === undefined && name === undefined) {
      // Sans argument, dig interroge la racine : non simulé
      throw new CommandFailure('dig: indiquez un nom à résoudre (dig srv1.lab.local).', 'InvalidArgument')
    }
    const r =
      reverse !== undefined
        ? reverseLookup(ctx.state, ctx.deviceId, reverse, server)
        : resolveName(ctx.state, ctx.deviceId, fqdn(name ?? ''), qtype, server)
    ctx.addTrace(r.trace)
    const type: DnsRecordType = reverse !== undefined ? 'PTR' : qtype
    const qname = fqdn(r.fqdn)
    const result = r.result
    const answers = result.kind === 'answer' ? result.records : []
    if (short) {
      if (result.kind === 'timeout' && server)
        return ctx.writeLines([`;; communications error to ${server}#53: timed out`], 'error')
      return ctx.writeLines(answers.map((a) => (a.type === 'A' ? a.data : fqdn(a.data))))
    }
    const cmd = [
      server ? `@${server}` : '',
      reverse !== undefined ? `-x ${reverse}` : (name ?? ''),
      qtype !== 'A' ? qtype : ''
    ]
      .filter((x) => x)
      .join(' ')
    const header = [``, `; <<>> DiG ${digVersion(ctx)} <<>> ${cmd}`, ';; global options: +cmd']
    // Serveur interrogé directement injoignable : aucune réponse
    if (result.kind === 'timeout' && server) {
      ctx.writeLines([
        `;; communications error to ${server}#53: timed out`,
        `;; communications error to ${server}#53: timed out`,
        `;; communications error to ${server}#53: timed out`,
        ...header,
        ';; no servers could be reached',
        ''
      ])
      return
    }
    // Sans @serveur, le résolveur local (127.0.0.53) répond SERVFAIL si les serveurs DNS ne répondent pas
    const status = result.kind === 'answer' ? 'NOERROR' : result.kind === 'nxdomain' ? 'NXDOMAIN' : 'SERVFAIL'
    const authoritative =
      !!server && (result.kind === 'answer' || result.kind === 'nxdomain') && result.authoritative
    const flags = `qr${authoritative ? ' aa' : ''} rd ra`
    const used = server ?? defaultResolver(ctx)
    const size =
      12 +
      qname.length +
      6 +
      answers.reduce((n, a) => n + 12 + (a.type === 'A' ? 4 : a.data.length + 2), 0) +
      11
    ctx.writeLines([
      ...header,
      ';; Got answer:',
      `;; ->>HEADER<<- opcode: QUERY, status: ${status}, id: ${queryId(qname, ctx.state.clock)}`,
      `;; flags: ${flags}; QUERY: 1, ANSWER: ${answers.length}, AUTHORITY: 0, ADDITIONAL: 1`,
      '',
      ';; OPT PSEUDOSECTION:',
      '; EDNS: version: 0, flags:; udp: 65494',
      ';; QUESTION SECTION:',
      `;${qname}\t\t\tIN\t${type}`,
      '',
      ...(answers.length > 0
        ? [
            ';; ANSWER SECTION:',
            ...answers.map(
              (a) => `${fqdn(a.name)}\t\t${a.ttl}\tIN\t${a.type}\t${a.type === 'A' ? a.data : fqdn(a.data)}`
            ),
            ''
          ]
        : []),
      ';; Query time: 0 msec',
      `;; SERVER: ${used}#53(${used}) (UDP)`,
      `;; WHEN: ${ctimeDate(ctx.state.clock, LAB_EPOCH_MS).replace(/ (\d{4})$/, ' UTC $1')}`,
      `;; MSG SIZE  rcvd: ${size}`,
      ''
    ])
  }
}

const resolvectlTool: ToolDef = {
  name: 'resolvectl',
  synopsis: 'Affiche les serveurs DNS utilisés (resolvectl status, resolvectl dns).',
  // Debian 12 n'installe pas systemd-resolved
  available: (ctx) => ctx.host.kind !== 'server' || linuxRelease(ctx.host) !== 'debian12',
  run(ctx, args) {
    const action = args[0] ?? 'status'
    const iface = ctx.host.interfaces.find((i) => effectiveIpv4(i))
    const servers = dnsServersOf(ctx.host)
    const name = iface?.name ?? 'eth0'
    if (action === 'dns') {
      ctx.writeLines(['Global:', `Link 2 (${name}): ${servers.join(' ')}`])
      return
    }
    if (action !== 'status') throw new CommandFailure(`Unknown command verb ${action}.`, 'InvalidArgument')
    const domain = ctx.host.host.domain ?? iface?.dhcpLease?.dnsSuffix ?? ''
    ctx.writeLines([
      'Global',
      '       Protocols: -LLMNR -mDNS -DNSOverTLS DNSSEC=no/unsupported',
      'resolv.conf mode: stub',
      '',
      `Link 2 (${name})`,
      '    Current Scopes: DNS',
      '         Protocols: +DefaultRoute +LLMNR -mDNS -DNSOverTLS DNSSEC=no/unsupported',
      ...(servers.length > 0
        ? [`Current DNS Server: ${servers[0]}`, `       DNS Servers: ${servers.join(' ')}`]
        : []),
      ...(domain ? [`        DNS Domain: ${domain}`] : [])
    ])
  }
}

export const dnsBashTools: ToolDef[] = [digTool, resolvectlTool]

/** Contenu de /etc/resolv.conf d'Ubuntu (résolveur local systemd-resolved). */
export function resolvConfLines(domain: string | null): string[] {
  return [
    '# This is /run/systemd/resolve/stub-resolv.conf managed by man:systemd-resolved(8).',
    '# Do not edit.',
    '#',
    "# This file might be symlinked as /etc/resolv.conf. If you're looking at",
    '# /etc/resolv.conf and seeing this text, you have followed the symlink.',
    '#',
    '# Run "resolvectl status" to see details about the uplink DNS servers',
    '# currently in use.',
    '',
    `nameserver ${STUB}`,
    'options edns0 trust-ad',
    `search ${domain ?? '.'}`
  ]
}
