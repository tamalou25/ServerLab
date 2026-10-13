/**
 * Sécurité IOS : listes d'accès (filtrage visible dans la trace, compteurs), port-security
 * (err-disabled), SSH, comptes et lignes, service password-encryption.
 */
import { describe, expect, it } from 'vitest'
import {
  connect,
  createShellSession,
  disconnect,
  evaluateCheck,
  executeLine,
  ping,
  runBackgroundTasks,
  unwrap,
  type LabState
} from '@engine/index'
import { add, cable, createLab, setIp } from '../helpers'
import { addIos, IosConsole, type SharedLab } from './helpers'

const reaches = (state: LabState, from: string, to: string): boolean => {
  const r = ping(state, from, to)
  return r.ok && r.value.success
}

/** PC1 (192.168.1.10) — R1 Gi0/0 ; R1 Gi0/1 — PC2 (192.168.2.10), routage direct par R1. */
function aclLab() {
  const r1 = addIos(createLab(), 'c1921')
  const pc1 = add(r1.state, 'client')
  const pc2 = add(pc1.state, 'client')
  let s = cable(pc2.state, pc1.id, 0, r1.id, 0)
  s = cable(s, pc2.id, 0, r1.id, 1)
  s = setIp(s, pc1.id, 0, '192.168.1.10/24', '192.168.1.1')
  s = setIp(s, pc2.id, 0, '192.168.2.10/24', '192.168.2.1')
  const lab: SharedLab = { state: s }
  const c = new IosConsole(lab, r1.id)
  c.lines('en', 'conf t', 'int g0/0', 'ip address 192.168.1.1 255.255.255.0', 'no shut')
  c.lines('int g0/1', 'ip address 192.168.2.1 255.255.255.0', 'no shut', 'exit')
  return { lab, c, pc1: pc1.id, pc2: pc2.id }
}

describe('listes d’accès', () => {
  it('étendue numérotée : bloque le ping, laisse passer le reste, compteurs', () => {
    const { lab, c, pc1, pc2 } = aclLab()
    expect(reaches(lab.state, pc1, '192.168.2.10')).toBe(true)
    c.lines(
      'access-list 101 deny icmp 192.168.1.0 0.0.0.255 host 192.168.2.10',
      'access-list 101 permit ip any any',
      'int g0/0',
      'ip access-group 101 in',
      'end'
    )
    // Le ping depuis la console du poste : trace de Simulation expliquée, effets appliqués
    const session = createShellSession(lab.state, pc1, 'cmd')
    const r = executeLine(lab.state, session, 'ping 192.168.2.10')
    const notes = r.trace?.events.map((e) => e.note ?? '') ?? []
    expect(
      notes.some((n) =>
        n.includes('refuse le paquet à l’entrée de GigabitEthernet0/0 : liste d’accès 101, entrée 10')
      )
    ).toBe(true)
    expect(r.output.map((l) => l.text).join('\n')).not.toContain('Réponse de 192.168.2.10')
    lab.state = r.state
    // Le reste du trafic passe (permit ip any any) ; la réponse à un ping de PC2 est aussi filtrée, comme sur IOS
    expect(reaches(lab.state, pc1, '192.168.1.1')).toBe(true)
    expect(reaches(lab.state, pc2, '192.168.1.10')).toBe(false)
    const show = c.run('show access-lists')
    expect(show[0]).toBe('Extended IP access list 101')
    expect(show[1]).toMatch(
      /^ {4}10 deny icmp 192\.168\.1\.0 0\.0\.0\.255 host 192\.168\.2\.10 \(\d+ match(es)?\)$/
    )
    expect(show[2]).toBe('    20 permit ip any any')
    const run = c.run('show running-config')
    expect(run).toContain('access-list 101 deny icmp 192.168.1.0 0.0.0.255 host 192.168.2.10')
    expect(run).toContain(' ip access-group 101 in')
  })

  it('refus implicite final et sortie (out)', () => {
    const { lab, c, pc1 } = aclLab()
    c.lines('access-list 5 permit 10.9.9.9', 'int g0/1', 'ip access-group 5 out', 'end')
    expect(reaches(lab.state, pc1, '192.168.2.10')).toBe(false)
    const session = createShellSession(lab.state, pc1, 'cmd')
    const notes =
      executeLine(lab.state, session, 'ping 192.168.2.10').trace?.events.map((e) => e.note ?? '') ?? []
    expect(notes.some((n) => n.includes('refus implicite final (deny any)'))).toBe(true)
    c.lines('conf t', 'int g0/1', 'no ip access-group 5 out', 'end')
    expect(reaches(lab.state, pc1, '192.168.2.10')).toBe(true)
  })

  it('standard nommée : mode config-std-nacl, numéros de séquence, suppression', () => {
    const { lab, c, pc1 } = aclLab()
    c.lines('conf t', 'ip access-list standard BLOQUE')
    expect(c.prompt).toBe('R1(config-std-nacl)#')
    c.lines('deny 192.168.1.0 0.0.0.255', 'permit any')
    c.lines('15 deny host 192.168.1.99', 'exit', 'int g0/1', 'ip access-group BLOQUE out', 'end')
    expect(c.run('show access-lists BLOQUE').slice(0, 4)).toEqual([
      'Standard IP access list BLOQUE',
      '    10 deny 192.168.1.0, wildcard bits 0.0.0.255',
      '    15 deny 192.168.1.99',
      '    20 permit any'
    ])
    expect(reaches(lab.state, pc1, '192.168.2.10')).toBe(false)
    c.lines('conf t', 'ip access-list standard BLOQUE', 'no 10', 'end')
    expect(reaches(lab.state, pc1, '192.168.2.10')).toBe(true)
    expect(c.run('show running-config')).toEqual(
      expect.arrayContaining([
        'ip access-list standard BLOQUE',
        ' deny host 192.168.1.99'.replace('host ', ''),
        ' permit any'
      ])
    )
  })

  it('étendue avec port : tcp eq www', () => {
    const { c } = aclLab()
    c.lines('access-list 120 permit tcp any host 192.168.2.10 eq www')
    expect(c.run('do show access-lists')).toEqual([
      'Extended IP access list 120',
      '    10 permit tcp any host 192.168.2.10 eq www'
    ])
  })

  it('commande étendue incomplète', () => {
    const { c } = aclLab()
    expect(c.run('access-list 101 permit icmp 1.1.1.1 0.0.0.0')).toEqual(['% Incomplete command.', ''])
  })
})

