/**
 * Outils réseau de la console bash qui s'ajoutent à `core.ts` (ip, ping) et à `dns/bash.ts`
 * (dig, resolvectl) : traceroute, curl, nslookup et `ip neigh` (v2.9, #236). Sorties au format
 * des outils d'origine (anglais) ; valeurs calculées depuis l'état du lab. Sources et écarts :
 * docs/fidelite.md (section v2.9), captures docs/captures/bash/.
 */
import { effectiveIpv4 } from '../../net/addressing'
import { tracert } from '../../net/diagnostics'
import { isIpv4 } from '../../net/ipv4'
import type { HostDevice } from '../../model/schema'
import { serverExchange } from '../../roles/adds/locator'
import { dnsServersOf, firstAddress, resolveName, reverseLookup } from '../../roles/dns/resolver'
import { httpGet } from '../../roles/iis/http'
import { isLinuxHost } from '../../model/host'
import { findPackage, type LinuxRelease } from '../../services/linuxcatalog'
import { linuxRelease, linuxSockets } from '../../services/linuxsystem'
import { CommandFailure, type ExecContext } from '../context'
import { neighborCache } from '../tools/diag'
import type { ToolDef } from '../tools/types'
import { unsimulatedOptionMessage } from '../unsimulated'

const STUB = '127.0.0.53'

// ---------------------------------------------------------------------------------------------
// ip neigh
// ---------------------------------------------------------------------------------------------

/** `ip neigh` : voisins du segment (cache ARP simulé), état toujours REACHABLE. */
export function neighLines(ctx: ExecContext): string[] {
  return neighborCache(ctx).flatMap((entry) =>
    entry.neighbors.map(
      (n) => `${n.ip} dev ${entry.iface.name} lladdr ${n.mac.toLowerCase().replace(/-/g, ':')} REACHABLE`
    )
  )
}

// ---------------------------------------------------------------------------------------------
// traceroute
// ---------------------------------------------------------------------------------------------

const ms = (v: number) => (v <= 0 ? 0.4 : v).toFixed(3)

const tracerouteTool: ToolDef = {
  name: 'traceroute',
  synopsis: 'Affiche le chemin vers un hôte (traceroute [-n] [-m sauts] hôte).',
  run(ctx, args) {
    let numeric = false
    let maxHops = 30
    let target: string | null = null
    for (let i = 0; i < args.length; i++) {
      const a = args[i] as string
      if (a === '-n') numeric = true
      else if (a === '-m') maxHops = Number(args[++i])
      else if (a.startsWith('-'))
        throw new CommandFailure(unsimulatedOptionMessage('traceroute', a), 'NotSupported')
      else target = a
    }
    if (!target) throw new CommandFailure('Specify "host" missing argument.', 'InvalidArgument')
    if (!Number.isInteger(maxHops) || maxHops < 1 || maxHops > 255)
      throw new CommandFailure(`traceroute: invalid hops value \`${maxHops}'`, 'InvalidArgument')
    let ip = target
    if (!isIpv4(target)) {
      const r = resolveName(ctx.state, ctx.deviceId, target)
      ctx.addTrace(r.trace)
      const found = firstAddress(r)
      if (!found)
        throw new CommandFailure(
          `${target}: Name or service not known\nCannot handle "host" cmdline arg \`${target}' on position 1 (argc 1)`,
          'HostNotFound'
        )
      ip = found
    }
    const result = tracert(ctx.state, ctx.deviceId, ip, maxHops)
    if (!result.ok) throw new CommandFailure(result.error.message, result.error.code)
    ctx.addTrace(result.value.trace)
    const label = (addr: string) => {
      if (numeric) return addr
      const ptr = reverseLookup(ctx.state, ctx.deviceId, addr)
      const name =
        ptr.result.kind === 'answer' ? ptr.result.records.find((x) => x.type === 'PTR')?.data : undefined
      return `${name ? name.replace(/\.$/, '') : addr} (${addr})`
    }
    const lines = [`traceroute to ${target} (${ip}), ${maxHops} hops max, 60 byte packets`]
    result.value.hops.forEach((o, i) => {
      const n = String(i + 1).padStart(2)
      if (o.kind === 'reply' || o.kind === 'ttl-expired') {
        const t = o.kind === 'reply' ? ms(o.time) : ms(0)
        lines.push(`${n}  ${label(o.from)}  ${t} ms  ${t} ms  ${t} ms`)
      } else if (o.kind === 'unreachable')
        lines.push(`${n}  ${label(o.from)}  ${ms(0)} ms !H  ${ms(0)} ms !H  ${ms(0)} ms !H`)
      else lines.push(`${n}  * * *`)
    })
    if (result.value.hops.some((o) => o.kind === 'transmit-failed'))
      throw new CommandFailure('connect: Network is unreachable', 'NetworkUnreachable')
    ctx.writeLines(lines)
  }
}

