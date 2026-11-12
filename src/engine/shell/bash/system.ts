/**
 * Administration système de la console bash (serveur Debian, poste Ubuntu) : apt, systemctl,
 * journalctl, ss, ps, df, free, uname, hostnamectl (v2.9, #236). Les sorties reprennent le
 * format des outils d'origine (anglais, locale C) ; les valeurs viennent de l'état du lab
 * (services/linuxsystem.ts). Ce qui n'est pas modélisé (mémoire, disques, CPU, version exacte
 * du noyau) n'est jamais inventé : la colonne affiche « - » et une ligne d'erreur le dit.
 * Sources et écarts connus : docs/fidelite.md, section v2.9 ; captures : docs/captures/bash/.
 */
import { ping } from '../../net/diagnostics'
import { effectiveIpv4 } from '../../net/addressing'
import {
  RELEASES,
  findPackage,
  findUnit,
  PACKAGES,
  type LinuxPackage,
  type LinuxUnit
} from '../../services/linuxcatalog'
import {
  activeSince,
  installPackages,
  installedUnits,
  isInstalled,
  jobFailedLines,
  journalStamp,
  linuxRelease,
  linuxSockets,
  relativeAgo,
  removePackages,
  statusStamp,
  unitAction,
  unitFailed,
  unitJournal,
  unitPid,
  unitStatus,
  unitTitle,
  type UnitAction
} from '../../services/linuxsystem'
import { CommandFailure, type ExecContext } from '../context'
import type { ToolDef } from '../tools/types'
import { unsimulatedOptionMessage } from '../unsimulated'

/** Options (commençant par -) et arguments d'une ligne de commande. */
function split(args: string[]): { flags: string[]; rest: string[] } {
  return { flags: args.filter((a) => a.startsWith('-')), rest: args.filter((a) => !a.startsWith('-')) }
}

const hasFlag = (flags: string[], ...names: string[]) => flags.some((f) => names.includes(f))

// ---------------------------------------------------------------------------------------------
// apt
// ---------------------------------------------------------------------------------------------

const APT_READING = [
  'Reading package lists... Done',
  'Building dependency tree... Done',
  'Reading state information... Done'
]

/** Accès au dépôt : un résolveur DNS configuré et un hôte public joignable (Internet simulé). */
function repositoryReachable(ctx: ExecContext): boolean {
  // Résolveur configuré sur une carte (statique ou bail DHCP) : sans lui, le nom du dépôt ne se résout pas
  if (!ctx.host.interfaces.some((i) => (effectiveIpv4(i)?.dnsServers.length ?? 0) > 0)) return false
  const r = ping(ctx.state, ctx.deviceId, '93.184.215.14', { count: 1, size: 56 })
  return r.ok && r.value.outcomes.some((o) => o.kind === 'reply')
}

const hostOfUrl = (url: string) => /^https?:\/\/([^/]+)/.exec(url)?.[1] ?? url

/** Verrou apt refusé à un utilisateur sans sudo. */
function aptDenied(ctx: ExecContext, sub: string): never {
  const lines =
    sub === 'update'
      ? [
          'Reading package lists... Done',
          'E: Could not open lock file /var/lib/apt/lists/lock - open (13: Permission denied)',
          'E: Unable to lock directory /var/lib/apt/lists/',
          'W: Problem unlinking the file /var/cache/apt/pkgcache.bin - RemoveCaches (13: Permission denied)',
          'W: Problem unlinking the file /var/cache/apt/srcpkgcache.bin - RemoveCaches (13: Permission denied)'
        ]
      : [
          'E: Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied)',
          'E: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), are you root?'
        ]
  ctx.writeLines(lines.slice(0, -1), 'error')
  throw new CommandFailure(lines[lines.length - 1] ?? '', 'PermissionDenied')
}

