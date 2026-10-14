/**
 * Outils de diagnostic de l'invite de commandes (v2.7, Lot 3c). Syntaxe et comportement sourcés
 * Microsoft Learn (fr-fr, windows-commands) : arp, route_ws2008 (sans paramètre : aide ; print),
 * netstat (-a écoute, -n numérique, -o PID), netsh-interface (ipv4 set address, set dnsservers,
 * show config), systeminfo, sc-query, tasklist (/fo table|list|csv, /nh), shutdown (/r, /s,
 * /t 0-315360000), dcdiag (sortie d'exemple « passed test »), dsquery user/computer/ou (cc725702,
 * cc730720, cc770509), dsadd user (cc731279 : compte désactivé par défaut).
 * Mises en page françaises : à vérifier (docs/fidelite.md, Lot 3).
 */
import { describe, expect, it } from 'vitest'
import type { LabState, ServerDevice } from '@engine/index'
import { buildReferenceLab } from '../serialization/reference-lab'
import { run, type RunResult } from './helpers'

const id = (s: LabState, name: string) => Object.values(s.devices).find((d) => d.name === name)?.id ?? ''

class Cmd {
  session: RunResult['session'] | undefined
  constructor(
    public state: LabState,
    private readonly host = 'SRV1'
  ) {}
  run(line: string, answers?: string[]): RunResult {
    const r = run(this.state, id(this.state, this.host), line, {
      shell: 'cmd',
      ...(answers ? { answers } : {}),
      ...(this.session ? { session: this.session } : {})
    })
    this.state = r.state
    this.session = r.session
    return r
  }
}

function asUser(state: LabState): LabState {
  const s = structuredClone(state)
  const d = s.devices[id(s, 'SRV1')] as unknown as { host: Record<string, unknown> }
  d.host.session = { user: 'jdupont', domain: 'LAB', logonServer: 'SRV1' }
  return s
}

describe('arp, route', () => {
  it('arp -a : voisins du segment (PC1 vu depuis SRV1), filtre par adresse', () => {
    const lab = buildReferenceLab()
    const cmd = new Cmd(lab)
    const pc1 = lab.devices[id(lab, 'PC1')]
    const out = cmd.run('arp -a').text
    expect(out).toContain('Interface : 192.168.10.1 --- 0x')
    const mac = pc1?.interfaces[0]?.mac.toLowerCase().replace(/[:.]/g, '-') ?? ''
    expect(out).toContain(mac)
    expect(cmd.run('arp -s 10.0.0.80 00-AA-00-4F-2A-9C').errors).toContain('n’est pas simulé')
    expect(cmd.run('arp').errors).toContain('syntaxe')
  })
  it('route : aide sans paramètre (Learn), print calculé, add non simulé', () => {
    const cmd = new Cmd(buildReferenceLab())
    expect(cmd.run('route').text).toContain('route [/f] [/p] [<command>')
    const print = cmd.run('route print').text
    expect(print).toMatch(/0\.0\.0\.0\s+0\.0\.0\.0\s+192\.168\.10\.254/)
    expect(print).toMatch(/192\.168\.10\.0\s+255\.255\.255\.0\s+On-link/)
    expect(cmd.run('route add 10.0.0.0 mask 255.0.0.0 192.168.10.254').errors).toContain('n’est pas simulé')
    expect(cmd.run('route bidule').errors).toContain('Commande non valide')
  })
})

