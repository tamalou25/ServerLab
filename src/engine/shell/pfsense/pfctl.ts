/**
 * `pfctl` du shell du pare-feu (v2.10, #247) : `-sr` (règles), `-ss` (états), `-si` (informations),
 * `-d` et `-e` (arrêt et démarrage du filtre). Mise en forme d'après pfctl de FreeBSD 14
 * (sbin/pfctl/pfctl_parser.c : print_rule, print_status ; pf_print_state.c : print_state).
 * Toute autre option est réelle mais non simulée : message honnête.
 */
import { setPfFilterEnabled } from '../../net/pf-console'
import { nicOf, type PfDevice } from '../../net/pf'
import { type PfIfaceKey } from '../../model/firewall'
import type { ExecContext } from '../context'
import { unsimulatedOptionMessage } from '../unsimulated'
import { pfRuleset } from './ruleset'
import { padEnd, padStart, type PfTerm } from './term'

/** Usage de pfctl (FreeBSD 14, sbin/pfctl/pfctl.c : usage), affiché sans argument. */
export const PFCTL_USAGE = [
  'usage: pfctl [-AdeghMmNnOPqRrvz] [-a anchor] [-D macro=value] [-F modifier]',
  '\t[-f file] [-i interface] [-K host | network]',
  '\t[-k host | network | gateway | label | id] [-o level] [-p device]',
  '\t[-s modifier] [-t table -T command [address ...]] [-x level]'
]

/** États de pf (TCP : ESTABLISHED des deux côtés, UDP : MULTIPLE, autres : 0:0). */
function stateSuffix(protocol: string): string {
  if (protocol === 'tcp') return 'ESTABLISHED:ESTABLISHED'
  if (protocol === 'udp') return 'MULTIPLE:MULTIPLE'
  return '0:0'
}

/** Lignes de `pfctl -ss` : une ligne par état, deux (entrée puis sortie) quand une traduction est appliquée. */
export function stateLines(device: PfDevice): string[] {
  const lines: string[] = []
  const ifname = (key: PfIfaceKey): string => nicOf(device, key)?.name ?? key
  for (const s of device.pf.states) {
    const suffix = `       ${stateSuffix(s.protocol)}`
    const dst = s.dst
    const proto = s.protocol === 'other' ? 'unknown' : s.protocol
    const [a, b] = s.translation ? s.translation.split(' → ') : []
    if (s.translation && a && b && a.includes(':')) {
      // Redirection de port : « adresse publique:port → adresse interne:port »
      lines.push(`${ifname(s.iface)} ${proto} ${b} (${a}) <- ${s.src}${suffix}`)
    } else if (s.translation && b) {
      // NAT sortant : l'état d'entrée garde l'adresse d'origine, celui de sortie porte l'adresse traduite
      lines.push(`${ifname(s.iface)} ${proto} ${dst} <- ${s.src}${suffix}`)
      lines.push(`${nicOf(device, 'wan')?.name ?? 'wan'} ${proto} ${b} (${s.src}) -> ${dst}${suffix}`)
    } else {
      lines.push(`${ifname(s.iface)} ${proto} ${dst} <- ${s.src}${suffix}`)
    }
  }
  return lines
}

/** Compteurs de `pfctl -si` (noms de FCNT_NAMES et PFRES_NAMES), calculés depuis l'état. */
const FCOUNTERS = ['searches', 'inserts', 'removals'] as const
const COUNTERS = [
  'match',
  'bad-offset',
  'fragment',
  'short',
  'normalize',
  'memory',
  'bad-timestamp',
  'congestion',
  'ip-option',
  'proto-cksum',
  'state-mismatch',
  'state-insert',
  'state-limit',
  'src-limit',
  'synproxy',
  'map-failed'
] as const

