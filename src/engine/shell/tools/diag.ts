/**
 * Outils de diagnostic de l'invite de commandes : arp, route, netstat, systeminfo, sc, tasklist,
 * shutdown. Sorties calculées depuis l'état du lab (cartes, table de routage, rôles installés,
 * règles du pare-feu, voisins du segment).
 *
 * Syntaxe et comportement d'après Microsoft Learn (fr-fr, windows-commands) :
 * arp, route_ws2008, netstat, systeminfo, sc-query, tasklist, shutdown. Les mises en page exactes
 * et libellés français ne sont pas publiés sur Learn : « à vérifier » (docs/fidelite.md, Lot 3).
 * Limites du modèle : pas de cache ARP alimenté par le trafic (les voisins joignables du segment
 * en tiennent lieu), pas de routes statiques sur les ordinateurs, pas de processus réels (liste
 * dérivée des services démarrés). sc query / start / stop / config : état des services du moteur
 * (Lot 2a, services/hostservices.ts).
 */
import { effectiveIpv4 } from '../../net/addressing'
import { formatIpv4, networkInt, parseIpv4, prefixToMask, prefixToMaskInt } from '../../net/ipv4'
import { routingTable } from '../../net/routing'
import { carrierUp, l2Segment } from '../../net/segment'
import type { NetInterface } from '../../model/schema'
import { predefinedRules } from '../../services/firewall'
import { restartComputer } from '../../services/system'
import { setPower } from '../../topology/actions'
import { LEARN_CMD } from '../cmd/help'
import type { ExecContext } from '../context'
import {
  setServiceStartType,
  startService,
  stopService,
  type ServiceStartType
} from '../../services/hostservices'
import { consoleServices, findService } from './services'
import type { ToolDef } from './types'

const help = (slug: string, syntax: string[]) => ({ syntax, url: `${LEARN_CMD}${slug}` })
const lower = (args: string[]) => args.map((a) => a.toLowerCase())
/** Option reconnue sous la forme -x ou /x. */
const has = (args: string[], ...names: string[]) =>
  lower(args).some((a) => names.some((n) => a === `-${n}` || a === `/${n}`))

/** Cartes avec une adresse IPv4 et un lien actif. */
function activeInterfaces(ctx: ExecContext): { iface: NetInterface; address: string; prefix: number }[] {
  const host = ctx.host
  return host.interfaces.flatMap((iface) => {
    const eff = effectiveIpv4(iface)
    if (!eff || !iface.enabled || !carrierUp(ctx.state, { deviceId: host.id, ifaceId: iface.id })) return []
    return [{ iface, address: eff.address, prefix: eff.prefixLength }]
  })
}

/** Index d'interface (comme ifIndex, cohérent avec Get-NetAdapter). */
const ifIndex = (ctx: ExecContext, iface: NetInterface) =>
  4 + ctx.host.interfaces.findIndex((i) => i.id === iface.id) * 2

// ---------------------------------------------------------------------------------------------
// arp

