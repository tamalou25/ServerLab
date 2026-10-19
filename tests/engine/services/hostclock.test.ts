/**
 * Horloge par ordinateur, W32Time et Kerberos (v2.8, chantier A) : une panne d'horloge de plus de
 * 5 minutes entre un poste et son contrôleur de domaine refuse la session de domaine et l'accès
 * aux partages ; Set-Date, `net time /set` ou `w32tm /resync` la réparent.
 */
import { describe, expect, it } from 'vitest'
import {
  buildLabStart,
  checkLab,
  command,
  dispatch,
  evaluateCheck,
  installFeatures,
  joinDomain,
  logoff,
  logon,
  restartComputer,
  unwrap,
  type LabState
} from '@engine/index'
import { build, cable, setIp } from '../helpers'
import { expectGolden } from '../golden/golden'
import { run } from '../shell/helpers'

const DSRM = ['P@ssw0rd!', 'P@ssw0rd!']

/** SRV1 (contrôleur de lab.local) et PC1 (membre du domaine), session de PC1 fermée. */
function domainLab() {
  const { state, ids } = build([
    ['server', 'SRV1'],
    ['client', 'PC1'],
    ['switch', 'SW1']
  ])
  let s = cable(state, ids.SRV1!, 0, ids.SW1!, 0)
  s = cable(s, ids.PC1!, 0, ids.SW1!, 1)
  s = setIp(s, ids.SRV1!, 0, '192.168.1.1/24', undefined, ['8.8.8.8'])
  s = setIp(s, ids.PC1!, 0, '192.168.1.10/24', undefined, ['192.168.1.1'])
  s = unwrap(installFeatures(s, ids.SRV1!, ['AD-Domain-Services'], { includeManagementTools: true })).state
  s = run(s, ids.SRV1!, 'Install-ADDSForest -DomainName lab.local -InstallDns', {
    answers: [...DSRM, 'O']
  }).state
  const op = joinDomain(s, ids.PC1!, {
    domain: 'lab.local',
    user: 'LAB\\Administrateur',
    password: 'P@ssw0rd'
  })
  expect(op.ok).toBe(true)
  s = unwrap(restartComputer(op.state, ids.PC1!)).state
  return { s, ids }
}

const CREDENTIALS = { user: 'Administrateur', password: 'P@ssw0rd', domain: 'LAB' }
const offsetOf = (s: LabState, id: string) => {
  const d = s.devices[id]
  return d && (d.kind === 'server' || d.kind === 'client') ? d.host.clockOffsetSeconds : NaN
}
const events = (s: LabState, id: string) => {
  const d = s.devices[id]
  return d && (d.kind === 'server' || d.kind === 'client') ? d.host.eventLog : []
}

