/**
 * Cmdlets réseau et système (v2.7, Lot 2c).
 *
 * Sources Microsoft Learn :
 * - NetTCPIP : Get-NetRoute (exemple 4 : -DestinationPrefix "0.0.0.0/0" | Select-Object
 *   -ExpandProperty NextHop = passerelle par défaut ; exemple 3 : -InterfaceIndex),
 *   Get-NetNeighbor (-State Reachable), Get-NetTCPConnection (-State, -LocalPort, -OwningProcess),
 *   Test-NetConnection (exemple 3 : -Port, champ TcpTestSucceeded), Remove-NetIPAddress.
 * - DnsClient : Set-DnsClientServerAddress -ServerAddresses / -ResetServerAddresses.
 * - NetAdapter : Disable-NetAdapter (caractères génériques, confirmation, -Confirm:$False),
 *   Enable-NetAdapter.
 * - PowerShell 5.1 : Get-EventLog (colonnes Index Time EntryType Source InstanceID Message,
 *   -Newest, -EntryType, -Source, -InstanceId, -List), Get-ComputerInfo (-Property "*…"),
 *   Test-ComputerSecureChannel (True / False, -Repair, -Verbose), Restart-Computer -ComputerName.
 */
import { describe, expect, it } from 'vitest'
import { command, dispatch, installFeatures, unwrap, type HostDevice, type LabState } from '@engine/index'
import { add, cable, createLab, setIp } from '../helpers'
import { addIos, IosConsole, type SharedLab } from '../ios/helpers'
import { buildReferenceLab } from '../serialization/reference-lab'
import { run, type RunResult } from './helpers'

const id = (s: LabState, name: string) => Object.values(s.devices).find((d) => d.name === name)?.id ?? ''

class Console {
  constructor(public state: LabState) {}
  run(line: string, on = 'SRV1', shell: 'powershell' | 'cmd' = 'powershell', answers?: string[]): RunResult {
    const r = run(this.state, id(this.state, on), line, { shell, ...(answers ? { answers } : {}) })
    this.state = r.state
    return r
  }
}

describe('Get-NetRoute, Get-NetNeighbor', () => {
  it('route par défaut : NextHop = passerelle (Learn, exemple 4) ; routes connectées', () => {
    const ps = new Console(buildReferenceLab())
    expect(
      ps
        .run('Get-NetRoute -DestinationPrefix "0.0.0.0/0" | Select-Object -ExpandProperty "NextHop"')
        .text.trim()
    ).toBe('192.168.10.254')
    const all = ps.run('Get-NetRoute').text
    expect(all).toMatch(/^ifIndex\s+DestinationPrefix\s+NextHop\s+PolicyStore$/m)
    expect(all).toMatch(/^\s*4\s+192\.168\.10\.0\/24\s+0\.0\.0\.0\s+ActiveStore$/m)
    expect(ps.run('Get-NetRoute -InterfaceIndex 4').text).toContain('0.0.0.0/0')
    expect(ps.run('Get-NetRoute -AddressFamily IPv6').text.trim()).toBe('')
    expect(ps.run('Get-NetRoute -DestinationPrefix 10.9.9.0/24').errors).toContain('MSFT_NetRoute')
  })
  it('Get-NetNeighbor : voisins du segment (Reachable) et diffusion (Permanent), comme arp -a', () => {
    const ps = new Console(buildReferenceLab())
    const pc2 = ps.state.devices[id(ps.state, 'PC2')]
    const mac = pc2?.interfaces[0]?.mac.toUpperCase().replace(/[:.]/g, '-') ?? ''
    const out = ps.run('Get-NetNeighbor').text
    expect(out).toMatch(new RegExp(`192\\.168\\.10\\.20\\s+${mac}\\s+Reachable`))
    expect(out).toMatch(/192\.168\.10\.255\s+FF-FF-FF-FF-FF-FF\s+Permanent/)
    expect(ps.run('Get-NetNeighbor -State Permanent').text).not.toContain('Reachable')
    expect(ps.run('arp -a', 'SRV1', 'cmd').text).toContain(mac.toLowerCase())
    expect(ps.run('Get-NetNeighbor -IPAddress 10.1.1.1').errors).toContain('MSFT_NetNeighbor')
  })
})