function aptUpdate(ctx: ExecContext): void {
  const release = RELEASES[linuxRelease(ctx.host)]
  if (repositoryReachable(ctx)) {
    ctx.writeLines([
      ...release.sources.map((s, i) => `Hit:${i + 1} ${s.url} ${s.suite} InRelease`),
      ...APT_READING,
      'All packages are up to date.'
    ])
    return
  }
  const failure = (url: string) => `Temporary failure resolving '${hostOfUrl(url)}'`
  ctx.writeLines([
    ...release.sources.flatMap((s, i) => [
      `Err:${i + 1} ${s.url} ${s.suite} InRelease`,
      `  ${failure(s.url)}`
    ]),
    ...APT_READING,
    'All packages are up to date.'
  ])
  ctx.writeLines(
    [
      ...release.sources.map(
        (s) => `W: Failed to fetch ${s.url}/dists/${s.suite}/InRelease  ${failure(s.url)}`
      ),
      'W: Some index files failed to download. They have been ignored, or old ones used instead.'
    ],
    'error'
  )
}

const pkgVersion = (ctx: ExecContext, p: LinuxPackage) => p.versions[linuxRelease(ctx.host)]

function confirm(ctx: ExecContext, assumeYes: boolean): boolean {
  if (assumeYes) return true
  const answer = ctx.ask('Do you want to continue? [Y/n] ').trim().toLowerCase()
  return answer === '' || answer === 'y' || answer === 'yes'
}

function aptInstall(ctx: ExecContext, names: string[], assumeYes: boolean): void {
  if (names.length === 0) throw new CommandFailure('E: No packages specified', 'InvalidArgument')
  const unknown = names.find((n) => !findPackage(n))
  if (unknown) {
    ctx.write(`E: Unable to locate package ${unknown}`, 'error')
    return
  }
  const release = RELEASES[linuxRelease(ctx.host)]
  const wanted = names.filter((n, i) => names.indexOf(n) === i)
  const fresh = wanted.filter((n) => !isInstalled(ctx.host, n))
  ctx.writeLines(APT_READING)
  for (const name of wanted.filter((n) => !fresh.includes(n))) {
    const p = findPackage(name) as LinuxPackage
    ctx.write(`${name} is already the newest version (${pkgVersion(ctx, p)}).`)
  }
  const summary = (n: number) => `0 upgraded, ${n} newly installed, 0 to remove and 0 not upgraded.`
  if (fresh.length === 0) return ctx.write(summary(0))
  ctx.writeLines([
    'The following NEW packages will be installed:',
    `  ${fresh.join(' ')}`,
    summary(fresh.length)
  ])
  if (!confirm(ctx, assumeYes)) return ctx.write('Abort.')
  if (!repositoryReachable(ctx)) {
    const first = findPackage(fresh[0] as string) as LinuxPackage
    const src = release.sources[0]
    ctx.writeLines(
      [
        `Err:1 ${src?.url} ${release.codename}/main amd64 ${first.name} amd64 ${pkgVersion(ctx, first)}`,
        `  Temporary failure resolving '${hostOfUrl(src?.url ?? '')}'`,
        'E: Failed to fetch some archives, maybe run apt-get update or try with --fix-missing?'
      ],
      'error'
    )
    return
  }
  const { failedUnits } = ctx.apply(installPackages(ctx.state, ctx.deviceId, fresh))
  for (const name of fresh) {
    const p = findPackage(name) as LinuxPackage
    ctx.write(`Setting up ${name} (${pkgVersion(ctx, p)}) ...`)
    for (const u of failedUnits.filter((u) => u.pkg === name)) ctx.writeLines(jobFailedLines(u), 'error')
  }
}

