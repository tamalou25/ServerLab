/**
 * Comportement de la console pfSense (v2.10, #247) : une modification faite à la console change l'état
 * que voit le moteur de règles et de routage ; commandes non simulées : message honnête.
 */
import { describe, expect, it } from 'vitest'
import { command, dispatch, ping, unwrap, type LabState } from '@engine/index'
import { applyTraceEffects } from '@engine/ios/registry'
import { fwOf, lab, open, type, type Session } from './console'

const pingOk = (s: LabState, from: string, to: string): boolean => {
  const r = ping(s, from, to, { count: 1 })
  return r.ok && r.value.success
}
/** Échange réel (effets durables : états, journal) d'un poste vers une adresse. */
const exchange = (s: LabState, from: string, to: string, count = 1): LabState => {
  const r = ping(s, from, to, { count })
  if (!r.ok) throw new Error(r.error.message)
  return applyTraceEffects(s, r.value.trace)
}
const sh = (s: LabState, id: string): Session => type(open(s, id), '8')
const out = (before: Session, after: Session): string => after.lines.slice(before.lines.length + 1).join('\n')
const text = (s: Session): string => s.lines.join('\n')

describe('console pfSense : effets sur le moteur', () => {
  it('option 2 : la nouvelle adresse LAN est celle du routage et du filtrage', () => {
    const { s, id, pc } = lab()
    expect(pingOk(s, pc, '192.168.1.1')).toBe(true)
    const done = type(open(s, id), '2', ['2', 'n', '192.168.1.254/24', '', 'n', '', 'n', 'n', ''])
    expect(fwOf(done.state, id).interfaces[1]?.address).toBe('192.168.1.254')
    expect(pingOk(done.state, pc, '192.168.1.1')).toBe(false)
    expect(pingOk(done.state, pc, '192.168.1.254')).toBe(true)
    expect(text(done)).toContain('The IPv4 LAN address has been set to 192.168.1.254/24')
  })

  it('option 2 : passerelle par défaut, serveur DHCP et protocole du webConfigurator enregistrés', () => {
    const { s, id } = lab()
    const wan = type(open(s, id), '2', [
      '1',
      'n',
      '198.51.100.2',
      '24',
      '198.51.100.1',
      'y',
      'n',
      '',
      'n',
      'n',
      ''
    ])
    const fw = fwOf(wan.state, id)
    expect(fw.pf.gateways.find((g) => g.address === '198.51.100.1')?.isDefault).toBe(true)
    expect(fw.interfaces[0]?.address).toBe('198.51.100.2')
    const lan = type(open(s, id), '2', [
      '2',
      'n',
      '192.168.1.1/24',
      '',
      'n',
      '',
      'y',
      '192.168.1.100',
      '192.168.1.199',
      'y',
      ''
    ])
    expect(fwOf(lan.state, id).pf.dhcp.lan).toMatchObject({
      enabled: true,
      rangeFrom: '192.168.1.100',
      rangeTo: '192.168.1.199'
    })
    expect(fwOf(lan.state, id).pf.webProtocol).toBe('http')
  })

  it('option 2 : saisies invalides redemandées, DHCP client non simulé (état inchangé)', () => {
    const { s, id } = lab()
    const bad = type(open(s, id), '2', [
      '2',
      'n',
      'abc',
      '192.168.1.1',
      '99',
      '24',
      '',
      'n',
      '',
      'n',
      'n',
      ''
    ])
    expect(text(bad)).toContain('Enter the new LAN IPv4 subnet bit count (1 to 32):')
    const dhcp = type(open(s, id), '2', ['2', 'y'])
    expect(text(dhcp)).toContain('existe réellement mais n’est pas simulée')
    expect(dhcp.state).toBe(s)
  })

  it('option 1 : échanger WAN et LAN déplace la configuration IP avec l’interface logique', () => {
    const { s, id } = lab()
    const done = type(open(s, id), '1', ['n', 'em1', 'em0', 'em2', 'y'])
    const fw = fwOf(done.state, id)
    expect(fw.pf.assignments.find((a) => a.key === 'wan')?.ifaceId).toBe(fw.interfaces[1]?.id)
    expect(fw.interfaces[1]?.address).toBe('203.0.113.2')
    expect(fw.interfaces[0]?.address).toBe('192.168.1.1')
    expect(text(done)).toContain('WAN  -> em1')
  })

  it('option 1 : retirer le LAN supprime son adresse', () => {
    const { s, id } = lab()
    const done = type(open(s, id), '1', ['n', 'em0', '', 'y', 'n'])
    const fw = fwOf(done.state, id)
    expect(fw.pf.assignments.find((a) => a.key === 'lan')?.ifaceId).toBeNull()
    expect(fw.interfaces[1]?.address).toBeNull()
  })

  it('option 1 : doublon, nom invalide et auto-détection', () => {
    const { s, id } = lab()
    expect(text(type(open(s, id), '1', ['n', 'em0', 'em0', '', 'y']))).toContain(
      'Error: The same interface name cannot be assigned twice!'
    )
    expect(text(type(open(s, id), '1', ['n', 'em9', 'a']))).toContain("Invalid interface name 'em9'")
    expect(text(type(open(s, id), '1', ['n', 'a']))).toContain('auto-détection')
  })

  it('option 3 : le mot de passe retrouve la valeur d’usine, comme la commande pf.resetAdminPassword', () => {
    const { s, id } = lab()
    const withPassword = structuredClone(s)
    const fw = withPassword.devices[id]
    if (fw?.kind === 'firewall') fw.pf.adminPassword = 'secret'
    const viaConsole = type(open(withPassword, id), '3', ['y', ''])
    const viaCommand = unwrap(dispatch(withPassword, command('pf.resetAdminPassword', id))).state
    expect(fwOf(viaConsole.state, id).pf.adminPassword).toBeUndefined()
    expect(fwOf(viaConsole.state, id).pf).toEqual(fwOf(viaCommand, id).pf)
    const refused = type(open(withPassword, id), '3', ['n'])
    expect(fwOf(refused.state, id).pf.adminPassword).toBe('secret')
  })

  it('option 4 : valeurs d’usine (LAN 192.168.1.1/24, une règle) et fin de session', () => {
    const { s, id } = lab()
    const withRule = unwrap(dispatch(s, command('pf.addRule', id, { iface: 'opt1', action: 'pass' }))).state
    expect(fwOf(withRule, id).pf.rules.length).toBe(2)
    const done = type(open(withRule, id), '4', ['y'])
    expect(done.exited).toBe(true)
    expect(fwOf(done.state, id).pf.rules.map((r) => r.iface)).toEqual(['lan'])
    expect(fwOf(done.state, id).interfaces.map((n) => n.address)).toEqual([null, '192.168.1.1', null])
    const declined = type(open(withRule, id), '4', ['n'])
    expect(declined.exited).toBe(false)
    expect(fwOf(declined.state, id).pf.rules.length).toBe(2)
  })

  it('option 5 : le redémarrage vide la table d’états et garde le journal', () => {
    const { s, id, pc, isp } = lab()
    const st = exchange(exchange(s, pc, '203.0.113.1'), isp, '203.0.113.2')
    expect(fwOf(st, id).pf.states.length).toBeGreaterThan(0)
    expect(fwOf(st, id).pf.log.length).toBeGreaterThan(0)
    const done = type(open(st, id), '5', ['y'])
    expect(done.exited).toBe(true)
    expect(fwOf(done.state, id).pf.states).toEqual([])
    expect(fwOf(done.state, id).pf.log.length).toBe(fwOf(st, id).pf.log.length)
    const single = type(open(st, id), '5', ['S'])
    expect(single.exited).toBe(false)
    expect(text(single)).toContain('n’est pas simulée')
  })

  it('option 7 : ping depuis le pare-feu ; adresse injoignable : aucune réponse', () => {
    const { s, id } = lab()
    const ok = type(open(s, id), '7', ['192.168.1.10', ''])
    expect(text(ok)).toContain('3 packets transmitted, 3 packets received, 0.0% packet loss')
    const lost = type(open(s, id), '7', ['10.9.9.9', ''])
    expect(text(lost)).toMatch(/0 packets received|No route to host/)
    expect(text(type(open(s, id), '7', ['pfsense.exemple']))).toContain('résolution de noms')
  })

  it('options du menu non simulées, option inconnue et sortie', () => {
    const { s, id } = lab()
    const o = open(s, id)
    for (const n of ['6', '9', '11', '12', '13', '14', '15', '16'])
      expect(text(type(o, n))).toContain('n’est pas simulé dans ServerLab')
    expect(text(type(o, '99'))).toContain('Enter an option')
    expect(type(o, '0').exited).toBe(true)
    expect(type(o, '').exited).toBe(true)
  })
})