describe('Get-NetTCPConnection, Test-NetConnection -Port', () => {
  it('écoutes des rôles dont le service est démarré ; DNS arrêté → plus de port 53', () => {
    const ps = new Console(buildReferenceLab())
    const out = ps.run('Get-NetTCPConnection -State Listen').text
    expect(out).toMatch(/0\.0\.0\.0\s+53\s+0\.0\.0\.0\s+0\s+Listen/)
    expect(out).toMatch(/0\.0\.0\.0\s+389\s+0\.0\.0\.0\s+0\s+Listen/)
    const pid = ps.run('(Get-NetTCPConnection -LocalPort 53).OwningProcess').text.trim()
    expect(ps.run('tasklist', 'SRV1', 'cmd').text).toMatch(new RegExp(`^dns\\.exe\\s+${pid}\\s`, 'm'))
    expect(ps.run(`Get-NetTCPConnection -OwningProcess ${pid}`).text).toContain(' 53 ')
    ps.run('Stop-Service DNS')
    expect(ps.run('Get-NetTCPConnection -LocalPort 53').errors).toContain('MSFT_NetTCPConnection')
    expect(ps.run('netstat -an', 'SRV1', 'cmd').text).not.toMatch(/TCP\s+0\.0\.0\.0:53\s/)
    expect(ps.run('Get-NetTCPConnection -State Established').errors).not.toBe('')
  })
  it('Test-NetConnection -Port : service à l’écoute, service arrêté, pare-feu, port fermé', () => {
    const ps = new Console(buildReferenceLab())
    const ok = ps.run('Test-NetConnection srv1.lab.local -Port 389', 'PC2').text
    expect(ok).toMatch(/RemotePort\s+: 389/)
    expect(ok).toMatch(/TcpTestSucceeded\s+: True/)
    // Port sans service : échec TCP, le ping est tenté (Learn)
    const closed = ps.run('Test-NetConnection 192.168.10.1 -Port 8080', 'PC2')
    expect(closed.text).toMatch(/TcpTestSucceeded\s+: False/)
    expect(closed.text).toMatch(/PingSucceeded\s+: True/)
    expect(closed.text).toContain('Échec de la connexion TCP à (192.168.10.1 : 8080)')
    // Service arrêté
    ps.run('Stop-Service LanmanServer')
    expect(ps.run('Test-NetConnection 192.168.10.1 -Port 445', 'PC2').text).toMatch(
      /TcpTestSucceeded\s+: False/
    )
    ps.run('Start-Service LanmanServer')
    expect(ps.run('Test-NetConnection 192.168.10.1 -Port 445', 'PC2').text).toMatch(
      /TcpTestSucceeded\s+: True/
    )
    // Règle de pare-feu désactivée sur la cible : le trafic entrant est bloqué
    ps.run('Set-NetFirewallRule -Name FPS-SMB-In-TCP -Enabled False')
    expect(ps.run('Test-NetConnection 192.168.10.1 -Port 445', 'PC2').text).toMatch(
      /TcpTestSucceeded\s+: False/
    )
  })
})

