/**
 * Redémarrage d'un serveur Linux (audit v2.11.1, M-02) : au démarrage, chaque unité automatique valide
 * sa configuration comme `systemctl start` ; une configuration cassée enregistrée sans restart
 * fait échouer l'unité au reboot au lieu de la laisser « active ».
 */
import { buildLabStart, createShellSession, executeLine, restartComputer, unwrap } from '@engine/index'
import type { LabState } from '@engine/index'
import { describe, expect, it } from 'vitest'
import { LINUX_START } from '../troubleshoot/bases-linux'

const UNITS = ['apache2', 'isc-dhcp-server', 'named']

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
  return {
    go,
    reboot() {
      s = unwrap(restartComputer(s, id)).state
      sess = createShellSession(s, id, 'bash')
    }
  }
}

describe('reboot Linux avec configuration cassée (M-02)', () => {
  it('une unité à config invalide échoue au démarrage', () => {
    const t = setup()
    t.go("echo 'Foo bar' | sudo tee -a /etc/apache2/apache2.conf")
    t.go("echo 'garbage {' | sudo tee -a /etc/dhcp/dhcpd.conf")
    t.go("echo 'options {' | sudo tee -a /etc/bind/named.conf.local")
    // Sans restart : les services tournent encore avec l'ancienne configuration
    for (const u of UNITS) expect(t.go(`systemctl is-active ${u}`)).toBe('active')
    t.reboot()
    for (const u of UNITS) expect(t.go(`systemctl is-active ${u}`)).not.toBe('active')
    expect(t.go('systemctl status isc-dhcp-server --no-pager')).toContain('failed')
    expect(t.go('curl -s -o /dev/null -w %{http_code} http://localhost')).not.toBe('200')
  })

  it('une configuration saine redémarre normalement', () => {
    const t = setup()
    t.reboot()
    for (const u of UNITS) expect(t.go(`systemctl is-active ${u}`)).toBe('active')
  })
})
