/**
 * Dépendances entre services (v2.8, chantier A, issue #223).
 *
 * Sources Microsoft Learn :
 * - Stop-Service, -Force : « Forces the cmdlet to stop a service even if that service has dependent
 *   services » (https://learn.microsoft.com/powershell/module/microsoft.powershell.management/stop-service?view=powershell-5.1).
 * - Get-Service -DependentServices / -RequiredServices (propriété ServicesDependedOn), exemple 7
 *   (https://learn.microsoft.com/powershell/module/microsoft.powershell.management/get-service?view=powershell-5.1).
 * - IIS : « net stop WAS … stop W3SVC as well », « net start W3SVC … start both WAS and W3SVC »
 *   (https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-server-2012-r2-and-2012/jj635851(v=ws.11)).
 * - Netlogon : dépendances LanmanWorkstation et LanmanServer sur un contrôleur de domaine
 *   (https://learn.microsoft.com/en-us/troubleshoot/windows-server/windows-security/troubleshoot-netlogon-service-startup-failures).
 * - Codes 1051 et 1068 (https://learn.microsoft.com/en-us/windows/win32/debug/system-error-codes--1000-1299-).
 */
import { describe, expect, it } from 'vitest'
import {
  command,
  dispatch,
  httpGet,
  installFeatures,
  stopService,
  unwrap,
  type HostDevice,
  type LabState
} from '@engine/index'
import { dependentNames, requiredChain, requiredNames } from '../../../src/engine/services/servicedeps'
import {
  dependentServices,
  disabledDependency,
  requiredServices,
  runningDependents
} from '../../../src/engine/services/hostservices'
import { buildReferenceLab } from '../serialization/reference-lab'
import { run, type RunResult } from '../shell/helpers'

const id = (s: LabState, name: string) => Object.values(s.devices).find((d) => d.name === name)?.id ?? ''

class Console {
  constructor(
    public state: LabState,
    private readonly shell: 'powershell' | 'cmd' = 'powershell'
  ) {}
  run(line: string, shell = this.shell): RunResult {
    const r = run(this.state, id(this.state, 'SRV1'), line, { shell })
    this.state = r.state
    return r
  }
}

/** SRV1 (contrôleur de domaine : Netlogon) avec IIS (W3SVC, WAS). */
function iisLab(): LabState {
  const s = buildReferenceLab()
  return unwrap(installFeatures(s, id(s, 'SRV1'), ['Web-Server'], { includeManagementTools: true })).state
}

/** IIS installé, puis WAS (et W3SVC) arrêtés de force. */
function stopped(): LabState {
  const s = iisLab()
  return unwrap(stopService(s, id(s, 'SRV1'), 'WAS', true)).state
}

const status = (s: LabState, name: string) =>
  ((s.devices[id(s, 'SRV1')] as HostDevice).host.services[name]?.status ?? 'Running') as string

describe('table de dépendances (fonctions pures)', () => {
  const present = ['W3SVC', 'WAS', 'Netlogon', 'LanmanServer', 'LanmanWorkstation', 'DNS']
  it('W3SVC requiert WAS ; Netlogon requiert LanmanWorkstation et LanmanServer', () => {
    expect(requiredNames('w3svc', present)).toEqual(['WAS'])
    expect(requiredNames('Netlogon', present)).toEqual(['LanmanWorkstation', 'LanmanServer'])
    expect(requiredNames('DNS', present)).toEqual([])
  })
  it('un service dépendant d’un rôle absent est ignoré', () => {
    expect(requiredNames('W3SVC', ['W3SVC'])).toEqual([])
    expect(dependentNames('WAS', ['WAS'])).toEqual([])
    expect(requiredNames('Netlogon', ['Netlogon', 'LanmanServer'])).toEqual(['LanmanServer'])
  })
  it('dépendants et chaîne requise', () => {
    expect(dependentNames('WAS', present)).toEqual(['W3SVC'])
    expect(dependentNames('LanmanServer', present)).toEqual(['Netlogon'])
    expect(requiredChain('W3SVC', present)).toEqual(['WAS'])
  })
})