describe('Test-NetConnection -Port à travers une liste d’accès IOS', () => {
  it('deny tcp … eq www sur R1 : TcpTestSucceeded False, ping toujours possible', () => {
    // PC1 (192.168.1.10) — R1 — SRV1 (192.168.2.10, IIS), comme tests/engine/ios/acl.test.ts
    const r1 = addIos(createLab(), 'c1921')
    const pc1 = add(r1.state, 'client')
    const srv = add(pc1.state, 'server')
    let s = cable(srv.state, pc1.id, 0, r1.id, 0)
    s = cable(s, srv.id, 0, r1.id, 1)
    s = setIp(s, pc1.id, 0, '192.168.1.10/24', '192.168.1.1')
    s = setIp(s, srv.id, 0, '192.168.2.10/24', '192.168.2.1')
    s = unwrap(installFeatures(s, srv.id, ['Web-Server'], { includeManagementTools: true })).state
    const lab: SharedLab = { state: s }
    const c = new IosConsole(lab, r1.id)
    c.lines('en', 'conf t', 'int g0/0', 'ip address 192.168.1.1 255.255.255.0', 'no shut')
    c.lines('int g0/1', 'ip address 192.168.2.1 255.255.255.0', 'no shut', 'end')
    const tnc = () => run(lab.state, pc1.id, 'Test-NetConnection 192.168.2.10 -Port 80').text
    expect(tnc()).toMatch(/TcpTestSucceeded\s+: True/)
    c.lines(
      'conf t',
      'access-list 110 deny tcp any host 192.168.2.10 eq www',
      'access-list 110 permit ip any any',
      'int g0/0',
      'ip access-group 110 in',
      'end'
    )
    const blocked = tnc()
    expect(blocked).toMatch(/TcpTestSucceeded\s+: False/)
    expect(blocked).toMatch(/PingSucceeded\s+: True/)
  })
})

describe('Set-DnsClientServerAddress, Remove-NetIPAddress, Disable/Enable-NetAdapter', () => {
  it('Set-DnsClientServerAddress : serveur DNS invalide → résolution impossible ; rétabli', () => {
    const ps = new Console(buildReferenceLab())
    ps.run('Set-DnsClientServerAddress -InterfaceIndex 4 -ServerAddresses 192.168.10.99', 'PC2')
    expect(ps.run('Get-DnsClientServerAddress', 'PC2').text).toContain('192.168.10.99')
    expect(ps.run('Resolve-DnsName srv1.lab.local', 'PC2').errors).not.toBe('')
    ps.run('Set-DnsClientServerAddress -InterfaceIndex 4 -ServerAddresses 192.168.10.1', 'PC2')
    expect(ps.run('Resolve-DnsName srv1.lab.local', 'PC2').errors).toBe('')
  })
  it('Remove-NetIPAddress : plus d’adresse, plus de ping', () => {
    const ps = new Console(buildReferenceLab())
    ps.run('Remove-NetIPAddress -IPAddress 192.168.10.20 -Confirm:$false', 'PC2')
    expect(ps.run('Get-NetIPAddress', 'PC2').text).not.toContain('192.168.10.20')
    expect(ps.run('ping 192.168.10.20', 'SRV1', 'cmd').text).not.toContain('Réponse de 192.168.10.20')
  })
  it('Disable-NetAdapter : confirmation (Learn, exemple 4), -Confirm:$False, Enable-NetAdapter', () => {
    const ps = new Console(buildReferenceLab())
    const name = ps.state.devices[id(ps.state, 'PC2')]?.interfaces[0]?.name ?? ''
    const r = ps.run(`Disable-NetAdapter -Name "${name}"`, 'PC2', 'powershell', ['N'])
    expect(r.text).toContain('Voulez-vous vraiment effectuer cette action ?')
    expect((ps.state.devices[id(ps.state, 'PC2')] as HostDevice).interfaces[0]?.enabled).toBe(true)
    ps.run('Disable-NetAdapter -Name "*" -Confirm:$False', 'PC2')
    expect((ps.state.devices[id(ps.state, 'PC2')] as HostDevice).interfaces[0]?.enabled).toBe(false)
    expect(ps.run('ping 192.168.10.20', 'SRV1', 'cmd').text).not.toContain('Réponse de 192.168.10.20')
    expect(ps.run('Get-NetAdapter', 'PC2').text).toMatch(/Disabled|Down/)
    ps.run(`Enable-NetAdapter -Name "${name}"`, 'PC2')
    expect(ps.run('ping 192.168.10.20', 'SRV1', 'cmd').text).toContain('Réponse de 192.168.10.20')
    expect(ps.run('Disable-NetAdapter -Name Absente -Confirm:$False', 'PC2').errors).toContain(
      'MSFT_NetAdapter'
    )
  })
})

