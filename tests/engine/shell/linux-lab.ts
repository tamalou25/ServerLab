/**
 * Lab de test des consoles Linux (v2.9, #236) : serveur Debian LSRV1 (192.168.2.10/24) et poste
 * Ubuntu LNX1 (192.168.2.20/24) sur SW1, routeur R1 (192.168.2.254) relié à Internet. DNS public
 * 8.8.8.8. Aucune horloge ni identifiant aléatoire : les sorties sont stables.
 */
import {
  addDevice,
  addStaticRoute,
  createShellSession,
  executeLine,
  setPower,
  unwrap,
  type DeviceKind,
  type LabState,
  type ShellSession
} from '@engine/index'
import { build, cable, setIp } from '../helpers'
import { run, type RunResult } from './helpers'

export interface LinuxLab {
  state: LabState
  ids: Record<string, string>
}

function addLinux(state: LabState, kind: DeviceKind, name: string): { state: LabState; id: string } {
  const r = unwrap(addDevice(state, { kind, os: 'linux', name, position: { x: 0, y: 0 } }))
  return { state: r.state, id: r.value }
}

/** `internet: false` : le routeur n'a pas de lien vers Internet (apt update échoue). */
export function buildLinuxLab(options: { internet?: boolean } = {}): LinuxLab {
  const internet = options.internet ?? true
  const base = build([
    ['switch', 'SW1'],
    ['router', 'R1'],
    ['cloud', 'INTERNET'],
    ['server', 'SRV1']
  ])
  let s = base.state
  const ids = { ...base.ids }
  for (const [kind, name] of [
    ['server', 'LSRV1'],
    ['client', 'LNX1']
  ] as const) {
    const r = addLinux(s, kind, name)
    s = r.state
    ids[name] = r.id
  }
  s = cable(s, ids.LSRV1!, 0, ids.SW1!, 0)
  s = cable(s, ids.LNX1!, 0, ids.SW1!, 1)
  s = cable(s, ids.R1!, 0, ids.SW1!, 2)
  s = cable(s, ids.SRV1!, 0, ids.SW1!, 3)
  s = setIp(s, ids.R1!, 0, '192.168.2.254/24')
  s = setIp(s, ids.SRV1!, 0, '192.168.2.1/24', '192.168.2.254')
  s = setIp(s, ids.LSRV1!, 0, '192.168.2.10/24', '192.168.2.254', ['8.8.8.8'])
  s = setIp(s, ids.LNX1!, 0, '192.168.2.20/24', '192.168.2.254', ['8.8.8.8'])
  if (internet) {
    s = cable(s, ids.R1!, 1, ids.INTERNET!, 0)
    s = setIp(s, ids.R1!, 1, '203.0.113.1/30')
    s = setIp(s, ids.INTERNET!, 0, '203.0.113.2/30')
    s = unwrap(
      addStaticRoute(s, ids.R1!, { network: '0.0.0.0', mask: '0.0.0.0', nextHop: '203.0.113.2' })
    ).state
  }
  return { state: s, ids }
}

/** Console bash d'un ordinateur du lab (la session et l'état se transmettent d'une commande à l'autre). */
export class Bash {
  session: ShellSession
  constructor(
    public state: LabState,
    public deviceId: string
  ) {
    this.session = createShellSession(state, deviceId, 'cmd')
  }
  run(line: string, answers: string[] = []): RunResult {
    const r = run(this.state, this.deviceId, line, { session: this.session, answers })
    this.state = r.state
    this.session = r.session
    return r
  }
  /**
   * Sortie réelle de l'outil (sortie standard et erreurs) : les remarques propres à ServerLab
   * (valeurs non modélisées, type `warning`) en sont exclues. Sert aux tests golden.
   */
  real(line: string, answers: string[] = []): string {
    const given: string[] = []
    const pending = [...answers]
    for (;;) {
      const r = executeLine(this.state, this.session, line, given)
      if (r.prompt) {
        given.push(pending.shift() ?? '')
        continue
      }
      this.state = r.state
      this.session = r.session
      return r.output
        .filter((l) => l.kind !== 'warning')
        .map((l) => l.text)
        .join('\n')
    }
  }
  /** Sortie standard et erreurs, dans l'ordre d'affichage. */
  out(line: string, answers: string[] = []): string {
    return this.run(line, answers).text
  }
  /** Redémarre l'ordinateur (extinction puis allumage). */
  reboot(): void {
    this.state = unwrap(setPower(this.state, this.deviceId, false)).state
    this.state = unwrap(setPower(this.state, this.deviceId, true)).state
  }
}
