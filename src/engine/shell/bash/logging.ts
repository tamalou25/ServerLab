/**
 * Journaux et protection des serveurs Linux (v2.9, #237) : `logger` (écrit dans /var/log/syslog, envoi
 * distant de rsyslog compris) et `fail2ban-client` (status, bannissement manuel). Formats d'origine :
 * util-linux, fail2ban 1.0.2 (client/beautifier.py, server/filter.py, server/actions.py).
 *
 * Le bannissement est ABSTRAIT (docs/fidelite.md) : `banip` pose une règle de refus sur l'état du lab ;
 * rien ne génère d'attaque. Voir services/linuxfail2ban.ts.
 */
import { banIp, enabledJails, fail2banRunning, jailStats, unbanIp } from '../../services/linuxfail2ban'
import { f2bStamp } from '../../services/linuxlogbase'
import { writeLogs } from '../../services/linuxlog'
import { findPackage } from '../../services/linuxcatalog'
import { isInstalled, linuxRelease, reloadUnitConfig } from '../../services/linuxsystem'
import { CommandFailure, type ExecContext } from '../context'
import type { ToolDef } from '../tools/types'
import { unsimulatedOptionMessage } from '../unsimulated'
import { actor } from './linuxfs'

// ---------------------------------------------------------------------------------------------
// logger
// ---------------------------------------------------------------------------------------------

const loggerTool: ToolDef = {
  name: 'logger',
  synopsis: 'Écrit un message dans le journal système (logger "message", logger -t étiquette message).',
  run(ctx, args) {
    let tag = actor(ctx)
    let withPid = false
    const words: string[] = []
    for (let i = 0; i < args.length; i++) {
      const a = args[i] as string
      if (a === '-t' || a === '--tag') tag = args[++i] ?? tag
      else if (a === '-i') withPid = true
      else if (a.startsWith('-') && a !== '-' && words.length === 0)
        throw new CommandFailure(unsimulatedOptionMessage('logger', a), 'NotSupported')
      else words.push(a)
    }
    const messages = words.length > 0 ? [words.join(' ')] : (ctx.stdin ?? [])
    if (messages.length === 0) return
    const pid = withPid ? 2000 + (ctx.state.seq % 1000) : 0
    ctx.apply(
      writeLogs(
        ctx.state,
        ctx.deviceId,
        messages.map((message) => ({ source: tag, pid, message }))
      )
    )
  }
}

// ---------------------------------------------------------------------------------------------
// fail2ban-client
// ---------------------------------------------------------------------------------------------

const SOCKET = '/var/run/fail2ban/fail2ban.sock'

/** Ligne de journal du client fail2ban (erreur standard) : « 2026-… fail2ban     [PID]: ERROR   … ». */
function clientLog(ctx: ExecContext, level: string, message: string): void {
  const pid = 2000 + (ctx.state.seq % 1000)
  ctx.write(
    `${f2bStamp(ctx.host, ctx.state.clock, true)} ${'fail2ban'.padEnd(24)}[${pid}]: ${level.padEnd(7)} ${message}`,
    'error'
  )
}

const jailMissing = (ctx: ExecContext, name: string) => {
  clientLog(ctx, 'ERROR', `NOK: ("UnknownJailException('${name}')",)`)
  ctx.write(`Sorry but the jail '${name}' does not exist`)
}

/** Version amont du paquet : « 1.0.2 » pour « 1.0.2-2 ». */
const version = (ctx: ExecContext) =>
  (findPackage('fail2ban')?.versions[linuxRelease(ctx.host)] ?? '').split('-')[0] ?? ''

const toSeconds = (ms: number) => (ms < 0 ? -1 : Math.round(ms / 1000))