describe('Get-EventLog, Get-ComputerInfo, Test-ComputerSecureChannel, Restart-Computer', () => {
  it('Get-EventLog -LogName System -Newest, -Source, -InstanceId, -EntryType, -List', () => {
    const ps = new Console(buildReferenceLab())
    ps.run('Stop-Service DNS')
    const out = ps.run('Get-EventLog -LogName System -Newest 1').text
    expect(out).toMatch(/^Index\s+Time\s+EntryType\s+Source\s+InstanceID\s+Message$/m)
    expect(out).toMatch(
      /Information\s+Service Control Manager\s+7036\s+Le service Serveur DNS est entré dans l’état : arrêté\./
    )
    expect(ps.run('Get-EventLog System -Source "Service Control*" -InstanceId 7036').text).toContain('7036')
    expect(ps.run('Get-EventLog -LogName System -EntryType Error').errors).toContain('Aucune correspondance')
    expect(ps.run('Get-EventLog -List').text).toMatch(/\d+\s+System/)
    expect(ps.run('Get-EventLog -LogName Bidon').errors).toContain('n’existe pas')
  })
  it('Get-ComputerInfo : propriétés calculées, -Property avec caractères génériques', () => {
    const ps = new Console(buildReferenceLab())
    const out = ps.run('Get-ComputerInfo').text
    expect(out).toMatch(/CsName\s+: SRV1/)
    expect(out).toMatch(/CsDomain\s+: lab\.local/)
    expect(out).toMatch(/CsDomainRole\s+: PrimaryDomainController/)
    expect(ps.run('Get-ComputerInfo', 'PC1').text).toMatch(/CsDomainRole\s+: MemberWorkstation/)
    expect(ps.run('Get-ComputerInfo', 'PC2').text).toMatch(/CsDomainRole\s+: StandaloneWorkstation/)
    const cs = ps.run('Get-ComputerInfo -Property "Cs*"').text
    expect(cs).toContain('CsName')
    expect(cs).not.toContain('OsName')
  })
  it('Test-ComputerSecureChannel : True ; compte recréé → False ; -Repair → True ; hors domaine → erreur', () => {
    const ps = new Console(buildReferenceLab())
    expect(ps.run('Test-ComputerSecureChannel', 'PC1').text.trim()).toBe('True')
    expect(ps.run('Test-ComputerSecureChannel -Verbose', 'PC1').text).toContain('fonctionne correctement')
    // Compte d'ordinateur supprimé puis recréé (New-ADComputer) : canal rompu
    const domain = ps.state.domains['lab.local']
    const account = domain?.computers.find((c) => c.name === 'PC1')
    const del = dispatch(ps.state, command('adds.removeObject', 'lab.local', account?.id ?? ''))
    if (!del.ok) throw new Error(del.error.message)
    ps.state = del.state
    expect(ps.run('Test-ComputerSecureChannel', 'PC1').text.trim()).toBe('False')
    ps.run('New-ADComputer -Name PC1')
    expect(ps.run('Test-ComputerSecureChannel', 'PC1').text.trim()).toBe('False')
    expect(ps.run('Test-ComputerSecureChannel -Repair', 'PC1').text.trim()).toBe('True')
    expect(ps.run('Test-ComputerSecureChannel', 'PC1').text.trim()).toBe('True')
    expect(ps.run('Test-ComputerSecureChannel', 'PC2').errors).toContain('n’est pas joint à un domaine')
  })
  it('Restart-Computer -ComputerName : ordinateur du domaine redémarré ; inconnu → erreur', () => {
    const ps = new Console(buildReferenceLab())
    const before = (ps.state.devices[id(ps.state, 'PC1')] as HostDevice).host.bootedAt
    ps.run('Restart-Computer -ComputerName PC1 -Force')
    expect((ps.state.devices[id(ps.state, 'PC1')] as HostDevice).host.bootedAt).toBeGreaterThan(before)
    expect(ps.run('Restart-Computer -ComputerName INCONNU').errors).toContain('RPC')
    expect(ps.run('Restart-Computer -ComputerName SRV1', 'PC2').errors).toContain('Accès refusé')
  })
})
