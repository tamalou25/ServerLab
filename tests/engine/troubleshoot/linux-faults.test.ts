/**
 * Pannes Linux du mode panne (v2.9, #241) : chaque panne se tire sur un serveur sain, produit un
 * symptôme lu sur l'état (vérifié aussi depuis un poste : curl, smbclient, dig, ssh), se répare avec les
 * commandes de la console (officielle = ce que l'élève saisit) ; tirage contrôlé du domaine `linux`.
 */
import { describe, expect, it } from 'vitest'
import {
  activeFaults,
  allRepaired,
  dispatch,
  FAULTS,
  getFault,
  startTroubleshooting,
  type ActiveFault,
  type FaultTargetParams,
  type LabState
} from '@engine/index'
import { mulberry32 } from '@engine/core/prng'
import { run } from '../shell/helpers'
import { buildLinuxHealthy } from './bases-linux'

const healthy = buildLinuxHealthy()
const id = (s: LabState, name: string) => Object.values(s.devices).find((d) => d.name === name)?.id ?? ''

/** Ligne saisie sur une machine ; renvoie état et sortie complète. */
function sh(state: LabState, machine: string, line: string, answers: string[] = []) {
  const r = run(state, id(state, machine), line, { shell: 'cmd', answers })
  return { state: r.state, text: r.text }
}

function applyAll(state: LabState, commands: ReturnType<NonNullable<ReturnType<typeof getFault>>['repair']>) {
  let next = state
  for (const c of commands) {
    const r = dispatch(next, c)
    if (!r.ok) throw new Error(`${c.type} : ${r.error.message}`)
    next = r.state
  }
  return next
}

const LINUX = FAULTS.filter((f) => f.domain === 'linux')

/** Cible forcée d'une panne de service (le tirage choisit sinon le service au hasard). */
const target = (service: string, extra: FaultTargetParams = {}): FaultTargetParams => ({
  device: id(healthy, 'LSRV1'),
  service,
  client: id(healthy, 'LNX1'),
  ...extra
})

function broken(faultId: string, params: FaultTargetParams): LabState {
  const fault = getFault(faultId)!
  return applyAll(healthy, fault.inject(healthy, params))
}

describe('catalogue des pannes Linux', () => {
  it('14 pannes de domaine linux, identifiants uniques, trois indices non vides', () => {
    expect(LINUX.map((f) => f.id).sort()).toEqual([
      'linux.apache-docroot-perms',
      'linux.apache-syntax',
      'linux.apache-vhost',
      'linux.dhcpd-interfaces',
      'linux.dhcpd-syntax',
      'linux.fail2ban-banned',
      'linux.named-missing-record',
      'linux.named-syntax',
      'linux.service-disabled',
      'linux.service-stopped',
      'linux.smb-share-perms',
      'linux.smb-wrong-path',
      'linux.sshd-permitrootlogin',
      'linux.sshd-port'
    ])
  })

  it.each(LINUX.map((f) => [f.id] as const))('%s : tirage, symptôme, réparation officielle', (faultId) => {
    const fault = getFault(faultId)!
    let seen = 0
    for (const seed of [1, 2, 3, 4, 5]) {
      const p = fault.pick(healthy, mulberry32(seed))
      expect(p, `graine ${seed}`).not.toBeNull()
      seen++
      // Cibles sérialisables
      for (const v of Object.values(p!)) expect(['string', 'number', 'boolean']).toContain(typeof v)
      // État sain : guéri, sans symptôme
      expect(fault.healed(healthy, p!)).toBe(true)
      expect(fault.symptomVisible(healthy, p!)).toBe(false)
      // Cassé : symptôme, non guéri, ticket et indices en français sans la cause
      const bad = applyAll(healthy, fault.inject(healthy, p!))
      expect(fault.symptomVisible(bad, p!)).toBe(true)
      expect(fault.healed(bad, p!)).toBe(false)
      const hints = fault.hints(bad, p!)
      expect(hints).toHaveLength(3)
      for (const h of hints) expect(h.trim().length).toBeGreaterThan(20)
      expect(fault.ticket(bad, p!).length).toBeGreaterThan(30)
      expect(fault.cause(bad, p!).length).toBeGreaterThan(30)
      // Réparé par la réparation officielle
      const fixed = applyAll(bad, fault.repair(bad, p!))
      expect(fault.healed(fixed, p!)).toBe(true)
      expect(fault.symptomVisible(fixed, p!)).toBe(false)
    }
    expect(seen).toBe(5)
  })
})

