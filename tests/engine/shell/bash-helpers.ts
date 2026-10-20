/**
 * Aides des tests de la console bash (v2.9) : un poste Linux LNX1 seul (aucun réseau nécessaire :
 * système de fichiers, comptes et droits sont locaux) et une session qui enchaîne les lignes.
 */
import {
  addDevice,
  createLab,
  createShellSession,
  unwrap,
  type HostDevice,
  type LabState,
  type ShellSession
} from '@engine/index'
import { run, type RunResult } from './helpers'

/** Lab réduit à un poste Linux nommé LNX1 (session etudiant). */
export function linuxLab(): LabState {
  const r = unwrap(
    addDevice(createLab(), { kind: 'client', os: 'linux', position: { x: 0, y: 0 }, name: 'LNX1' })
  )
  return r.state
}

/** Session bash qui conserve l'état et le dossier courant entre les lignes. */
export class Bash {
  session: ShellSession
  readonly deviceId: string
  constructor(public state: LabState = linuxLab()) {
    this.deviceId = Object.values(state.devices).find((d) => d.name === 'LNX1')?.id ?? ''
    this.session = createShellSession(state, this.deviceId, 'cmd')
  }
  run(line: string, answers: string[] = []): RunResult {
    const r = run(this.state, this.deviceId, line, { session: this.session, answers })
    this.state = r.state
    this.session = r.session
    return r
  }
  /** Sortie complète (standard puis erreurs, dans l'ordre d'affichage) en une seule chaîne. */
  all(line: string, answers: string[] = []): string {
    return this.run(line, answers).text
  }
  get host(): HostDevice {
    return this.state.devices[this.deviceId] as HostDevice
  }
}
