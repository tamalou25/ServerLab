/**
 * Commandes du système de base de la console bash (poste Ubuntu) : ip, ping, dhclient,
 * hostname, whoami. Messages et sorties au format d'origine des outils (iproute2, iputils).
 */
import { effectiveIpv4 } from '../../net/addressing'
import { setInterfaceIpv4 } from '../../net/config'
import { ping } from '../../net/diagnostics'
import { broadcastInt, formatIpv4, isIpv4, networkAddress, parseIpv4 } from '../../net/ipv4'
import { carrierUp } from '../../net/segment'
import type { NetInterface } from '../../model/schema'
import { dhcpRelease, dhcpRenew } from '../../roles/dhcp/client'
import { firstAddress, resolveName } from '../../roles/dns/resolver'
import { CommandFailure, type ExecContext } from '../context'
import type { ToolDef } from '../tools/types'
import { neighLines } from './net'

/** Les commandes d'administration exigent sudo. */
export function requireRoot(ctx: ExecContext, message: string): void {
  if (!ctx.root) throw new CommandFailure(message, 'PermissionDenied')
}

/** Carte désignée par son nom (dev eth0) ou première carte du poste. */
export function linuxIface(ctx: ExecContext, name?: string): NetInterface {
  const iface = name
    ? ctx.host.interfaces.find((i) => i.name === name)
    : ctx.host.interfaces.find((i) => i.l3)
  if (!iface) throw new CommandFailure(`Cannot find device "${name ?? ''}"`, 'NotFound')
  return iface
}

const linuxMac = (mac: string) => mac.toLowerCase().replace(/-/g, ':')

function linkLines(ctx: ExecContext, iface: NetInterface, index: number): string[] {
  const carrier = iface.enabled && carrierUp(ctx.state, { deviceId: ctx.host.id, ifaceId: iface.id })
  const flags = !iface.enabled
    ? 'BROADCAST,MULTICAST'
    : carrier
      ? 'BROADCAST,MULTICAST,UP,LOWER_UP'
      : 'NO-CARRIER,BROADCAST,MULTICAST,UP'
  return [
    `${index}: ${iface.name}: <${flags}> mtu 1500 qdisc fq_codel state ${carrier ? 'UP' : 'DOWN'} group default qlen 1000`,
    `    link/ether ${linuxMac(iface.mac)} brd ff:ff:ff:ff:ff:ff`
  ]
}

const LOOPBACK = [
  '1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN group default qlen 1000',
  '    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00'
]

function addressLines(ctx: ExecContext, only?: string): string[] {
  if (only !== undefined && only !== 'lo' && !ctx.host.interfaces.some((i) => i.name === only))
    throw new CommandFailure(`Device "${only}" does not exist.`, 'NotFound')
  const lines =
    only && only !== 'lo'
      ? []
      : [...LOOPBACK, '    inet 127.0.0.1/8 scope host lo', '       valid_lft forever preferred_lft forever']
  ctx.host.interfaces.forEach((iface, i) => {
    if (only !== undefined && iface.name !== only) return
    lines.push(...linkLines(ctx, iface, i + 2))
    const eff = effectiveIpv4(iface)
    const carrier = iface.enabled && carrierUp(ctx.state, { deviceId: ctx.host.id, ifaceId: iface.id })
    if (!eff || !carrier) return
    const brd = formatIpv4(broadcastInt(parseIpv4(eff.address) ?? 0, eff.prefixLength))
    const scope = eff.source === 'apipa' ? 'link' : 'global'
    const dynamic = eff.source === 'dhcp' ? ' dynamic' : ''
    lines.push(
      `    inet ${eff.address}/${eff.prefixLength} brd ${brd} scope ${scope}${dynamic} ${iface.name}`
    )
    const lease = eff.source === 'dhcp' ? iface.dhcpLease : null
    const left = lease
      ? `${Math.max(0, Math.round((lease.expiresAt - ctx.state.clock) / 1000))}sec`
      : 'forever'
    lines.push(`       valid_lft ${left} preferred_lft ${left}`)
  })
  return lines
}

function routeLines(ctx: ExecContext): string[] {
  const lines: string[] = []
  const defaults: string[] = []
  for (const iface of ctx.host.interfaces) {
    const eff = effectiveIpv4(iface)
    const carrier = iface.enabled && carrierUp(ctx.state, { deviceId: ctx.host.id, ifaceId: iface.id })
    if (!eff || !carrier) continue
    const dhcp = eff.source === 'dhcp'
    if (eff.gateway)
      defaults.push(
        dhcp
          ? `default via ${eff.gateway} dev ${iface.name} proto dhcp src ${eff.address} metric 100`
          : `default via ${eff.gateway} dev ${iface.name} proto static`
      )
    const net = `${networkAddress(eff.address, eff.prefixLength)}/${eff.prefixLength}`
    lines.push(
      `${net} dev ${iface.name} proto kernel scope link src ${eff.address}${dhcp ? ' metric 100' : ''}`
    )
  }
  return [...defaults, ...lines]
}

