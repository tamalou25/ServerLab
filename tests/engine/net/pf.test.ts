/**
 * Moteur de règles du pare-feu pfSense (v2.10, #243) : filtrage par interface à l'entrée, premier
 * résultat gagnant, refus par défaut, table d'états, Pass / Block / Reject, journal, alias, règles
 * automatiques (anti-verrouillage, réseaux privés et bogons du WAN).
 */
import { describe, expect, it } from 'vitest'
import {
  PF_LOG_LIMIT,
  addPfRule,
  clearPfLog,
  movePfRule,
  ping,
  removePfAlias,
  removePfRule,
  serverExchange,
  setPfAlias,
  setFirewallProfile,
  setPfBlockNetworks,
  updatePfRule,
  unwrap,
  type LabState,
  type PacketTrace,
  type PfRuleInput
} from '@engine/index'
import { applyTraceEffects } from '@engine/ios/registry'
import { build, cable, setIp } from '../helpers'

/**
 * FW1 : em0 WAN 8.8.8.1/24 (PCW 8.8.8.8), em1 LAN 192.168.1.1/24 (PC1 .10), em2 DMZ 172.16.0.1/24 (SRV1 .10).
 * Le WAN utilise une adresse publique : le blocage des réseaux privés du WAN est actif par défaut.
 */
function topo() {
  const { state, ids } = build([
    ['firewall', 'FW1'],
    ['client', 'PC1'],
    ['server', 'SRV1'],
    ['client', 'PCW']
  ])
  let s = cable(state, ids.PCW!, 0, ids.FW1!, 0)
  s = cable(s, ids.PC1!, 0, ids.FW1!, 1)
  s = cable(s, ids.SRV1!, 0, ids.FW1!, 2)
  s = setIp(s, ids.FW1!, 0, '8.8.8.1/24')
  s = setIp(s, ids.FW1!, 2, '172.16.0.1/24')
  s = setIp(s, ids.PCW!, 0, '8.8.8.8/24', '8.8.8.1')
  s = setIp(s, ids.PC1!, 0, '192.168.1.10/24', '192.168.1.1')
  s = setIp(s, ids.SRV1!, 0, '172.16.0.10/24', '172.16.0.1')
  // Pare-feu Windows de SRV1 désactivé : seul pfSense filtre dans ces tests
  s = unwrap(setFirewallProfile(s, ids.SRV1!, ['Domain', 'Private', 'Public'], { enabled: false })).state
  return { s, ids }
}

const fwOf = (s: LabState, id: string) => {
  const d = s.devices[id]
  if (!d || d.kind !== 'firewall') throw new Error('pas un pare-feu')
  return d
}

const add = (s: LabState, fw: string, input: PfRuleInput, before: string | null = null) =>
  unwrap(addPfRule(s, fw, input, before))

function doPing(s: LabState, from: string, to: string) {
  const r = ping(s, from, to, { count: 1 })
  if (!r.ok) throw new Error(r.error.message)
  return r.value
}

const notes = (t: PacketTrace) => t.events.map((e) => e.note).join('\n')

describe('règle d’usine et refus par défaut', () => {
  it('le LAN joint la DMZ (Default allow LAN to any) et la règle appliquée est dans la trace', () => {
    const { s, ids } = topo()
    const r = doPing(s, ids.PC1!, '172.16.0.10')
    expect(r.success).toBe(true)
    expect(notes(r.trace)).toContain('Default allow LAN to any rule')
    expect(notes(r.trace)).toContain('réponse d’une connexion suivie par la table d’états')
  })

  it('la DMZ ne joint pas le LAN : refus par défaut, journalisé', () => {
    const { s, ids } = topo()
    const r = doPing(s, ids.SRV1!, '192.168.1.10')
    expect(r.success).toBe(false)
    expect(notes(r.trace)).toContain('Default deny')
    expect(r.trace.effects?.some((e) => e.kind === 'pf-log' && e.data.ruleId === '')).toBe(true)
    const logged = applyTraceEffects(s, r.trace)
    const log = fwOf(logged, ids.FW1!).pf.log
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ action: 'block', iface: 'opt1', protocol: 'icmp', src: '172.16.0.10' })
  })

  it('un pare-feu éteint ou sans règle de retour : la réponse ne passe que par la table d’états', () => {
    const { s, ids } = topo()
    // La règle LAN passe l'aller ; sans état la réponse serait bloquée sur la DMZ (aucune règle)
    const r = doPing(s, ids.PC1!, '172.16.0.10')
    expect(r.success).toBe(true)
    const persisted = applyTraceEffects(s, r.trace)
    expect(fwOf(persisted, ids.FW1!).pf.states).toHaveLength(1)
  })
})

