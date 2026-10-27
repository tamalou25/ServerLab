/**
 * Interface web du pare-feu pfSense (v2.10, #246) : accès depuis le LAN (anti-verrouillage), refus depuis le
 * WAN et la DMZ selon les règles, redirection HTTP vers HTTPS, authentification, journal alimenté.
 */
import { describe, expect, it } from 'vitest'
import {
  PF_DEFAULT_PASSWORD,
  PF_LOGIN_ERROR,
  addPfRule,
  command,
  dispatch,
  pfAuthenticate,
  pfWebRequest,
  unwrap,
  type LabState,
  type PfWebResult
} from '@engine/index'
import { build, cable, setIp } from '../helpers'

/** FW1 : WAN 8.8.8.1/24 (PCW 8.8.8.8), LAN 192.168.1.1/24 (PC1 .10), DMZ 172.16.0.1/24 (SRV1 .10). */
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
  return { s, ids }
}

const web = (s: LabState, from: string, url: string): { state: LabState; value: PfWebResult } =>
  unwrap(pfWebRequest(s, from, url))

describe('accès au webConfigurator', () => {
  it('le LAN joint https://192.168.1.1 grâce à la règle d’anti-verrouillage, même sans règle de l’utilisateur', () => {
    const { s, ids } = topo()
    const cleared = unwrap(dispatch(s, command('pf.removeRule', ids.FW1!, 'pf-default-lan'))).state
    const r = web(cleared, ids.PC1!, 'https://192.168.1.1')
    expect(r.value.kind).toBe('response')
    if (r.value.kind !== 'response') return
    expect(r.value.firewallId).toBe(ids.FW1)
    expect(r.value.via).toBe('lan')
    expect(r.value.redirected).toBe(false)
    expect(r.value.certificateWarning).toContain('autorité de certification')
    const notes = r.value.trace.events.map((e) => e.note).join('\n')
    expect(notes).toContain('Anti-Lockout Rule')
  })

  it('HTTP est redirigé vers HTTPS', () => {
    const { s, ids } = topo()
    const r = web(s, ids.PC1!, 'http://192.168.1.1')
    expect(r.value.kind === 'response' && r.value.redirected).toBe(true)
    expect(r.value.kind === 'response' && r.value.url).toBe('https://192.168.1.1/')
  })

  it('un port sur lequel rien n’écoute est refusé', () => {
    const { s, ids } = topo()
    const r = web(s, ids.PC1!, 'https://192.168.1.1:8443')
    expect(r.value.kind).toBe('failure')
  })

  it('une adresse qui n’est pas celle d’un pare-feu est laissée au client HTTP ordinaire', () => {
    const { s, ids } = topo()
    expect(web(s, ids.PC1!, 'http://172.16.0.10').value.kind).toBe('not-firewall')
    expect(web(s, ids.PC1!, 'pas une adresse').value.kind).toBe('not-firewall')
  })

  it('depuis le WAN : refusé par défaut et journalisé, autorisé par une règle Pass sur le WAN', () => {
    const { s, ids } = topo()
    const refused = web(s, ids.PCW!, 'https://8.8.8.1')
    expect(refused.value.kind).toBe('failure')
    const fw = refused.state.devices[ids.FW1!]
    expect(fw?.kind === 'firewall' && fw.pf.log.at(-1)).toMatchObject({
      action: 'block',
      iface: 'wan',
      dst: '8.8.8.1:443'
    })

    const opened = unwrap(
      addPfRule(s, ids.FW1!, {
        iface: 'wan',
        protocol: 'tcp',
        destination: { type: 'interface', key: 'wan', what: 'address' },
        destinationPort: { from: 443, to: 443 }
      })
    ).state
    const ok = web(opened, ids.PCW!, 'https://8.8.8.1')
    expect(ok.value.kind).toBe('response')
    expect(ok.value.kind === 'response' && ok.value.via).toBe('wan')
  })

  it('depuis la DMZ : refusé tant qu’aucune règle OPT1 ne l’autorise', () => {
    const { s, ids } = topo()
    expect(web(s, ids.SRV1!, 'https://172.16.0.1').value.kind).toBe('failure')
  })

  it('la commande pf.webRequest alimente la table d’états du pare-feu', () => {
    const { s, ids } = topo()
    const r = unwrap(dispatch(s, command('pf.webRequest', ids.PC1!, 'https://192.168.1.1')))
    const fw = r.state.devices[ids.FW1!]
    expect(fw?.kind === 'firewall' && fw.pf.states.some((e) => e.dst === '192.168.1.1:443')).toBe(true)
  })
})

describe('authentification', () => {
  it('admin / pfsense par défaut', () => {
    const { s, ids } = topo()
    expect(pfAuthenticate(s, ids.FW1!, 'admin', PF_DEFAULT_PASSWORD).ok).toBe(true)
    expect(pfAuthenticate(s, ids.FW1!, ' Admin ', PF_DEFAULT_PASSWORD).ok).toBe(true)
  })

  it('refuse un mauvais mot de passe ou un autre compte', () => {
    const { s, ids } = topo()
    for (const [u, p] of [
      ['admin', 'admin'],
      ['root', 'pfsense'],
      ['admin', '']
    ] as const) {
      const r = pfAuthenticate(s, ids.FW1!, u, p)
      expect(r.ok).toBe(false)
      expect(!r.ok && r.error.message).toBe(PF_LOGIN_ERROR)
    }
  })

  it('refuse un équipement qui n’est pas un pare-feu', () => {
    const { s, ids } = topo()
    const r = pfAuthenticate(s, ids.PC1!, 'admin', 'pfsense')
    expect(!r.ok && r.error.code).toBe('NotAFirewall')
  })
})
