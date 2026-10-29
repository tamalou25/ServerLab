/**
 * Autres services (v2.8, chantier A, issue #222) : CertSvc, TermService, WsusService, MpsSvc et
 * Spooler. Pour chacun : arrêt (commande nommée) → effet sur le reste du lab → redémarrage → guérison.
 */
import { describe, expect, it } from 'vitest'
import {
  adcsOf,
  command,
  computerServices,
  dispatch,
  evaluateCheck,
  installFeatures,
  ping,
  rdpConnect,
  unwrap,
  wsusClientStatus,
  wsusComputers,
  type AnyCommand,
  type HostDevice,
  type LabState
} from '@engine/index'
import { certSvcStoppedMessage } from '../../../src/engine/roles/adcs/actions'
import { wsusServiceStoppedMessage } from '../../../src/engine/roles/wsus/client'
import { listeningPorts } from '../../../src/engine/services/listening'
import { RDP_UNREACHABLE } from '../../../src/engine/roles/rds/connect'
import { expectGolden } from '../golden/golden'
import { buildReferenceLab } from '../serialization/reference-lab'
import { run } from '../shell/helpers'

const D = 'lab.local'
const id = (s: LabState, name: string) => Object.values(s.devices).find((d) => d.name === name)?.id ?? ''
const host = (s: LabState, name: string) => s.devices[id(s, name)] as HostDevice

function exec(state: LabState, ...cmds: AnyCommand[]): LabState {
  let s = state
  for (const cmd of cmds) {
    const r = dispatch(s, cmd)
    if (!r.ok) throw new Error(`${cmd.type} : ${r.error.message}`)
    s = r.state
  }
  return s
}
const stop = (s: LabState, name: string, service: string) =>
  exec(s, command('service.stop', id(s, name), service))
const start = (s: LabState, name: string, service: string) =>
  exec(s, command('service.start', id(s, name), service))
const myCerts = (s: LabState, name: string) => host(s, name).host.certificates.filter((c) => c.store === 'My')

describe('CertSvc arrêté : plus de délivrance de certificats', () => {
  /** SRV1 (contrôleur de domaine) : autorité racine d'entreprise. */
  function caLab(): LabState {
    let s = buildReferenceLab()
    const srv = id(s, 'SRV1')
    s = unwrap(installFeatures(s, srv, ['ADCS-Cert-Authority'], { includeManagementTools: true })).state
    return exec(s, command('adcs.install', srv, {}))
  }
  const request = (s: LabState) => dispatch(s, command('adcs.request', id(s, 'PC1'), { template: 'Machine' }))

  it('arrêt, demande refusée, redémarrage, guérison', () => {
    const s = caLab()
    const first = request(s)
    expect(first.ok).toBe(true)

    const down = stop(unwrap(first).state, 'SRV1', 'CertSvc')
    const refused = request(down)
    expect(refused.ok).toBe(false)
    expect(!refused.ok && refused.error.message).toBe(certSvcStoppedMessage('LAB-SRV1-CA'))
    const cmdlet = run(down, id(down, 'PC1'), 'Get-Certificate -Template Machine')
    expect(cmdlet.errors).toContain('RPC_S_SERVER_UNAVAILABLE')
    expect(cmdlet.state).toEqual(down)
    expectGolden(certSvcStoppedMessage('LAB-SRV1-CA'), 'ps/certsvc-arrete')
    expect(
      evaluateCheck(down, { type: 'serviceState', device: 'SRV1', name: 'CertSvc', running: false })
    ).toBe(true)

    // La révocation sur l'autorité passe par le même service
    const serial = adcsOf(down.devices[id(down, 'SRV1')])!.issued[0]!.serial
    const revoke = dispatch(down, command('adcs.revoke', id(down, 'SRV1'), serial, 'Unspecified'))
    expect(revoke.ok).toBe(false)

    const up = start(down, 'SRV1', 'CertSvc')
    expect(request(up).ok).toBe(true)
    expect(dispatch(up, command('adcs.revoke', id(up, 'SRV1'), serial, 'Unspecified')).ok).toBe(true)
  })

  it('l’inscription automatique est suspendue pendant la panne, puis reprend', () => {
    let s = caLab()
    s = exec(s, command('gpo.createAndLink', D, { name: 'Auto' }, null))
    const gpo = s.domains[D]!.gpos.find((g) => g.name === 'Auto')!
    s = exec(s, command('gpo.updateSettings', D, gpo.id, { computer: { autoEnrollment: 'Enabled' } }))
    const down = run(stop(s, 'SRV1', 'CertSvc'), id(s, 'PC1'), 'gpupdate /force', { shell: 'cmd' }).state
    expect(myCerts(down, 'PC1')).toHaveLength(0)
    const up = run(start(down, 'SRV1', 'CertSvc'), id(s, 'PC1'), 'gpupdate /force', { shell: 'cmd' }).state
    expect(myCerts(up, 'PC1')).toHaveLength(1)
  })
})