describe('ordre des règles : la première qui correspond gagne', () => {
  it('une règle Block placée après la règle d’usine ne s’applique pas, avant elle si', () => {
    const { s, ids } = topo()
    const fw = ids.FW1!
    const block = add(s, fw, {
      iface: 'lan',
      action: 'block',
      protocol: 'icmp',
      destination: { type: 'address', address: '172.16.0.10' },
      descr: 'Pas de ping vers SRV1'
    })
    expect(doPing(block.state, ids.PC1!, '172.16.0.10').success).toBe(true)
    const moved = unwrap(movePfRule(block.state, fw, block.value, 'pf-default-lan')).state
    const r = doPing(moved, ids.PC1!, '172.16.0.10')
    expect(r.success).toBe(false)
    expect(notes(r.trace)).toContain('Pas de ping vers SRV1')
    expect(notes(r.trace)).toContain('(Block)')
  })

  it('ajout avant une règle, désactivation, suppression', () => {
    const { s, ids } = topo()
    const fw = ids.FW1!
    const b = add(s, fw, { iface: 'lan', action: 'block' }, 'pf-default-lan')
    expect(fwOf(b.state, fw).pf.rules[0]!.id).toBe(b.value)
    expect(doPing(b.state, ids.PC1!, '172.16.0.10').success).toBe(false)
    const off = unwrap(updatePfRule(b.state, fw, b.value, { disabled: true })).state
    expect(doPing(off, ids.PC1!, '172.16.0.10').success).toBe(true)
    const gone = unwrap(removePfRule(b.state, fw, b.value)).state
    expect(fwOf(gone, fw).pf.rules).toHaveLength(1)
    expect(doPing(gone, ids.PC1!, '172.16.0.10').success).toBe(true)
  })

  it('les règles d’une interface ne s’appliquent pas aux autres', () => {
    const { s, ids } = topo()
    const r = add(s, ids.FW1!, { iface: 'opt1', action: 'block' })
    // L'aller est autorisé sur le LAN ; la réponse revient par la DMZ grâce à la table d'états
    expect(doPing(r.state, ids.PC1!, '172.16.0.10').success).toBe(true)
    expect(doPing(r.state, ids.SRV1!, '192.168.1.10').success).toBe(false)
  })

  it('port de destination et protocole : web autorisé, le reste refusé', () => {
    const { s, ids } = topo()
    const fw = ids.FW1!
    let st = unwrap(removePfRule(s, fw, 'pf-default-lan')).state
    st = add(st, fw, {
      iface: 'lan',
      action: 'pass',
      protocol: 'tcp',
      destination: { type: 'address', address: '172.16.0.10' },
      destinationPort: { from: 80, to: 80 },
      descr: 'Web vers SRV1'
    }).state
    const web = serverExchange(st, ids.PC1!, '172.16.0.10', {
      protocol: 'HTTP',
      port: 80,
      request: 'GET /',
      reply: '200',
      fields: []
    })
    const smb = serverExchange(st, ids.PC1!, '172.16.0.10', {
      protocol: 'SMB',
      port: 445,
      request: 'SMB',
      reply: 'SMB',
      fields: []
    })
    expect(web.ok).toBe(true)
    expect(smb.ok).toBe(false)
    expect(doPing(st, ids.PC1!, '172.16.0.10').success).toBe(false)
  })
})