/** Nouvelle configuration statique de la carte (adresse, passerelle), DNS conservés. */
function setStatic(ctx: ExecContext, iface: NetInterface, patch: { cidr?: string; gateway?: string | null }) {
  const eff = effectiveIpv4(iface)
  const [address, prefix] = patch.cidr
    ? (patch.cidr.split('/') as [string, string | undefined])
    : [eff?.address ?? '', String(eff?.prefixLength ?? 24)]
  ctx.apply(
    setInterfaceIpv4(ctx.state, ctx.host.id, iface.id, {
      addressing: 'static',
      address,
      mask: prefix ?? '32',
      gateway: patch.gateway === undefined ? (eff?.gateway ?? null) : patch.gateway,
      dnsServers: eff?.dnsServers ?? []
    })
  )
}

const ipTool: ToolDef = {
  name: 'ip',
  synopsis: 'Affiche ou modifie les adresses et les routes (ip a, ip r).',
  run(ctx, args) {
    const [object = '', action = 'show', ...rest] = args.filter((a) => a !== '-4')
    const is = (value: string, ...names: string[]) => names.some((n) => n.startsWith(value) && value !== '')
    if (is(object, 'address', 'addr')) {
      if (action === 'show' || action === 'list' || action === 'ls') {
        const names = rest.filter((a) => a !== 'dev' && a !== 'up' && !a.startsWith('-'))
        return ctx.writeLines(addressLines(ctx, names[0]))
      }
      if (action === 'add' || action === 'del' || action === 'flush') {
        requireRoot(ctx, 'RTNETLINK answers: Operation not permitted')
        const dev = rest[rest.indexOf('dev') + 1]
        const iface = linuxIface(ctx, rest.includes('dev') ? dev : undefined)
        if (action === 'add') {
          const cidr = rest[0] ?? ''
          if (!/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(cidr) || !isIpv4(cidr.split('/')[0] ?? ''))
            throw new CommandFailure(
              `Error: any valid prefix is expected rather than "${cidr}".`,
              'InvalidArgument'
            )
          setStatic(ctx, iface, { cidr })
        } else
          ctx.apply(
            setInterfaceIpv4(ctx.state, ctx.host.id, iface.id, {
              addressing: 'static',
              address: '',
              mask: '',
              gateway: null,
              dnsServers: []
            })
          )
        return
      }
    }
    if (is(object, 'route')) {
      if (action === 'show' || action === 'list') return ctx.writeLines(routeLines(ctx))
      if (action === 'add' || action === 'del') {
        requireRoot(ctx, 'RTNETLINK answers: Operation not permitted')
        if (rest[0] !== 'default')
          throw new CommandFailure(
            'Seule la route par défaut est simulée (ip route add default via …).',
            'NotSupported'
          )
        const iface = linuxIface(ctx)
        if (action === 'del') return setStatic(ctx, iface, { gateway: null })
        const via = rest[rest.indexOf('via') + 1] ?? ''
        if (!rest.includes('via') || !isIpv4(via))
          throw new CommandFailure(`Error: inet address is expected rather than "${via}".`, 'InvalidArgument')
        return setStatic(ctx, iface, { gateway: via })
      }
    }
    if (is(object, 'neighbour', 'neighbor') || object === 'neigh') return ctx.writeLines(neighLines(ctx))
    if (is(object, 'link')) {
      const lines = [...LOOPBACK]
      ctx.host.interfaces.forEach((iface, i) => lines.push(...linkLines(ctx, iface, i + 2)))
      return ctx.writeLines(lines)
    }
    if (object === '')
      return ctx.writeLines([
        'Usage: ip [ OPTIONS ] OBJECT { COMMAND | help }',
        '       OBJECT := { address | link | route }'
      ])
    throw new CommandFailure(`Object "${object}" is unknown, try "ip help".`, 'InvalidArgument')
  }
}

/** Durée affichée par ping (millisecondes, trois chiffres significatifs). */
const rtt = (ms: number) => (ms <= 0 ? 0.4 : ms).toFixed(ms >= 10 ? 1 : ms >= 1 ? 2 : 3)

