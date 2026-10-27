/**
 * Lab 53 « Dépannage Linux : le site web et l'accès SSH sont en panne » : départ cassé par buildLabState
 * (droits du DocumentRoot + port de sshd, graine fixe), symptômes vus depuis les postes, réparation à la
 * console puis réparation officielle = 100 % des critères, cas partiels.
 */
import { describe, expect, it } from 'vitest'
import { activeFaults, allRepaired, checkLab, getFault, type LabState } from '@engine/index'
import { run } from '../shell/helpers'
import { failing, loadTroubleshootingLab, repairOfficial } from './depannage-helpers'

const { lab, start } = loadTroubleshootingLab('lab-53-depannage-linux.json')
const id = (s: LabState, name: string) => Object.values(s.devices).find((d) => d.name === name)?.id ?? ''
const sh = (s: LabState, machine: string, line: string, answers: string[] = []) =>
  run(s, id(s, machine), line, { shell: 'cmd', answers })

describe('lab-53-depannage-linux', () => {
  it('démarre cassé : deux pannes Linux fixées, aucune réparée', () => {
    expect(activeFaults(start).map((f) => f.id)).toEqual(['linux.apache-docroot-perms', 'linux.sshd-port'])
    expect(allRepaired(start)).toBe(false)
    for (const f of activeFaults(start)) expect(getFault(f.id)!.healed(start, f.params), f.id).toBe(false)
  })

  it('symptômes visibles depuis les postes : 403 et connexion SSH refusée', () => {
    expect(sh(start, 'LNX1', 'curl -sI http://192.168.20.10/').text).toContain('403 Forbidden')
    expect(sh(start, 'LNX1', 'ssh admin@192.168.20.10', ['x']).text).toContain('Connection refused')
    expect(failing(start, lab).sort()).toEqual(['panne-ssh', 'panne-web', 'ssh-port', 'web'])
  })

  it('la réparation saisie à la console valide 100 % des critères', () => {
    let s = start
    for (const line of [
      'sudo chmod 755 /var/www/html',
      "sudo sed -i 's/^Port 2222$/#Port 22/' /etc/ssh/sshd_config",
      'sudo systemctl restart ssh'
    ])
      s = sh(s, 'LSRV1', line).state
    expect(failing(s, lab)).toEqual([])
    expect(allRepaired(s)).toBe(true)
  })

  it('la réparation officielle valide 100 % des critères', () => {
    const fixed = repairOfficial(start)
    expect(failing(fixed, lab)).toEqual([])
    expect(checkLab(fixed, lab).passed).toBe(lab.criteria.length)
    expect(sh(fixed, 'LNX1', 'curl -sI http://192.168.20.10/').text).toContain('200 OK')
  })

  it('cas partiel : le site réparé, SSH toujours en panne', () => {
    const half = repairOfficial(start, 'linux.apache-docroot-perms')
    expect(failing(half, lab)).toEqual(['panne-ssh', 'ssh-port'])
    expect(allRepaired(half)).toBe(false)
  })
})