describe('Set-Date et Get-Date', () => {
  it('-Adjust avance l’heure locale du poste seulement, Get-Date la relit', () => {
    const { s, ids } = domainLab()
    const before = run(s, ids.PC1!, 'Get-Date').text
    const r = run(s, ids.PC1!, 'Set-Date -Adjust 00:10:00')
    expect(r.errors).toBe('')
    expect(offsetOf(r.state, ids.PC1!)).toBe(600)
    expect(offsetOf(r.state, ids.SRV1!)).toBe(0)
    const after = run(r.state, ids.PC1!, 'Get-Date').text
    expect(after).not.toBe(before)
    // Le temps du lab ne bouge pas : seul l’écart du poste change
    expect(after.slice(0, 11)).toBe(before.slice(0, 11))
    expect(run(r.state, ids.PC1!, 'Set-Date -Adjust -0:10:00').state.devices[ids.PC1!]).toMatchObject({
      host: { clockOffsetSeconds: 0 }
    })
  })

  it('-Date fixe l’heure (date complète ou heure seule)', () => {
    const { s, ids } = domainLab()
    const r = run(s, ids.PC1!, 'Set-Date -Date "05/01/2026 09:30:00"')
    expect(offsetOf(r.state, ids.PC1!)).toBeGreaterThan(5000)
    expect(run(r.state, ids.PC1!, 'Get-Date -Format "HH:mm"').text).toBe('09:30')
    const t = run(s, ids.PC1!, 'Set-Date 23:00')
    expect(run(t.state, ids.PC1!, 'Get-Date -Format "HH:mm"').text).toBe('23:00')
  })

  it('erreurs : ni -Date ni -Adjust, valeur illisible', () => {
    const { s, ids } = domainLab()
    expect(run(s, ids.PC1!, 'Set-Date').errors).toContain('Indiquez soit -Date, soit -Adjust.')
    expect(run(s, ids.PC1!, 'Set-Date -Adjust demain').errors).toContain('intervalle de temps')
    expect(run(s, ids.PC1!, 'Set-Date -Date hier').errors).toContain('en date')
  })

  it('la commande nommée host.setClock est annulable', () => {
    const { s, ids } = domainLab()
    const r = dispatch(s, command('host.setClock', ids.PC1!, 900))
    expect(r.ok).toBe(true)
    if (r.ok) expect(offsetOf(r.state, ids.PC1!)).toBe(900)
  })
})

describe('Kerberos : écart d’horloge supérieur à 5 minutes', () => {
  it('à 300 s la session de domaine passe ; au-delà elle est refusée (événements 4771 et 4625)', () => {
    const { s, ids } = domainLab()
    const ok = run(s, ids.PC1!, 'Set-Date -Adjust 00:05:00').state
    expect(logon(ok, ids.PC1!, CREDENTIALS).ok).toBe(true)
    const late = run(s, ids.PC1!, 'Set-Date -Adjust 00:05:01').state
    const refused = logon(late, ids.PC1!, CREDENTIALS)
    expect(refused.ok).toBe(false)
    expect(refused.message).toBe(
      'Il existe une différence d’heure et/ou de date entre le client et le serveur.'
    )
    const kdc = events(refused.state, ids.SRV1!).find((e) => e.eventId === 4771)
    expect(kdc?.message).toContain('0x25')
    expect(kdc?.message).toContain('KRB_AP_ERR_SKEW')
    const client = events(refused.state, ids.PC1!).find((e) => e.eventId === 4625)
    expect(client?.message).toContain('0xC0000133')
    // Un écart dans l’autre sens est refusé de la même façon
    const early = run(s, ids.PC1!, 'Set-Date -Adjust -0:06:00').state
    expect(logon(early, ids.PC1!, CREDENTIALS).ok).toBe(false)
  })

  it('un écart de l’horloge refusé n’incrémente pas le compteur de mots de passe erronés', () => {
    const { s, ids } = domainLab()
    const late = run(s, ids.PC1!, 'Set-Date -Adjust 01:00:00').state
    let t = late
    for (let i = 0; i < 6; i++) t = logon(t, ids.PC1!, { ...CREDENTIALS, password: 'faux' }).state
    const back = unwrap(dispatch(t, command('host.setClock', ids.PC1!, 0)))
    expect(logon(back.state, ids.PC1!, CREDENTIALS).ok).toBe(true)
  })

  it('un compte local n’est pas concerné par l’horloge', () => {
    const { s, ids } = domainLab()
    const late = run(s, ids.PC1!, 'Set-Date -Adjust 01:00:00').state
    const local = logon(late, ids.PC1!, { user: 'Administrateur', password: 'P@ssw0rd', domain: null })
    expect(local.ok).toBe(true)
  })

  it('partages du domaine : accès refusé (erreur 1398) tant que l’écart dépasse 5 minutes', () => {
    const { s, ids } = domainLab()
    const session = logon(s, ids.PC1!, CREDENTIALS).state
    const mount = (state: LabState) => run(state, ids.PC1!, 'net use Z: \\\\SRV1\\C$', { shell: 'cmd' })
    expect(mount(session).errors).toBe('')
    const late = run(session, ids.PC1!, 'Set-Date -Adjust 00:10:00').state
    const refused = mount(late)
    expect(refused.errors).toContain('1398')
    expect(refused.errors).toContain('Il existe une différence d’heure et/ou de date')
  })
})

