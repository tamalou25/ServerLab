/**
 * Administration de Bind9 d'une console bash (v2.9, #240) : `named-checkconf`, `named-checkzone`, `rndc`
 * (status, reload, reconfig, flush) et `host`, d'après named-checkconf(1), named-checkzone(1), rndc(8),
 * host(1) et les sources de BIND 9.18 (Debian bookworm). Mêmes messages que les outils réels
 * (docs/captures/bash/*.txt, docs/fidelite.md L-90 à L-99). La résolution réelle par les clients est dans
 * roles/dns/resolver.ts ; ici seuls les outils d'administration et le client `host`.
 */
import { isIpv4 } from '../../net/ipv4'
import {
  AUTOMATIC_ZONES,
  checkConf,
  hostBindVersion,
  loadServer,
  loadZone,
  runningServer
} from '../../services/linuxbind'
import { findUnit } from '../../services/linuxcatalog'
import { fileText } from '../../services/linuxconfig'
import { isInstalled } from '../../services/linuxpackages'
import { rndcReload, unitStatus } from '../../services/linuxsystem'
import { dnsServersOf, resolveName, reverseLookup } from '../../roles/dns/resolver'
import { LAB_EPOCH_MS } from '../../core/clock'
import { CommandFailure, type ExecContext } from '../context'
import type { ToolDef } from '../tools/types'
import { unsimulatedOptionMessage } from '../unsimulated'
import { ctimeDate, resolvePath } from './interpreter'

const installed = (ctx: ExecContext) => isInstalled(ctx.host, 'bind9')
const filesOf = (ctx: ExecContext) => ctx.host.host.linux?.files

// ---------------------------------------------------------------------------------------------
// named-checkconf
// ---------------------------------------------------------------------------------------------

const namedCheckconfTool: ToolDef = {
  name: 'named-checkconf',
  synopsis: 'Contrôle named.conf (named-checkconf [-z] [fichier]).',
  switches: ['-z', '-v'],
  available: installed,
  run(ctx, args) {
    let zones = false
    const operands: string[] = []
    for (const a of args) {
      if (a === '-z') zones = true
      else if (a === '-v') return ctx.write(`${hostBindVersion(ctx.host)}`)
      else if (a.startsWith('-'))
        throw new CommandFailure(unsimulatedOptionMessage('named-checkconf', a), 'NotSupported')
      else operands.push(a)
    }
    const path = operands[0] ? resolvePath(ctx, operands[0]) : undefined
    const check = checkConf((p) => fileText(filesOf(ctx), p), path)
    ctx.writeLines(check.messages, 'error')
    if (!check.ok || !zones) return
    const server = loadServer(ctx.host, (p) => fileText(filesOf(ctx), p))
    for (const { zone } of server.zones) {
      if (zone.type !== 'primary' || zone.file === null) continue
      const full = zone.file.startsWith('/') ? zone.file : `${check.model.directory}/${zone.file}`
      ctx.writeLines(loadZone(fileText(filesOf(ctx), full), zone.name, full).messages)
    }
  }
}

// ---------------------------------------------------------------------------------------------
// named-checkzone
// ---------------------------------------------------------------------------------------------

const CHECKZONE_USAGE =
  'usage: named-checkzone [-djqvD] [-c class] [-f format] [-F format] [-J filename] [-i mode] [-k mode] [-m mode] [-M mode] [-n mode] [-l ttl] [-L serial] [-o filename] [-r mode] [-s style] [-S mode] [-t directory] [-T mode] [-w directory] [-D] [-W mode] zonename filename'

const namedCheckzoneTool: ToolDef = {
  name: 'named-checkzone',
  synopsis: 'Contrôle un fichier de zone (named-checkzone [-q] zone fichier).',
  switches: ['-q'],
  available: installed,
  run(ctx, args) {
    let quiet = false
    const operands: string[] = []
    for (const a of args) {
      if (a === '-q') quiet = true
      else if (a.startsWith('-'))
        throw new CommandFailure(unsimulatedOptionMessage('named-checkzone', a), 'NotSupported')
      else operands.push(a)
    }
    if (operands.length !== 2) return ctx.write(CHECKZONE_USAGE, 'error')
    const [zone, file] = operands as [string, string]
    const name = zone.toLowerCase().replace(/\.$/, '') || '.'
    const load = loadZone(fileText(filesOf(ctx), resolvePath(ctx, file)), name, file)
    if (quiet) return
    ctx.writeLines(load.messages)
    if (load.ok) ctx.write('OK')
  }
}

// ---------------------------------------------------------------------------------------------
// rndc
// ---------------------------------------------------------------------------------------------

