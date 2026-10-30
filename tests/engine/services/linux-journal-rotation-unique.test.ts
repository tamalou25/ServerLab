/**
 * Rotation du journal : un seul point d'entrée (`appendEventEntry`) pour `logEvent` et `pushUntimed`
 * (audit v2.11.1, revue A2 / M-03 : `pushUntimed` gardait un `splice(0, …)` qui évinçait les entrées d'état).
 */
import { EVENT_LOG_LIMIT, appendEventEntry } from '@engine/core/eventlog'
import { transact } from '@engine/core/result'
import { pushUntimed } from '@engine/services/linuxapachehost'
import { buildLabStart, createShellSession, executeLine } from '@engine/index'
import type { EventLogEntry, LabState } from '@engine/index'
import { describe, expect, it } from 'vitest'
import { LINUX_START } from '../troubleshoot/bases-linux'

const entry = (id: number, message: string, source = 'apache2.error'): EventLogEntry => ({
  id,
  time: id,
  log: 'Système',
  level: 'information',
  source,
  eventId: 0,
  message,
  account: source === 'systemd' ? 'ssh' : 'error.log'
})

function lsrv() {
  const s = buildLabStart(LINUX_START)
  const id = Object.values(s.devices).find((d) => d.name === 'LSRV1')!.id
  return { s, id }
}

describe('rotation unique du journal (A2)', () => {
  it('appendEventEntry garde les entrées « Started » d’unité quand le journal est plein', () => {
    const log: EventLogEntry[] = [entry(1, 'Started OpenBSD Secure Shell server.', 'systemd')]
    for (let i = 2; i <= EVENT_LOG_LIMIT; i++) log.push(entry(i, `ligne ${i}`))
    appendEventEntry(log, entry(EVENT_LOG_LIMIT + 1, 'nouvelle ligne'))
    expect(log).toHaveLength(EVENT_LOG_LIMIT)
    expect(log.some((e) => e.message.startsWith('Started '))).toBe(true)
  })

  it('pushUntimed (lignes d’Apache) n’évince pas une entrée d’état d’unité', () => {
    const { s, id } = lsrv()
    const next = transact(s, (draft) => {
      const log = (draft.devices[id] as { host: { eventLog: EventLogEntry[] } }).host.eventLog
      log.length = 0
      log.push(entry(1000, 'Started OpenBSD Secure Shell server.', 'systemd'))
      for (let i = 0; i < EVENT_LOG_LIMIT - 1; i++) log.push(entry(2000 + i, `x${i}`))
      for (let i = 0; i < 30; i++)
        pushUntimed(draft, id, {
          level: 'information',
          source: 'apache2.error',
          eventId: 1,
          message: `m${i}`
        })
    })
    if (!next.ok) throw new Error(next.error.message)
    const log = (next.state.devices[id] as { host: { eventLog: EventLogEntry[] } }).host.eventLog
    expect(log).toHaveLength(EVENT_LOG_LIMIT)
    expect(log.some((e) => e.message === 'Started OpenBSD Secure Shell server.')).toBe(true)
  })

  it('les identifiants négatifs de pushUntimed restent uniques après rotation', () => {
    const { s, id } = lsrv()
    const next = transact(s, (draft) => {
      for (let i = 0; i < EVENT_LOG_LIMIT * 3; i++)
        pushUntimed(draft, id, {
          level: 'information',
          source: 'apache2.error',
          eventId: 1,
          message: `m${i}`
        })
    })
    if (!next.ok) throw new Error(next.error.message)
    const ids = (next.state.devices[id] as { host: { eventLog: EventLogEntry[] } }).host.eventLog.map(
      (e) => e.id
    )
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('flux : redémarrer ssh, 520 requêtes curl, redémarrer Apache → « active since » de ssh inchangé', () => {
    let s: LabState = buildLabStart(LINUX_START)
    const id = Object.values(s.devices).find((d) => d.name === 'LSRV1')!.id
    let sess = createShellSession(s, id, 'bash')
    const go = (line: string) => {
      const r = executeLine(s, sess, line, [])
      s = r.state
      sess = r.session
      return r.output.map((o) => o.text).join('\n')
    }
    const since = (out: string) => /Active: .* since [^;]+/.exec(out)?.[0]
    go('sudo systemctl restart ssh')
    const avant = since(go('systemctl status ssh --no-pager'))
    expect(avant).toBeDefined()
    for (let i = 0; i < 520; i++) go('curl -s http://localhost/')
    go('sudo systemctl restart apache2')
    expect(since(go('systemctl status ssh --no-pager'))).toBe(avant)
  }, 30_000)
})