describe('Block, Reject et journalisation', () => {
  const http = (s: LabState, from: string) =>
    serverExchange(s, from, '172.16.0.10', {
      protocol: 'HTTP',
      port: 80,
      request: 'GET /',
      reply: '200',
      fields: []
    })

  it('Block : aucune réponse ; Reject TCP : un TCP RST revient au client', () => {
    const { s, ids } = topo()
    const fw = ids.FW1!
    const blocked = add(s, fw, { iface: 'lan', action: 'block', protocol: 'tcp' }, 'pf-default-lan')
    const b = http(blocked.state, ids.PC1!)
    expect(b.ok).toBe(false)
    expect(b.trace.events.some((e) => e.summary.includes('TCP RST'))).toBe(false)

    const rejected = add(s, fw, { iface: 'lan', action: 'reject', protocol: 'tcp' }, 'pf-default-lan')
    const r = http(rejected.state, ids.PC1!)
    expect(r.ok).toBe(false)
    const rst = r.trace.events.find((e) => e.summary.includes('TCP RST'))
    expect(rst).toBeDefined()
    expect(rst!.outcome).toBe('delivered')
    expect(rst!.toDeviceId).toBe(ids.PC1)
    expect(notes(r.trace)).toContain('Reject')
  })

  it('Reject UDP : message ICMP « port inaccessible » renvoyé', () => {
    const { s, ids } = topo()
    const fw = ids.FW1!
    const rej = add(s, fw, { iface: 'lan', action: 'reject', protocol: 'udp' }, 'pf-default-lan')
    const r = serverExchange(rej.state, ids.PC1!, '172.16.0.10', {
      protocol: 'LDAP',
      port: 389,
      request: 'LDAP ping',
      reply: 'LDAP',
      fields: []
    })
    expect(r.ok).toBe(false)
    const icmp = r.trace.events.find((e) => e.summary.includes('port'))
    expect(icmp?.protocol).toBe('ICMP')
    expect(icmp?.outcome).toBe('delivered')
  })

  it('Reject ne s’applique pas à l’ICMP : le paquet est détruit en silence', () => {
    const { s, ids } = topo()
    const rej = add(s, ids.FW1!, { iface: 'lan', action: 'reject', protocol: 'icmp' }, 'pf-default-lan')
    const r = doPing(rej.state, ids.PC1!, '172.16.0.10')
    expect(r.success).toBe(false)
    expect(notes(r.trace)).toContain('ne peut pas être rejeté')
    expect(r.trace.events.filter((e) => e.protocol === 'ICMP' && e.outcome === 'delivered')).toHaveLength(0)
  })

  it('seules les règles marquées « log » alimentent le journal ; plafond PF_LOG_LIMIT', () => {
    const { s, ids } = topo()
    const fw = ids.FW1!
    const quiet = doPing(s, ids.PC1!, '172.16.0.10')
    expect(quiet.trace.effects?.some((e) => e.kind === 'pf-log')).toBeFalsy()

    const logged = add(s, fw, { iface: 'lan', action: 'pass', log: true, descr: 'Tout' }, 'pf-default-lan')
    const r = doPing(logged.state, ids.PC1!, '172.16.0.10')
    const after = applyTraceEffects(logged.state, r.trace)
    expect(fwOf(after, fw).pf.log).toEqual([
      expect.objectContaining({ ruleId: logged.value, action: 'pass', iface: 'lan', dst: '172.16.0.10' })
    ])

    // Plafond : les plus anciennes entrées sont éliminées
    const many: PacketTrace = {
      title: 'test',
      events: [],
      effects: Array.from({ length: PF_LOG_LIMIT + 20 }, (_, i) => ({
        kind: 'pf-log',
        deviceId: fw,
        data: {
          ruleId: '',
          action: 'block',
          iface: 'wan',
          protocol: 'tcp',
          src: `1.1.1.${i % 250}`,
          dst: 'x'
        }
      }))
    }
    const capped = fwOf(applyTraceEffects(s, many), fw).pf.log
    expect(capped).toHaveLength(PF_LOG_LIMIT)
    expect(unwrap(clearPfLog(applyTraceEffects(s, many), fw)).state).toBeDefined()
    expect(fwOf(unwrap(clearPfLog(applyTraceEffects(s, many), fw)).state, fw).pf.log).toEqual([])
  })

  it('déterminisme : deux évaluations identiques donnent la même trace', () => {
    const { s, ids } = topo()
    const a = doPing(s, ids.PC1!, '172.16.0.10')
    const b = doPing(s, ids.PC1!, '172.16.0.10')
    expect(b.trace).toEqual(a.trace)
  })
})