describe('netstat, tasklist, sc', () => {
  it('netstat -an : ports en écoute des rôles installés ; -ano : PID cohérent avec tasklist', () => {
    const cmd = new Cmd(buildReferenceLab())
    const an = cmd.run('netstat -an').text
    expect(an).toMatch(/TCP\s+0\.0\.0\.0:53\s+0\.0\.0\.0:0\s+LISTENING/)
    expect(an).toMatch(/TCP\s+0\.0\.0\.0:389\s/)
    expect(an).toMatch(/UDP\s+0\.0\.0\.0:53\s+\*:\*/)
    const ano = cmd.run('netstat -ano').text
    const dnsPid = /TCP\s+0\.0\.0\.0:53\s+0\.0\.0\.0:0\s+LISTENING\s+(\d+)/.exec(ano)?.[1]
    expect(cmd.run('tasklist').text).toMatch(new RegExp(`^dns\\.exe\\s+${dnsPid}\\s`, 'm'))
    expect(cmd.run('netstat -n').text).not.toContain('LISTENING')
    expect(cmd.run('netstat -e').errors).toContain('n’est pas simulée')
    // Poste client : pas de serveur DNS
    expect(new Cmd(buildReferenceLab(), 'PC1').run('netstat -an').text).not.toContain(':53 ')
  })
  it('tasklist /fo csv /nh, /fo invalide', () => {
    const cmd = new Cmd(buildReferenceLab())
    const csv = cmd.run('tasklist /fo csv /nh').text.split('\n')
    expect(csv[0]).toBe('"System Idle Process","0","Services","0"')
    expect(cmd.run('tasklist /fo xml').errors).toContain('/fo')
  })
  it('sc query : services dérivés des rôles ; introuvable (1060) ; config sans start= refusé', () => {
    const cmd = new Cmd(buildReferenceLab())
    expect(cmd.run('sc query DNS').text).toContain('NOM_SERVICE: DNS')
    expect(cmd.run('sc query').text).toContain('NOM_SERVICE: NTDS')
    expect(cmd.run('sc query Absent').errors).toContain('1060')
    expect(cmd.run('sc config DNS').errors).toContain('n’est pas simulée')
    expect(cmd.run('sc pause DNS').errors).toContain('n’est pas simulée')
  })
})

describe('netsh interface ipv4, systeminfo, shutdown', () => {
  it('set address statique / dhcp, set dnsservers, show config', () => {
    const lab = buildReferenceLab()
    const pc = new Cmd(lab, 'PC1')
    const name = lab.devices[id(lab, 'PC1')]?.interfaces[0]?.name ?? ''
    pc.run(
      `netsh interface ipv4 set address name="${name}" source=static address=192.168.10.50 mask=255.255.255.0 gateway=192.168.10.254`
    )
    const iface = () => pc.state.devices[id(pc.state, 'PC1')]?.interfaces[0]
    expect(iface()?.address).toBe('192.168.10.50')
    expect(iface()?.gateway).toBe('192.168.10.254')
    pc.run(`netsh interface ip set dns "${name}" static 192.168.10.1`)
    expect(iface()?.dnsServers).toEqual(['192.168.10.1'])
    const show = pc.run(`netsh interface ipv4 show config name="${name}"`).text
    expect(show).toContain('192.168.10.50')
    expect(show).toMatch(/Serveurs DNS configurés statiquement :\s+192\.168\.10\.1/)
    expect(pc.run('netsh interface ipv4 set address name=Inconnue source=dhcp').errors).toContain(
      'introuvable'
    )
    expect(
      pc.run(`netsh interface ipv4 set address name="${name}" source=static address=300.1.1.1 mask=24`).errors
    ).toContain('n’est pas une adresse IPv4 valide')
    pc.run(`netsh interface ipv4 set address "${name}" dhcp`)
    expect(iface()?.addressing).toBe('dhcp')
    expect(pc.run('netsh interface ipv6 show config').errors).toContain('n’est pas simulé')
  })
  it('systeminfo : sous-ensemble calculé (nom, domaine, cartes)', () => {
    const out = new Cmd(buildReferenceLab()).run('systeminfo').text
    expect(out).toMatch(/^Nom de l’hôte:\s+SRV1$/m)
    expect(out).toMatch(/^Domaine:\s+lab\.local$/m)
    expect(out).toContain('192.168.10.1')
  })
  it('shutdown /r redémarre, /s éteint, erreurs', () => {
    const cmd = new Cmd(buildReferenceLab(), 'PC1')
    expect(cmd.run('shutdown').errors).toContain('/r')
    expect(cmd.run('shutdown /r /t abc').errors).toContain('315360000')
    expect(cmd.run('shutdown /h').errors).toContain('n’est pas simulée')
    expect(cmd.run('shutdown /r /t 0').errors).toBe('')
    const s = cmd.run('shutdown /s /t 0')
    expect(s.state.devices[id(s.state, 'PC1')]?.powered).toBe(false)
  })
})

