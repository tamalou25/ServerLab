/**
 * Cmdlets de base (pipeline, aide, invites, emplacement), cmdlets réseau et système, et outils de
 * fichiers de l'Invite de commandes jamais exercés ailleurs, sur le lab de référence.
 */
import { describe, expect, it } from 'vitest'
import { findNode, hasFeature, type LabState, type ServerDevice } from '@engine/index'
import { buildReferenceLab } from '../serialization/reference-lab'
import { run, type RunResult } from './helpers'

const id = (s: LabState, name: string) => Object.values(s.devices).find((d) => d.name === name)?.id ?? ''

/** Console persistante (PowerShell ou cmd) sur un équipement. */
class Console {
  session: RunResult['session'] | undefined
  constructor(
    public state: LabState,
    readonly device: string,
    readonly shell: 'powershell' | 'cmd' = 'powershell'
  ) {}
  run(line: string, answers: string[] = []): RunResult {
    const r = run(this.state, id(this.state, this.device), line, {
      shell: this.shell,
      answers,
      ...(this.session ? { session: this.session } : {})
    })
    this.state = r.state
    this.session = r.session
    return r
  }
}

describe('PowerShell : cmdlets de base', () => {
  it('pipeline : Sort-Object, Format-List, Measure-Object, Out-Null, Write-Output', () => {
    const ps = new Console(buildReferenceLab(), 'SRV1')
    const sorted = ps.run('Get-ADUser -Filter * | Sort-Object Name -Descending | Format-List Name').text
    const names = [...sorted.matchAll(/^Name : (.+)$/gm)].map((m) => m[1])
    expect(names).toEqual(['krbtgt', 'Jean Dupont', 'Invité', 'Administrateur'])
    expect(ps.run('Get-ADUser -Filter * | Measure-Object').text).toMatch(/Count\s+: 4/)
    expect(ps.run('Get-ADGroup -Filter * | Out-Null').text.trim()).toBe('')
    expect(ps.run("Write-Output 'bonjour'").text.trim()).toBe('bonjour')
  })

  it('Get-Command (filtre, module), Get-Help, Get-Date, Clear-Host', () => {
    const ps = new Console(buildReferenceLab(), 'SRV1')
    const ad = ps.run('Get-Command -Name Get-AD*').text
    expect(ad).toMatch(/Cmdlet\s+Get-ADUser\s+1\.0\.0\.0 ActiveDirectory/)
    expect(ad).not.toContain('New-ADUser')
    const dhcp = ps.run('Get-Command -Module DhcpServer').text
    expect(dhcp).toContain('Add-DhcpServerv4Scope')
    expect(dhcp).not.toContain('Get-ADUser')
    const help = ps.run('Get-Help Get-ADUser').text
    expect(help).toContain('NOM')
    expect(help).toContain('SYNTAXE')
    expect(help).toContain('[-Identity] <string>')
    expect(ps.run('Get-Date').text).toMatch(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/m)
    expect(ps.run('Clear-Host').errors).toBe('')
  })

  it('Read-Host et Get-Credential : invites, valeur réutilisable', () => {
    const ps = new Console(buildReferenceLab(), 'SRV1')
    const asked = ps.run("$n = Read-Host 'Nom'", ['Alice'])
    expect(asked.prompts).toEqual(['Nom: '])
    expect(ps.run('Write-Output $n').text.trim()).toBe('Alice')
    const cred = ps.run('$c = Get-Credential LAB\\Administrateur', ['secret'])
    expect(cred.prompts[0]).toContain('LAB\\Administrateur')
  })

  it('Set-Location et Get-Location : l’emplacement suit la session', () => {
    const ps = new Console(buildReferenceLab(), 'SRV1')
    expect(ps.run('Get-Location').text).toContain('C:\\Users\\Administrateur')
    ps.run('Set-Location C:\\Windows')
    expect(ps.run('Get-Location').text).toContain('C:\\Windows')
    expect(ps.run('Set-Location C:\\Introuvable').errors).not.toBe('')
    expect(ps.run('Get-Location').text).toContain('C:\\Windows')
  })
})