describe('moteur : stopService / startService', () => {
  it('sans IIS, WAS n’existe pas : aucun dépendant', () => {
    const s = buildReferenceLab()
    expect(dependentServices(s, id(s, 'SRV1'), 'LanmanServer').map((x) => x.name)).toEqual(['Netlogon'])
    expect(requiredServices(s, id(s, 'SRV1'), 'W3SVC')).toEqual([])
  })
  it('arrêter WAS sans force échoue ; avec force arrête W3SVC puis WAS', () => {
    const s = iisLab()
    const srv = id(s, 'SRV1')
    expect(runningDependents(s, srv, 'WAS').map((x) => x.name)).toEqual(['W3SVC'])
    const refused = stopService(s, srv, 'WAS')
    expect(refused.ok === false && refused.error.code).toBe('ServiceHasDependents')
    const ok = unwrap(stopService(s, srv, 'WAS', true)).state
    expect(status(ok, 'WAS')).toBe('Stopped')
    expect(status(ok, 'W3SVC')).toBe('Stopped')
    // Un seul évènement 7036 par service arrêté (dépendant d'abord)
    const events = (ok.devices[srv] as HostDevice).host.eventLog.filter((e) => e.eventId === 7036)
    expect(events.slice(-2).map((e) => e.message)).toEqual([
      'Le service Service de publication World Wide Web est entré dans l’état : arrêté.',
      'Le service Service d’activation des processus Windows est entré dans l’état : arrêté.'
    ])
  })
  it('arrêter le dépendant seul ne demande pas -Force', () => {
    const s = iisLab()
    expect(stopService(s, id(s, 'SRV1'), 'W3SVC').ok).toBe(true)
  })
  it('effet sur le lab : couper WAS de force coupe le site web', () => {
    const s = iisLab()
    const pc1 = id(s, 'PC1')
    expect(httpGet(s, pc1, 'http://srv1.lab.local').kind).toBe('response')
    const off = unwrap(stopService(s, id(s, 'SRV1'), 'WAS', true)).state
    expect(httpGet(off, pc1, 'http://srv1.lab.local').kind).toBe('failure')
    // Sans force : refusé, le site répond toujours
    expect(stopService(s, id(s, 'SRV1'), 'WAS').ok).toBe(false)
  })
  it('démarrer W3SVC démarre WAS d’abord', () => {
    let s = stopped()
    expect(status(s, 'WAS')).toBe('Stopped')
    s = unwrap(dispatch(s, command('service.start', id(s, 'SRV1'), 'W3SVC'))).state
    expect(status(s, 'WAS')).toBe('Running')
    expect(status(s, 'W3SVC')).toBe('Running')
  })
  it('dépendance désactivée : le démarrage échoue (1068), rien ne démarre', () => {
    let s = stopped()
    s = unwrap(dispatch(s, command('service.setStartType', id(s, 'SRV1'), 'WAS', 'Disabled'))).state
    expect(disabledDependency(s, id(s, 'SRV1'), 'W3SVC')?.name).toBe('WAS')
    const r = dispatch(s, command('service.start', id(s, 'SRV1'), 'W3SVC'))
    expect(r.ok === false && r.error.code).toBe('ServiceDependencyFailed')
  })
  it('LanmanServer sans force est refusé tant que Netlogon tourne ; commande service.stop avec force', () => {
    const s = buildReferenceLab()
    const srv = id(s, 'SRV1')
    const refused = dispatch(s, command('service.stop', srv, 'LanmanServer'))
    expect(refused.ok === false && refused.error.code).toBe('ServiceHasDependents')
    const forced = unwrap(dispatch(s, command('service.stop', srv, 'LanmanServer', true))).state
    expect(status(forced, 'LanmanServer')).toBe('Stopped')
    expect(status(forced, 'Netlogon')).toBe('Stopped')
  })
  it('restart avec force redémarre les dépendants', () => {
    const s = iisLab()
    const r = unwrap(dispatch(s, command('service.restart', id(s, 'SRV1'), 'WAS', true))).state
    expect(status(r, 'WAS')).toBe('Running')
    expect(status(r, 'W3SVC')).toBe('Running')
    expect(dispatch(s, command('service.restart', id(s, 'SRV1'), 'WAS')).ok).toBe(false)
  })
})