/** Lignes de `pfctl -si` (print_status de pfctl, sans l'option verbeuse). */
export function infoLines(device: PfDevice, clock: number): string[] {
  const pf = device.pf
  const runtime = Math.max(0, Math.floor((clock - (pf.filterSince ?? 0)) / 1000))
  let day = runtime
  const sec = day % 60
  day = Math.floor(day / 60)
  const min = day % 60
  day = Math.floor(day / 60)
  const hrs = day % 24
  day = Math.floor(day / 24)
  const p2 = (n: number): string => String(n).padStart(2, '0')
  const running = pf.filterDisabled ? 'Disabled' : 'Enabled'
  const statline = `Status: ${running} for ${day} days ${p2(hrs)}:${p2(min)}:${p2(sec)}`
  const values: Record<string, number> = {
    searches: pf.states.length + pf.log.length,
    inserts: pf.states.length,
    removals: 0,
    match: pf.states.length + pf.log.length
  }
  const row = (name: string): string => {
    const value = values[name] ?? 0
    const rate = runtime > 0 ? `${padStart((value / runtime).toFixed(1), 14)}/s` : padStart('', 14)
    return `  ${padEnd(name, 25)} ${padStart(String(value), 14)} ${rate}`
  }
  return [
    `${padEnd(statline, 44)}${padStart('Debug: Urgent', 15)}`,
    '',
    `${padEnd('State Table', 27)} ${padStart('Total', 14)} ${padStart('Rate', 16)}`,
    `  ${padEnd('current entries', 25)} ${padStart(String(pf.states.length), 14)} ${padStart('', 14)}`,
    ...FCOUNTERS.map(row),
    'Counters',
    ...COUNTERS.map(row)
  ]
}

/** Exécute `pfctl <arguments>`. */
export function runPfctl(ctx: ExecContext, t: PfTerm, args: string[]): void {
  const device = ctx.device
  if (device.kind !== 'firewall') return
  if (args.length === 0) {
    for (const line of PFCTL_USAGE) t.note(line, 'error')
    return
  }
  // Options regroupées (-sr, -vvsr…) puis options à argument (-s r)
  const todo: ('rules' | 'states' | 'info' | 'enable' | 'disable')[] = []
  let quiet = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (!arg.startsWith('-') || arg === '-') {
      t.note(unsimulatedOptionMessage('pfctl', arg), 'warning')
      return
    }
    const letters = arg.slice(1)
    for (let j = 0; j < letters.length; j++) {
      const c = letters[j] as string
      if (c === 'q') quiet = true
      else if (c === 'e') todo.push('enable')
      else if (c === 'd') todo.push('disable')
      else if (c === 's') {
        // Modificateur : lettres suivantes ou argument suivant (-sr, -s rules)
        const rest = letters.slice(j + 1)
        const mod = rest !== '' ? rest : (args[++i] ?? '')
        const known: Record<string, 'rules' | 'states' | 'info'> = {
          r: 'rules',
          rules: 'rules',
          s: 'states',
          states: 'states',
          i: 'info',
          info: 'info'
        }
        const what = known[mod]
        if (!what) {
          if (mod === '') {
            for (const line of PFCTL_USAGE) t.note(line, 'error')
          } else t.note(unsimulatedOptionMessage('pfctl', `-s ${mod}`), 'warning')
          return
        }
        todo.push(what)
        break
      } else {
        t.note(unsimulatedOptionMessage('pfctl', `-${c}`), 'warning')
        return
      }
    }
  }
  for (const action of todo) {
    switch (action) {
      case 'rules':
        for (const l of pfRuleset(device)) t.ctx.write(l.text)
        break
      case 'states':
        for (const l of stateLines(device)) t.ctx.write(l)
        break
      case 'info':
        for (const l of infoLines(device, ctx.state.clock)) t.ctx.write(l)
        break
      case 'enable':
      case 'disable': {
        const result = setPfFilterEnabled(ctx.state, ctx.deviceId, action === 'enable')
        if (!result.ok) {
          t.note(`pfctl: ${result.error.message}`, 'error')
          return
        }
        ctx.state = result.state
        if (!quiet) t.ctx.write(action === 'enable' ? 'pf enabled' : 'pf disabled')
        break
      }
    }
  }
}