// ---------------------------------------------------------------------------------------------
// curl
// ---------------------------------------------------------------------------------------------

/** Version amont d'un paquet du catalogue (« 2.4.68 » pour « 2.4.68-1~deb12u1 »). */
function upstreamVersion(pkg: string, release: LinuxRelease): string {
  const full = findPackage(pkg)?.versions[release] ?? ''
  return full.replace(/^\d+:/, '').split(/[-~+]/)[0] ?? full
}

/** En-tête Server annoncé par le serveur Web (« Apache/2.4.68 (Debian) », « nginx/1.22.1 »). */
function serverHeader(host: HostDevice, unit: string): string {
  const release = linuxRelease(host)
  const ubuntu = release !== 'debian12'
  return unit === 'nginx'
    ? `nginx/${upstreamVersion('nginx', release)}${ubuntu ? ' (Ubuntu)' : ''}`
    : `Apache/${upstreamVersion('apache2', release)} (${ubuntu ? 'Ubuntu' : 'Debian'})`
}

const curlTool: ToolDef = {
  name: 'curl',
  synopsis: 'Requête HTTP (curl [-I] [-s] http://hôte[:port]/chemin).',
  run(ctx, args) {
    let headOnly = false
    let silent = false
    let urlText: string | null = null
    for (const a of args) {
      if (a === '-I' || a === '--head') headOnly = true
      else if (a === '-s' || a === '--silent' || a === '-S' || a === '-sS') silent = true
      else if (a.startsWith('-'))
        throw new CommandFailure(unsimulatedOptionMessage('curl', a), 'NotSupported')
      else urlText = a
    }
    if (!urlText)
      throw new CommandFailure(
        "curl: try 'curl --help' or 'curl --manual' for more information",
        'InvalidArgument'
      )
    const m = /^(?:(https?):\/\/)?([^/:]+)(?::(\d+))?(\/.*)?$/.exec(urlText)
    if (!m)
      throw new CommandFailure(`curl: (3) URL using bad/illegal format or missing URL`, 'InvalidArgument')
    const [, scheme = 'http', host = '', portText, path = '/'] = m
    if (scheme === 'https')
      throw new CommandFailure(unsimulatedOptionMessage('curl', 'https://'), 'NotSupported')
    const port = Number(portText ?? 80)
    const here = ctx.host
    const isLocal =
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host.toLowerCase() === here.name.toLowerCase() ||
      here.interfaces.some((i) => effectiveIpv4(i)?.address === host)
    let ip = host
    if (!isLocal && !isIpv4(host)) {
      const r = resolveName(ctx.state, ctx.deviceId, host)
      ctx.addTrace(r.trace)
      const found = firstAddress(r)
      if (!found) throw new CommandFailure(`curl: (6) Could not resolve host: ${host}`, 'HostNotFound')
      ip = found
    }
    const refused = () =>
      new CommandFailure(
        `curl: (7) Failed to connect to ${host} port ${port} after 0 ms: Couldn't connect to server`,
        'ConnectFailed'
      )
    const target = isLocal
      ? here
      : Object.values(ctx.state.devices).find(
          (d): d is HostDevice =>
            (d.kind === 'server' || d.kind === 'client') &&
            d.powered &&
            d.interfaces.some((i) => effectiveIpv4(i)?.address === ip)
        )
    // Cible Windows : IIS (httpGet)
    if (target && !isLinuxHost(target)) {
      const r = httpGet(ctx.state, ctx.deviceId, `http://${host}:${port}${path}`)
      if (r.trace) ctx.addTrace(r.trace)
      if (r.kind === 'failure') throw refused()
      ctx.writeLines(
        [`HTTP/1.1 ${r.status} ${r.statusText}`.trimEnd(), 'Server: Microsoft-IIS/10.0'].slice(
          0,
          headOnly ? 2 : 0
        )
      )
      if (!headOnly) ctx.write(r.body)
      return
    }
    if (!isLocal) {
      const exchange = serverExchange(ctx.state, ctx.deviceId, ip, {
        protocol: 'HTTP',
        port,
        request: `GET ${path} HTTP/1.1`,
        reply: 'HTTP/1.1 200 OK',
        fields: [['Hôte', host]]
      })
      ctx.addTrace(exchange.trace)
      if (!exchange.ok) throw refused()
    }
    const web = target
      ? linuxSockets(target).find(
          (s) => s.proto === 'tcp' && s.port === port && ['apache2', 'nginx'].includes(s.unit.name)
        )
      : undefined
    if (!target || !web) throw refused()
    if (headOnly) ctx.writeLines(['HTTP/1.1 200 OK', `Server: ${serverHeader(target, web.unit.name)}`])
    if (!silent)
      ctx.write(
        headOnly
          ? 'curl: seuls la ligne d’état et l’en-tête Server sont reproduits (Date, ETag, Content-Length… non modélisés).'
          : 'curl: le contenu de la page par défaut du serveur Web n’est pas reproduit par ServerLab.',
        'warning'
      )
  }
}