describe('PowerShell', () => {
  it('Stop-Service sans -Force : erreur ServiceHasDependentServices, avec -Force : dépendants arrêtés', () => {
    const ps = new Console(iisLab())
    const r = ps.run('Stop-Service WAS')
    expect(r.errors).toContain(
      'Impossible d’arrêter le service « Service d’activation des processus Windows (WAS) » car il a des services dépendants. Il ne peut être arrêté que si l’indicateur Force est défini.'
    )
    expect(r.errors).toContain('ServiceHasDependentServices')
    expect(status(ps.state, 'WAS')).toBe('Running')
    expect(ps.run('Stop-Service WAS -Force').errors).toBe('')
    expect(status(ps.state, 'WAS')).toBe('Stopped')
    expect(status(ps.state, 'W3SVC')).toBe('Stopped')
  })
  it('Get-Service -DependentServices et -RequiredServices sont calculés (plus de « non simulé »)', () => {
    const ps = new Console(iisLab())
    const dep = ps.run('Get-Service WAS -DependentServices')
    expect(dep.errors).toBe('')
    expect(dep.text).toMatch(/^Running\s+W3SVC\s+Service de publication World Wide Web$/m)
    const req = ps.run('Get-Service W3SVC -RequiredServices')
    expect(req.text).toMatch(/^Running\s+WAS\s/m)
    expect(ps.run('Get-Service Netlogon -RequiredServices').text).toMatch(
      /LanmanWorkstation[\s\S]*LanmanServer/
    )
    expect(ps.run('Get-Service DNS -DependentServices').text.trim()).toBe('')
  })
  it('propriétés DependentServices et ServicesDependedOn (alias -DS, -SDO)', () => {
    const ps = new Console(iisLab())
    expect(ps.run('(Get-Service WAS).DependentServices').text).toMatch(/W3SVC/)
    expect(ps.run('(Get-Service W3SVC).ServicesDependedOn').text).toMatch(/WAS/)
    expect(ps.run('Get-Service WAS -DS').text).toMatch(/W3SVC/)
    expect(ps.run('Get-Service W3SVC -SDO').text).toMatch(/WAS/)
    expect(
      ps.run('Get-Service | Where-Object {$_.DependentServices} | Select-Object -ExpandProperty Name').text
    ).toMatch(/WAS/)
  })
  it('Start-Service W3SVC démarre WAS ; dépendance désactivée : échec CouldNotStartService', () => {
    const ps = new Console(iisLab())
    ps.run('Stop-Service WAS -Force')
    ps.run('Start-Service W3SVC')
    expect(status(ps.state, 'WAS')).toBe('Running')
    ps.run('Stop-Service WAS -Force')
    ps.run('Set-Service WAS -StartupType Disabled')
    const r = ps.run('Start-Service W3SVC')
    expect(r.errors).toContain('Le service ou le groupe de dépendances n’a pas pu démarrer.')
    expect(r.errors).toContain('CouldNotStartService')
    expect(status(ps.state, 'W3SVC')).toBe('Stopped')
  })
  it('Restart-Service -Force redémarre WAS et W3SVC', () => {
    const ps = new Console(iisLab())
    expect(ps.run('Restart-Service WAS').errors).toContain('ServiceHasDependentServices')
    expect(ps.run('Restart-Service WAS -Force').errors).toBe('')
    expect(status(ps.state, 'W3SVC')).toBe('Running')
  })
})

describe('cmd : net start / net stop / sc', () => {
  it('sc stop : erreur 1051 tant que des dépendants tournent', () => {
    const c = new Console(iisLab(), 'cmd')
    const r = c.run('sc stop WAS')
    expect(r.errors).toContain('[SC] ControlService échec(s) 1051 :')
    expect(status(c.state, 'WAS')).toBe('Running')
    c.run('sc stop W3SVC')
    expect(c.run('sc stop WAS').errors).toBe('')
    expect(status(c.state, 'WAS')).toBe('Stopped')
  })
  it('net stop : message honnête (invite non simulée), rien n’est arrêté', () => {
    const c = new Console(iisLab(), 'cmd')
    const r = c.run('net stop WAS')
    expect(r.errors).toContain('n’est pas simulée dans ServerLab')
    expect(r.errors).toContain('Service de publication World Wide Web')
    expect(status(c.state, 'WAS')).toBe('Running')
  })
  it('net start / sc start : dépendance démarrée d’abord, désactivée → erreur 1068', () => {
    const c = new Console(iisLab(), 'cmd')
    c.run('sc stop W3SVC')
    c.run('sc stop WAS')
    c.run('net start W3SVC')
    expect(status(c.state, 'WAS')).toBe('Running')
    c.run('sc stop W3SVC')
    c.run('sc stop WAS')
    c.run('sc config WAS start= disabled')
    const net = c.run('net start W3SVC')
    expect(net.errors).toContain('Erreur système 1068.')
    expect(net.errors).toContain('Le service ou le groupe de dépendances n’a pas pu démarrer.')
    const sc = c.run('sc start W3SVC')
    expect(sc.errors).toContain('[SC] StartService échec(s) 1068 :')
    expect(status(c.state, 'W3SVC')).toBe('Stopped')
  })
})