describe('PowerShell : réseau et système', () => {
  it('Get-NetIPConfiguration et Get-DnsClientServerAddress', () => {
    const ps = new Console(buildReferenceLab(), 'PC2')
    const conf = ps.run('Get-NetIPConfiguration').text
    expect(conf).toMatch(/IPv4Address\s+: 192\.168\.10\.20/)
    expect(conf).toMatch(/IPv4DefaultGateway\s+: 192\.168\.10\.254/)
    expect(ps.run('Get-NetIPConfiguration -Detailed').text).toMatch(/DNSServer\s+: \{192\.168\.10\.1\}/)
    expect(ps.run('Get-DnsClientServerAddress -AddressFamily IPv4').text).toMatch(
      /Ethernet0\s+\d+ IPv4\s+\{192\.168\.10\.1\}/
    )
  })

  it('Test-Connection et Test-NetConnection', () => {
    const ps = new Console(buildReferenceLab(), 'PC2')
    const replies = ps.run('Test-Connection 192.168.10.1 -Count 2').text
    expect(replies.match(/^PC2\s+192\.168\.10\.1/gm)).toHaveLength(2)
    expect(ps.run('Test-Connection 192.168.10.99 -Quiet').text.trim()).toBe('False')
    expect(ps.run('Test-Connection 192.168.10.1 -Quiet').text.trim()).toBe('True')
    const tnc = ps.run('Test-NetConnection srv1.lab.local -Port 445')
    expect(tnc.text).toMatch(/RemoteAddress\s+: 192\.168\.10\.1/)
    // Lot 2c : test TCP simulé (SMB à l'écoute sur SRV1)
    expect(tnc.text).toMatch(/TcpTestSucceeded\s+: True/)
  })

  it('Set-NetIPInterface -Dhcp Enabled : passe en adressage automatique, DNS conservé', () => {
    const ps = new Console(buildReferenceLab(), 'PC2')
    ps.run('Set-NetIPInterface -InterfaceAlias Ethernet0 -Dhcp Enabled')
    const iface = ps.state.devices[id(ps.state, 'PC2')]?.interfaces[0]
    expect(iface && 'addressing' in iface ? iface.addressing : null).toBe('dhcp')
    expect(ps.run('Get-DnsClientServerAddress -AddressFamily IPv4').text).toContain('{192.168.10.1}')
  })

  it('Uninstall-WindowsFeature puis Stop-Computer', () => {
    const ps = new Console(buildReferenceLab(), 'SRV1')
    expect(ps.run('Uninstall-WindowsFeature DHCP').text).toMatch(/True\s+No\s+Success\s+\{Serveur DHCP\}/)
    expect(hasFeature(ps.state.devices[id(ps.state, 'SRV1')] as ServerDevice, 'DHCP')).toBe(false)
    ps.run('Stop-Computer -Force')
    expect(ps.state.devices[id(ps.state, 'SRV1')]?.powered).toBe(false)
  })
})

describe('Invite de commandes : dossiers et fichiers', () => {
  const exists = (s: LabState, path: string) =>
    findNode((s.devices[id(s, 'SRV1')] as ServerDevice).storage, path) !== undefined

  it('md, del / erase, rd et rmdir /s /q', () => {
    let s = buildReferenceLab()
    const cmd = new Console(s, 'SRV1', 'cmd')
    cmd.run('md C:\\Test')
    cmd.run('md C:\\Test\\Sous')
    expect(exists(cmd.state, 'C:\\Test\\Sous')).toBe(true)
    // Fichiers créés depuis PowerShell, supprimés depuis cmd
    const ps = new Console(cmd.state, 'SRV1')
    ps.run('New-Item -Path C:\\Test\\a.txt -ItemType File')
    ps.run('New-Item -Path C:\\Test\\b.txt -ItemType File')
    cmd.state = ps.state
    expect(cmd.run('dir C:\\Test').text).toMatch(/2 fichier\(s\)/)
    cmd.run('del C:\\Test\\a.txt')
    cmd.run('erase C:\\Test\\b.txt')
    expect(exists(cmd.state, 'C:\\Test\\a.txt') || exists(cmd.state, 'C:\\Test\\b.txt')).toBe(false)
    expect(cmd.run('del C:\\Test\\a.txt').text).toContain('Impossible de trouver C:\\Test\\a.txt')
    expect(cmd.run('rd C:\\Test').text).toContain('Le répertoire n’est pas vide.')
    expect(exists(cmd.state, 'C:\\Test')).toBe(true)
    cmd.run('rd C:\\Test\\Sous')
    cmd.run('md C:\\Test\\Sous2')
    cmd.run('rmdir /s /q C:\\Test')
    s = cmd.state
    expect(exists(s, 'C:\\Test')).toBe(false)
  })
})