describe('port-security', () => {
  /** SW1 (2960), PC1 sur Fa0/1 ; PC2 libre, à brancher sur Fa0/1 à la place de PC1. */
  function switchLab() {
    const sw = addIos(createLab(), 'c2960')
    const pc1 = add(sw.state, 'client')
    const pc2 = add(pc1.state, 'client')
    const s = cable(pc2.state, pc1.id, 0, sw.id, 0)
    const lab: SharedLab = { state: s }
    return { lab, c: new IosConsole(lab, sw.id), pc1: pc1.id, pc2: pc2.id, sw: sw.id }
  }

  /** Débranche le poste de Fa0/1 et y branche l'autre (même console, même lab). */
  function swap(lab: SharedLab, sw: string, to: string): void {
    const link = Object.values(lab.state.links)[0]!
    lab.state = unwrap(disconnect(lab.state, link.id)).state
    const port = lab.state.devices[sw]!.interfaces[0]!.id
    lab.state = unwrap(
      connect(
        lab.state,
        { deviceId: to, ifaceId: lab.state.devices[to]!.interfaces[0]!.id },
        { deviceId: sw, ifaceId: port }
      )
    ).state
    // Mode Temps réel : les tâches de fond (apprentissage, violation) passent après la modification
    lab.state = runBackgroundTasks(lab.state).state
  }

  const configure = (c: IosConsole, ...extra: string[]) =>
    c.lines(
      'en',
      'conf t',
      'int fa0/1',
      'switchport mode access',
      'switchport port-security',
      ...extra,
      'end'
    )

  it('apprentissage sticky enregistré dans la configuration', () => {
    const { c } = switchLab()
    configure(c, 'switchport port-security mac-address sticky')
    const brief = c.run('show port-security')
    expect(brief[3]).toBe('      Fa0/1              1            1                  0         Shutdown')
    const run = c.run('show running-config')
    expect(run).toEqual(
      expect.arrayContaining([' switchport port-security', ' switchport port-security mac-address sticky'])
    )
    expect(
      run.some((l) =>
        /^ switchport port-security mac-address sticky [0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}$/.test(l)
      )
    ).toBe(true)
  })

  it('violation shutdown : un autre poste met le port en err-disabled', () => {
    const { lab, c, pc2, sw } = switchLab()
    configure(c, 'switchport port-security mac-address sticky')
    swap(lab, sw, pc2)
    const out = c.run('show interfaces fa0/1')
    expect(out.join('\n')).toContain('FastEthernet0/1 is down, line protocol is down (err-disabled)')
    const status = c.run('show port-security interface fa0/1')
    expect(status).toContain('Port Status                : Secure-shutdown')
    expect(status).toContain('Security Violation Count   : 1')
    expect(c.run('show ip interface brief').join('\n')).not.toContain('administratively')
    // shutdown puis no shutdown rétablit le port, la nouvelle adresse est refusée tant que maximum atteint
    c.lines('conf t', 'int fa0/1', 'shutdown', 'no shutdown', 'end')
    expect(c.run('show interfaces fa0/1')[0]).toContain('is down')
  })

  it('violation restrict : le port reste actif, compteur incrémenté', () => {
    const { lab, c, pc2, sw } = switchLab()
    configure(c, 'switchport port-security violation restrict', 'switchport port-security mac-address sticky')
    swap(lab, sw, pc2)
    const out = c.run('show port-security interface fa0/1')
    expect(out).toContain('Violation Mode             : Restrict')
    expect(out).toContain('Security Violation Count   : 1')
    expect(c.run('show interfaces fa0/1')[0]).not.toContain('err-disabled')
  })

  it('critère de lab iosPortSecurity : port sécurisé, violation constatée ou non (audit T-02)', () => {
    const { lab, c, pc2, sw } = switchLab()
    const name = lab.state.devices[sw]!.name
    const check = (violated?: boolean, iface = 'Fa0/1') =>
      evaluateCheck(lab.state, {
        type: 'iosPortSecurity',
        device: name,
        interface: iface,
        ...(violated === undefined ? {} : { violated })
      })
    // Port-security absente : le critère échoue dans les deux sens
    expect(check(true)).toBe(false)
    expect(check(false)).toBe(false)

    configure(c, 'switchport port-security mac-address sticky')
    expect(check(false)).toBe(true)
    expect(check(true)).toBe(false)
    // Port voisin sans port-security, interface inconnue
    expect(check(false, 'Fa0/2')).toBe(false)
    expect(check(false, 'Fa0/99')).toBe(false)

    swap(lab, sw, pc2)
    expect(check(true)).toBe(true)
    // violated vaut true par défaut
    expect(check()).toBe(true)
    expect(check(false)).toBe(false)
  })

  it('maximum 2 : deux adresses acceptées', () => {
    const { c } = switchLab()
    expect(configure(c, 'switchport port-security maximum 2').length).toBeGreaterThan(0)
    expect(c.run('show port-security interface fa0/1')).toContain('Maximum MAC Addresses      : 2')
  })

  it('refusé sur un port trunk', () => {
    const { c } = switchLab()
    c.lines('en', 'conf t', 'int fa0/2', 'switchport mode trunk')
    expect(c.run('switchport port-security')).toEqual(['Command rejected: Fa0/2 is a trunk port.'])
  })
})

