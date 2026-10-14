/**
 * Invite de commandes : commandes internes (ver, echo, cd, help, exit…) et options des outils
 * réseau (ipconfig, ping, tracert, whoami) jamais exercées ailleurs, sur le lab de référence.
 */
import { describe, expect, it } from 'vitest'
import { createShellSession, executeLine, type LabState } from '@engine/index'
import { buildReferenceLab } from '../serialization/reference-lab'
import { run, type RunResult } from './helpers'

const id = (s: LabState, name: string) => Object.values(s.devices).find((d) => d.name === name)?.id ?? ''

/** Invite de commandes persistante sur un équipement. */
class Cmd {
  session: RunResult['session'] | undefined
  constructor(
    public state: LabState,
    readonly device: string
  ) {}
  run(line: string): RunResult {
    const r = run(this.state, id(this.state, this.device), line, {
      shell: 'cmd',
      ...(this.session ? { session: this.session } : {})
    })
    this.state = r.state
    this.session = r.session
    return r
  }
}

describe('Invite de commandes : commandes internes', () => {
  it('ver, echo, title, cd / chdir, help, commande inconnue, exit', () => {
    const cmd = new Cmd(buildReferenceLab(), 'SRV1')
    expect(cmd.run('ver').text).toContain('Invite de commandes simulée')
    expect(cmd.run('echo').text).toBe('ECHO est activé.')
    expect(cmd.run('echo Bonjour à tous').text).toBe('Bonjour à tous')
    expect(cmd.run('title Mon serveur').text).toBe('')
    expect(cmd.run('cd').text).toBe('C:\\Users\\Administrateur')
    cmd.run('chdir /d C:\\Windows')
    expect(cmd.run('cd').text).toBe('C:\\Windows')
    const help = cmd.run('help').text
    expect(help).toMatch(/^IPCONFIG\s+Affiche la configuration IP/m)
    expect(help).toMatch(/^POWERSHELL\s+Démarre PowerShell\./m)
    expect(cmd.run('foo').errors).toContain("'foo' n’est pas reconnu en tant que commande interne")
    // Outil Windows réel non simulé (audit F-01)
    expect(cmd.run('taskkill /im dns.exe').errors).toBe(
      '« taskkill » est une commande réelle qui n’est pas simulée dans ServerLab.'
    )
    expect(cmd.run('WMIC.EXE os').errors).toContain('« WMIC.EXE » est une commande réelle')
    // cls efface l'écran ; exit au niveau le plus haut ferme la console
    const session = createShellSession(cmd.state, id(cmd.state, 'SRV1'), 'cmd')
    expect(executeLine(cmd.state, session, 'cls', []).clear).toBe(true)
    expect(executeLine(cmd.state, session, 'exit', []).exit).toBe(true)
  })

  it('poste client : le volume C: n’est pas simulé', () => {
    const cmd = new Cmd(buildReferenceLab(), 'PC1')
    expect(cmd.run('cd C:\\Windows').errors).toContain('n’est pas simulé')
    expect(cmd.run('cd').text).toBe('C:\\Users\\Utilisateur')
  })
})

describe('Invite de commandes : ipconfig', () => {
  it('/flushdns, /registerdns, option inconnue', () => {
    const cmd = new Cmd(buildReferenceLab(), 'PC1')
    expect(cmd.run('ipconfig /flushdns').text).toContain('Cache de résolution DNS vidé.')
    expect(cmd.run('ipconfig /registerdns').text).toContain('a été initiée')
    const bad = cmd.run('ipconfig /bad')
    expect(bad.errors).toBe('Erreur : option « /bad » non reconnue.')
    expect(bad.text).toContain('UTILISATION :')
  })

  it('/release puis /renew : bail libéré puis obtenu de nouveau', () => {
    const cmd = new Cmd(buildReferenceLab(), 'PC1')
    expect(cmd.run('ipconfig /release Ethernet9').errors).toContain(
      'aucune carte ne correspond au nom « Ethernet9 »'
    )
    const released = cmd.run('ipconfig /release').text
    expect(released).not.toContain('Adresse IPv4')
    expect(cmd.state.devices[id(cmd.state, 'PC1')]?.interfaces[0]).toMatchObject({ dhcpLease: null })
    expect(cmd.run('ipconfig /renew').text).toMatch(/Adresse IPv4[ .]+: 192\.168\.10\.100/)
  })

  it('/renew sur une carte statique : refusé', () => {
    const cmd = new Cmd(buildReferenceLab(), 'PC2')
    expect(cmd.run('ipconfig /renew').text).toContain('L’adaptateur Ethernet0 n’est pas activé pour DHCP.')
  })
})

describe('Invite de commandes : ping, tracert, whoami', () => {
  it('ping : aide, cible absente, -n invalide, nom inconnu, options -n et -l', () => {
    const cmd = new Cmd(buildReferenceLab(), 'PC1')
    expect(cmd.run('ping /?').text).toContain('Utilisation : ping [-t] [-n nombre]')
    expect(cmd.run('ping').errors).toBe('Le nom de la cible doit être indiqué.')
    expect(cmd.run('ping -n 0 srv1').errors).toContain('Valeur incorrecte pour l’option -n')
    expect(cmd.run('ping inconnu.lab.local').text).toContain('n’a pas pu trouver l’hôte inconnu.lab.local')
    const ok = cmd.run('ping srv1.lab.local -n 1 -l 64').text
    expect(ok).toContain('srv1.lab.local [192.168.10.1] avec 64 octets de données')
    expect(ok).toContain('envoyés = 1, reçus = 1, perdus = 0')
  })

  it('tracert : utilisation, nom inconnu, -d -h', () => {
    const cmd = new Cmd(buildReferenceLab(), 'PC1')
    expect(cmd.run('tracert').text).toContain('Utilisation : tracert')
    expect(cmd.run('tracert inconnu.lab.local').text).toContain('Impossible de résoudre le nom système cible')
    const route = cmd.run('tracert -d -h 5 srv1.lab.local').text
    expect(route).toContain('avec un maximum de 5 sauts')
    expect(route).toMatch(/1\s+<1 ms\s+<1 ms\s+<1 ms\s+192\.168\.10\.1/)
  })

  it('whoami : compte local, /upn refusé, /groups', () => {
    const cmd = new Cmd(buildReferenceLab(), 'PC1')
    expect(cmd.run('whoami').text).toBe('pc1\\utilisateur')
    expect(cmd.run('whoami /upn').errors).toContain('n’est pas un utilisateur de domaine')
    expect(cmd.run('whoami /groups').text).toMatch(/Tout le monde\s+Groupe bien connu/)
  })
})
