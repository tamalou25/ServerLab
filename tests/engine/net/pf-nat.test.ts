/**
 * NAT du pare-feu pfSense (v2.10, #244) : NAT sortant automatique / hybride / manuel, redirections de
 * port avec règle associée vers un serveur de la DMZ, traduction visible dans la trace et la table d'états.
 */
import { describe, expect, it } from 'vitest'
import {
  addPfOutboundNat,
  addPfPortForward,
  dispatch,
  command,
  ping,
  removePfPortForward,
  serverExchange,
  setFirewallProfile,
  setPfNatMode,
  unwrap,
  updatePfPortForward,
  type LabState,
  type PacketTrace
} from '@engine/index'
import { applyTraceEffects } from '@engine/ios/registry'
import { build, cable, setIp } from '../helpers'

/**
 * FW1 : em0 WAN 8.8.8.1/24 (PCW 8.8.8.8), em1 LAN 192.168.1.1/24 (PC1 .10), em2 DMZ 172.16.0.1/24 (SRV1 .10).
 * Aucune route par défaut : les réseaux joints sont tous directement connectés (passerelle de #245 non utilisée).
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
  // PCW sans passerelle : comme Internet, il ne sait pas répondre à une adresse privée
  s = setIp(s, ids.PCW!, 0, '8.8.8.8/24')
  s = setIp(s, ids.PC1!, 0, '192.168.1.10/24', '192.168.1.1')
  s = setIp(s, ids.SRV1!, 0, '172.16.0.10/24', '172.16.0.1')
  s = unwrap(setFirewallProfile(s, ids.SRV1!, ['Domain', 'Private', 'Public'], { enabled: false })).state
  return { s, ids }
}

const fwOf = (s: LabState, id: string) => {
  const d = s.devices[id]
  if (!d || d.kind !== 'firewall') throw new Error('pas un pare-feu')
  return d
}
const notes = (t: PacketTrace) => t.events.map((e) => e.note).join('\n')
const ping1 = (s: LabState, from: string, to: string) => {
  const r = ping(s, from, to, { count: 1 })
  if (!r.ok) throw new Error(r.error.message)
  return r.value
}
const web = (s: LabState, from: string, dst: string, port = 80) =>
  serverExchange(s, from, dst, {
    protocol: 'HTTP',
    port,
    request: `GET / HTTP/1.1 (${dst})`,
    reply: 'HTTP/1.1 200 OK',
    fields: []
  })

describe('NAT sortant', () => {
  it('automatique : le LAN joint le WAN avec l’adresse du WAN, la réponse est retraduite', () => {
    const { s, ids } = topo()
    const r = ping1(s, ids.PC1!, '8.8.8.8')
    expect(r.success).toBe(true)
    const text = notes(r.trace)
    expect(text).toContain('NAT sortant automatique, réseau LAN')
    expect(text).toContain('traduit l’adresse source 192.168.1.10 en 8.8.8.1')
    expect(text).toContain('retraduit l’adresse de destination 8.8.8.1 en 192.168.1.10')
  })

  it('la DMZ est aussi traduite en mode automatique', () => {
    const { s, ids } = topo()
    // Une règle sur la DMZ laisse sortir SRV1 vers le WAN
    const withRule = unwrap(
      dispatch(s, command('pf.addRule', ids.FW1!, { iface: 'opt1', action: 'pass' }))
    ).state
    const r = ping1(withRule, ids.SRV1!, '8.8.8.8')
    expect(r.success).toBe(true)
    expect(notes(r.trace)).toContain('NAT sortant automatique, réseau DMZ')
  })

  it('mode désactivé : la source privée sort telle quelle et la réponse ne revient pas', () => {
    const { s, ids } = topo()
    const off = unwrap(setPfNatMode(s, ids.FW1!, 'disabled')).state
    const r = ping1(off, ids.PC1!, '8.8.8.8')
    expect(r.success).toBe(false)
    expect(notes(r.trace)).not.toContain('NAT sortant')
  })

  it('mode manuel sans règle : pas de traduction ; avec règle, la règle s’applique', () => {
    const { s, ids } = topo()
    const manual = unwrap(setPfNatMode(s, ids.FW1!, 'manual')).state
    expect(ping1(manual, ids.PC1!, '8.8.8.8').success).toBe(false)
    const rule = unwrap(
      addPfOutboundNat(manual, ids.FW1!, {
        source: { type: 'network', address: '192.168.1.0', prefixLength: 24 },
        descr: 'LAN vers WAN'
      })
    )
    const r = ping1(rule.state, ids.PC1!, '8.8.8.8')
    expect(r.success).toBe(true)
    expect(notes(r.trace)).toContain('règle manuelle « LAN vers WAN »')
    // Le mode manuel ne traduit pas la DMZ : aucune règle ne la couvre
    expect(fwOf(rule.state, ids.FW1!).pf.nat.outbound).toHaveLength(1)
  })

  it('hybride : règle manuelle d’abord, automatique ensuite ; adresse de traduction explicite', () => {
    const { s, ids } = topo()
    const hybrid = unwrap(setPfNatMode(s, ids.FW1!, 'hybrid')).state
    const auto = ping1(hybrid, ids.PC1!, '8.8.8.8')
    expect(auto.success).toBe(true)
    expect(notes(auto.trace)).toContain('NAT sortant automatique')
    const manual = unwrap(
      addPfOutboundNat(hybrid, ids.FW1!, {
        source: { type: 'address', address: '192.168.1.10' },
        translation: '8.8.8.1',
        descr: 'PC1'
      })
    ).state
    expect(notes(ping1(manual, ids.PC1!, '8.8.8.8').trace)).toContain('règle manuelle « PC1 »')
  })

  it('la table d’états garde la traduction après validation de la trace', () => {
    const { s, ids } = topo()
    const r = ping1(s, ids.PC1!, '8.8.8.8')
    const states = fwOf(applyTraceEffects(s, r.trace), ids.FW1!).pf.states
    expect(states).toHaveLength(1)
    expect(states[0]).toMatchObject({
      src: '192.168.1.10',
      dst: '8.8.8.8',
      translation: '192.168.1.10 → 8.8.8.1'
    })
  })

  it('une règle de NAT sortant invalide est refusée en français', () => {
    const { s, ids } = topo()
    const bad = addPfOutboundNat(s, ids.FW1!, {
      source: { type: 'any' },
      translation: 'pas-une-ip'
    })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error.message).toContain('adresse de traduction')
    expect(setPfNatMode(s, ids.FW1!, 'bizarre' as never).ok).toBe(false)
  })
})

describe('redirection de port vers la DMZ', () => {
  const forward = () => {
    const { s, ids } = topo()
    const added = unwrap(
      addPfPortForward(s, ids.FW1!, {
        protocol: 'tcp',
        destinationPort: { from: 80, to: 80 },
        targetAddress: '172.16.0.10',
        descr: 'Web DMZ'
      })
    )
    return { s: added.state, ids, id: added.value }
  }

  it('crée la règle de filtrage associée', () => {
    const { s, ids, id } = forward()
    const fw = fwOf(s, ids.FW1!)
    const fwd = fw.pf.nat.portForwards.find((f) => f.id === id)!
    const rule = fw.pf.rules.find((r) => r.id === fwd.ruleId)!
    expect(rule).toMatchObject({
      iface: 'wan',
      action: 'pass',
      protocol: 'tcp',
      destination: { type: 'address', address: '172.16.0.10' },
      destinationPort: { from: 80, to: 80 }
    })
  })

  it('un client du WAN joint le serveur de la DMZ par l’adresse du WAN : traduction dans la trace', () => {
    const { s, ids } = forward()
    const r = web(s, ids.PCW!, '8.8.8.1')
    expect(r.ok).toBe(true)
    const text = notes(r.trace)
    expect(text).toContain('traduit la destination 8.8.8.1:80 en 172.16.0.10:80')
    expect(text).toContain('NAT Web DMZ')
    expect(text).toContain('la réponse part avec la source 8.8.8.1')
    const states = fwOf(applyTraceEffects(s, r.trace), ids.FW1!).pf.states
    expect(states.map((st) => st.translation)).toContain('8.8.8.1:80 → 172.16.0.10:80')
  })

  it('port externe différent du port interne', () => {
    const { s, ids } = topo()
    const added = unwrap(
      addPfPortForward(s, ids.FW1!, {
        protocol: 'tcp',
        destinationPort: { from: 8080, to: 8080 },
        targetAddress: '172.16.0.10',
        targetPort: 80
      })
    ).state
    const r = web(added, ids.PCW!, '8.8.8.1', 8080)
    expect(r.ok).toBe(true)
    expect(notes(r.trace)).toContain('8.8.8.1:8080 en 172.16.0.10:80')
  })

  it('sans redirection, ou sur un autre port, le WAN est refusé par défaut', () => {
    const { s, ids } = forward()
    expect(web(s, ids.PCW!, '8.8.8.1', 443).ok).toBe(false)
    const { s: bare } = topo()
    expect(web(bare, ids.PCW!, '8.8.8.1').ok).toBe(false)
  })

  it('sans règle associée, le filtrage refuse le paquet traduit', () => {
    const { s, ids } = topo()
    const added = unwrap(
      addPfPortForward(s, ids.FW1!, {
        protocol: 'tcp',
        destinationPort: { from: 80, to: 80 },
        targetAddress: '172.16.0.10',
        associatedRule: false
      })
    ).state
    const r = web(added, ids.PCW!, '8.8.8.1')
    expect(r.ok).toBe(false)
    expect(notes(r.trace)).toContain('Default deny')
    expect(fwOf(added, ids.FW1!).pf.rules.some((x) => x.iface === 'wan')).toBe(false)
  })

  it('la mise à jour et la suppression suivent la règle associée', () => {
    const { s, ids, id } = forward()
    const off = unwrap(updatePfPortForward(s, ids.FW1!, id, { disabled: true })).state
    const fw = fwOf(off, ids.FW1!)
    expect(fw.pf.rules.find((r) => r.iface === 'wan')?.disabled).toBe(true)
    expect(web(off, ids.PCW!, '8.8.8.1').ok).toBe(false)
    const moved = unwrap(updatePfPortForward(s, ids.FW1!, id, { targetPort: 8000 })).state
    expect(fwOf(moved, ids.FW1!).pf.rules.filter((r) => r.iface === 'wan')).toHaveLength(1)
    expect(fwOf(moved, ids.FW1!).pf.rules.find((r) => r.iface === 'wan')?.destinationPort).toEqual({
      from: 8000,
      to: 8000
    })
    const gone = unwrap(removePfPortForward(s, ids.FW1!, id)).state
    expect(fwOf(gone, ids.FW1!).pf.nat.portForwards).toHaveLength(0)
    expect(fwOf(gone, ids.FW1!).pf.rules.some((r) => r.iface === 'wan')).toBe(false)
  })

  it('refuse un doublon, un port absent et une adresse invalide', () => {
    const { s, ids } = forward()
    const dup = addPfPortForward(s, ids.FW1!, {
      protocol: 'tcp',
      destinationPort: { from: 80, to: 80 },
      targetAddress: '172.16.0.11'
    })
    expect(dup.ok).toBe(false)
    if (!dup.ok) expect(dup.error.message).toContain('déjà redirigé')
    const badIp = addPfPortForward(s, ids.FW1!, {
      protocol: 'udp',
      destinationPort: { from: 53, to: 53 },
      targetAddress: '172.16.0.999'
    })
    expect(badIp.ok).toBe(false)
    const noPort = addPfPortForward(s, ids.FW1!, {
      protocol: 'tcp',
      destinationPort: null as never,
      targetAddress: '172.16.0.10'
    })
    expect(noPort.ok).toBe(false)
  })

  it('annulation par la commande nommée pf.addPortForward', () => {
    const { s, ids } = topo()
    const r = unwrap(
      dispatch(
        s,
        command('pf.addPortForward', ids.FW1!, {
          protocol: 'tcp',
          destinationPort: { from: 80, to: 80 },
          targetAddress: '172.16.0.10'
        })
      )
    )
    expect(fwOf(r.state, ids.FW1!).pf.nat.portForwards).toHaveLength(1)
  })
})