describe('SSH, comptes et lignes', () => {
  const console1 = () => {
    const r = addIos(createLab(), 'c1921')
    return new IosConsole(r.state, r.id)
  }

  it('crypto key generate rsa exige un nom de domaine', () => {
    const c = console1()
    c.lines('en', 'conf t')
    expect(c.run('crypto key generate rsa modulus 1024')).toEqual(['% Please define a domain-name first.'])
  })

  it('configuration SSH complète et running-config', () => {
    const c = console1()
    c.lines('en', 'conf t', 'ip domain-name lab.local')
    expect(c.run('crypto key generate rsa modulus 1024')).toEqual([
      'The name for the keys will be: R1.lab.local',
      '% Generating 1024 bit RSA keys, keys will be non-exportable...',
      '[OK] (elapsed time was 1 seconds)',
      '%SSH-5-ENABLED: SSH 1.99 has been enabled'
    ])
    c.lines('ip ssh version 2', 'username admin privilege 15 secret Cisco123', 'line vty 0 4')
    c.lines('transport input ssh', 'login local', 'exit', 'line console 0', 'password cisco', 'login', 'end')
    const run = c.run('show running-config')
    expect(run).toContain('ip domain name lab.local')
    expect(run).toContain('ip ssh version 2')
    expect(run.some((l) => /^username admin privilege 15 secret 5 \$1\$\S{4}\$\S{22}$/.test(l))).toBe(true)
    const at = run.indexOf('line vty 0 4')
    expect(run.slice(at, at + 3)).toEqual(['line vty 0 4', ' login local', ' transport input ssh'])
    const con = run.indexOf('line con 0')
    expect(run.slice(con, con + 3)).toEqual(['line con 0', ' password cisco', ' login'])
    expect(c.run('show ip ssh')[0]).toBe('SSH Enabled - version 2.0')
  })

  it('génération interactive du module RSA', () => {
    const c = console1()
    c.lines('en', 'conf t', 'ip domain-name lab.local')
    expect(() => c.run('crypto key generate rsa')).toThrow('How many bits in the modulus [512]:')
    expect(c.run('crypto key generate rsa', ['2048']).join('\n')).toContain('Generating 2048 bit RSA keys')
    expect(c.run('crypto key generate rsa', ['100'])).toContain('% A decimal number between 360 and 4096.')
  })

  it('SSH désactivé tant qu’aucune clé n’existe', () => {
    const c = console1()
    c.run('en')
    expect(c.run('show ip ssh')[0]).toBe('SSH Disabled - version 1.99')
  })

  it('transport input réservé aux lignes vty', () => {
    const c = console1()
    c.lines('en', 'conf t', 'line console 0')
    expect(c.run('transport input ssh')[1]).toBe("% Invalid input detected at '^' marker.")
  })

  it('service password-encryption : mots de passe de ligne en type 7', () => {
    const c = console1()
    c.lines('en', 'conf t', 'line vty 0 4', 'password secret', 'login', 'exit')
    expect(c.run('do show running-config')).toContain(' password secret')
    c.lines('service password-encryption', 'end')
    const run = c.run('show running-config')
    expect(run).toContain('service password-encryption')
    expect(run.some((l) => /^ password 7 [0-9A-F]{4,}$/.test(l))).toBe(true)
    expect(run).not.toContain(' password secret')
  })
})