describe('TermService arrêté : Bureau à distance refusé', () => {
  function rdpLab(): LabState {
    let s = buildReferenceLab()
    s = exec(s, command('rds.setRemoteDesktop', id(s, 'SRV1'), { enabled: true }))
    return s
  }
  const connect = (s: LabState) =>
    rdpConnect(s, id(s, 'PC1'), {
      computer: 'srv1.lab.local',
      user: 'LAB\\Administrateur',
      password: 'P@ssw0rd'
    })
  const rdpListens = (s: LabState) =>
    listeningPorts(host(s, 'SRV1')).some((p) => p.protocol === 'TCP' && p.port === 3389)

  it('arrêt : connexion refusée et port 3389 fermé ; redémarrage : tout revient', () => {
    const s = rdpLab()
    expect(connect(s).ok).toBe(true)
    expect(rdpListens(s)).toBe(true)
    expect(run(s, id(s, 'PC1'), 'Test-NetConnection srv1.lab.local -Port 3389').text).toMatch(
      /TcpTestSucceeded\s*:\s*True/
    )

    const down = stop(s, 'SRV1', 'TermService')
    const refused = connect(down)
    expect(refused.ok).toBe(false)
    expect(refused.message).toBe(RDP_UNREACHABLE)
    expect(rdpListens(down)).toBe(false)
    expect(run(down, id(down, 'PC1'), 'Test-NetConnection srv1.lab.local -Port 3389').text).toMatch(
      /TcpTestSucceeded\s*:\s*False/
    )
    // Le réglage « connexions à distance autorisées » n'est pas modifié
    expect(host(down, 'SRV1').host.remoteDesktop.enabled).toBe(true)

    const up = start(down, 'SRV1', 'TermService')
    expect(rdpListens(up)).toBe(true)
    expect(connect(up).ok).toBe(true)
  })
})