describe('règles automatiques', () => {
  it('WAN : une source privée est bloquée, puis passe quand la case est décochée et qu’une règle l’autorise', () => {
    const { s, ids } = topo()
    const fw = ids.FW1!
    let st = setIp(s, fw, 0, '192.168.100.1/24')
    st = setIp(st, ids.PCW!, 0, '192.168.100.8/24', '192.168.100.1')
    const r = doPing(st, ids.PCW!, '172.16.0.10')
    expect(r.success).toBe(false)
    expect(notes(r.trace)).toContain('Block private networks')
    expect(
      applyTraceEffects(st, r.trace).devices[fw]!.kind === 'firewall' &&
        fwOf(applyTraceEffects(st, r.trace), fw).pf.log.length
    ).toBe(1)

    st = unwrap(setPfBlockNetworks(st, fw, 'wan', { blockPrivate: false })).state
    // Sans règle WAN : refus par défaut
    expect(doPing(st, ids.PCW!, '172.16.0.10').success).toBe(false)
    st = add(st, fw, { iface: 'wan', action: 'pass', protocol: 'icmp' }).state
    expect(doPing(st, ids.PCW!, '172.16.0.10').success).toBe(true)
  })

  it('WAN : un bogon est bloqué', () => {
    const { s, ids } = topo()
    let st = setIp(s, ids.FW1!, 0, '203.0.113.1/24')
    st = setIp(st, ids.PCW!, 0, '203.0.113.8/24', '203.0.113.1')
    st = add(st, ids.FW1!, { iface: 'wan', action: 'pass' }).state
    const r = doPing(st, ids.PCW!, '172.16.0.10')
    expect(r.success).toBe(false)
    expect(notes(r.trace)).toContain('Block bogon networks')
  })

  it('anti-verrouillage : le LAN joint l’administration (443) même sans règle ; pas d’autres ports', () => {
    const { s, ids } = topo()
    const st = unwrap(removePfRule(s, ids.FW1!, 'pf-default-lan')).state
    const ex = (port: number) =>
      serverExchange(st, ids.PC1!, '192.168.1.1', {
        protocol: 'HTTP',
        port,
        request: 'GET /',
        reply: '200',
        fields: []
      })
    const ok = ex(443)
    expect(ok.ok).toBe(true)
    expect(notes(ok.trace)).toContain('Anti-Lockout')
    expect(ex(8080).ok).toBe(false)
    expect(doPing(st, ids.PC1!, '172.16.0.10').success).toBe(false)
  })
})

describe('alias', () => {
  it('un alias d’hôtes et un alias de réseaux, imbriqués, servent de destination', () => {
    const { s, ids } = topo()
    const fw = ids.FW1!
    let st = unwrap(removePfRule(s, fw, 'pf-default-lan')).state
    st = unwrap(
      setPfAlias(st, fw, { name: 'Serveurs', type: 'host', values: ['172.16.0.10'], descr: '' })
    ).state
    st = unwrap(
      setPfAlias(st, fw, { name: 'Zones', type: 'network', values: ['Serveurs', '10.9.0.0/16'], descr: '' })
    ).state
    expect(doPing(st, ids.PC1!, '172.16.0.10').success).toBe(false)
    st = add(st, fw, { iface: 'lan', action: 'pass', destination: { type: 'alias', name: 'Zones' } }).state
    expect(doPing(st, ids.PC1!, '172.16.0.10').success).toBe(true)
    const removal = removePfAlias(st, fw, 'Zones')
    expect(removal.ok).toBe(false)
    if (!removal.ok) expect(removal.error.message).toContain('utilisé par une règle')
  })
})

describe('erreurs métier en français', () => {
  const err = (r: { ok: boolean; error?: { code: string; message: string } }) => {
    if (r.ok) throw new Error('succès inattendu')
    return r.error!
  }

  it('refuse les paramètres invalides', () => {
    const { s, ids } = topo()
    const fw = ids.FW1!
    expect(
      err(addPfRule(s, fw, { iface: 'lan', source: { type: 'address', address: '300.1.1.1' } })).message
    ).toContain('n’est pas une adresse IPv4 valide')
    expect(
      err(addPfRule(s, fw, { iface: 'lan', source: { type: 'alias', name: 'Nope' } })).message
    ).toContain('n’existe pas')
    expect(
      err(addPfRule(s, fw, { iface: 'lan', protocol: 'icmp', destinationPort: { from: 80, to: 80 } })).message
    ).toContain('TCP, UDP')
    expect(
      err(addPfRule(s, fw, { iface: 'lan', protocol: 'tcp', destinationPort: { from: 90, to: 80 } })).message
    ).toContain('invalide')
    expect(err(removePfRule(s, fw, 'zzz')).message).toContain('n’existe pas')
    expect(err(movePfRule(s, fw, 'pf-default-lan', 'zzz')).code).toBe('RuleNotFound')
    expect(err(addPfRule(s, ids.PC1!, { iface: 'lan' })).message).toContain('n’est pas un pare-feu')
    expect(
      err(setPfAlias(s, fw, { name: '1mauvais', type: 'host', values: [], descr: '' })).message
    ).toContain('commence par une lettre')
    expect(err(setPfAlias(s, fw, { name: 'P', type: 'port', values: ['70000'], descr: '' })).code).toBe(
      'InvalidPort'
    )
  })
})