describe('console pfSense : shell', () => {
  it('pfctl -d / -e changent le filtrage vu par le moteur', () => {
    const { s, id, pc } = lab()
    // Sans la règle d’usine du LAN, tout est refusé
    const denied = unwrap(dispatch(s, command('pf.removeRule', id, 'pf-default-lan'))).state
    expect(pingOk(denied, pc, '203.0.113.2')).toBe(false)
    const off = type(sh(denied, id), 'pfctl -d')
    expect(pingOk(off.state, pc, '203.0.113.2')).toBe(true)
    const on = type(off, 'pfctl -e')
    expect(pingOk(on.state, pc, '203.0.113.2')).toBe(false)
    expect(out(off, on)).toContain('pf enabled')
    expect(type(on, 'pfctl -e').lines.at(-1)).toBe('pfctl: pf already enabled')
  })

  it('pfctl -sr suit les règles de l’état, -ss et -si la table d’états', () => {
    const { s, id, pc } = lab()
    const added = unwrap(
      dispatch(
        s,
        command('pf.addRule', id, {
          iface: 'lan',
          action: 'block',
          protocol: 'tcp',
          destinationPort: { from: 3389, to: 3389 },
          descr: 'Pas de RDP',
          log: true
        })
      )
    ).state
    const base = sh(added, id)
    expect(out(base, type(base, 'pfctl -sr'))).toContain(
      'block drop in log quick on em1 inet proto tcp from any to any port = ms-wbt-server label "USER_RULE: Pas de RDP"'
    )
    const exchanged = exchange(added, pc, '203.0.113.1')
    const b2 = sh(exchanged, id)
    expect(out(b2, type(b2, 'pfctl -ss'))).toContain('em1 icmp 203.0.113.1 <- 192.168.1.10')
    const disabled = type(type(b2, 'pfctl -d'), 'pfctl -si')
    expect(text(disabled)).toContain('Status: Disabled')
    expect(text(disabled)).toMatch(/current entries\s+1/)
  })

  it('filter.log : cat, tail, filterparser.php ; clog expliqué', () => {
    const { s, id, isp } = lab()
    const st = exchange(s, isp, '203.0.113.2', 2)
    const base = sh(st, id)
    const cat = out(base, type(base, 'cat /var/log/filter.log'))
    expect(cat.split('\n').length).toBe(fwOf(st, id).pf.log.length)
    expect(cat).toMatch(/filterlog: \d+,16777216,,\d+,em0,match,block,in,4,/)
    expect(out(base, type(base, 'tail -n 1 /var/log/filter.log')).split('\n')).toHaveLength(1)
    expect(out(base, type(base, 'cat /var/log/filter.log | grep nothing'))).toBe('')
    expect(out(base, type(base, 'cat /var/log/filter.log | filterparser.php'))).toMatch(
      / block em0 ICMP 203\.0\.113\.1 203\.0\.113\.2$/m
    )
    expect(out(base, type(base, 'clog /var/log/filter.log'))).toContain('texte')
    expect(out(base, type(base, 'cat /var/log/system.log'))).toContain('pas simulé')
  })

  it('commandes et options hors périmètre : message honnête', () => {
    const { s, id } = lab()
    const base = sh(s, id)
    expect(out(base, type(base, 'ls'))).toContain('non simulée')
    expect(out(base, type(base, 'pfctl -sn'))).toContain('existe réellement')
    expect(out(base, type(base, 'pfctl -vvsr'))).toContain('existe réellement')
    expect(out(base, type(base, 'pfctl'))).toContain('usage: pfctl')
    expect(out(base, type(base, 'netstat -an'))).toContain('existe réellement')
    expect(out(base, type(base, 'ifconfig em9'))).toBe('ifconfig: interface em9 does not exist')
    expect(out(base, type(base, 'foobar'))).toBe('foobar: Command not found.')
  })

  it('exit ramène au menu, ifconfig reflète câbles et adresses', () => {
    const { s, id } = lab()
    const base = sh(s, id)
    expect(out(base, type(base, 'ifconfig em2'))).toContain('status: no carrier')
    expect(type(base, 'exit').session.pfsense?.mode).toBe('menu')
    const moved = type(open(s, id), '2', ['3', 'n', '172.16.5.1/24', '', 'n', '', 'n', 'n', ''])
    const b2 = sh(moved.state, id)
    expect(out(b2, type(b2, 'ifconfig em2'))).toContain('inet 172.16.5.1 netmask 0xffffff00')
  })
})
