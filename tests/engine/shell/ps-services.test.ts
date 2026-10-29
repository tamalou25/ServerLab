/**
 * Services système (v2.7, Lot 2a) : état démarré / arrêté et type de démarrage dans le moteur,
 * Get-Service, Start/Stop/Restart/Set-Service, net start / net stop, sc query|start|stop|config.
 *
 * Sources Microsoft Learn (PowerShell 5.1, microsoft.powershell.management) :
 * - Get-Service : https://learn.microsoft.com/powershell/module/microsoft.powershell.management/get-service?view=powershell-5.1
 *   « The default display shows the status, service name, and display name of each service » ;
 *   exemple de sortie « Status   Name               DisplayName » (golden ci-dessous) ;
 *   « Status is an enumeration, in which Stopped has a value of 1, and Running has a value of 4 » ;
 *   tri croissant par Status : Stopped avant Running ; exemple 11 « "WinRM" | Get-Service ».
 * - Set-Service : -StartupType Automatic | Manual | Disabled (« Disabled - The service is disabled
 *   and cannot be started by a user or application » ; Boot / System : pilotes seulement) ;
 *   -Status Running | Stopped | Paused ; exemple « Set-Service -Name WinRM -Status Running -PassThru ».
 * - Start-Service, exemple 4 « Start a disabled service » : échec, puis Set-Service -StartupType
 *   manual et le démarrage réussit.
 * - Start-Service / Stop-Service : aucune sortie sans -PassThru.
 * - net stop (bb490715) : « You cannot stop or pause the DHCP Client service » ; « Stopping the
 *   Server service prevents users from gaining access to the computer's shared resources ».
 * - sc.exe query (fr-fr) : state= active (défaut), inactive, all ; sc.exe config start= auto |
 *   demand | disabled | delayed-auto.
 */
import { describe, expect, it } from 'vitest'
import { command, dispatch, type HostDevice, type LabState } from '@engine/index'
import { buildReferenceLab } from '../serialization/reference-lab'
import { run, type RunResult } from './helpers'

const id = (s: LabState, name: string) => Object.values(s.devices).find((d) => d.name === name)?.id ?? ''

class Console {
  constructor(
    public state: LabState,
    private readonly host = 'SRV1',
    private readonly shell: 'powershell' | 'cmd' = 'powershell'
  ) {}
  run(line: string, on = this.host, shell = this.shell): RunResult {
    const r = run(this.state, id(this.state, on), line, { shell })
    this.state = r.state
    return r
  }
}

const services = (s: LabState, name = 'SRV1') => (s.devices[id(s, name)] as HostDevice).host.services

