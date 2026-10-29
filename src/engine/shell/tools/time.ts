/**
 * Heure du système vue des consoles : `w32tm` (service Temps Windows) et `net time` (v2.8, chantier A).
 *
 * Sources Microsoft Learn (captures docs/captures/cmd/w32tm-*.txt, net-time-*.txt) :
 *  - w32tm : paramètres /query /status [/verbose] et /resync [/computer] [/nowait] [/rediscover] [/soft],
 *    disposition de la sortie « w32tm /query /status /verbose » (exemple de la page Windows Time Service
 *    Tools and Settings) :
 *    https://learn.microsoft.com/windows-server/networking/windows-time-service/windows-time-service-tools-and-settings
 *  - net time : syntaxe « NET TIME [\\ordinateur | /DOMAIN[:domaine] | /RTSDOMAIN[:domaine]] [/SET] » et
 *    lignes « Current time at \\DC-01.mydomain.com is 8/7/2009 10:01:42 AM » :
 *    https://learn.microsoft.com/archive/blogs/w32time/net-time-and-w32time
 * Les libellés français réels et les valeurs de `/query /status` ne sont pas publiés : docs/fidelite.md,
 * « À vérifier (v2.8 — services) ». Les options non reproduites donnent un message honnête (unsimulated.ts).
 */
import { clockParts } from '../../core/clock'
import type { HostDevice } from '../../model/schema'
import { effectiveIpv4 } from '../../net/addressing'
import { ping } from '../../net/diagnostics'
import {
  clockOffset,
  domainControllerOf,
  localClock,
  resyncClock,
  setHostClock,
  W32TIME_NOT_STARTED_MESSAGE
} from '../../services/hostclock'
import { serviceRunning } from '../../services/servicestate'
import { LEARN_CMD } from '../cmd/help'
import type { ExecContext } from '../context'
import { unsimulatedOptionMessage } from '../unsimulated'
import type { ToolDef } from './types'

const p2 = (n: number) => String(n).padStart(2, '0')

/** « 5/23/2023 7:51:39 PM » : format de la page Learn (culture en-US, mois et jour sans zéro). */
export function formatLearnDate(clock: number): string {
  const t = clockParts(clock)
  const h12 = t.h % 12 === 0 ? 12 : t.h % 12
  return `${t.month + 1}/${t.date}/${t.year} ${h12}:${p2(t.m)}:${p2(t.s)} ${t.h < 12 ? 'AM' : 'PM'}`
}

/** Source de temps de l'ordinateur : contrôleur de domaine pour un membre, sinon l'horloge locale. */
function timeSource(ctx: ExecContext): HostDevice | null {
  const dc = domainControllerOf(ctx.state, ctx.deviceId)
  return dc && dc.id !== ctx.deviceId ? dc : null
}

/** FQDN d'un ordinateur du domaine (SRV1.lab.local). */
function fqdn(host: HostDevice): string {
  return host.host.domain ? `${host.name}.${host.host.domain}` : host.name
}

/** Lignes de `w32tm /query /status` : la disposition est celle de l'exemple /verbose de Learn. */
export function statusLines(ctx: ExecContext, verbose: boolean): string[] {
  const source = timeSource(ctx)
  const phase = source ? clockOffset(ctx.state, ctx.deviceId) - clockOffset(ctx.state, source.id) : 0
  const base = [
    'Leap Indicator: 0(no warning)',
    source
      ? 'Stratum: 2 (secondary reference - syncd by (S)NTP)'
      : 'Stratum: 1 (primary reference - syncd by radio clock)',
    'Precision: -23 (119.209ns per tick)',
    'Root Delay: 0.0003538s',
    'Root Dispersion: 0.0100002s',
    'ReferenceId: 0x00000000 (unspecified)',
    `Last Successful Sync Time: ${formatLearnDate(localClock(ctx.state, ctx.deviceId))}`,
    `Source: ${source ? fqdn(source) : 'Local CMOS Clock'}`,
    'Poll Interval: 6 (64s)'
  ]
  if (!verbose) return base
  return [
    ...base,
    '',
    `Phase Offset: ${phase.toFixed(7)}s`,
    'ClockRate: 0.0156250s',
    'State Machine: 2 (Sync)',
    'Time Source Flags: 0 (None)',
    'Server Role: 0 (None)',
    'Last Sync Error: 0 (The command completed successfully.)',
    'Time since Last Good Sync Time: 15.7344985s'
  ]
}

function w32tmError(ctx: ExecContext, message: string): void {
  ctx.write(`The following error occurred: ${message}`, 'error')
}