describe('linux.service-stopped / service-disabled', () => {
  it.each(['ssh', 'apache2', 'smbd', 'named', 'isc-dhcp-server'])(
    '%s : arrêté puis relancé à la console',
    (unit) => {
      const bad = broken('linux.service-stopped', target(unit))
      expect(sh(bad, 'LSRV1', `systemctl is-active ${unit}`).text).toBe('inactive')
      const fixed = sh(bad, 'LSRV1', `sudo systemctl start ${unit}`).state
      expect(sh(fixed, 'LSRV1', `systemctl is-active ${unit}`).text).toBe('active')
      expect(getFault('linux.service-stopped')!.healed(fixed, target(unit))).toBe(true)
    }
  )

  it('désactivé : start seul ne suffit pas, enable est nécessaire', () => {
    const p = target('apache2')
    const bad = broken('linux.service-disabled', p)
    expect(sh(bad, 'LSRV1', 'systemctl is-enabled apache2').text).toBe('disabled')
    const started = sh(bad, 'LSRV1', 'sudo systemctl start apache2').state
    expect(getFault('linux.service-disabled')!.healed(started, p)).toBe(false)
    const fixed = sh(started, 'LSRV1', 'sudo systemctl enable apache2').state
    expect(getFault('linux.service-disabled')!.healed(fixed, p)).toBe(true)
  })
})

describe('linux.sshd-port / sshd-permitrootlogin / fail2ban-banned', () => {
  it('port : sshd actif mais sur 2222, la connexion au 22 est refusée, redémarrage nécessaire', () => {
    const p = getFault('linux.sshd-port')!.pick(healthy, mulberry32(1))!
    const bad = broken('linux.sshd-port', p)
    expect(sh(bad, 'LSRV1', 'systemctl is-active ssh').text).toBe('active')
    expect(sh(bad, 'LSRV1', 'ss -tln').text).toContain(':2222')
    expect(sh(bad, 'LNX1', 'ssh admin@192.168.20.10', ['x']).text).toContain('Connection refused')
    // Corriger le fichier sans redémarrer ne suffit pas
    const file = sh(bad, 'LSRV1', "sudo sed -i 's/^Port 2222$/#Port 22/' /etc/ssh/sshd_config").state
    expect(getFault('linux.sshd-port')!.healed(file, p)).toBe(false)
    const fixed = sh(file, 'LSRV1', 'sudo systemctl restart ssh').state
    expect(getFault('linux.sshd-port')!.healed(fixed, p)).toBe(true)
  })

  it('PermitRootLogin : root refusé après redémarrage, rétabli à la console', () => {
    const fault = getFault('linux.sshd-permitrootlogin')!
    const p = fault.pick(healthy, mulberry32(1))!
    const bad = broken(fault.id, p)
    expect(sh(bad, 'LSRV1', 'sudo grep -n PermitRootLogin /etc/ssh/sshd_config').text).toBeDefined()
    const set = sh(bad, 'LSRV1', 'sudo passwd root', ['Root1', 'Root1']).state
    expect(
      sh(set, 'LNX1', 'ssh -o StrictHostKeyChecking=no root@192.168.20.10 hostname', [
        'Root1',
        'Root1',
        'Root1'
      ]).text
    ).toContain('Permission denied')
    const fixed = sh(
      sh(set, 'LSRV1', "sudo sed -i 's/^PermitRootLogin no$/PermitRootLogin yes/' /etc/ssh/sshd_config")
        .state,
      'LSRV1',
      'sudo systemctl restart ssh'
    ).state
    expect(fault.healed(fixed, p)).toBe(true)
    expect(
      sh(fixed, 'LNX1', 'ssh -o StrictHostKeyChecking=no root@192.168.20.10 hostname', ['Root1']).text
    ).toContain('LSRV1')
  })

  it('fail2ban : le poste banni est refusé, levé par fail2ban-client', () => {
    const fault = getFault('linux.fail2ban-banned')!
    const p = fault.pick(healthy, mulberry32(1))!
    const bad = applyAll(healthy, fault.inject(healthy, p))
    const ip = String(p['ip'])
    const clientName = healthy.devices[String(p['client'])]!.name
    expect(sh(bad, 'LSRV1', 'sudo fail2ban-client status sshd').text).toContain(ip)
    expect(sh(bad, clientName, 'ssh -o StrictHostKeyChecking=no admin@192.168.20.10', ['x']).text).toContain(
      'Connection refused'
    )
    const fixed = sh(bad, 'LSRV1', `sudo fail2ban-client set sshd unbanip ${ip}`).state
    expect(fault.healed(fixed, p)).toBe(true)
    expect(
      sh(fixed, clientName, 'ssh -o StrictHostKeyChecking=no admin@192.168.20.10', ['x', 'x', 'x']).text
    ).not.toContain('Connection refused')
  })
})