export const arpTool: ToolDef = {
  name: 'arp',
  synopsis: 'Affiche les entrées du cache ARP (voisins du segment).',
  switches: ['-a', '-g', '-d', '-s', '-N', '-v'],
  help: help('arp', [
    'arp -s [inet_addr] [eth_addr] [if_addr]',
    'arp -d [inet_addr] [if_addr]',
    'arp -a [inet_addr] [-N if_addr] [-v]'
  ]),
  run(ctx, args) {
    const op = (args[0] ?? '').toLowerCase()
    if (op === '-s' || op === '/s' || op === '-d' || op === '/d') {
      ctx.write(
        `arp ${op} n’est pas simulé dans ServerLab : le cache ARP est dérivé des voisins du segment.`,
        'error'
      )
      return
    }
    if (op !== '-a' && op !== '/a' && op !== '-g' && op !== '/g') {
      ctx.write('La syntaxe de la commande n’est pas correcte. Tapez arp /? pour l’aide.', 'error')
      return
    }
    const rest = args.slice(1)
    const nIndex = rest.findIndex((a) => a === '-N' || a.toLowerCase() === '/n')
    const ifFilter = nIndex >= 0 ? rest[nIndex + 1] : undefined
    const inet = rest.find((a, i) => !a.startsWith('-') && !a.startsWith('/') && i !== nIndex + 1)
    const lines: string[] = []
    for (const { iface, address, prefix } of activeInterfaces(ctx)) {
      if (ifFilter && ifFilter !== address) continue
      const net = networkInt(parseIpv4(address) ?? 0, prefix)
      const neighbors = l2Segment(ctx.state, { deviceId: ctx.host.id, ifaceId: iface.id })
        .flatMap((m) => {
          const d = ctx.state.devices[m.port.deviceId]
          const i = d?.interfaces.find((x) => x.id === m.port.ifaceId)
          const eff = i ? effectiveIpv4(i) : null
          if (!d?.powered || !i || !eff || eff.address === address) return []
          if (networkInt(parseIpv4(eff.address) ?? 0, prefix) !== net) return []
          return [{ ip: eff.address, mac: i.mac.toLowerCase().replace(/[:.]/g, '-') }]
        })
        .filter((n, i, all) => all.findIndex((o) => o.ip === n.ip) === i)
        .filter((n) => !inet || n.ip === inet)
        .sort((a, b) => (parseIpv4(a.ip) ?? 0) - (parseIpv4(b.ip) ?? 0))
      const broadcast = formatIpv4((net | ~prefixToMaskInt(prefix)) >>> 0)
      lines.push(
        '',
        `Interface : ${address} --- 0x${ifIndex(ctx, iface).toString(16)}`,
        '  Adresse Internet      Adresse physique      Type',
        ...neighbors.map((n) => `  ${n.ip.padEnd(22)}${n.mac.padEnd(22)}dynamique`),
        ...(inet ? [] : [`  ${broadcast.padEnd(22)}${'ff-ff-ff-ff-ff-ff'.padEnd(22)}statique`])
      )
    }
    if (lines.length === 0) {
      ctx.write('Aucune entrée ARP trouvée.', 'error')
      return
    }
    ctx.writeLines([...lines, ''])
  }
}

// ---------------------------------------------------------------------------------------------
// route

function routePrint(ctx: ExecContext): void {
  const routes = routingTable(ctx.state, ctx.host)
  const ifaces = activeInterfaces(ctx)
  const addressOf = (ifaceId: string) => ifaces.find((i) => i.iface.id === ifaceId)?.address ?? ''
  const rows = routes.map((r) => {
    const gw = r.gateway ?? 'On-link'
    return `${r.network.padStart(18)}${prefixToMask(r.prefixLength).padStart(18)}${gw.padStart(18)}${addressOf(r.ifaceId).padStart(16)}`
  })
  ctx.writeLines([
    '===========================================================================',
    'Liste d’Interfaces',
    ...ctx.host.interfaces.map(
      (i) =>
        `${String(ifIndex(ctx, i)).padStart(3)}...${i.mac.toLowerCase().replace(/[-:.]/g, ' ')} ......${i.name}`
    ),
    '===========================================================================',
    '',
    'IPv4 Table de routage',
    '===========================================================================',
    'Itinéraires actifs :',
    'Destination réseau    Masque réseau  Adr. passerelle   Adr. interface',
    ...rows,
    '===========================================================================',
    'Itinéraires persistants :',
    '  Aucun',
    ''
  ])
}

export const routeTool: ToolDef = {
  name: 'route',
  synopsis: 'Affiche la table de routage IP locale (route print).',
  switches: ['print', 'add', 'delete', 'change', '/f', '/p'],
  help: help('route_ws2008', [
    'route [/f] [/p] [<command> [<destination>] [mask <netmask>] [<gateway>] [metric <metric>]] [if <interface>]]'
  ]),
  run(ctx, args) {
    const command = lower(args).find((a) => !a.startsWith('/') && !a.startsWith('-'))
    if (!command) {
      // Learn : sans paramètre, route affiche l'aide
      ctx.writeLines([
        'Syntaxe (Microsoft Learn) :',
        '  route [/f] [/p] [<command> [<destination>] [mask <netmask>] [<gateway>] [metric <metric>]] [if <interface>]]',
        ''
      ])
      return
    }
    if (command === 'print') {
      routePrint(ctx)
      return
    }
    if (command === 'add' || command === 'delete' || command === 'change' || has(args, 'f')) {
      ctx.write(
        `route ${command} n’est pas simulé dans ServerLab : les routes statiques des ordinateurs ne sont pas modélisées (passerelle par défaut seulement).`,
        'error'
      )
      return
    }
    ctx.write(`Commande non valide : ${command}. Commandes valides : print, add, delete, change.`, 'error')
  }
}

