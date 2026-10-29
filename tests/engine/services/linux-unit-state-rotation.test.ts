/**
 * État des unités Linux et rotation du journal (audit v2.11.1, M-03) : « failed », le nombre de démarrages
 * (donc le PID) ne dépendent pas du plafond de 500 entrées du journal d'évènements.
 */
import { buildLabStart, clearEventLog, createShellSession, executeLine, unwrap } from '@engine/index'
import type { LabState } from '@engine/index'
import { describe, expect, it } from 'vitest'
import { LINUX_START } from '../troubleshoot/bases-linux'

function setup() {
  let s: LabState = buildLabStart(LINUX_START)
  const id = Object.values(s.devices).find((d) => d.name === 'LSRV1')!.id
  let sess = createShellSession(s, id, 'bash')
  const go = (line: string) => {
    const r = executeLine(s, sess, line, [])
    s = r.state
    sess = r.session
    return r.output.map((o) => o.text).join('\n')
  }
  return { go, clear: () => (s = unwrap(clearEventLog(s, id, 'Système')).state) }
}

const pidOf = (status: string) => /Main PID: (\d+)/.exec(status)?.[1]

describe('état des unités Linux et journal plafonné (M-03)', () => {
  it('une unité en échec le reste après rotation du journal', () => {
    const t = setup()
    t.go("echo 'Foo bar' | sudo tee -a /etc/apache2/apache2.conf")
    t.go('sudo systemctl restart apache2')
    expect(t.go('systemctl status apache2 --no-pager')).toContain('failed')
    for (let i = 0; i < 300; i++) t.go('sudo systemctl restart ssh')
    expect(t.go('systemctl status apache2 --no-pager')).toContain('failed')
  })

  it('le PID ne change pas sans action sur l’unité', () => {
    const t = setup()
    for (let i = 0; i < 3; i++) t.go('sudo systemctl restart ssh')
    const avant = pidOf(t.go('systemctl status ssh --no-pager'))
    expect(avant).toBeDefined()
    for (let i = 0; i < 300; i++) t.go('sudo systemctl restart named')
    expect(pidOf(t.go('systemctl status ssh --no-pager'))).toBe(avant)
  })

  it('effacer le journal ne réinitialise ni l’échec ni le PID', () => {
    const t = setup()
    t.go("echo 'Foo bar' | sudo tee -a /etc/apache2/apache2.conf")
    t.go('sudo systemctl restart apache2')
    t.go('sudo systemctl restart ssh')
    const pid = pidOf(t.go('systemctl status ssh --no-pager'))
    t.clear()
    expect(t.go('systemctl status apache2 --no-pager')).toContain('failed')
    expect(pidOf(t.go('systemctl status ssh --no-pager'))).toBe(pid)
  })
})