describe('w32tm /resync', () => {
  it('service Temps Windows démarré : l’écart revient à celui du contrôleur, la session passe', () => {
    const { s, ids } = domainLab()
    const late = run(s, ids.PC1!, 'Set-Date -Adjust 00:20:00').state
    expect(logon(late, ids.PC1!, CREDENTIALS).ok).toBe(false)
    const r = run(late, ids.PC1!, 'w32tm /resync', { shell: 'cmd' })
    expect(r.errors).toBe('')
    expectGolden(r.text, 'cmd/w32tm-resync')
    expect(offsetOf(r.state, ids.PC1!)).toBe(0)
    expect(logon(r.state, ids.PC1!, CREDENTIALS).ok).toBe(true)
    expect(events(r.state, ids.PC1!).some((e) => e.source === 'Microsoft-Windows-Time-Service')).toBe(true)
  })

  it('le poste se resynchronise sur le contrôleur, même décalé', () => {
    const { s, ids } = domainLab()
    let t = unwrap(dispatch(s, command('host.setClock', ids.SRV1!, 120))).state
    t = unwrap(dispatch(t, command('host.setClock', ids.PC1!, -4000))).state
    expect(offsetOf(run(t, ids.PC1!, 'w32tm /resync', { shell: 'cmd' }).state, ids.PC1!)).toBe(120)
  })

  it('service arrêté : w32tm /resync échoue et ne change pas l’heure', () => {
    const { s, ids } = domainLab()
    const stopped = run(run(s, ids.PC1!, 'Set-Date -Adjust 00:20:00').state, ids.PC1!, 'Stop-Service W32Time')
    expect(stopped.errors).toBe('')
    const r = run(stopped.state, ids.PC1!, 'w32tm /resync', { shell: 'cmd' })
    expectGolden(r.text, 'cmd/w32tm-resync-stopped')
    expect(offsetOf(r.state, ids.PC1!)).toBe(1200)
    // Démarré de nouveau : la resynchronisation répare
    const started = run(r.state, ids.PC1!, 'Start-Service W32Time')
    const fixed = run(started.state, ids.PC1!, 'w32tm /resync', { shell: 'cmd' })
    expect(offsetOf(fixed.state, ids.PC1!)).toBe(0)
  })

  it('option non simulée : message honnête', () => {
    const { s, ids } = domainLab()
    expect(run(s, ids.PC1!, 'w32tm /monitor', { shell: 'cmd' }).errors).toContain('n’est pas simulée')
    expect(run(s, ids.PC1!, 'w32tm /resync /computer:SRV1', { shell: 'cmd' }).errors).toContain(
      'n’est pas simulée'
    )
  })
})

describe('w32tm /query /status', () => {
  it('poste du domaine à l’heure : disposition de l’exemple Learn', () => {
    const { s, ids } = domainLab()
    const at0 = { ...s, clock: 0 }
    const r = run(at0, ids.PC1!, 'w32tm /query /status /verbose', { shell: 'cmd' })
    expectGolden(r.text, 'cmd/w32tm-query-status-verbose')
  })

  it('sans /verbose : première partie seulement ; écart visible dans Phase Offset', () => {
    const { s, ids } = domainLab()
    const plain = run({ ...s, clock: 0 }, ids.PC1!, 'w32tm /query /status', { shell: 'cmd' })
    expectGolden(plain.text, 'cmd/w32tm-query-status')
    const late = run(s, ids.PC1!, 'Set-Date -Adjust 00:10:00').state
    expect(run(late, ids.PC1!, 'w32tm /query /status /verbose', { shell: 'cmd' }).text).toContain(
      'Phase Offset: 600.0000000s'
    )
  })

  it('service arrêté : erreur du service', () => {
    const { s, ids } = domainLab()
    const stopped = run(s, ids.PC1!, 'Stop-Service W32Time').state
    expect(run(stopped, ids.PC1!, 'w32tm /query /status', { shell: 'cmd' }).errors).toContain('0x80070426')
  })
})