function aptRemove(ctx: ExecContext, names: string[], assumeYes: boolean): void {
  if (names.length === 0) throw new CommandFailure('E: No packages specified', 'InvalidArgument')
  const unknown = names.find((n) => !findPackage(n))
  if (unknown) {
    ctx.write(`E: Unable to locate package ${unknown}`, 'error')
    return
  }
  const wanted = names.filter((n, i) => names.indexOf(n) === i)
  const present = wanted.filter((n) => isInstalled(ctx.host, n))
  ctx.writeLines(APT_READING)
  for (const name of wanted.filter((n) => !present.includes(n)))
    ctx.write(`Package '${name}' is not installed, so not removed`)
  const summary = (n: number) => `0 upgraded, 0 newly installed, ${n} to remove and 0 not upgraded.`
  if (present.length === 0) return ctx.write(summary(0))
  ctx.writeLines([
    'The following packages will be REMOVED:',
    `  ${present.join(' ')}`,
    summary(present.length)
  ])
  if (!confirm(ctx, assumeYes)) return ctx.write('Abort.')
  ctx.apply(removePackages(ctx.state, ctx.deviceId, present))
  for (const name of present)
    ctx.write(`Removing ${name} (${pkgVersion(ctx, findPackage(name) as LinuxPackage)}) ...`)
}

function aptSearch(ctx: ExecContext, terms: string[]): void {
  if (terms.length === 0)
    throw new CommandFailure('E: You must give at least one search pattern', 'InvalidArgument')
  const suite = RELEASES[linuxRelease(ctx.host)].suite
  const found = PACKAGES.filter((p) =>
    terms.every((t) => `${p.name} ${p.description}`.toLowerCase().includes(t.toLowerCase()))
  )
  ctx.writeLines(['Sorting... Done', 'Full Text Search... Done'])
  for (const p of found) {
    const installed = isInstalled(ctx.host, p.name)
    ctx.writeLines([
      `${p.name}/${suite}${installed ? ',now' : ''} ${pkgVersion(ctx, p)} amd64${installed ? ' [installed]' : ''}`,
      `  ${p.description}`,
      ''
    ])
  }
}

function aptList(ctx: ExecContext, flags: string[], patterns: string[]): void {
  const suite = RELEASES[linuxRelease(ctx.host)].suite
  const only = hasFlag(flags, '--installed')
  ctx.write('Listing... Done')
  for (const p of PACKAGES) {
    const installed = isInstalled(ctx.host, p.name)
    if (only && !installed) continue
    if (patterns.length > 0 && !patterns.some((x) => p.name.includes(x.replace(/\*/g, '')))) continue
    ctx.write(
      `${p.name}/${suite}${installed ? ',now' : ''} ${pkgVersion(ctx, p)} amd64${installed ? ' [installed]' : ''}`
    )
  }
}

function runApt(ctx: ExecContext, args: string[], legacy: boolean): void {
  const { flags, rest } = split(args)
  const [sub = '', ...operands] = rest
  const assumeYes = hasFlag(flags, '-y', '--yes', '--assume-yes')
  const needsRoot = [
    'update',
    'install',
    'remove',
    'purge',
    'upgrade',
    'full-upgrade',
    'dist-upgrade',
    'autoremove'
  ]
  if (needsRoot.includes(sub) && !ctx.root) aptDenied(ctx, sub)
  switch (sub) {
    case 'update':
      return aptUpdate(ctx)
    case 'install':
      return aptInstall(ctx, operands, assumeYes)
    case 'remove':
    case 'purge':
      return aptRemove(ctx, operands, assumeYes)
    case 'upgrade':
    case 'full-upgrade':
    case 'dist-upgrade':
      return ctx.writeLines([
        'Reading package lists... Done',
        'Building dependency tree... Done',
        'Reading state information... Done',
        'Calculating upgrade... Done',
        '0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.'
      ])
    case 'search':
      return aptSearch(ctx, operands)
    case 'list':
      if (legacy) break
      return aptList(ctx, flags, operands)
    case '':
      throw new CommandFailure(
        legacy ? 'Usage: apt-get [options] command' : 'Usage: apt [options] command',
        'InvalidArgument'
      )
    default:
      break
  }
  if (sub === 'autoremove' || sub === 'show' || sub === 'policy' || sub === 'edit-sources')
    throw new CommandFailure(unsimulatedOptionMessage(legacy ? 'apt-get' : 'apt', sub), 'NotSupported')
  throw new CommandFailure(`E: Invalid operation ${sub}`, 'InvalidArgument')
}

