/**
 * Lab des tests Samba (v2.9, #239) : le lab Linux (serveur LSRV1 192.168.2.10, poste LNX1 192.168.2.20)
 * plus un poste Windows PC1 (192.168.2.30, session locale « Utilisateur »).
 */
import { addDevice, unwrap, type LabState, type ShellSession } from '@engine/index'
import { cable, setIp } from '../helpers'
import { run } from './helpers'
import { Bash, buildLinuxLab, type LinuxLab } from './linux-lab'

export type Who = 'srv' | 'pc' | 'win'
/** [machine, ligne tapée, réponses aux invites] */
export type Command = [Who, string, string[]?]

export interface SambaLab extends LinuxLab {
  pcWin: string
}

export function buildSambaLab(): SambaLab {
  const lab = buildLinuxLab()
  const added = unwrap(
    addDevice(lab.state, { kind: 'client', os: 'windows', name: 'PC1', position: { x: 0, y: 0 } })
  )
  let state = added.state
  const id = added.value
  state = cable(state, id, 0, lab.ids.SW1!, 5)
  state = setIp(state, id, 0, '192.168.2.30/24', '192.168.2.254')
  state = structuredClone(state)
  ;(state.devices[id] as unknown as { host: Record<string, unknown> }).host.session = {
    user: 'Utilisateur',
    domain: null,
    logonServer: 'PC1'
  }
  return { state, ids: lab.ids, pcWin: id }
}

/** Les trois consoles du lab (serveur Linux, poste Linux, poste Windows) sur un état partagé. */
export class Consoles {
  state: LabState
  private readonly srv: Bash
  private readonly pc: Bash
  private winSession: ShellSession | undefined
  constructor(private readonly lab: SambaLab) {
    this.state = lab.state
    this.srv = new Bash(lab.state, lab.ids.LSRV1!)
    this.pc = new Bash(lab.state, lab.ids.LNX1!)
  }
  /** Sortie réelle (sortie standard et erreurs) d'une ligne tapée sur la machine. */
  run(who: Who, line: string, answers: string[] = []): string {
    if (who === 'win') {
      const r = run(this.state, this.lab.pcWin, line, {
        shell: 'cmd',
        answers,
        ...(this.winSession ? { session: this.winSession } : {})
      })
      this.state = r.state
      this.winSession = r.session
      return r.text
    }
    const shell = who === 'srv' ? this.srv : this.pc
    shell.state = this.state
    const out = shell.real(line, answers)
    this.state = shell.state
    return out
  }
}

/** Ajoute des lignes à la fin d'un fichier de configuration (une commande tee -a par ligne). */
export function appendLines(path: string, lines: string[]): Command[] {
  return lines.map((l) => ['srv', `echo '${l}' | sudo tee -a ${path}`] as Command)
}