describe('net time', () => {
  it('\\\\SRV1 : heure du contrôleur par RPC, même service Temps arrêté', () => {
    const { s, ids } = domainLab()
    const stopped = run(s, ids.PC1!, 'Stop-Service W32Time').state
    const r = run({ ...stopped, clock: 0 }, ids.PC1!, 'net time \\\\SRV1', { shell: 'cmd' })
    expectGolden(r.text, 'cmd/net-time')
  })

  it('sans argument : contrôleur de domaine (nom complet)', () => {
    const { s, ids } = domainLab()
    const r = run({ ...s, clock: 0 }, ids.PC1!, 'net time', { shell: 'cmd' })
    expect(r.text).toBe('Current time at \\\\SRV1.lab.local is 1/5/2026 8:00:00 AM')
  })

  it('/set /y aligne l’horloge locale sur celle du serveur ; /set seul et /rtsdomain non simulés', () => {
    const { s, ids } = domainLab()
    const late = run(s, ids.PC1!, 'Set-Date -Adjust 00:30:00').state
    expect(run(late, ids.PC1!, 'net time \\\\SRV1 /set', { shell: 'cmd' }).errors).toContain(
      'n’est pas simulée'
    )
    const r = run(late, ids.PC1!, 'net time \\\\SRV1 /set /y', { shell: 'cmd' })
    expect(offsetOf(r.state, ids.PC1!)).toBe(0)
    expect(logon(r.state, ids.PC1!, CREDENTIALS).ok).toBe(true)
    expect(run(s, ids.PC1!, 'net time /rtsdomain', { shell: 'cmd' }).errors).toContain('n’est pas simulée')
  })

  it('ordinateur introuvable : erreur système 53', () => {
    const { s, ids } = domainLab()
    expect(run(s, ids.PC1!, 'net time \\\\INCONNU', { shell: 'cmd' }).errors).toContain('Erreur système 53.')
  })
})

describe('critère de lab clockOffset', () => {
  it('vrai tant que l’écart absolu reste sous le maximum', () => {
    const { s, ids } = domainLab()
    const check = { type: 'clockOffset', device: 'PC1', maxSeconds: 60 }
    expect(evaluateCheck(s, check)).toBe(true)
    const late = unwrap(dispatch(s, command('host.setClock', ids.PC1!, 61))).state
    expect(evaluateCheck(late, check)).toBe(false)
    const early = unwrap(dispatch(s, command('host.setClock', ids.PC1!, -60))).state
    expect(evaluateCheck(early, check)).toBe(true)
    expect(evaluateCheck(s, { ...check, device: 'INCONNU' })).toBe(false)
  })

  it('un lab dont la solution est de resynchroniser l’horloge', () => {
    const { s, ids } = domainLab()
    const broken = run(s, ids.PC1!, 'Set-Date -Adjust 00:20:00').state
    const lab = {
      criteria: [
        {
          id: 'horloge',
          label: 'PC1 est à l’heure',
          hint: 'Resynchronisez l’horloge.',
          check: { type: 'clockOffset', device: 'PC1', maxSeconds: 1 }
        }
      ]
    }
    expect(buildLabStart).toBeDefined()
    expect(checkLab(broken, lab as never).passed).toBe(0)
    const fixed = run(broken, ids.PC1!, 'w32tm /resync', { shell: 'cmd' }).state
    expect(checkLab(fixed, lab as never).passed).toBe(1)
    expect(logoff(fixed, ids.PC1!)).toBeDefined()
  })
})