describe('Get-Service', () => {
  it('affichage par défaut : colonnes Status / Name / DisplayName (golden Learn)', () => {
    const ps = new Console(buildReferenceLab())
    const lines = ps.run('Get-Service DNS, Netlogon').text.split('\n')
    // Mise en page de l'exemple Learn (largeurs 8, 18, 38)
    expect(lines.slice(0, 5)).toEqual([
      '',
      'Status   Name               DisplayName',
      '------   ----               -----------',
      'Running  DNS                Serveur DNS',
      'Running  Netlogon           Ouverture de session réseau'
    ])
  })
  it('services des rôles installés (DNS, DHCPServer, NTDS, Netlogon, LanmanServer) ; W32Time arrêté (lab)', () => {
    const ps = new Console(buildReferenceLab())
    const out = ps.run('Get-Service').text
    for (const name of ['DNS', 'DHCPServer', 'NTDS', 'Netlogon', 'LanmanServer'])
      expect(out).toMatch(new RegExp(`^Running\\s+${name}\\s`, 'm'))
    expect(out).toMatch(/^Stopped\s+W32Time\s+Temps Windows$/m)
    // Poste client : ni DNS ni NTDS
    const pc = ps.run('Get-Service', 'PC2').text
    expect(pc).not.toMatch(/^\w+\s+DNS\s/m)
    expect(pc).toMatch(/^Running\s+LanmanServer\s/m)
  })
  it('caractères génériques, -DisplayName, pipeline de noms, -Exclude', () => {
    const ps = new Console(buildReferenceLab())
    expect(ps.run('Get-Service Lanman*').text).toMatch(/LanmanServer[\s\S]*LanmanWorkstation/)
    expect(ps.run("Get-Service -DisplayName 'Serveur D*'").text).toMatch(/DHCPServer[\s\S]*DNS/)
    expect(ps.run('"DNS" | Get-Service').text).toMatch(/^Running\s+DNS\s/m)
    expect(ps.run('Get-Service Lanman* -Exclude *Server').text).not.toContain('LanmanServer')
  })
  it('propriétés : Status et StartType (énumérations), tri par valeur (Stopped avant Running)', () => {
    const ps = new Console(buildReferenceLab())
    expect(ps.run('(Get-Service DNS).Status').text.trim()).toBe('Running')
    expect(ps.run('(Get-Service DNS).StartType').text.trim()).toBe('Automatic')
    ps.run('Stop-Service W32Time')
    const sorted = ps.run('Get-Service DNS, W32Time | Sort-Object Status').text
    expect(sorted.indexOf('W32Time')).toBeLessThan(sorted.indexOf('DNS '))
    expect(ps.run("Get-Service | Where-Object {$_.Status -eq 'Stopped'}").text).toMatch(
      /^Stopped\s+W32Time\s/m
    )
  })
  it('erreurs : service introuvable, -ComputerName distant non simulé', () => {
    const ps = new Console(buildReferenceLab())
    const err = ps.run('Get-Service Inexistant').errors
    expect(err).toContain('Impossible de trouver un service assorti du nom « Inexistant »')
    expect(err).toContain('NoServiceFoundForGivenName')
    // Caractère générique sans correspondance : aucune erreur
    expect(ps.run('Get-Service Zz*').errors).toBe('')
    expect(ps.run('Get-Service -ComputerName SRV9').errors).toContain('n’est pas simulé')
    expect(ps.run('Get-Service -ComputerName localhost DNS').errors).toBe('')
    // -RequiredServices est calculé (v2.8) ; un service absent du modèle reste introuvable
    expect(ps.run('Get-Service WinRM -RequiredServices').errors).toContain('Impossible de trouver un service')
  })
})