describe('Apache2', () => {
  const curl = (s: LabState) => sh(s, 'LNX1', 'curl -sI http://192.168.20.10/').text

  it('syntaxe : configtest en erreur, service en échec, réparé après correction ET redémarrage', () => {
    const fault = getFault('linux.apache-syntax')!
    const p = fault.pick(healthy, mulberry32(1))!
    const bad = broken(fault.id, p)
    expect(sh(bad, 'LSRV1', 'sudo apache2ctl configtest').text).toContain("Invalid command 'DocumentRot'")
    expect(sh(bad, 'LSRV1', 'systemctl is-active apache2').text).toBe('failed')
    expect(curl(bad)).not.toContain('200 OK')
    const edited = sh(bad, 'LSRV1', `sudo sed -i 's/DocumentRot /DocumentRoot /' ${String(p['file'])}`).state
    expect(fault.healed(edited, p)).toBe(false)
    const fixed = sh(edited, 'LSRV1', 'sudo systemctl restart apache2').state
    expect(fault.healed(fixed, p)).toBe(true)
    expect(curl(fixed)).toContain('200 OK')
  })

  it('hôte virtuel : 404 après rechargement, 200 une fois corrigé et rechargé', () => {
    const fault = getFault('linux.apache-vhost')!
    const p = fault.pick(healthy, mulberry32(1))!
    const bad = broken(fault.id, p)
    expect(sh(bad, 'LSRV1', 'systemctl is-active apache2').text).toBe('active')
    expect(curl(bad)).toContain('404 Not Found')
    const edited = sh(bad, 'LSRV1', `sudo sed -i 's/-old$//' ${String(p['file'])}`).state
    expect(fault.healed(edited, p)).toBe(false)
    const fixed = sh(edited, 'LSRV1', 'sudo systemctl reload apache2').state
    expect(fault.healed(fixed, p)).toBe(true)
    expect(curl(fixed)).toContain('200 OK')
  })

  it('droits du DocumentRoot : 403, rétabli par chmod', () => {
    const fault = getFault('linux.apache-docroot-perms')!
    const p = fault.pick(healthy, mulberry32(1))!
    const bad = broken(fault.id, p)
    expect(curl(bad)).toContain('403 Forbidden')
    const fixed = sh(bad, 'LSRV1', `sudo chmod 755 ${String(p['root'])}`).state
    expect(fault.healed(fixed, p)).toBe(true)
    expect(curl(fixed)).toContain('200 OK')
  })
})

describe('Samba', () => {
  const list = (s: LabState) => sh(s, 'LNX1', 'smbclient //192.168.20.10/public -U alice%Passw0rd -c ls').text

  it('chemin erroné : partage introuvable tant que smbd n’est pas redémarré', () => {
    const fault = getFault('linux.smb-wrong-path')!
    const p = fault.pick(healthy, mulberry32(1))!
    expect(list(healthy)).not.toContain('NT_STATUS')
    const bad = broken(fault.id, p)
    expect(list(bad)).toContain('NT_STATUS_BAD_NETWORK_NAME')
    const edited = sh(bad, 'LSRV1', "sudo sed -i 's/-old$//' /etc/samba/smb.conf").state
    expect(fault.healed(edited, p)).toBe(false)
    const fixed = sh(edited, 'LSRV1', 'sudo systemctl restart smbd').state
    expect(fault.healed(fixed, p)).toBe(true)
    expect(list(fixed)).not.toContain('NT_STATUS')
  })

  it('droits du dossier : accès refusé, rétabli par chmod', () => {
    const fault = getFault('linux.smb-share-perms')!
    const p = fault.pick(healthy, mulberry32(1))!
    const bad = broken(fault.id, p)
    expect(list(bad)).toContain('NT_STATUS_ACCESS_DENIED')
    const fixed = sh(bad, 'LSRV1', `sudo chmod ${String(p['mode'])} ${String(p['path'])}`).state
    expect(fault.healed(fixed, p)).toBe(true)
    expect(list(fixed)).not.toContain('NT_STATUS')
  })
})