describe('dcdiag, dsquery, dsadd', () => {
  it('dcdiag : tests issus de l’état AD/DNS (format de l’exemple Learn)', () => {
    const cmd = new Cmd(buildReferenceLab())
    const out = cmd.run('dcdiag').text
    expect(out).toContain('Directory Server Diagnosis')
    expect(out).toContain('         ......................... SRV1 passed test Connectivity')
    expect(out).toContain('SRV1 passed test Advertising')
    expect(out).toContain('SRV1 passed test Replications')
    expect(out).toContain('SRV1 passed test Services')
    expect(out).not.toContain('test DNS')
    expect(cmd.run('dcdiag /test:DNS').text).toContain('passed test DNS')
    expect(cmd.run('dcdiag /test:KccEvent').errors).toContain('n’est pas simulé')
  })
  it('dcdiag : carte du contrôleur désactivée → échec Connectivity', () => {
    const s = structuredClone(buildReferenceLab())
    const srv = s.devices[id(s, 'SRV1')] as ServerDevice
    for (const i of srv.interfaces) i.enabled = false
    const out = new Cmd(s).run('dcdiag').text
    expect(out).toContain('SRV1 failed test Connectivity')
    expect(out).toContain('SRV1 failed test Advertising')
  })
  it('dsquery user / computer / ou : DN, -o samid, -name, -limit, StartNode', () => {
    const cmd = new Cmd(buildReferenceLab())
    expect(cmd.run('dsquery user -name Jean*').text).toMatch(/^"CN=[^"]+,DC=lab,DC=local"$/m)
    expect(cmd.run('dsquery user -samid jdupont -o samid').text).toBe('"jdupont"')
    expect(cmd.run('dsquery computer -o samid').text).toContain('"PC1$"')
    expect(cmd.run('dsquery user -limit 1').text.split('\n')).toHaveLength(1)
    expect(cmd.run('dsquery ou -name Absent*').text).toBe('')
    expect(cmd.run('dsquery user OU=Inexistante,DC=lab,DC=local').errors).toContain('introuvable')
    expect(cmd.run('dsquery group').errors).toContain('n’est pas un type')
    expect(cmd.run('dsquery user -o xml').errors).toContain('non valide')
  })
  it('dsadd user : désactivé par défaut (Learn), -disabled no, droits, conteneur introuvable', () => {
    const cmd = new Cmd(buildReferenceLab())
    expect(cmd.run('dsadd user "CN=Paul Durand,CN=Users,DC=lab,DC=local" -samid pdurand').text).toBe(
      'dsadd réussite:CN=Paul Durand,CN=Users,DC=lab,DC=local'
    )
    const pd = cmd.state.domains['lab.local']?.users.find((u) => u.sam === 'pdurand')
    expect(pd?.enabled).toBe(false)
    cmd.run('dsadd user CN=mdan,CN=Users,DC=lab,DC=local -pwd P@ssw0rd123 -disabled no -mustchpwd yes')
    const md = cmd.state.domains['lab.local']?.users.find((u) => u.sam === 'mdan')
    expect(md?.enabled).toBe(true)
    expect(md?.mustChangePassword).toBe(true)
    expect(cmd.run('dsadd user CN=x,OU=Absente,DC=lab,DC=local').errors).toContain('introuvable')
    expect(cmd.run('dsadd user CN=pdurand,CN=Users,DC=lab,DC=local').errors).toContain('dsadd échec')
    expect(new Cmd(asUser(cmd.state)).run('dsadd user CN=y,CN=Users,DC=lab,DC=local').errors).toContain(
      'Accès refusé'
    )
  })
})