describe('Start-Service, Stop-Service, Restart-Service, Set-Service', () => {
  it('Stop-Service puis Start-Service : aucune sortie sans -PassThru, état dans le moteur', () => {
    const ps = new Console(buildReferenceLab())
    const stop = ps.run('Stop-Service -Name DNS')
    expect(stop.text.trim()).toBe('')
    expect(services(ps.state)['DNS']).toEqual({ status: 'Stopped', startType: 'Automatic' })
    expect(ps.run('Get-Service DNS').text).toMatch(/^Stopped\s+DNS\s+Serveur DNS$/m)
    expect(ps.run('Start-Service DNS -PassThru').text).toMatch(/^Running\s+DNS\s/m)
    // Retour à l'état par défaut : rien n'est stocké
    expect(services(ps.state)['DNS']).toBeUndefined()
  })
  it('pipeline Get-Service | Stop-Service, Restart-Service, journal 7036', () => {
    const ps = new Console(buildReferenceLab())
    ps.run('Get-Service DHCPServer | Stop-Service')
    expect(services(ps.state)['DHCPServer']?.status).toBe('Stopped')
    ps.run('Restart-Service DHCPServer')
    expect(services(ps.state)['DHCPServer']).toBeUndefined()
    const log = (ps.state.devices[id(ps.state, 'SRV1')] as HostDevice).host.eventLog
    expect(log.filter((e) => e.eventId === 7036).map((e) => e.message)).toContain(
      'Le service Serveur DHCP est entré dans l’état : arrêté.'
    )
  })
  it('Set-Service -StartupType Disabled : Start-Service échoue ; Manual : le démarrage réussit (Learn, exemple 4)', () => {
    const ps = new Console(buildReferenceLab())
    ps.run('Stop-Service W32Time')
    ps.run('Set-Service W32Time -StartupType Disabled')
    expect(ps.run('(Get-Service W32Time).StartType').text.trim()).toBe('Disabled')
    const err = ps.run('Start-Service W32Time').errors
    expect(err).toContain('Le service « Temps Windows (W32Time) » ne peut pas être démarré')
    expect(err).toContain('CouldNotStartService')
    ps.run('Set-Service W32Time -StartupType Manual')
    expect(ps.run('Start-Service W32Time').errors).toBe('')
    expect(services(ps.state)['W32Time']).toEqual({ status: 'Running', startType: 'Manual' })
  })
  it('Set-Service -Status Stopped / Running -PassThru ; Paused et Boot refusés', () => {
    const ps = new Console(buildReferenceLab())
    expect(
      ps.run('Stop-Service Netlogon; Set-Service -Name LanmanServer -Status Stopped -PassThru').text
    ).toMatch(/^Stopped\s+LanmanServer\s+Serveur$/m)
    expect(ps.run('Set-Service LanmanServer -Status Running').errors).toBe('')
    expect(ps.run('Set-Service DNS -Status Paused').errors).toContain('n’est pas simulée')
    expect(ps.run('Set-Service DNS -StartupType Boot').errors).toContain('pilotes')
    expect(ps.run('Set-Service DNS -StartupType Bidon').errors).not.toBe('')
  })
  it('le Client DHCP ne peut pas être arrêté (Learn, net stop)', () => {
    const ps = new Console(buildReferenceLab())
    expect(ps.run('Stop-Service Dhcp').errors).toContain('ne peut pas être arrêté')
    expect(ps.run('net stop dhcp', 'SRV1', 'cmd').errors).toContain('NET HELPMSG 2191')
  })
  it('redémarrage : Automatic redémarre, Manual reste arrêté', () => {
    const ps = new Console(buildReferenceLab())
    ps.run('Stop-Service DNS')
    ps.run('Set-Service W32Time -StartupType Manual')
    ps.run('Restart-Computer -Force')
    expect(services(ps.state)['DNS']).toBeUndefined()
    expect(services(ps.state)['W32Time']).toEqual({ status: 'Stopped', startType: 'Manual' })
  })
  it('commandes nommées de l’interface (service.stop, service.setStartType) : même état que la console', () => {
    let s = buildReferenceLab()
    const srv = id(s, 'SRV1')
    const r = dispatch(s, command('service.stop', srv, 'DNS'))
    expect(r.ok).toBe(true)
    if (r.ok) s = r.state
    const t = dispatch(s, command('service.setStartType', srv, 'DNS', 'Manual'))
    if (t.ok) s = t.state
    expect(services(s)['DNS']).toEqual({ status: 'Stopped', startType: 'Manual' })
    expect(new Console(s).run('Get-Service DNS').text).toMatch(/^Stopped\s+DNS\s/m)
  })
})

describe('net start / net stop, sc', () => {
  it('net stop puis net start : messages, liste des services démarrés', () => {
    const cmd = new Console(buildReferenceLab(), 'SRV1', 'cmd')
    expect(cmd.run('net stop "Serveur DNS"').text).toContain('Le service Serveur DNS a été arrêté.')
    expect(cmd.run('net stop DNS').errors).toContain('NET HELPMSG 3521')
    expect(cmd.run('net start').text).not.toContain('   Serveur DNS')
    expect(cmd.run('net start DNS').text).toContain('Le service Serveur DNS a démarré.')
    expect(cmd.run('net start DNS').errors).toContain('NET HELPMSG 2182')
  })
  it('sc stop / query state= / start / config start= disabled', () => {
    const cmd = new Console(buildReferenceLab(), 'SRV1', 'cmd')
    expect(cmd.run('sc stop DNS').text).toContain('3  STOP_PENDING')
    expect(cmd.run('sc query DNS').text).toContain('1  STOPPED')
    expect(cmd.run('sc query').text).not.toContain('NOM_SERVICE: DNS')
    expect(cmd.run('sc query state= inactive').text).toContain('NOM_SERVICE: DNS')
    expect(cmd.run('sc query state= all').text).toContain('NOM_SERVICE: NTDS')
    expect(cmd.run('sc stop DNS').errors).toContain('1062')
    expect(cmd.run('sc config DNS start= disabled').text).toContain('ChangeServiceConfig réussite(s)')
    expect(cmd.run('sc start DNS').errors).toContain('1058')
    expect(cmd.run('sc config DNS start= demand').errors).toBe('')
    expect(cmd.run('sc start DNS').text).toContain('2  START_PENDING')
    expect(services(cmd.state)['DNS']).toEqual({ status: 'Running', startType: 'Manual' })
    expect(cmd.run('sc config DNS start= boot').errors).toContain('n’est pas simulée')
  })
  it('tasklist : dns.exe disparaît quand le service DNS est arrêté', () => {
    const cmd = new Console(buildReferenceLab(), 'SRV1', 'cmd')
    expect(cmd.run('tasklist').text).toContain('dns.exe')
    cmd.run('net stop dns')
    expect(cmd.run('tasklist').text).not.toContain('dns.exe')
  })
})