// ---------------------------------------------------------------------------------------------
// tasklist, netstat (processus dérivés des services)

interface Process {
  image: string
  pid: number
}

/** Exécutables propres de services (les autres services s'exécutent dans svchost.exe). */
const SERVICE_IMAGES: Record<string, string> = {
  DNS: 'dns.exe',
  vmms: 'vmms.exe',
  CertSvc: 'certsrv.exe',
  DFSR: 'dfsrs.exe',
  wbengine: 'wbengine.exe',
  WsusService: 'WsusService.exe'
}

/** Processus de l'ordinateur : noyau et processus système, puis exécutables des services. */
export function processes(ctx: ExecContext): Process[] {
  const base = ['smss.exe', 'csrss.exe', 'wininit.exe', 'services.exe', 'lsass.exe', 'svchost.exe']
  const roles = consoleServices(ctx)
    .filter((s) => s.status === 'Running')
    .map((s) => SERVICE_IMAGES[s.name])
    .filter((x): x is string => !!x)
  const list: Process[] = [
    { image: 'System Idle Process', pid: 0 },
    { image: 'System', pid: 4 }
  ]
  ;[...base, ...roles, 'cmd.exe'].forEach((image, i) => list.push({ image, pid: 300 + i * 4 }))
  return list
}

export const tasklistTool: ToolDef = {
  name: 'tasklist',
  synopsis: 'Affiche les processus (dérivés des services installés).',
  switches: ['/fo', '/nh', '/svc', '/fi'],
  help: help('tasklist', [
    'tasklist [/s <computer> [/u [<domain>\\]<username> [/p <password>]]] [{/m <module> | /svc | /v}] [/fo {table | list | csv}] [/nh] [/fi <filter> [/fi <filter> [ ... ]]]'
  ]),
  run(ctx, args) {
    const opts = lower(args)
    const unsupported = opts.find((a) => ['/s', '/m', '/svc', '/v', '/fi'].includes(a))
    if (unsupported) {
      ctx.write(`L’option ${unsupported} de tasklist n’est pas simulée dans ServerLab.`, 'error')
      return
    }
    const foIndex = opts.indexOf('/fo')
    const format = foIndex >= 0 ? (opts[foIndex + 1] ?? '') : 'table'
    if (!['table', 'list', 'csv'].includes(format)) {
      ctx.write(`Erreur : valeur non valide « ${args[foIndex + 1] ?? ''} » pour l’option /fo.`, 'error')
      return
    }
    const noHeader = opts.includes('/nh')
    const procs = processes(ctx)
    const session = (p: Process): [string, string] =>
      p.image === 'cmd.exe' ? ['Console', '1'] : ['Services', '0']
    if (format === 'csv') {
      ctx.writeLines([
        ...(noHeader ? [] : ['"Nom de l’image","PID","Nom de la session","Numéro de session"']),
        ...procs.map((p) => [p.image, String(p.pid), ...session(p)].map((v) => `"${v}"`).join(','))
      ])
      return
    }
    if (format === 'list') {
      ctx.writeLines(
        procs.flatMap((p) => [
          '',
          `Nom de l’image :    ${p.image}`,
          `PID :               ${p.pid}`,
          `Nom de la session : ${session(p)[0]}`,
          `Numéro de session : ${session(p)[1]}`
        ])
      )
      return
    }
    ctx.writeLines([
      '',
      ...(noHeader
        ? []
        : [
            `${'Nom de l’image'.padEnd(26)}${'PID'.padStart(8)} ${'Nom de la session'.padEnd(17)}${'Numéro de s'.padStart(12)}`,
            `${'='.repeat(25)} ${'='.repeat(8)} ${'='.repeat(16)} ${'='.repeat(11)}`
          ]),
      ...procs.map(
        (p) =>
          `${p.image.slice(0, 25).padEnd(26)}${String(p.pid).padStart(8)} ${session(p)[0].padEnd(17)}${session(p)[1].padStart(11)}`
      ),
      ''
    ])
  }
}

