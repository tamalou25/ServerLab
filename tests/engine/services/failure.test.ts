/**
 * Échec au démarrage d'un service et options de récupération (v2.8, chantier A, issue #224).
 *
 * Sources Microsoft Learn :
 * - Codes d'erreur système : 1053 ERROR_SERVICE_REQUEST_TIMEOUT, 1066 ERROR_SERVICE_SPECIFIC_ERROR,
 *   1068 ERROR_SERVICE_DEPENDENCY_FAIL (https://learn.microsoft.com/en-us/windows/win32/debug/system-error-codes--1000-1299-).
 * - Évènement 7000 « The Netlogon service failed to start due to the following error: »
 *   (https://learn.microsoft.com/en-us/troubleshoot/windows-server/windows-security/troubleshoot-netlogon-service-startup-failures).
 * - Évènement 7034 « terminated unexpectedly. It has done this X time(s). »
 *   (https://learn.microsoft.com/en-us/troubleshoot/windows-server/system-management-components/error-1053-1067-7034-after-update-openssh-doesnt-start).
 * - sc failure / sc qfailure (https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-xp/bb490995(v=technet.10)).
 */
import { describe, expect, it } from 'vitest'
import {
  applyStatePatches,
  command,
  dispatch,
  httpGet,
  installFeatures,
  parseSlab,
  restartComputer,
  serializeSlab,
  unwrap,
  type HostDevice,
  type LabState
} from '@engine/index'
import { readFixture } from '../serialization/fixtures'
import { buildReferenceLab } from '../serialization/reference-lab'
import { expectGolden } from '../golden/golden'
import { run } from '../shell/helpers'

const id = (s: LabState, name: string) => Object.values(s.devices).find((d) => d.name === name)?.id ?? ''

/** SRV1 (contrôleur de domaine) avec IIS : services W3SVC et WAS. */
function iisLab(): LabState {
  const s = buildReferenceLab()
  return unwrap(installFeatures(s, id(s, 'SRV1'), ['Web-Server'], { includeManagementTools: true })).state
}

const host = (s: LabState) => (s.devices[id(s, 'SRV1')] as HostDevice).host
const events = (s: LabState, eventId: number) => host(s).eventLog.filter((e) => e.eventId === eventId)
const status = (s: LabState, name: string) => host(s).services[name]?.status ?? 'Running'

/** W3SVC en échec de configuration (injection de panne). */
function broken(reason: 'invalidConfig' | 'timeout' = 'invalidConfig'): LabState {
  const s = iisLab()
  return unwrap(dispatch(s, command('service.setFailure', id(s, 'SRV1'), 'W3SVC', reason))).state
}

const sh = (s: LabState, line: string, shell: 'powershell' | 'cmd' = 'cmd') =>
  run(s, id(s, 'SRV1'), line, { shell })

describe('mise en échec du service (service.setFailure)', () => {
  it('un service qui tourne s’arrête de façon inattendue : évènement 7034, le site web tombe', () => {
    const s = iisLab()
    const pc1 = id(s, 'PC1')
    expect(httpGet(s, pc1, 'http://srv1.lab.local').kind).toBe('response')
    const b = broken()
    expect(status(b, 'W3SVC')).toBe('Stopped')
    expect(httpGet(b, pc1, 'http://srv1.lab.local').kind).toBe('failure')
    const e = events(b, 7034)
    expect(e).toHaveLength(1)
    expect(e[0]).toMatchObject({ level: 'error', source: 'Service Control Manager', log: 'Système' })
    expect(e[0]?.message).toBe(
      'Le service Service de publication World Wide Web s’est arrêté de manière inattendue. Ce comportement s’est produit 1 fois.'
    )
  })

  it('les dépendants en cours d’exécution s’arrêtent d’abord (7036), le service en échec ensuite', () => {
    const s = iisLab()
    const b = unwrap(dispatch(s, command('service.setFailure', id(s, 'SRV1'), 'WAS', 'timeout'))).state
    expect(status(b, 'W3SVC')).toBe('Stopped')
    expect(status(b, 'WAS')).toBe('Stopped')
    expect(
      events(b, 7036).filter((e) => e.message.includes('World Wide Web') && e.message.includes('arrêté'))
    ).toHaveLength(1)
    expect(events(b, 7034)).toHaveLength(1)
  })

  it('première action « restart » : 7031 avec l’action corrective, puis 7000 (le redémarrage échoue)', () => {
    let s = iisLab()
    const srv = id(s, 'SRV1')
    s = unwrap(
      dispatch(
        s,
        command('service.setRecovery', srv, 'W3SVC', {
          resetSeconds: 86400,
          actions: [{ type: 'restart', delayMs: 60000 }]
        })
      )
    ).state
    s = unwrap(dispatch(s, command('service.setFailure', srv, 'W3SVC', 'invalidConfig'))).state
    expect(events(s, 7034)).toHaveLength(0)
    expect(events(s, 7031)[0]?.message).toBe(
      'Le service Service de publication World Wide Web s’est arrêté de manière inattendue. Ce comportement s’est produit 1 fois. L’action corrective suivante sera exécutée dans 60000 millisecondes : Redémarrer le service.'
    )
    expect(events(s, 7000)).toHaveLength(1)
    expect(status(s, 'W3SVC')).toBe('Stopped')
  })

  it('un service déjà arrêté est marqué sans évènement ; service inconnu refusé', () => {
    let s = iisLab()
    const srv = id(s, 'SRV1')
    s = unwrap(dispatch(s, command('service.stop', srv, 'W3SVC'))).state
    const before = host(s).eventLog.length
    s = unwrap(dispatch(s, command('service.setFailure', srv, 'W3SVC', 'timeout'))).state
    expect(host(s).eventLog).toHaveLength(before)
    expect(host(s).services['W3SVC']?.failure).toEqual({ reason: 'timeout' })
    const r = dispatch(s, command('service.setFailure', srv, 'Inconnu', 'timeout'))
    expect(r.ok === false && r.error.code).toBe('ServiceNotFound')
  })
})