const aptTool: ToolDef = {
  name: 'apt',
  synopsis: 'Gère les paquets (apt update, apt install, apt remove, apt search, apt list --installed).',
  run: (ctx, args) => runApt(ctx, args, false)
}

const aptGetTool: ToolDef = {
  name: 'apt-get',
  synopsis: 'Gère les paquets (apt-get update, install, remove).',
  run: (ctx, args) => runApt(ctx, args, true)
}

// ---------------------------------------------------------------------------------------------
// systemctl
// ---------------------------------------------------------------------------------------------

const unitName = (raw: string) => (raw.endsWith('.service') ? raw : `${raw}.service`)

/** Unité installée désignée par `raw` (nom, nom.service ou alias), sinon undefined. */
function installedUnit(ctx: ExecContext, raw: string): LinuxUnit | undefined {
  const unit = findUnit(raw)
  return unit && isInstalled(ctx.host, unit.pkg) ? unit : undefined
}

const unitFile = (ctx: ExecContext, unit: LinuxUnit) =>
  `${linuxRelease(ctx.host) === 'ubuntu2404' ? '/usr/lib' : '/lib'}/systemd/system/${unit.name}.service`

function journalLine(ctx: ExecContext, clock: number, message: string): string {
  // Messages d'un processus de l'unité (« apachectl[1000]: … ») : leur propre nom de programme
  const own = /^[\w-]+\[\d+\]: /.test(message)
  return `${journalStamp(ctx.host, clock)} ${ctx.host.name} ${own ? '' : 'systemd[1]: '}${message}`
}

/** Les utilisateurs de Debian hors groupe adm ne lisent pas le journal sans sudo. */
function canReadJournal(ctx: ExecContext): boolean {
  return ctx.root || linuxRelease(ctx.host) !== 'debian12'
}

function systemctlStatus(ctx: ExecContext, unit: LinuxUnit): void {
  const st = unitStatus(ctx.host, unit)
  const failed = unitFailed(ctx.host, unit)
  const since = activeSince(ctx.host, unit.name)
  const last = unitJournal(ctx.host, unit.name).at(-1)
  const stamp = (clock: number) => `${statusStamp(ctx.host, clock)}; ${relativeAgo(ctx.state.clock - clock)}`
  const preset = linuxRelease(ctx.host) === 'ubuntu2204' ? 'vendor preset: enabled' : 'preset: enabled'
  const lines = [
    `${st.active ? '●' : failed ? '×' : '○'} ${unitTitle(unit)}`,
    `     Loaded: loaded (${unitFile(ctx, unit)}; ${st.enabled ? 'enabled' : 'disabled'}; ${preset})`
  ]
  if (st.active) {
    lines.push(`     Active: active (running) since ${stamp(since)}`)
    lines.push(`   Main PID: ${unitPid(ctx.host, unit)} (${unit.process})`)
  } else if (failed) lines.push(`     Active: failed (Result: exit-code) since ${stamp(last?.time ?? 0)}`)
  else lines.push(`     Active: inactive (dead)${last ? ` since ${stamp(last.time)}` : ''}`)
  if (!canReadJournal(ctx)) {
    ctx.writeLines(lines)
    ctx.write('')
    ctx.write('Warning: some journal files were not opened due to insufficient permissions.', 'error')
  } else {
    ctx.writeLines([...lines, ''])
    const entries = unitJournal(ctx.host, unit.name).slice(-10)
    ctx.writeLines(entries.map((e) => journalLine(ctx, e.time, e.message)))
  }
  ctx.write('Tasks, Memory, CPU et CGroup ne sont pas modélisés par ServerLab (lignes omises).', 'warning')
}