describe('WsusService arrêté : les clients ne remontent plus', () => {
  /** SRV1 avec WSUS synchronisé, PC1 client par stratégie, mise à jour approuvée pour tous. */
  function wsusLab(): LabState {
    let s = buildReferenceLab()
    const srv = id(s, 'SRV1')
    s = unwrap(installFeatures(s, srv, ['UpdateServices'], { includeManagementTools: true })).state
    s = exec(
      s,
      command('wsus.postInstall', srv, 'C:\\WSUS'),
      command('wsus.synchronize', srv),
      command('wsus.approve', srv, 'KB9100201', 'Ordinateurs non attribués', true),
      command('gpo.createAndLink', D, { name: 'WSUS' }, null)
    )
    const gpo = s.domains[D]!.gpos.find((g) => g.name === 'WSUS')!
    s = exec(
      s,
      command('gpo.updateSettings', D, gpo.id, {
        computer: { wuServer: { state: 'Enabled', url: 'http://srv1.lab.local:8530' } }
      })
    )
    return run(s, id(s, 'PC1'), 'gpupdate /force', { shell: 'cmd' }).state
  }
  const received = { type: 'wsusClientUpdate', client: 'PC1', update: 'KB9100201', received: true } as const

  it('arrêt : client en erreur, plus listé, synchronisation refusée ; redémarrage : guérison', () => {
    const s = wsusLab()
    const srv = id(s, 'SRV1')
    expect(wsusClientStatus(s, id(s, 'PC1')).kind).toBe('ok')
    expect(wsusComputers(s, srv)).toHaveLength(1)
    expect(evaluateCheck(s, received)).toBe(true)

    const down = stop(s, 'SRV1', 'WsusService')
    const status = wsusClientStatus(down, id(down, 'PC1'))
    expect(status.kind === 'error' && status.message).toBe(wsusServiceStoppedMessage('SRV1'))
    expect(wsusComputers(down, srv)).toEqual([])
    expect(evaluateCheck(down, received)).toBe(false)
    const sync = dispatch(down, command('wsus.synchronize', srv))
    expect(!sync.ok && sync.error.message).toBe(wsusServiceStoppedMessage('SRV1'))
    expectGolden(wsusServiceStoppedMessage('SRV1'), 'ps/wsusservice-arrete')

    const up = start(down, 'SRV1', 'WsusService')
    expect(wsusClientStatus(up, id(up, 'PC1')).kind).toBe('ok')
    expect(wsusComputers(up, srv)).toHaveLength(1)
    expect(evaluateCheck(up, received)).toBe(true)
    expect(dispatch(up, command('wsus.synchronize', srv)).ok).toBe(true)
  })
})

describe('MpsSvc arrêté : le pare-feu ne filtre plus', () => {
  const pingOk = (s: LabState, from: string, to: string) => {
    const r = ping(s, id(s, from), to, { count: 1 })
    return r.ok && r.value.success
  }

  it('arrêt : règle de blocage sans effet, redémarrage : le filtrage revient', () => {
    let s = buildReferenceLab()
    const srv = id(s, 'SRV1')
    s = exec(s, command('firewall.setRuleEnabled', srv, { name: 'FPS-ICMP4-ERQ-In' }, false))
    expect(pingOk(s, 'PC1', '192.168.10.1')).toBe(false)

    const down = stop(s, 'SRV1', 'MpsSvc')
    expect(pingOk(down, 'PC1', '192.168.10.1')).toBe(true)
    // Les règles restent configurées, seul leur effet disparaît
    expect(host(down, 'SRV1').host.firewall.predefined['FPS-ICMP4-ERQ-In']).toBe(false)

    const up = start(down, 'SRV1', 'MpsSvc')
    expect(pingOk(up, 'PC1', '192.168.10.1')).toBe(false)
  })
})

describe('Spooler : présent partout, sans effet de rôle', () => {
  it('listé sur un serveur et un poste, nom affiché et démarrage automatique', () => {
    const s = buildReferenceLab()
    for (const name of ['SRV1', 'PC1']) {
      const spooler = computerServices(s, id(s, name)).find((x) => x.name === 'Spooler')
      expect(spooler).toMatchObject({
        display: 'Spouleur d’impression',
        status: 'Running',
        startType: 'Automatic'
      })
      expect(spooler?.role).toBeUndefined()
    }
    expect(run(s, id(s, 'PC1'), 'Get-Service Spooler').text).toContain('Spouleur d’impression')
    expect(run(s, id(s, 'PC1'), 'sc query Spooler', { shell: 'cmd' }).text).toContain('Spooler')
  })

  it('arrêt, démarrage et état par défaut non stocké dans le fichier', () => {
    const s = buildReferenceLab()
    const down = stop(s, 'PC1', 'Spooler')
    expect(host(down, 'PC1').host.services['Spooler']).toMatchObject({ status: 'Stopped' })
    expect(run(down, id(down, 'PC1'), 'Get-Service Spooler').text).toMatch(/Stopped/)
    const up = start(down, 'PC1', 'Spooler')
    expect(host(up, 'PC1').host.services['Spooler']).toBeUndefined()
    expect(host(s, 'PC1').host.services['Spooler']).toBeUndefined()
  })
})
