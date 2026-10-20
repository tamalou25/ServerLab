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
import type { LinuxNode } from '../../model/linuxnode'
import { sourceAddressFor } from '../../sim/forward'
import { findPackage, type LinuxRelease } from '../../services/linuxcatalog'
import { apacheListening, recordRequest, webRespond } from '../../services/linuxhttp'
import { linuxRelease, linuxSockets } from '../../services/linuxsystem'
import { CommandFailure, type ExecContext } from '../context'
import { neighborCache } from '../tools/diag'
import { contentOfHost, hostFiles } from './linuxfs'
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

/** En-tête Server annoncé par nginx (« nginx/1.22.1 »). */
function nginxHeader(host: HostDevice): string {
  const release = linuxRelease(host)
  return `nginx/${upstreamVersion('nginx', release)}${release !== 'debian12' ? ' (Ubuntu)' : ''}`
}

/** Message de curl quand le certificat du serveur n'est pas approuvé (src/tool_operate.c, curl 7.88.1). */
const CERT_PROBLEM = [
  'curl: (60) SSL certificate problem: self-signed certificate',
  'More details here: https://curl.se/docs/sslcerts.html',
  '',
  'curl failed to verify the legitimacy of the server and therefore could not',
  'establish a secure connection to it. To learn more about this situation and',
  'how to fix it, please visit the web page mentioned above.'
]

interface CurlOptions {
  head: boolean
  silent: boolean
  insecure: boolean
  include: boolean
  follow: boolean
  headers: string[]
  agent: string | null
  output: string | null
  writeOut: string | null
  resolve: Record<string, string>
}

/** Options de curl qui prennent une valeur (le reste de la grappe ou l'argument suivant). */
const CURL_WITH_VALUE: Record<string, keyof CurlOptions | 'ignored'> = {
  H: 'headers',
  A: 'agent',
  o: 'output',
  w: 'writeOut',
  m: 'ignored'
}
const CURL_LONG_VALUE: Record<string, string> = {
  '--header': 'H',
  '--user-agent': 'A',
  '--output': 'o',
  '--write-out': 'w',
  '--max-time': 'm',
  '--resolve': 'resolve'
}
const CURL_FLAGS: Record<string, keyof CurlOptions> = {
  I: 'head',
  s: 'silent',
  S: 'silent',
  k: 'insecure',
  i: 'include',
  L: 'follow'
}
const CURL_LONG_FLAGS: Record<string, string> = {
  '--head': 'I',
  '--silent': 's',
  '--show-error': 'S',
  '--insecure': 'k',
  '--include': 'i',
  '--location': 'L'
}

function parseCurl(args: string[]): { opts: CurlOptions; url: string | null } {
  const opts: CurlOptions = {
    head: false,
    silent: false,
    insecure: false,
    include: false,
    follow: false,
    headers: [],
    agent: null,
    output: null,
    writeOut: null,
    resolve: {}
  }
  let url: string | null = null
  const setValue = (key: string, value: string) => {
    if (key === 'resolve') {
      const [h = '', p = '', ip = ''] = value.split(':')
      opts.resolve[`${h.toLowerCase()}:${p}`] = ip
    } else if (key === 'H') opts.headers.push(value)
    else if (key === 'A') opts.agent = value
    else if (key === 'o') opts.output = value
    else if (key === 'w') opts.writeOut = value
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    if (a.startsWith('--')) {
      const [name = '', inline] = a.split('=')
      const flag = CURL_LONG_FLAGS[name]
      const withValue = CURL_LONG_VALUE[name]
      if (flag) opts[CURL_FLAGS[flag] as 'head'] = true
      else if (withValue) setValue(withValue, inline ?? args[++i] ?? '')
      else throw new CommandFailure(unsimulatedOptionMessage('curl', a), 'NotSupported')
    } else if (a.startsWith('-') && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const c = a[j] as string
        if (CURL_FLAGS[c]) opts[CURL_FLAGS[c] as 'head'] = true
        else if (CURL_WITH_VALUE[c]) {
          setValue(c, a.slice(j + 1) || (args[++i] ?? ''))
          break
        } else throw new CommandFailure(unsimulatedOptionMessage('curl', `-${c}`), 'NotSupported')
      }
    } else url = a
  }
  return { opts, url }
}