// ---------------------------------------------------------------------------------------------
// nslookup
// ---------------------------------------------------------------------------------------------

const nslookupTool: ToolDef = {
  name: 'nslookup',
  synopsis: 'Interroge un serveur DNS (nslookup nom [serveur], nslookup adresse).',
  run(ctx, args) {
    const operands = args.filter((a) => !a.startsWith('-'))
    const option = args.find((a) => a.startsWith('-'))
    if (option) throw new CommandFailure(unsimulatedOptionMessage('nslookup', option), 'NotSupported')
    const [query, serverArg] = operands
    if (!query)
      throw new CommandFailure(
        'nslookup: mode interactif non simulé (nslookup nom [serveur]).',
        'NotSupported'
      )
    if (serverArg !== undefined && !isIpv4(serverArg))
      throw new CommandFailure(`;; couldn't get address for '${serverArg}': not found`, 'InvalidArgument')
    const server = serverArg
    const used =
      server ??
      (isLinuxHost(ctx.host) && ctx.host.kind === 'client' ? STUB : (dnsServersOf(ctx.host)[0] ?? STUB))
    const reverse = isIpv4(query)
    const r = reverse
      ? reverseLookup(ctx.state, ctx.deviceId, query, server)
      : resolveName(ctx.state, ctx.deviceId, query, 'A', server)
    ctx.addTrace(r.trace)
    const header = ['Server:\t\t' + used, `Address:\t${used}#53`, '']
    const result = r.result
    if (result.kind === 'timeout') {
      ctx.write(';; communications error to ' + used + '#53: timed out', 'error')
      ctx.write(';; no servers could be reached', 'error')
      return
    }
    if (result.kind === 'nxdomain' || result.kind === 'servfail') {
      const what = r.fqdn.replace(/\.$/, '')
      ctx.writeLines([
        ...header,
        `** server can't find ${what}: ${result.kind === 'nxdomain' ? 'NXDOMAIN' : 'SERVFAIL'}`,
        ''
      ])
      return
    }
    const authoritative = !!server && result.authoritative
    const out = [...header, ...(authoritative ? [] : ['Non-authoritative answer:'])]
    for (const rec of result.records) {
      if (rec.type === 'PTR') out.push(`${r.fqdn.replace(/\.$/, '')}\tname = ${rec.data.replace(/\.$/, '')}.`)
      else if (rec.type === 'A') out.push(`Name:\t${rec.name.replace(/\.$/, '')}`, `Address: ${rec.data}`)
    }
    ctx.writeLines([...out, ''])
  }
}

export const netBashTools: ToolDef[] = [tracerouteTool, curlTool, nslookupTool]