/** Processus propriétaire d'un port en écoute (PID cohérent avec tasklist). */
function portOwner(ctx: ExecContext, port: number): number {
  const procs = processes(ctx)
  const pid = (image: string) => procs.find((p) => p.image === image)?.pid ?? 4
  if (port === 53) return pid('dns.exe')
  if (port === 88 || port === 389) return pid('lsass.exe')
  if (port === 5722) return pid('dfsrs.exe')
  if (port === 8530 || port === 80 || port === 443 || port === 445) return 4
  return pid('svchost.exe')
}

export const netstatTool: ToolDef = {
  name: 'netstat',
  synopsis: 'Affiche les ports en écoute (rôles installés).',
  switches: ['-a', '-n', '-o', '-an', '-ano', '-p'],
  help: help('netstat', ['netstat [-a] [-b] [-e] [-n] [-o] [-p <Protocol>] [-q] [-r] [-s] [<interval>]']),
  run(ctx, args) {
    const flags = new Set(
      lower(args)
        .filter((a) => /^[-/][a-z]+$/.test(a))
        .flatMap((a) => [...a.slice(1)])
    )
    const unsupported = [...flags].find((f) => !['a', 'n', 'o', 'r'].includes(f))
    if (unsupported) {
      ctx.write(`L’option -${unsupported} de netstat n’est pas simulée dans ServerLab.`, 'error')
      return
    }
    if (flags.has('r')) {
      routePrint(ctx)
      return
    }
    const withPid = flags.has('o')
    const host = ctx.host
    // Ports d'écoute : règles prédéfinies des services présents (TCP / UDP) ; le pare-feu
    // filtre le trafic mais ne ferme pas les ports en écoute.
    const listen = predefinedRules(host)
      .filter((r) => r.protocol === 'TCP' || r.protocol === 'UDP')
      .filter((r) => r.id !== 'RemoteDesktop-UserMode-In-TCP' || host.host.remoteDesktop.enabled)
      .flatMap((r) => r.localPorts.map((port) => ({ proto: r.protocol, port })))
      .filter((e, i, all) => all.findIndex((o) => o.proto === e.proto && o.port === e.port) === i)
      .sort((a, b) => (a.proto === b.proto ? a.port - b.port : a.proto === 'TCP' ? -1 : 1))
    // Sans -a : connexions actives seulement (aucune connexion établie n'est simulée)
    const rows = flags.has('a')
      ? listen.map(({ proto, port }) => {
          const local = `0.0.0.0:${port}`
          const remote = proto === 'TCP' ? '0.0.0.0:0' : '*:*'
          const state = proto === 'TCP' ? 'LISTENING' : ''
          const line = `  ${proto.padEnd(7)}${local.padEnd(23)}${remote.padEnd(23)}${state.padEnd(16)}`
          return (withPid ? `${line}${portOwner(ctx, port)}` : line).trimEnd()
        })
      : []
    ctx.writeLines([
      '',
      'Connexions actives',
      '',
      `  ${'Proto'.padEnd(7)}${'Adresse locale'.padEnd(23)}${'Adresse distante'.padEnd(23)}${withPid ? `${'État'.padEnd(16)}PID` : 'État'}`,
      ...rows,
      ''
    ])
  }
}

// ---------------------------------------------------------------------------------------------
// systeminfo

export const systeminfoTool: ToolDef = {
  name: 'systeminfo',
  synopsis: 'Affiche la configuration de l’ordinateur (sous-ensemble simulé).',
  switches: ['/fo', '/nh'],
  help: help('systeminfo', [
    'systeminfo [/s <computer> [/u <domain>\\<username> [/p <password>]]] [/fo {TABLE | LIST | CSV}] [/nh]'
  ]),
  run(ctx, args) {
    const opts = lower(args)
    const unsupported = opts.find((a) => a.startsWith('/') && a !== '/fo' && a !== '/nh')
    const fo = opts.includes('/fo') ? (opts[opts.indexOf('/fo') + 1] ?? '') : 'list'
    if (unsupported || fo !== 'list') {
      ctx.write(
        `L’option ${unsupported ?? `/fo ${fo}`} de systeminfo n’est pas simulée dans ServerLab (format LIST seulement).`,
        'error'
      )
      return
    }
    const host = ctx.host
    const server = host.kind === 'server'
    const domain = host.host.domain ?? host.host.workgroup
    const logon = host.host.session?.logonServer
    const cards = host.interfaces
    const row = (label: string, value: string) => `${`${label}:`.padEnd(43)}${value}`
    ctx.writeLines([
      '',
      row('Nom de l’hôte', host.name),
      row(
        'Nom du système d’exploitation',
        server ? 'Système serveur (simulé) Standard' : 'Système client (simulé)'
      ),
      row('Domaine', domain),
      row('Serveur d’ouverture de session', `\\\\${logon ?? host.name}`),
      row('Carte(s) réseau', `${cards.length} carte(s) réseau installée(s).`),
      ...cards.flatMap((c, i) => {
        const eff = effectiveIpv4(c)
        return [
          `${' '.repeat(43)}[${String(i + 1).padStart(2, '0')}]: ${c.name}`,
          `${' '.repeat(49)}DHCP activé :      ${c.addressing === 'dhcp' ? 'Oui' : 'Non'}`,
          ...(eff ? [`${' '.repeat(49)}Adresse(s) IP`, `${' '.repeat(49)}[01]: ${eff.address}`] : [])
        ]
      }),
      ''
    ])
  }
}