const VERB_PAST: Record<UnitAction, string> = {
  start: 'start',
  stop: 'stop',
  restart: 'restart',
  reload: 'reload',
  enable: 'enable',
  disable: 'disable'
}

const systemctlTool: ToolDef = {
  name: 'systemctl',
  synopsis:
    'Pilote les services (start, stop, restart, reload, enable, disable, status, is-active, is-enabled).',
  run(ctx, args) {
    const { flags, rest } = split(args)
    const [verb = '', ...units] = rest
    const now = hasFlag(flags, '--now')
    const actions = ['start', 'stop', 'restart', 'reload', 'enable', 'disable'] as const
    const read = ['status', 'is-active', 'is-enabled']
    if (verb === '')
      throw new CommandFailure(
        'systemctl: ensemble des unités non simulé (indiquez un verbe et une unité).',
        'NotSupported'
      )
    if (![...actions, ...read].includes(verb as never)) {
      throw new CommandFailure(`Unknown command verb ${verb}.`, 'InvalidArgument')
    }
    if (units.length === 0) throw new CommandFailure('Too few arguments.', 'InvalidArgument')

    for (const raw of units) {
      const unit = installedUnit(ctx, raw)
      if (verb === 'status') {
        if (!unit) {
          ctx.write(`Unit ${unitName(raw)} could not be found.`, 'error')
          continue
        }
        systemctlStatus(ctx, unit)
      } else if (verb === 'is-active') {
        ctx.write(
          !unit
            ? 'inactive'
            : unitStatus(ctx.host, unit).active
              ? 'active'
              : unitFailed(ctx.host, unit)
                ? 'failed'
                : 'inactive'
        )
      } else if (verb === 'is-enabled') {
        if (!unit)
          ctx.write(`Failed to get unit file state for ${unitName(raw)}: No such file or directory`, 'error')
        else ctx.write(unitStatus(ctx.host, unit).enabled ? 'enabled' : 'disabled')
      } else {
        const action = verb as UnitAction
        const manage = action === 'enable' || action === 'disable'
        if (!ctx.root) {
          ctx.writeLines(
            manage
              ? [`Failed to ${VERB_PAST[action]} unit: Interactive authentication required.`]
              : [
                  `Failed to ${VERB_PAST[action]} ${unitName(raw)}: Interactive authentication required.`,
                  `See system logs and 'systemctl status ${unitName(raw)}' for details.`
                ],
            'error'
          )
          continue
        }
        if (!unit) {
          ctx.write(
            manage
              ? `Failed to ${VERB_PAST[action]} unit: Unit file ${unitName(raw)} does not exist.`
              : `Failed to ${VERB_PAST[action]} ${unitName(raw)}: Unit ${unitName(raw)} ${action === 'stop' ? 'not loaded' : 'not found'}.`,
            'error'
          )
          continue
        }
        const r = unitAction(ctx.state, ctx.deviceId, unit.name, action)
        if (!r.ok) {
          ctx.write(r.error.message, 'error')
          continue
        }
        ctx.state = r.state
        ctx.writeLines(r.value.lines)
        if (r.value.startFailed) ctx.writeLines(jobFailedLines(unit), 'error')
        if (now && manage) {
          const follow = unitAction(
            ctx.state,
            ctx.deviceId,
            unit.name,
            action === 'enable' ? 'start' : 'stop'
          )
          if (follow.ok) {
            ctx.state = follow.state
            if (follow.value.startFailed) ctx.writeLines(jobFailedLines(unit), 'error')
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// journalctl
// ---------------------------------------------------------------------------------------------

const journalctlTool: ToolDef = {
  name: 'journalctl',
  synopsis: 'Affiche le journal systemd (journalctl -u unité, -n N, --no-pager).',
  run(ctx, args) {
    const units: string[] = []
    let lines: number | null = null
    for (let i = 0; i < args.length; i++) {
      const a = args[i] as string
      if (a === '-u' || a === '--unit') units.push(args[++i] ?? '')
      else if (a.startsWith('--unit=')) units.push(a.slice(7))
      else if (a === '-n' || a === '--lines') lines = Number(args[++i])
      else if (a.startsWith('--lines=')) lines = Number(a.slice(8))
      else if (/^-n\d+$/.test(a)) lines = Number(a.slice(2))
      else if (a === '-f' || a === '--follow' || a === '-k' || a === '-o' || a === '--output')
        throw new CommandFailure(unsimulatedOptionMessage('journalctl', a), 'NotSupported')
    }
    if (lines !== null && (!Number.isInteger(lines) || lines < 0))
      throw new CommandFailure('Failed to parse lines: Invalid argument', 'InvalidArgument')
    if (!canReadJournal(ctx)) {
      ctx.writeLines(
        [
          'Hint: You are currently not seeing messages from other users and the system.',
          "      Users in groups 'adm', 'systemd-journal' can see all messages.",
          '      Pass -q to turn off this notice.'
        ],
        'error'
      )
      ctx.write('-- No entries --')
      return
    }
    const wanted = units.map((u) => findUnit(u)?.name ?? `${u}`)
    const all = ctx.host.host.eventLog.filter(
      (e) => e.source === 'systemd' && (wanted.length === 0 || wanted.includes(e.account ?? ''))
    )
    const entries = lines === null ? all : lines === 0 ? [] : all.slice(-lines)
    if (entries.length === 0) return ctx.write('-- No entries --')
    ctx.writeLines(entries.map((e) => journalLine(ctx, e.time, e.message)))
  }
}

// ---------------------------------------------------------------------------------------------
// ss
// ---------------------------------------------------------------------------------------------

const ssTool: ToolDef = {
  name: 'ss',
  synopsis: 'Affiche les sockets (ss -tulpn : ports en écoute et processus).',
  run(ctx, args) {
    const letters = args
      .filter((a) => /^-[a-zA-Z0-9]+$/.test(a))
      .join('')
      .replace(/-/g, '')
    const unknown = [...letters].find((c) => !'tulnpa46H'.includes(c))
    if (unknown) throw new CommandFailure(unsimulatedOptionMessage('ss', `-${unknown}`), 'NotSupported')
    const wantTcp = letters.includes('t')
    const wantUdp = letters.includes('u')
    const both = !wantTcp && !wantUdp
    const showProcess = letters.includes('p')
    const sockets = linuxSockets(ctx.host).filter(
      (s) =>
        (both || (s.proto === 'tcp' ? wantTcp : wantUdp)) &&
        !(letters.includes('4') && s.address.includes(':'))
    )
    const listening = letters.includes('l') || letters.includes('a')
    // Descripteur de fichier : 3 pour la première socket d'un processus, puis 4, 5…
    const fds = new Map<number, number>()
    const rows = (listening ? sockets : []).map((s) => {
      const peer = s.address === '*' ? '*' : s.address.startsWith('[') ? '[::]' : '0.0.0.0'
      const fd = 3 + (fds.get(s.pid) ?? 0)
      fds.set(s.pid, fd - 2)
      // Sans droits, ss ne voit que les processus de l'utilisateur
      const process = showProcess && ctx.root ? `users:(("${s.unit.process}",pid=${s.pid},fd=${fd}))` : ''
      return {
        netid: s.proto,
        state: s.proto === 'tcp' ? 'LISTEN' : 'UNCONN',
        sendq: String(s.backlog),
        address: s.address,
        port: String(s.port),
        peer,
        process
      }
    })
    const addrW = Math.max(13, ...rows.map((r) => r.address.length)) + 1
    const portW = Math.max(4, ...rows.map((r) => r.port.length))
    const peerW = Math.max(12, ...rows.map((r) => r.peer.length)) + 1
    // iproute2 : la colonne Netid n'apparaît que si plusieurs types de socket sont affichés
    const netid = both || (wantTcp && wantUdp)
    ctx.write(
      `${netid ? 'Netid ' : ''}State  Recv-Q Send-Q ${'Local Address'.padStart(addrW)}:${'Port'.padEnd(portW)} ${'Peer Address'.padStart(peerW)}:Port Process`
    )
    for (const r of rows)
      ctx.write(
        `${netid ? `${r.netid.padEnd(5)} ` : ''}${r.state.padEnd(6)} ${'0'.padEnd(6)} ${r.sendq.padEnd(6)} ${r.address.padStart(addrW)}:${r.port.padEnd(portW)} ${r.peer.padStart(peerW)}:${'*'.padEnd(4)} ${r.process}`.trimEnd()
      )
    if (!listening)
      ctx.write(
        'ss: les connexions établies ne sont pas modélisées (utilisez -l pour les ports en écoute).',
        'warning'
      )
  }
}

// ---------------------------------------------------------------------------------------------
// ps, df, free, uname, hostnamectl
// ---------------------------------------------------------------------------------------------

const UNIT_USER: Record<string, string> = { named: 'bind', mariadb: 'mysql' }

const psTool: ToolDef = {
  name: 'ps',
  synopsis: 'Liste les processus (ps aux), dérivés des services actifs.',
  run(ctx, args) {
    const sessionUser = ctx.host.host.session?.user ?? 'etudiant'
    const bashPid = 1000
    const psPid = 2000 + (ctx.state.seq % 1000)
    const note = () =>
      ctx.write('ps: %CPU, %MEM, VSZ, RSS, START et TIME ne sont pas modélisés (affichés « - »).', 'warning')
    if (args.length === 0) {
      ctx.writeLines([
        '    PID TTY          TIME CMD',
        `${String(bashPid).padStart(7)} pts/0    ${'-'.padStart(8)} bash`,
        `${String(psPid).padStart(7)} pts/0    ${'-'.padStart(8)} ps`
      ])
      return note()
    }
    const letters = args.join('').replace(/-/g, '')
    if (letters !== 'aux' && letters !== 'axu' && letters !== 'auxww')
      throw new CommandFailure(unsimulatedOptionMessage('ps', args.join(' ')), 'NotSupported')
    const row = (user: string, pid: number, tty: string, command: string) =>
      `${user.padEnd(8)} ${String(pid).padStart(7)} ${'-'.padStart(4)} ${'-'.padStart(4)} ${'-'.padStart(6)} ${'-'.padStart(5)} ${tty.padEnd(8)} ${'-'.padEnd(4)} ${'-'.padEnd(5)} ${'-'.padStart(6)} ${command}`
    ctx.writeLines([
      'USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND',
      row('root', 1, '?', '/sbin/init'),
      ...installedUnits(ctx.host)
        .filter((u) => unitStatus(ctx.host, u).active)
        .map((u) => row(UNIT_USER[u.name] ?? 'root', unitPid(ctx.host, u), '?', u.command)),
      row(sessionUser, bashPid, 'pts/0', '-bash'),
      row(ctx.root ? 'root' : sessionUser, psPid, 'pts/0', 'ps aux')
    ])
    note()
  }
}

const dfTool: ToolDef = {
  name: 'df',
  synopsis: 'Affiche l’espace disque (df -h) : tailles non modélisées.',
  run(ctx, args) {
    const mounts = ctx.host.host.mounts
    const row = (fs: string, mount: string) =>
      `${fs.padEnd(15)} ${'-'.padStart(4)}  ${'-'.padStart(4)} ${'-'.padStart(5)} ${'-'.padStart(4)} ${mount}`
    if (args.some((a) => a.startsWith('-') && !/^-[hHTk]+$/.test(a)))
      throw new CommandFailure(unsimulatedOptionMessage('df', args.join(' ')), 'NotSupported')
    ctx.writeLines([
      'Filesystem      Size  Used Avail Use% Mounted on',
      row('-', '/'),
      ...mounts.map((m) => row(m.source, m.target))
    ])
    ctx.write(
      'df: les tailles des systèmes de fichiers ne sont pas modélisées par ServerLab (affichées « - »).',
      'warning'
    )
  }
}

const freeTool: ToolDef = {
  name: 'free',
  synopsis: 'Affiche la mémoire (free -h) : valeurs non modélisées.',
  run(ctx, args) {
    if (args.some((a) => a.startsWith('-') && !/^-[hmgkb]$/.test(a)))
      throw new CommandFailure(unsimulatedOptionMessage('free', args.join(' ')), 'NotSupported')
    const cells = (...c: string[]) => c.map((x) => x.padStart(12)).join('')
    ctx.writeLines([
      `        ${cells('total', 'used', 'free', 'shared', 'buff/cache', 'available')}`,
      `${'Mem:'.padEnd(8)}${cells('-', '-', '-', '-', '-', '-')}`,
      `${'Swap:'.padEnd(8)}${cells('-', '-', '-')}`
    ])
    ctx.write('free: la mémoire n’est pas modélisée par ServerLab (affichée « - »).', 'warning')
  }
}

const unameTool: ToolDef = {
  name: 'uname',
  synopsis: 'Affiche le nom du système (-s -n -m -o) ; version du noyau (-a, -r, -v) non modélisée.',
  run(ctx, args) {
    const flags = args.join('').replace(/-/g, '')
    // -a, -r et -v exigent la release et la version du noyau, non modélisées : on refuse
    // proprement, sans sortie partielle (audit v2.11.1, F-06)
    const unsupported = [...flags].find((c) => !'snmo'.includes(c))
    if (unsupported)
      throw new CommandFailure(unsimulatedOptionMessage('uname', `-${unsupported}`), 'NotSupported')
    const picks = new Set(flags === '' ? ['s'] : flags.split(''))
    const out: string[] = []
    if (picks.has('s')) out.push('Linux')
    if (picks.has('n')) out.push(ctx.host.name)
    if (picks.has('m')) out.push('x86_64')
    if (picks.has('o')) out.push('GNU/Linux')
    if (out.length > 0) ctx.write(out.join(' '))
  }
}

/** Identifiant de machine : 32 chiffres hexadécimaux dérivés de l'identifiant de l'ordinateur. */
function machineId(deviceId: string): string {
  let h = 2166136261
  let out = ''
  for (let i = 0; out.length < 32; i++) {
    h = Math.imul(h ^ deviceId.charCodeAt(i % deviceId.length), 16777619) >>> 0
    out += h.toString(16).padStart(8, '0')
  }
  return out.slice(0, 32)
}

const hostnamectlTool: ToolDef = {
  name: 'hostnamectl',
  synopsis: 'Affiche le nom d’hôte et le système (hostnamectl).',
  run(ctx, args) {
    const sub = args.find((a) => !a.startsWith('-')) ?? 'status'
    if (sub !== 'status')
      throw new CommandFailure(unsimulatedOptionMessage('hostnamectl', sub), 'NotSupported')
    const fields: [string, string][] = [
      ['Static hostname', ctx.host.name],
      ['Machine ID', machineId(ctx.deviceId)],
      ['Operating System', RELEASES[linuxRelease(ctx.host)].prettyName],
      ['Architecture', 'x86-64']
    ]
    ctx.writeLines(fields.map(([k, v]) => `${k.padStart(18)}: ${v}`))
    ctx.write(
      'hostnamectl: icône, châssis, virtualisation, noyau et matériel ne sont pas modélisés par ServerLab (lignes omises).',
      'warning'
    )
  }
}

export const systemBashTools: ToolDef[] = [
  aptTool,
  aptGetTool,
  systemctlTool,
  journalctlTool,
  ssTool,
  psTool,
  dfTool,
  freeTool,
  unameTool,
  hostnamectlTool
]