export const w32tmTool: ToolDef = {
  name: 'w32tm',
  synopsis: 'Service Temps Windows : état (/query /status) et resynchronisation (/resync).',
  switches: ['/query', '/status', '/verbose', '/resync', '/nowait', '/rediscover', '/soft'],
  help: {
    syntax: [
      'w32tm /query [/computer:<target>] {/source | /configuration | /peers | /status} [/verbose]',
      'w32tm /resync [/computer:<computer>] [/nowait] [/rediscover] [/soft]'
    ],
    url: `${LEARN_CMD}w32tm`
  },
  run(ctx, args) {
    const lower = args.map((a) => a.toLowerCase())
    const verb = lower[0] ?? ''
    // Seul l'ordinateur local est simulé
    const remote = lower.find((a) => a.startsWith('/computer:'))
    if (
      remote &&
      !['.', 'localhost', ctx.host.name.toLowerCase()].includes(remote.slice('/computer:'.length))
    ) {
      ctx.write(unsimulatedOptionMessage('w32tm', '/computer'), 'error')
      return
    }
    if (verb === '/query' && lower.includes('/status')) {
      if (!serviceRunning(ctx.host, 'W32Time')) return w32tmError(ctx, W32TIME_NOT_STARTED_MESSAGE)
      ctx.writeLines(statusLines(ctx, lower.includes('/verbose')))
      return
    }
    if (verb === '/resync') {
      ctx.write('Sending resync command to local computer')
      const r = resyncClock(ctx.state, ctx.deviceId)
      if (!r.ok) return w32tmError(ctx, r.error.message)
      ctx.state = r.state
      ctx.write('The command completed successfully.')
      return
    }
    const option = verb === '/query' ? `/query ${lower[1] ?? ''}`.trim() : verb || '(sans paramètre)'
    ctx.write(unsimulatedOptionMessage('w32tm', option), 'error')
  }
}

/** Ordinateur désigné par `\\nom` ou `\\nom.domaine.local` (insensible à la casse). */
function hostByUncName(ctx: ExecContext, unc: string): HostDevice | undefined {
  const name = unc.replace(/^\\\\/, '').toLowerCase()
  const short = name.split('.')[0] ?? name
  if (name === 'localhost') return ctx.host
  return Object.values(ctx.state.devices).find(
    (d): d is HostDevice =>
      (d.kind === 'server' || d.kind === 'client') &&
      d.powered &&
      (d.name.toLowerCase() === short || d.name.toLowerCase() === name)
  )
}

/** Le contrôleur ou serveur répond-il à un test d'écho depuis l'ordinateur de la console ? */
function reachable(ctx: ExecContext, target: HostDevice): boolean {
  if (target.id === ctx.deviceId) return true
  return target.interfaces.some((iface) => {
    const ip = effectiveIpv4(iface)?.address
    if (!ip) return false
    const r = ping(ctx.state, ctx.deviceId, ip, { count: 1 })
    return r.ok && r.value.success
  })
}

/**
 * `net time [\\ordinateur | /domain[:domaine]] [/set /y]` : l'heure est demandée par RPC (NetRemoteTOD) :
 * le service Temps Windows de l'ordinateur interrogé n'a pas besoin de tourner.
 */
export function netTime(ctx: ExecContext, args: string[]): void {
  const lower = args.map((a) => a.toLowerCase())
  const rts = lower.find((a) => a.startsWith('/rtsdomain'))
  if (rts) {
    ctx.write(unsimulatedOptionMessage('net time', '/rtsdomain'), 'error')
    return
  }
  const set = lower.includes('/set')
  if (set && !lower.includes('/y')) {
    ctx.write(unsimulatedOptionMessage('net time', '/set sans /y (invite de confirmation)'), 'error')
    return
  }
  const unc = args.find((a) => a.startsWith('\\\\'))
  const wantsDomain = lower.some((a) => a === '/domain' || a.startsWith('/domain:'))
  let target: HostDevice | undefined
  let label: string
  if (unc) {
    target = hostByUncName(ctx, unc)
    label = unc
  } else {
    // Sans ordinateur : contrôleur de domaine de l'ordinateur (DC Locator)
    target = domainControllerOf(ctx.state, ctx.deviceId) ?? undefined
    if (!target && !wantsDomain && !ctx.host.host.domain) {
      ctx.writeLines(
        ['Erreur système 1355.', '', 'Le domaine spécifié n’existe pas ou n’a pas pu être contacté.', ''],
        'error'
      )
      return
    }
    label = target ? `\\\\${fqdn(target)}` : ''
  }
  if (!target || !reachable(ctx, target)) {
    ctx.writeLines(['Erreur système 53.', '', 'Le chemin réseau n’a pas été trouvé.', ''], 'error')
    return
  }
  ctx.write(`Current time at ${label} is ${formatLearnDate(localClock(ctx.state, target.id))}`)
  if (set) {
    const r = setHostClock(ctx.state, ctx.deviceId, clockOffset(ctx.state, target.id))
    if (!r.ok) {
      ctx.write(r.error.message, 'error')
      return
    }
    ctx.state = r.state
  }
}