// ---------------------------------------------------------------------------------------------
// sc

export const scTool: ToolDef = {
  name: 'sc',
  synopsis: 'Interroge et contrôle les services (query, start, stop, config start=).',
  switches: ['query', 'start', 'stop', 'config'],
  help: help('sc-query', [
    'sc.exe [<servername>] query [<servicename>] [type= {driver | service | all}] [type= {own | share | interact | kernel | filesys | rec | adapt}] [state= {active | inactive | all}] [bufsize= <Buffersize>] [ri= <Resumeindex>] [group= <groupname>]',
    'sc.exe [<servername>] config [<servicename>] [start= {boot | system | auto | demand | disabled | delayed-auto}]'
  ]),
  run(ctx, args) {
    const [op = '', ...rest] = args
    const verb = op.toLowerCase()
    // Options « nom= valeur » (Learn : le signe égal fait partie du nom, un espace avant la valeur)
    const options = new Map<string, string>()
    const positional: string[] = []
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i] as string
      if (a.endsWith('=')) {
        options.set(a.slice(0, -1).toLowerCase(), (rest[i + 1] ?? '').toLowerCase())
        i++
      } else positional.push(a)
    }
    const name = positional[0]
    const missing = (api: string) =>
      ctx.writeLines(
        [
          `[SC] ${api} échec(s) 1060 :`,
          '',
          'Le service spécifié n’existe pas en tant que service installé.',
          ''
        ],
        'error'
      )
    const state = (s: { status: string }) =>
      s.status === 'Running'
        ? '        ÉTAT               : 4  RUNNING'
        : '        ÉTAT               : 1  STOPPED'
    if (verb === 'query') {
      if (name) {
        const s = findService(ctx, name)
        if (!s) return missing('EnumQueryServicesStatus:OpenService')
        ctx.writeLines(['', `NOM_SERVICE: ${s.name}`, `NOM_AFFICHAGE: ${s.display}`, state(s), ''])
        return
      }
      // Learn : state= active (défaut), inactive (arrêtés) ou all
      const filter = options.get('state') ?? 'active'
      if (!['active', 'inactive', 'all'].includes(filter)) {
        ctx.write(`[SC] Valeur non valide pour state= : ${filter} (active, inactive, all).`, 'error')
        return
      }
      const list = consoleServices(ctx).filter((s) =>
        filter === 'all' ? true : filter === 'active' ? s.status === 'Running' : s.status !== 'Running'
      )
      ctx.writeLines(
        list.flatMap((s) => ['', `NOM_SERVICE: ${s.name}`, `NOM_AFFICHAGE: ${s.display}`, state(s), ''])
      )
      return
    }
    if (verb === 'start' || verb === 'stop') {
      const s = name ? findService(ctx, name) : undefined
      if (!s) return missing('OpenService')
      if (verb === 'start') {
        if (s.status === 'Running')
          return ctx.write(
            '[SC] StartService échec(s) 1056 :\n\nUne instance du service s’exécute déjà.',
            'error'
          )
        if (s.startType === 'Disabled')
          return ctx.write(
            '[SC] StartService échec(s) 1058 :\n\nLe service ne peut pas être démarré, soit parce qu’il a été désactivé, soit parce qu’il n’a pas de périphériques activés qui lui sont associés.',
            'error'
          )
        ctx.apply(startService(ctx.state, ctx.deviceId, s.name))
        ctx.writeLines(['', `NOM_SERVICE: ${s.name}`, '        ÉTAT               : 2  START_PENDING', ''])
        return
      }
      if (s.status === 'Stopped')
        return ctx.write('[SC] ControlService échec(s) 1062 :\n\nLe service n’a pas été démarré.', 'error')
      if (!s.canStop)
        return ctx.write(
          '[SC] ControlService échec(s) 1052 :\n\nLe contrôle demandé n’est pas valide pour ce service.',
          'error'
        )
      ctx.apply(stopService(ctx.state, ctx.deviceId, s.name))
      ctx.writeLines(['', `NOM_SERVICE: ${s.name}`, '        ÉTAT               : 3  STOP_PENDING', ''])
      return
    }
    if (verb === 'config') {
      const s = name ? findService(ctx, name) : undefined
      if (!s) return missing('OpenService')
      const start = options.get('start')
      // Learn (sc config) : auto, demand, disabled, delayed-auto ; boot et system : pilotes
      const types: Record<string, ServiceStartType> = {
        auto: 'Automatic',
        'delayed-auto': 'Automatic',
        demand: 'Manual',
        disabled: 'Disabled'
      }
      const others = [...options.keys()].filter((k) => k !== 'start')
      if (others.length > 0 || start === undefined || !types[start]) {
        ctx.write(
          `L’option « ${others[0] ?? `start= ${start ?? ''}`} » de sc config n’est pas simulée dans ServerLab (start= auto, demand, disabled ou delayed-auto).`,
          'error'
        )
        return
      }
      ctx.apply(setServiceStartType(ctx.state, ctx.deviceId, s.name, types[start] as ServiceStartType))
      ctx.writeLines(['[SC] ChangeServiceConfig réussite(s)', ''])
      return
    }
    ctx.write(
      `La sous-commande « sc ${op} » n’est pas simulée dans ServerLab (query, start, stop, config).`,
      'error'
    )
  }
}