const pingTool: ToolDef = {
  name: 'ping',
  synopsis: 'Teste la connectivité (ping -c 4 hôte).',
  run(ctx, args) {
    let count = 4
    let target: string | null = null
    for (let i = 0; i < args.length; i++) {
      const a = args[i] as string
      if (a === '-c') count = Number(args[++i])
      else if (a.startsWith('-c')) count = Number(a.slice(2))
      else if (!a.startsWith('-')) target = a
    }
    if (!target)
      throw new CommandFailure('ping: usage error: Destination address required', 'InvalidArgument')
    if (!Number.isInteger(count) || count < 1)
      throw new CommandFailure(`ping: invalid argument: '${count}'`, 'InvalidArgument')
    let ip = target
    let label = target
    if (!isIpv4(target)) {
      const r = resolveName(ctx.state, ctx.deviceId, target)
      ctx.addTrace(r.trace)
      const found = firstAddress(r)
      if (!found)
        throw new CommandFailure(
          r.result.kind === 'nxdomain'
            ? `ping: ${target}: Name or service not known`
            : `ping: ${target}: Temporary failure in name resolution`,
          'HostNotFound'
        )
      ip = found
      label = r.fqdn.replace(/\.$/, '')
    }
    const result = ping(ctx.state, ctx.deviceId, ip, { count: Math.min(count, 20), size: 56 })
    if (!result.ok) throw new CommandFailure(`ping: ${result.error.message}`, result.error.code)
    const { outcomes } = result.value
    ctx.addTrace(result.value.trace)
    if (outcomes.every((o) => o.kind === 'transmit-failed'))
      throw new CommandFailure('ping: connect: Network is unreachable', 'NetworkUnreachable')
    const named = label !== ip
    const lines = [`PING ${label} (${ip}) 56(84) bytes of data.`]
    outcomes.forEach((o, i) => {
      if (o.kind === 'reply')
        lines.push(
          `64 bytes from ${named ? `${label} (${o.from})` : o.from}: icmp_seq=${i + 1} ttl=${o.ttl} time=${rtt(o.time)} ms`
        )
      else if (o.kind === 'unreachable')
        lines.push(`From ${o.from} icmp_seq=${i + 1} Destination Host Unreachable`)
      else if (o.kind === 'ttl-expired') lines.push(`From ${o.from} icmp_seq=${i + 1} Time to live exceeded`)
    })
    const sent = outcomes.length
    const received = outcomes.filter((o) => o.kind === 'reply').length
    const errors = outcomes.filter((o) => o.kind === 'unreachable' || o.kind === 'ttl-expired').length
    const loss = Math.round(((sent - received) / sent) * 100)
    lines.push(
      '',
      `--- ${label} ping statistics ---`,
      `${sent} packets transmitted, ${received} received, ${errors > 0 ? `+${errors} errors, ` : ''}${loss}% packet loss, time ${Math.max(0, sent - 1) * 1001}ms`
    )
    const times = outcomes.flatMap((o) => (o.kind === 'reply' ? [o.time <= 0 ? 0.4 : o.time] : []))
    if (times.length > 0) {
      const min = Math.min(...times)
      const max = Math.max(...times)
      const avg = times.reduce((a, b) => a + b, 0) / times.length
      const mdev = Math.sqrt(times.reduce((a, b) => a + (b - avg) ** 2, 0) / times.length)
      lines.push(`rtt min/avg/max/mdev = ${[min, avg, max, mdev].map((v) => v.toFixed(3)).join('/')} ms`)
    }
    ctx.writeLines(lines)
  }
}

const dhclientTool: ToolDef = {
  name: 'dhclient',
  synopsis: 'Demande (ou libère avec -r) un bail DHCP.',
  run(ctx, args) {
    const release = args.includes('-r')
    const iface = linuxIface(
      ctx,
      args.find((a) => !a.startsWith('-'))
    )
    if (release) {
      const op = dhcpRelease(ctx.state, ctx.deviceId, iface.id)
      ctx.state = op.state
      ctx.addTrace(op.trace)
      return
    }
    if (iface.addressing !== 'dhcp')
      ctx.apply(
        setInterfaceIpv4(ctx.state, ctx.host.id, iface.id, {
          addressing: 'dhcp',
          address: '',
          mask: '',
          gateway: null,
          dnsServers: []
        })
      )
    const op = dhcpRenew(ctx.state, ctx.deviceId, iface.id)
    ctx.state = op.state
    ctx.addTrace(op.trace)
  }
}

const hostnameTool: ToolDef = {
  name: 'hostname',
  synopsis: 'Affiche le nom de l’ordinateur.',
  run(ctx) {
    ctx.write(ctx.host.name)
  }
}

const whoamiTool: ToolDef = {
  name: 'whoami',
  synopsis: 'Affiche l’utilisateur courant.',
  run(ctx) {
    ctx.write(ctx.root ? 'root' : (ctx.host.host.session?.user ?? 'etudiant'))
  }
}

export const coreBashTools: ToolDef[] = [ipTool, pingTool, dhclientTool, hostnameTool, whoamiTool]