describe('effets de l’arrêt des services sur la simulation (bout en bout)', () => {
  it('DNS arrêté : nslookup, Resolve-DnsName et ping par nom échouent depuis PC2', () => {
    const lab = new Console(buildReferenceLab())
    expect(lab.run('nslookup srv1.lab.local', 'PC2', 'cmd').text).toContain('192.168.10.1')
    expect(lab.run('ping srv1.lab.local', 'PC2', 'cmd').text).toContain('Réponse de 192.168.10.1')
    lab.run('Stop-Service DNS')
    const ns = lab.run('nslookup srv1.lab.local', 'PC2', 'cmd')
    expect(ns.text).toContain('DNS request timed out.')
    expect(ns.text).not.toMatch(/Nom\s*:\s+srv1\.lab\.local/)
    expect(lab.run('Resolve-DnsName srv1.lab.local', 'PC2').errors).not.toBe('')
    expect(lab.run('ping srv1.lab.local', 'PC2', 'cmd').text).not.toContain('Réponse de 192.168.10.1')
    // Par adresse : le réseau fonctionne toujours
    expect(lab.run('ping 192.168.10.1', 'PC2', 'cmd').text).toContain('Réponse de 192.168.10.1')
    // Le service redémarré, la résolution revient
    lab.run('Start-Service DNS')
    expect(lab.run('ping srv1.lab.local', 'PC2', 'cmd').text).toContain('Réponse de 192.168.10.1')
  })
  it('DHCPServer arrêté : PC1 n’obtient plus de bail ; redémarré : bail obtenu', () => {
    const lab = new Console(buildReferenceLab())
    lab.run('ipconfig /release', 'PC1', 'cmd')
    lab.run('Stop-Service DHCPServer')
    lab.run('ipconfig /renew', 'PC1', 'cmd')
    const pc1 = () => lab.state.devices[id(lab.state, 'PC1')] as HostDevice
    expect(pc1().interfaces[0]?.dhcpLease ?? null).toBeNull()
    lab.run('Start-Service DHCPServer')
    lab.run('ipconfig /renew', 'PC1', 'cmd')
    expect(pc1().interfaces[0]?.dhcpLease?.address).toMatch(/^192\.168\.10\./)
  })
  it('LanmanServer arrêté : le partage n’est plus accessible (erreur 53)', () => {
    const lab = new Console(buildReferenceLab())
    lab.run('New-Item -Path C:\\Compta -ItemType Directory')
    lab.run("New-SmbShare -Name Compta -Path C:\\Compta -FullAccess 'Tout le monde'")
    expect(lab.run('dir \\\\SRV1\\Compta', 'SRV1', 'cmd').errors).toBe('')
    lab.run('net stop Netlogon', 'SRV1', 'cmd')
    lab.run('net stop LanmanServer', 'SRV1', 'cmd')
    expect(services(lab.state)['LanmanServer']?.status).toBe('Stopped')
    expect(lab.run('dir \\\\SRV1\\Compta', 'SRV1', 'cmd').errors).toContain('chemin réseau')
    lab.run('Start-Service LanmanServer')
    expect(lab.run('dir \\\\SRV1\\Compta', 'SRV1', 'cmd').errors).toBe('')
  })
})