describe('un service en échec refuse de démarrer', () => {
  it('Start-Service : erreur 1066, évènement 7000 journalisé', () => {
    const r = sh(broken(), 'Start-Service W3SVC', 'powershell')
    expect(r.errors).toContain('Le service a renvoyé un code d’erreur spécifique au service.')
    expect(r.errors).toContain('Service de publication World Wide Web (W3SVC)')
    expect(status(r.state, 'W3SVC')).toBe('Stopped')
    const e = events(r.state, 7000)
    expect(e).toHaveLength(1)
    expect(e[0]?.message).toBe(
      'Le service Service de publication World Wide Web n’a pas pu démarrer en raison de l’erreur suivante : \nLe service a renvoyé un code d’erreur spécifique au service.'
    )
    expect(e[0]?.level).toBe('error')
  })

  it('Restart-Service et Set-Service -Status Running sont refusés de la même façon', () => {
    const b = broken()
    expect(sh(b, 'Restart-Service W3SVC', 'powershell').errors).toContain('spécifique au service')
    const set = sh(b, 'Set-Service W3SVC -Status Running', 'powershell')
    expect(set.errors).toContain('spécifique au service')
    expect(status(set.state, 'W3SVC')).toBe('Stopped')
  })

  it('net start : erreur système 1066 (golden) et évènement 7000', () => {
    const r = sh(broken('invalidConfig'), 'net start W3SVC')
    expectGolden(r.text, 'cmd/net-start-failed-1066')
    expect(events(r.state, 7000)).toHaveLength(1)
    expect(status(r.state, 'W3SVC')).toBe('Stopped')
  })

  it('sc start : erreur 1053 pour un délai dépassé (golden) et évènement 7000', () => {
    const r = sh(broken('timeout'), 'sc start W3SVC')
    expectGolden(r.text, 'cmd/sc-start-failed-1053')
    expect(events(r.state, 7000)).toHaveLength(1)
  })

  it('commande service.start du moteur : ServiceStartFailed, état inchangé', () => {
    const b = broken()
    const r = dispatch(b, command('service.start', id(b, 'SRV1'), 'W3SVC'))
    expect(r.ok === false && r.error.code).toBe('ServiceStartFailed')
  })

  it('un service qui dépend d’un service en échec ne démarre pas (1068)', () => {
    const s = iisLab()
    const srv = id(s, 'SRV1')
    const b = unwrap(dispatch(s, command('service.setFailure', srv, 'WAS', 'invalidConfig'))).state
    const r = dispatch(b, command('service.start', srv, 'W3SVC'))
    expect(r.ok === false && r.error.code).toBe('ServiceDependencyFailed')
    expect(sh(b, 'sc start W3SVC').errors).toContain('1068')
  })

  it('le test de bout en bout : échec, refus, réparation, démarrage, site web de retour', () => {
    const pc1 = id(iisLab(), 'PC1')
    let s = broken()
    const refused = sh(s, 'net start W3SVC')
    expect(refused.errors).toContain('1066')
    s = refused.state
    // Réparation de la configuration : le service peut démarrer, sans démarrer pour autant
    s = unwrap(dispatch(s, command('service.clearFailure', id(s, 'SRV1'), 'W3SVC'))).state
    expect(status(s, 'W3SVC')).toBe('Stopped')
    expect(host(s).services['W3SVC']?.failure).toBeUndefined()
    const started = sh(s, 'Start-Service W3SVC', 'powershell')
    expect(started.errors).toBe('')
    expect(status(started.state, 'W3SVC')).toBe('Running')
    expect(httpGet(started.state, pc1, 'http://srv1.lab.local').kind).toBe('response')
    // Un seul 7000 (le refus), pas de nouvel évènement d'erreur au démarrage réussi
    expect(events(started.state, 7000)).toHaveLength(1)
    expect(sh(s, 'sc start W3SVC').errors).toBe('')
  })

  it('la panne est annulable : annuler remet le service en marche', () => {
    const s = iisLab()
    const r = dispatch(s, command('service.setFailure', id(s, 'SRV1'), 'W3SVC', 'timeout'))
    if (!r.ok || !r.entry) throw new Error('mise en échec refusée')
    expect(applyStatePatches(r.state, r.entry.inversePatches)).toEqual(s)
    expect(applyStatePatches(applyStatePatches(r.state, r.entry.inversePatches), r.entry.patches)).toEqual(
      r.state
    )
  })
})