// ---------------------------------------------------------------------------------------------
// shutdown

export const shutdownTool: ToolDef = {
  name: 'shutdown',
  synopsis: 'Redémarre (/r) ou arrête (/s) l’ordinateur.',
  switches: ['/r', '/s', '/t', '/f', '/a', '/c', '/d'],
  help: help('shutdown', [
    'shutdown [/i | /l | /s | /sg | /r | /g | /a | /p | /h | /e | /o] [/hybrid] [/fw] [/f] [/m \\\\computer][/t xxx][/d [p|u:]xx:yy [/c "comment"]]'
  ]),
  run(ctx, args) {
    const opts = lower(args)
    const tIndex = opts.indexOf('/t')
    if (tIndex >= 0) {
      const t = Number(opts[tIndex + 1])
      // Learn : plage 0 - 315360000
      if (!/^\d+$/.test(opts[tIndex + 1] ?? '') || t > 315360000) {
        ctx.write('La syntaxe de la commande n’est pas correcte. Valeur de /t : 0 à 315360000.', 'error')
        return
      }
    }
    const action = ['/r', '/s', '/p', '/a', '/l', '/h', '/g', '/sg', '/i', '/e', '/o'].filter((o) =>
      opts.includes(o)
    )
    if (action.length !== 1 || (action[0] !== '/r' && action[0] !== '/s' && action[0] !== '/p')) {
      ctx.write(
        action.length === 0
          ? 'La syntaxe de la commande n’est pas correcte : indiquez /r (redémarrer) ou /s (arrêter).'
          : `L’option ${action.join(' ')} de shutdown n’est pas simulée dans ServerLab (/r, /s et /p seulement).`,
        'error'
      )
      return
    }
    if (opts.includes('/m')) {
      ctx.write('L’arrêt d’un ordinateur distant (/m) n’est pas simulé dans ServerLab.', 'error')
      return
    }
    // Délai /t non simulé : l'action est appliquée immédiatement
    const r =
      action[0] === '/r'
        ? restartComputer(ctx.state, ctx.deviceId, 'shutdown /r')
        : setPower(ctx.state, ctx.deviceId, false)
    if (!r.ok) {
      ctx.write(r.error.message, 'error')
      return
    }
    ctx.state = r.state
    if (action[0] !== '/r') ctx.exit = true
  }
}

export const diagTools: ToolDef[] = [
  arpTool,
  routeTool,
  netstatTool,
  systeminfoTool,
  scTool,
  tasklistTool,
  shutdownTool
]