describe('Bind9 et isc-dhcp-server', () => {
  it('named : syntaxe invalide signalée par named-checkconf, service en échec', () => {
    const fault = getFault('linux.named-syntax')!
    const p = fault.pick(healthy, mulberry32(1))!
    const bad = broken(fault.id, p)
    expect(sh(bad, 'LSRV1', 'sudo named-checkconf').text).toContain('/etc/bind/named.conf.local:')
    expect(sh(bad, 'LSRV1', 'systemctl is-active named').text).toBe('failed')
    const fixed = sh(
      sh(bad, 'LSRV1', 'sudo sed -i \'s/file "db.lab.lan"$/file "db.lab.lan";/\' /etc/bind/named.conf.local')
        .state,
      'LSRV1',
      'sudo systemctl restart named'
    ).state
    expect(fault.healed(fixed, p)).toBe(true)
    expect(sh(fixed, 'LNX1', 'dig @192.168.20.10 www.lab.lan +short').text).toBe('192.168.20.20')
  })

  it('enregistrement manquant : NXDOMAIN après rndc reload, réparé en le rétablissant', () => {
    const fault = getFault('linux.named-missing-record')!
    const p = fault.pick(healthy, mulberry32(1))!
    const name = String(p['name'])
    const bad = broken(fault.id, p)
    expect(sh(bad, 'LNX1', `dig @192.168.20.10 ${name}`).text).toContain('NXDOMAIN')
    const fixed = sh(
      sh(bad, 'LSRV1', `sudo sed -i 's/^;//' ${String(p['file'])}`).state,
      'LSRV1',
      'sudo rndc reload'
    ).state
    expect(fault.healed(fixed, p)).toBe(true)
    expect(sh(fixed, 'LNX1', `dig @192.168.20.10 ${name} +short`).text).not.toBe('')
  })

  it('dhcpd : INTERFACESv4 vide, journal « Not configured to listen on any interfaces! »', () => {
    const fault = getFault('linux.dhcpd-interfaces')!
    const p = fault.pick(healthy, mulberry32(1))!
    const bad = broken(fault.id, p)
    expect(sh(bad, 'LSRV1', 'systemctl is-active isc-dhcp-server').text).toBe('failed')
    expect(sh(bad, 'LSRV1', 'sudo journalctl -u isc-dhcp-server --no-pager').text).toContain(
      'Not configured to listen on any interfaces!'
    )
    const fixed = sh(
      sh(bad, 'LSRV1', 'echo \'INTERFACESv4="eth0"\' | sudo tee /etc/default/isc-dhcp-server').state,
      'LSRV1',
      'sudo systemctl restart isc-dhcp-server'
    ).state
    expect(fault.healed(fixed, p)).toBe(true)
  })

  it('dhcpd : point-virgule manquant signalé par dhcpd -t', () => {
    const fault = getFault('linux.dhcpd-syntax')!
    const p = fault.pick(healthy, mulberry32(1))!
    const bad = broken(fault.id, p)
    expect(sh(bad, 'LSRV1', 'sudo dhcpd -t').text).toContain('semicolon expected')
    expect(sh(bad, 'LSRV1', 'systemctl is-active isc-dhcp-server').text).toBe('failed')
    expect(fault.healed(bad, p)).toBe(false)
  })
})

describe('tirage du domaine linux', () => {
  const SEEDS = Array.from({ length: 30 }, (_, i) => i + 1)
  const repair = (start: LabState, faults: ActiveFault[]): LabState => {
    let s = start
    for (const a of faults) s = applyAll(s, getFault(a.id)!.repair(s, a.params))
    return s
  }

  it(
    'toute panne tirée est réparable, dans les deux ordres, et le tirage est déterministe',
    { timeout: 120_000 },
    () => {
      let valid = 0
      for (const count of [1, 2, 3])
        for (const seed of SEEDS) {
          const r = startTroubleshooting(healthy, { seed, domain: 'linux', count })
          const again = startTroubleshooting(healthy, { seed, domain: 'linux', count })
          expect(JSON.stringify(r)).toBe(JSON.stringify(again))
          if (!r.ok) continue
          valid++
          expect(r.value.faults).toHaveLength(count)
          for (const list of [r.value.faults, [...r.value.faults].reverse()]) {
            const fixed = repair(r.state, list)
            expect(allRepaired(fixed), `x${count} graine ${seed}`).toBe(true)
          }
          expect(activeFaults(r.state)).toHaveLength(count)
        }
      expect(valid).toBeGreaterThan(50)
    }
  )

  it('diversité : au moins 8 pannes différentes sur 40 graines', () => {
    const ids = new Set<string>()
    for (const seed of SEEDS) {
      const r = startTroubleshooting(healthy, { seed, domain: 'linux' })
      if (r.ok) ids.add(r.value.faults[0]!.id)
    }
    expect(ids.size).toBeGreaterThanOrEqual(8)
  })

  it('un lab sans serveur Linux : aucune panne Linux applicable', () => {
    const empty = buildLinuxHealthy()
    const windowsOnly = {
      ...empty,
      devices: Object.fromEntries(Object.entries(empty.devices).filter(([, d]) => d.name === 'PC1'))
    }
    const r = startTroubleshooting(windowsOnly, { seed: 1, domain: 'linux' })
    expect(r.ok).toBe(false)
  })
})