describe('la panne survit au redémarrage et au type de démarrage', () => {
  it('le redémarrage de l’ordinateur laisse le service arrêté et journalise 7000', () => {
    const b = broken()
    const srv = id(b, 'SRV1')
    const before = events(b, 7000).length
    const rebooted = unwrap(restartComputer(b, srv)).state
    expect(status(rebooted, 'W3SVC')).toBe('Stopped')
    expect(host(rebooted).services['W3SVC']?.failure).toEqual({ reason: 'invalidConfig' })
    expect(events(rebooted, 7000)).toHaveLength(before + 1)
  })

  it('un type de démarrage manuel ne journalise pas 7000 au redémarrage', () => {
    let b = broken()
    const srv = id(b, 'SRV1')
    b = unwrap(dispatch(b, command('service.setStartType', srv, 'W3SVC', 'Manual'))).state
    expect(host(b).services['W3SVC']?.failure).toBeDefined()
    expect(events(unwrap(restartComputer(b, srv)).state, 7000)).toHaveLength(0)
  })

  it('arrêter, démarrer ou changer le type d’un autre service garde panne et récupération', () => {
    let s = broken()
    const srv = id(s, 'SRV1')
    s = unwrap(dispatch(s, command('service.setRecovery', srv, 'W3SVC', { resetSeconds: 5 }))).state
    s = unwrap(dispatch(s, command('service.setStartType', srv, 'W3SVC', 'Disabled'))).state
    expect(host(s).services['W3SVC']).toMatchObject({
      startType: 'Disabled',
      failure: { reason: 'invalidConfig' },
      recovery: { resetSeconds: 5 }
    })
    s = unwrap(dispatch(s, command('service.clearFailure', srv, 'W3SVC'))).state
    expect(host(s).services['W3SVC']?.recovery?.resetSeconds).toBe(5)
  })

  it('l’état par défaut n’est pas stocké : réparer sans autre changement efface l’entrée', () => {
    const s = unwrap(
      dispatch(iisLab(), command('service.setFailure', id(iisLab(), 'SRV1'), 'W3SVC', 'timeout'))
    )
    const stopped = s.state
    const repaired = unwrap(dispatch(stopped, command('service.clearFailure', id(stopped, 'SRV1'), 'W3SVC')))
    expect(host(repaired.state).services['W3SVC']).toEqual({ status: 'Stopped', startType: 'Automatic' })
  })
})