const rndcTool: ToolDef = {
  name: 'rndc',
  synopsis: 'Pilote named (rndc status | reload [zone] | reconfig | flush).',
  switches: ['status', 'reload', 'reconfig', 'flush'],
  available: installed,
  run(ctx, args) {
    const [command, ...rest] = args
    if (command === undefined)
      throw new CommandFailure(
        'rndc : indiquez une commande (status, reload [zone], reconfig, flush). Les autres commandes ne sont pas simulées.',
        'Usage'
      )
    if (!['status', 'reload', 'reconfig', 'flush'].includes(command))
      throw new CommandFailure(unsimulatedOptionMessage('rndc', command), 'NotSupported')
    if (!ctx.root)
      throw new CommandFailure('none:0: open: /etc/bind/rndc.key: permission denied', 'AccessDenied')
    const unit = findUnit('named')
    if (!unit || !unitStatus(ctx.host, unit).active)
      throw new CommandFailure('rndc: connect failed: 127.0.0.1#953: connection refused', 'ConnectionRefused')
    if (command === 'flush') return
    if (command === 'status') {
      const server = runningServer(ctx.host)
      const now = ctx.state.clock
      const date = (clock: number) =>
        `${ctimeDate(clock, LAB_EPOCH_MS).replace(/^(\w{3}) (\w{3}) +(\d+) (.*) (\d{4})$/, '$1, $3 $2 $5 $4')} GMT`
      ctx.writeLines([
        `version: BIND ${hostBindVersion(ctx.host)} (Extended Support Version) <id:>`,
        `running on ${ctx.host.name}: Linux x86_64`,
        `boot time: ${date(0)}`,
        `last configured: ${date(now)}`,
        'configuration file: /etc/bind/named.conf',
        'CPUs found: 1',
        'worker threads: 1',
        `number of zones: ${AUTOMATIC_ZONES + server.zones.length} (${AUTOMATIC_ZONES} automatic)`,
        'debug level: 0',
        'xfers running: 0',
        'xfers deferred: 0',
        'soa queries in progress: 0',
        'query logging is OFF',
        'recursive clients: 0/900/1000',
        'tcp clients: 0/150',
        'TCP high-water: 0',
        'server is up and running'
      ])
      ctx.write(
        'rndc status : la version du noyau, la date de démarrage et le nombre de processeurs ne sont pas modélisés.',
        'warning'
      )
      return
    }
    if (command === 'reconfig' && rest.length > 0)
      throw new CommandFailure(unsimulatedOptionMessage('rndc reconfig', rest[0] as string), 'NotSupported')
    const result = ctx.apply(
      rndcReload(ctx.state, ctx.deviceId, command as 'reload' | 'reconfig', rest[0] ?? null)
    )
    if (result.message !== '') ctx.write(result.message, result.failed ? 'error' : 'out')
  }
}

// ---------------------------------------------------------------------------------------------
// host (bind9-host)
// ---------------------------------------------------------------------------------------------

const hostTool: ToolDef = {
  name: 'host',
  synopsis: 'Interroge le DNS (host nom [serveur], host -t type nom, host adresse).',
  run(ctx, args) {
    let type: string | null = null
    const operands: string[] = []
    for (let i = 0; i < args.length; i++) {
      const a = args[i] as string
      if (a === '-t') type = (args[++i] ?? '').toUpperCase()
      else if (a.startsWith('-'))
        throw new CommandFailure(unsimulatedOptionMessage('host', a), 'NotSupported')
      else operands.push(a)
    }
    const [query, serverArg] = operands
    if (!query)
      throw new CommandFailure('host : indiquez un nom ou une adresse (host nom [serveur]).', 'Usage')
    if (serverArg !== undefined && !isIpv4(serverArg))
      throw new CommandFailure(`Host ${serverArg} not found: 3(NXDOMAIN)`, 'NotFound')
    const server = serverArg ?? dnsServersOf(ctx.host)[0] ?? '127.0.0.53'
    const header = serverArg
      ? ['Using domain server:', `Name: ${serverArg}`, `Address: ${serverArg}#53`, 'Aliases: ', '']
      : []
    const reverse = isIpv4(query) && type === null
    const wanted = (type ?? (reverse ? 'PTR' : 'A')) as 'A'
    const r = reverse
      ? reverseLookup(ctx.state, ctx.deviceId, query, serverArg)
      : resolveName(ctx.state, ctx.deviceId, query, wanted, serverArg)
    ctx.addTrace(r.trace)
    const out = [...header]
    const name = (reverse ? r.fqdn : query).replace(/\.$/, '')
    const res = r.result
    if (res.kind === 'timeout') {
      ctx.writeLines(
        [';; communications error to ' + server + '#53: timed out', ';; no servers could be reached'],
        'error'
      )
      return
    }
    if (res.kind === 'nxdomain' || res.kind === 'servfail') {
      const code = res.kind === 'nxdomain' ? '3(NXDOMAIN)' : res.refused ? '5(REFUSED)' : '2(SERVFAIL)'
      ctx.writeLines([...out, `Host ${name} not found: ${code}`])
      return
    }
    if (res.records.length === 0) {
      ctx.writeLines([...out, `${name} has no ${wanted} record`])
      return
    }
    const abs = (n: string) => (n.endsWith('.') ? n : `${n}.`)
    for (const rec of res.records) {
      const owner = rec.name.replace(/\.$/, '')
      switch (rec.type) {
        case 'A':
          out.push(`${owner} has address ${rec.data}`)
          break
        case 'AAAA':
          out.push(`${owner} has IPv6 address ${rec.data}`)
          break
        case 'CNAME':
          out.push(`${owner} is an alias for ${abs(rec.data)}`)
          break
        case 'PTR':
          out.push(`${name} domain name pointer ${abs(rec.data)}`)
          break
        case 'NS':
          out.push(`${owner} name server ${abs(rec.data)}`)
          break
        case 'MX': {
          const [pref, target] = rec.data.split(' ')
          out.push(`${owner} mail is handled by ${pref} ${abs(target ?? '')}`)
          break
        }
        case 'TXT':
          out.push(`${owner} descriptive text ${rec.data}`)
          break
        case 'SOA': {
          const f = rec.data.split(' ')
          out.push(`${owner} has SOA record ${f.join(' ')}`)
          break
        }
        default:
          out.push(`${owner} has ${rec.type} record ${rec.data}`)
      }
    }
    ctx.writeLines(out)
  }
}

export const bindBashTools: ToolDef[] = [namedCheckconfTool, namedCheckzoneTool, rndcTool, hostTool]