const curlTool: ToolDef = {
  name: 'curl',
  synopsis: 'Requête HTTP (curl [-I] [-i] [-s] [-k] [-L] [-H en-tête] http(s)://hôte[:port]/chemin).',
  run(ctx, args) {
    const { opts, url } = parseCurl(args)
    if (!url)
      throw new CommandFailure(
        "curl: try 'curl --help' or 'curl --manual' for more information",
        'InvalidArgument'
      )
    const here = ctx.host
    const release = linuxRelease(here)
    const head = opts.head
    let lastStatus = 0
    const visit = (urlText: string, hops: number): void => {
      const m = /^(?:(https?):\/\/)?([^/:]+)(?::(\d+))?([/?].*)?$/.exec(urlText)
      if (!m)
        throw new CommandFailure(`curl: (3) URL using bad/illegal format or missing URL`, 'InvalidArgument')
      const [, scheme = 'http', host = '', portText, rawPath = '/'] = m
      const path = rawPath.startsWith('?') ? `/${rawPath}` : rawPath
      const https = scheme === 'https'
      const port = Number(portText ?? (https ? 443 : 80))
      // -H "Host: nom" : nom de site demandé, distinct de l'adresse jointe
      const hostHeader = opts.headers
        .map((h) => /^host:\s*(.+)$/i.exec(h)?.[1]?.trim())
        .find((h): h is string => !!h)
      const requested = (hostHeader ?? host).replace(/:\d+$/, '')
      const isLocal =
        host === 'localhost' ||
        host === '127.0.0.1' ||
        host.toLowerCase() === here.name.toLowerCase() ||
        here.interfaces.some((i) => effectiveIpv4(i)?.address === host)
      let ip = opts.resolve[`${host.toLowerCase()}:${port}`] ?? host
      if (!isLocal && !isIpv4(ip)) {
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
      const target: HostDevice | undefined = isLocal
        ? here
        : Object.values(ctx.state.devices).find(
            (d): d is HostDevice =>
              (d.kind === 'server' || d.kind === 'client') &&
              d.powered &&
              d.interfaces.some((i) => effectiveIpv4(i)?.address === ip)
          )
      // Cible Windows : IIS (httpGet)
      if (target && !isLinuxHost(target)) {
        const r = httpGet(ctx.state, ctx.deviceId, `${scheme}://${host}:${port}${path}`)
        if (r.trace) ctx.addTrace(r.trace)
        if (r.kind === 'failure') throw refused()
        ctx.writeLines(
          [`HTTP/1.1 ${r.status} ${r.statusText}`.trimEnd(), 'Server: Microsoft-IIS/10.0'].slice(
            0,
            head ? 2 : 0
          )
        )
        if (!head) ctx.write(r.body)
        lastStatus = r.status
        return
      }
      if (!isLocal) {
        const exchange = serverExchange(ctx.state, ctx.deviceId, ip, {
          protocol: 'HTTP',
          port,
          request: `GET ${path} HTTP/1.1`,
          reply: 'HTTP/1.1 200 OK',
          fields: [['Hôte', requested]]
        })
        ctx.addTrace(exchange.trace)
        if (!exchange.ok) throw refused()
      }
      if (!target) throw refused()
      const dstIp = isLocal && (host === 'localhost' || host === '127.0.0.1') ? '127.0.0.1' : ip

      // Apache2 : la réponse vient de sa configuration en vigueur (services/linuxhttp.ts)
      if (apacheListening(target, port, dstIp)) {
        const files = hostFiles(target)
        const clientIp = isLocal ? dstIp : (sourceAddressFor(ctx.state, here, ip) ?? '127.0.0.1')
        const web = webRespond(
          target,
          files,
          (p) => (files[p] ? contentOfHost(target, p, files[p] as LinuxNode, files) : ''),
          {
            scheme: https ? 'https' : 'http',
            host: requested,
            port,
            dstIp,
            path,
            method: head ? 'HEAD' : 'GET',
            clientIp,
            clientPort: 32768 + ((ctx.state.seq * 37) % 28000),
            userAgent: opts.agent ?? `curl/${upstreamVersion('curl', release)}`
          },
          ctx.state.clock
        )
        if ('failure' in web) {
          if (web.failure === 'refused') throw refused()
          throw new CommandFailure('curl: (35) error:0A00010B:SSL routines::wrong version number', 'SslError')
        }
        if (https && web.tls && !opts.insecure) {
          ctx.writeLines(CERT_PROBLEM, 'error')
          return
        }
        ctx.apply(recordRequest(ctx.state, target.id, web))
        lastStatus = web.status
        const showHeaders = head || opts.include
        if (showHeaders) {
          ctx.write(`HTTP/1.1 ${web.status} ${web.statusText}`)
          ctx.writeLines(web.headers.map(([k, v]) => `${k}: ${v}`))
          ctx.write('')
        }
        const location = web.headers.find(([k]) => k === 'Location')?.[1]
        const following = opts.follow && !!location && web.status >= 300 && web.status < 400 && hops < 50
        // Avec -L, curl n'affiche pas le corps d'une redirection qu'il suit
        if (!head && !following && opts.output !== '/dev/null' && web.body !== '')
          ctx.writeLines(web.body.endsWith('\n') ? web.body.slice(0, -1).split('\n') : web.body.split('\n'))
        if (!opts.silent) for (const note of web.notes) ctx.write(`curl: ${note}`, 'warning')
        if (following && location) visit(location, hops + 1)
        return
      }

      const web = linuxSockets(target).find(
        (s) => s.proto === 'tcp' && s.port === port && s.unit.name === 'nginx'
      )
      if (!web) throw refused()
      if (https)
        throw new CommandFailure(unsimulatedOptionMessage('curl', 'https:// (nginx)'), 'NotSupported')
      if (head) ctx.writeLines(['HTTP/1.1 200 OK', `Server: ${nginxHeader(target)}`])
      if (!opts.silent)
        ctx.write(
          head
            ? 'curl: seuls la ligne d’état et l’en-tête Server sont reproduits (Date, ETag, Content-Length… non modélisés).'
            : 'curl: le contenu de la page par défaut du serveur Web n’est pas reproduit par ServerLab.',
          'warning'
        )
      lastStatus = 200
    }
    visit(url, 0)
    if (opts.writeOut !== null)
      ctx.write(
        opts.writeOut
          .replace(/%\{http_code\}/g, String(lastStatus))
          .replace(/\\n/g, '\n')
          .replace(/\n$/, '')
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