describe('sc failure / sc qfailure', () => {
  it('sc failure puis sc qfailure : sortie calculée depuis l’état (golden)', () => {
    const set = sh(iisLab(), 'sc failure W3SVC reset= 30 actions= restart/5000')
    expectGolden(set.text, 'cmd/sc-failure')
    expect(set.state.devices[id(set.state, 'SRV1')]).toBeDefined()
    expectGolden(sh(set.state, 'sc qfailure W3SVC').text, 'cmd/sc-qfailure')
  })

  it('trois actions, message de redémarrage et commande (golden)', () => {
    const r = sh(
      iisLab(),
      'sc failure W3SVC reset= 60 reboot= "Le serveur redémarre dans 30 secondes." command= C:\\Scripts\\relance.cmd actions= run/5000/restart/60000/reboot/30000'
    )
    expect(r.errors).toBe('')
    expectGolden(sh(r.state, 'sc qfailure W3SVC').text, 'cmd/sc-qfailure-three-actions')
  })

  it('sans configuration : période 0, rien d’autre', () => {
    const r = sh(iisLab(), 'sc qfailure W3SVC')
    expect(r.text).toContain('RESET_PERIOD (in seconds)    : 0')
    expect(r.text).toContain('FAILURE_ACTIONS              :\n')
  })

  it('actions= "" supprime les actions ; reset= infinite', () => {
    let s = sh(iisLab(), 'sc failure W3SVC reset= 30 actions= restart/5000').state
    s = sh(s, 'sc failure W3SVC reset= infinite actions= ""').state
    const q = sh(s, 'sc qfailure W3SVC').text
    expect(q).toContain('INFINITE')
    expect(q).not.toContain('RESTART')
  })

  it('reset= sans actions=, action inconnue, délai invalide, sans espace : erreur 87', () => {
    const s = iisLab()
    for (const line of [
      'sc failure W3SVC reset= 30',
      'sc failure W3SVC actions= restart/5000',
      'sc failure W3SVC reset= 30 actions= explode/5000',
      'sc failure W3SVC reset= 30 actions= restart/abc',
      'sc failure W3SVC reset= 30 actions= restart',
      'sc failure W3SVC reset=30 actions=restart/5000'
    ]) {
      const r = sh(s, line)
      expect(r.errors, line).toContain('échec(s) 87')
      expect(host(r.state).services['W3SVC'], line).toBeUndefined()
    }
  })

  it('service inexistant : erreur 1060', () => {
    expect(sh(iisLab(), 'sc qfailure Inconnu').errors).toContain('1060')
    expect(sh(iisLab(), 'sc failure Inconnu reset= 1 actions= ""').errors).toContain('1060')
  })

  it('l’état de récupération est annulable et survit à l’enregistrement .slab', () => {
    const s = iisLab()
    const r = dispatch(
      s,
      command('service.setRecovery', id(s, 'SRV1'), 'W3SVC', {
        resetSeconds: 60,
        command: 'C:\\relance.cmd',
        actions: [{ type: 'run', delayMs: 100 }]
      })
    )
    if (!r.ok || !r.entry) throw new Error('commande refusée')
    expect(r.entry.label).toContain('récupération')
    expect(applyStatePatches(r.state, r.entry.inversePatches)).toEqual(s)
    const reopened = parseSlab(
      serializeSlab(r.state, { savedAt: '2026-10-19T10:00:00.000Z', appVersion: '2.8.0' })
    )
    if (!reopened.ok) throw new Error(reopened.message)
    expect(reopened.doc.lab).toEqual(r.state)
    const failing = unwrap(
      dispatch(r.state, command('service.setFailure', id(s, 'SRV1'), 'W3SVC', 'timeout'))
    )
    const again = parseSlab(
      serializeSlab(failing.state, { savedAt: '2026-10-19T10:00:00.000Z', appVersion: '2.8.0' })
    )
    if (!again.ok) throw new Error(again.message)
    expect(again.doc.lab).toEqual(failing.state)
  })
})

describe('format .slab 26 : champs facultatifs', () => {
  it('v26.slab s’ouvre sans panne ni récupération (valeurs par défaut)', () => {
    const parsed = parseSlab(readFixture(26))
    if (!parsed.ok) throw new Error(parsed.message)
    expect(parsed.doc.schemaVersion).toBe(28)
    const hosts = Object.values(parsed.doc.lab.devices).filter(
      (d) => d.kind === 'server' || d.kind === 'client'
    ) as HostDevice[]
    expect(hosts.length).toBeGreaterThan(0)
    for (const h of hosts)
      for (const s of Object.values(h.host.services)) {
        expect(s.failure).toBeUndefined()
        expect(s.recovery).toBeUndefined()
      }
  })

  it('un ancien état de service (sans panne) reste valide et sans récupération configurée', () => {
    const s = iisLab()
    const r = sh(s, 'sc qfailure W3SVC')
    expect(r.errors).toBe('')
    expect(host(s).services['W3SVC']).toBeUndefined()
  })
})