const fail2banClientTool: ToolDef = {
  name: 'fail2ban-client',
  synopsis: 'Pilote fail2ban (fail2ban-client status [prison], set prison banip|unbanip adresse, ping).',
  available: (ctx) => isInstalled(ctx.host, 'fail2ban'),
  run(ctx, args) {
    const rest = args.filter((a) => !a.startsWith('-'))
    const flag = args.find((a) => a.startsWith('-'))
    if (flag === '-V' || flag === '--version') return ctx.write(version(ctx))
    if (flag) throw new CommandFailure(unsimulatedOptionMessage('fail2ban-client', flag), 'NotSupported')
    const [command = '', ...operands] = rest
    if (command === '')
      return ctx.writeLines(
        [
          'Usage: fail2ban-client [OPTIONS] <COMMAND>',
          '',
          "Try 'fail2ban-client --help' for more information."
        ],
        'error'
      )
    // La socket du serveur n'existe que si fail2ban tourne ; elle est réservée à root
    if (!fail2banRunning(ctx.host))
      return clientLog(ctx, 'ERROR', `Failed to access socket path: ${SOCKET}. Is fail2ban running?`)
    if (!ctx.root)
      return clientLog(ctx, 'ERROR', `Permission denied to socket: ${SOCKET}, (you must be root)`)

    const jails = enabledJails(ctx.host)
    const jailNamed = (name: string) => jails.find((j) => j.name === name)
    switch (command) {
      case 'ping':
        return ctx.write('Server replied: pong')
      case 'version':
        return ctx.write(version(ctx))
      case 'reload':
        ctx.apply(reloadUnitConfig(ctx.state, ctx.deviceId, 'fail2ban'))
        return ctx.write('OK')
      case 'status': {
        const [name, extra] = operands
        if (name === undefined) {
          ctx.writeLines([
            'Status',
            `|- Number of jail:\t${jails.length}`,
            `\`- Jail list:\t${jails.map((j) => j.name).join(', ')}`
          ])
          const other = jails.filter((j) => j.name !== 'sshd')
          if (other.length > 0)
            ctx.write(
              `fail2ban-client : seule la prison sshd est simulée par ServerLab (${other.map((j) => j.name).join(', ')} : non simulées).`,
              'warning'
            )
          return
        }
        const jail = jailNamed(name)
        if (!jail || extra !== undefined) return jailMissing(ctx, name)
        if (jail.name !== 'sshd')
          throw new CommandFailure(
            unsimulatedOptionMessage('fail2ban-client', `status ${name}`),
            'NotSupported'
          )
        const st = jailStats(ctx.host, ctx.state.clock, jail)
        return ctx.writeLines([
          `Status for the jail: ${jail.name}`,
          '|- Filter',
          `|  |- Currently failed:\t${st.currentlyFailed}`,
          `|  |- Total failed:\t${st.totalFailed}`,
          `|  \`- File list:\t${jail.logpath}`,
          '`- Actions',
          `   |- Currently banned:\t${st.currentlyBanned}`,
          `   |- Total banned:\t${st.totalBanned}`,
          `   \`- Banned IP list:\t${st.banned.join(' ')}`
        ])
      }
      case 'get': {
        const [name = '', option = ''] = operands
        const jail = jailNamed(name)
        if (!jail) return jailMissing(ctx, name)
        if (option === 'maxretry') return ctx.write(String(jail.maxretry))
        if (option === 'findtime') return ctx.write(String(toSeconds(jail.findtime)))
        if (option === 'bantime') return ctx.write(String(toSeconds(jail.bantime)))
        throw new CommandFailure(
          unsimulatedOptionMessage('fail2ban-client', `get ${name} ${option}`),
          'NotSupported'
        )
      }
      case 'set': {
        const [name = '', option = '', ...ips] = operands
        if (!jailNamed(name)) return jailMissing(ctx, name)
        if (option !== 'banip' && option !== 'unbanip')
          throw new CommandFailure(
            unsimulatedOptionMessage('fail2ban-client', `set ${name} ${option}`),
            'NotSupported'
          )
        if (ips.length === 0) return ctx.write('Sorry but the command is invalid')
        const count = ctx.apply(
          option === 'banip'
            ? banIp(ctx.state, ctx.deviceId, name, ips)
            : unbanIp(ctx.state, ctx.deviceId, name, ips)
        )
        return ctx.write(String(count))
      }
      default:
        throw new CommandFailure(unsimulatedOptionMessage('fail2ban-client', command), 'NotSupported')
    }
  }
}

export const loggingBashTools: ToolDef[] = [loggerTool, fail2banClientTool]
