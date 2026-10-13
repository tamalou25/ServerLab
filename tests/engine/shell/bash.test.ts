/**
 * Poste Linux (Ubuntu simulé) : console bash, ip / ping / dig, jonction au domaine (realm) et
 * accès à un partage selon les autorisations NTFS (mount -t cifs, smbclient). Acceptation : le
 * poste rejoint le domaine et accède au partage selon les droits du compte.
 */
import { describe, expect, it } from 'vitest'
import {
  autoConfigureDhcp,
  command,
  createShellSession,
  dispatch,
  findNode,
  parseSlab,
  ping,
  serializeSlab,
  shellPrompt,
  type HostDevice,
  type LabState,
  type ServerDevice,
  type ShellSession
} from '@engine/index'
import { buildReferenceLab } from '../serialization/reference-lab'
import { run, type RunResult } from './helpers'

const id = (s: LabState, name: string) => Object.values(s.devices).find((d) => d.name === name)?.id ?? ''

function apply(s: LabState, cmd: Parameters<typeof dispatch>[1]): LabState {
  const r = dispatch(s, cmd)
  if (!r.ok) throw new Error(r.error.message)
  return r.state
}

/** Lab de référence + poste LNX1 (DHCP) câblé sur SW1. */
function withLinux(): LabState {
  let s = buildReferenceLab()
  const r = dispatch(
    s,
    command('topology.addDevice', { kind: 'client', os: 'linux', position: { x: 400, y: 240 } })
  )
  if (!r.ok) throw new Error(r.error.message)
  s = r.state
  const lnx = s.devices[r.value as string]!
  const sw = s.devices[id(s, 'SW1')]!
  const used = new Set(Object.values(s.links).flatMap((l) => [l.a.ifaceId, l.b.ifaceId]))
  const port = sw.interfaces.find((i) => !used.has(i.id) && i.name !== 'Fa0/5')!
  s = apply(
    s,
    command(
      'topology.connect',
      { deviceId: lnx.id, ifaceId: lnx.interfaces[0]!.id },
      { deviceId: sw.id, ifaceId: port.id }
    )
  )
  return autoConfigureDhcp(s).state
}

class Bash {
  session: ShellSession
  constructor(public state: LabState) {
    this.session = createShellSession(state, id(state, 'LNX1'), 'cmd')
  }
  run(line: string, answers: string[] = []): RunResult {
    const r = run(this.state, id(this.state, 'LNX1'), line, { session: this.session, answers })
    this.state = r.state
    this.session = r.session
    return r
  }
}

class Windows {
  constructor(
    public state: LabState,
    private device = 'SRV1'
  ) {}
  run(line: string, shell: 'cmd' | 'powershell' = 'powershell'): RunResult {
    const r = run(this.state, id(this.state, this.device), line, { shell })
    this.state = r.state
    return r
  }
}

/** Partage Compta : GG_Compta modifie, GG_Lecture lit, mmartin n'a aucun droit NTFS. */
function withShare(s: LabState): LabState {
  const ps = new Windows(s)
  ps.run('New-Item -Path C:\\Compta -ItemType Directory')
  ps.run('New-Item -Path C:\\Compta\\Budget -ItemType Directory')
  ps.run("New-SmbShare -Name Compta -Path C:\\Compta -FullAccess 'Tout le monde'")
  for (const sam of ['mmartin', 'lecteur'])
    ps.run(
      `New-ADUser -Name ${sam} -AccountPassword (ConvertTo-SecureString 'Azerty123!' -AsPlainText -Force) -Enabled $true`
    )
  ps.run('New-ADGroup -Name GG_Lecture -GroupScope Global')
  ps.run('Add-ADGroupMember -Identity GG_Lecture -Members lecteur')
  ps.run(
    'icacls C:\\Compta /inheritance:r /grant Administrateurs:(OI)(CI)F /grant LAB\\GG_Compta:(OI)(CI)M /grant LAB\\GG_Lecture:(OI)(CI)RX',
    'cmd'
  )
  return ps.state
}

const host = (s: LabState) => s.devices[id(s, 'LNX1')] as HostDevice
const server = (s: LabState) => s.devices[id(s, 'SRV1')] as ServerDevice

describe('Poste Linux : équipement et console', () => {
  it('poste client Ubuntu : nom LNX1, carte eth0, session etudiant, console bash', () => {
    const s = withLinux()
    const lnx = host(s)
    expect(lnx).toMatchObject({ kind: 'client', name: 'LNX1' })
    expect(lnx.host.os).toBe('linux')
    expect(lnx.interfaces.map((i) => i.name)).toEqual(['eth0'])
    const sh = new Bash(s)
    expect(sh.session.stack).toEqual(['bash'])
    expect(shellPrompt(sh.session, s)).toBe('etudiant@LNX1:~$ ')
    sh.run('cd /mnt')
    expect(shellPrompt(sh.session, sh.state)).toBe('etudiant@LNX1:/mnt$ ')
    expect(sh.run('cd /nulle-part').errors).toBe('bash: cd: /nulle-part: No such file or directory')
    expect(sh.run('foo').errors).toBe('foo: command not found')
    // Commande Linux réelle non simulée : dit comme tel, pas « introuvable » (audit F-01)
    expect(sh.run('systemctl status ssh').errors).toBe(
      'systemctl: commande réelle non simulée dans ServerLab'
    )
    expect(sh.run('ss -tulpn').errors).toBe('ss: commande réelle non simulée dans ServerLab')
    expect(sh.run('whoami').text).toBe('etudiant')
    expect(sh.run('sudo whoami').text).toBe('root')
    expect(sh.run('hostname').text).toBe('LNX1')
  })

  it('ip a / ip route : bail DHCP, route par défaut', () => {
    const sh = new Bash(withLinux())
    const addr = sh.run('ip a').text
    expect(addr).toContain('2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500')
    expect(addr).toMatch(/inet 192\.168\.10\.\d+\/24 brd 192\.168\.10\.255 scope global dynamic eth0/)
    expect(addr).toMatch(/link\/ether ([0-9a-f]{2}:){5}[0-9a-f]{2}/)
    const routes = sh.run('ip route').text.split('\n')
    expect(routes[0]).toMatch(
      /^default via 192\.168\.10\.254 dev eth0 proto dhcp src 192\.168\.10\.\d+ metric 100$/
    )
    expect(routes[1]).toMatch(/^192\.168\.10\.0\/24 dev eth0 proto kernel scope link src/)
    expect(sh.run('ip a | grep inet').text.split('\n')).toHaveLength(2)
    expect(sh.run('ip foo').errors).toBe('Object "foo" is unknown, try "ip help".')
  })

  it('ip addr add / ip route add : sudo obligatoire, adresse statique', () => {
    const sh = new Bash(withLinux())
    expect(sh.run('ip addr add 192.168.10.50/24 dev eth0').errors).toBe(
      'RTNETLINK answers: Operation not permitted'
    )
    sh.run('sudo ip addr add 192.168.10.50/24 dev eth0')
    sh.run('sudo ip route add default via 192.168.10.254')
    expect(sh.run('ip a').text).toContain('inet 192.168.10.50/24 brd 192.168.10.255 scope global eth0')
    expect(sh.run('ip route').text).toContain('default via 192.168.10.254 dev eth0 proto static')
    // Retour au DHCP
    sh.run('sudo dhclient eth0')
    expect(sh.run('ip a').text).toMatch(/scope global dynamic eth0/)
  })

  it('ping : format Linux, TTL du serveur Windows (128) ; ping vers le poste Linux (TTL 64, pas de pare-feu)', () => {
    const sh = new Bash(withLinux())
    const out = sh.run('ping -c 2 srv1.lab.local').text
    expect(out).toContain('PING srv1.lab.local (192.168.10.1) 56(84) bytes of data.')
    expect(out).toMatch(/64 bytes from srv1\.lab\.local \(192\.168\.10\.1\): icmp_seq=1 ttl=128 time=/)
    expect(out).toContain('2 packets transmitted, 2 received, 0% packet loss')
    expect(out).toMatch(/rtt min\/avg\/max\/mdev = /)
    expect(sh.run('ping -c 1 inconnu.lab.local').errors).toBe(
      'ping: inconnu.lab.local: Name or service not known'
    )
    const lnxIp = /inet (192\.168\.10\.\d+)\/24/.exec(sh.run('ip a').text)?.[1] ?? ''
    const r = ping(sh.state, id(sh.state, 'PC1'), lnxIp, { count: 1 })
    expect(r.ok && r.value.outcomes[0]).toMatchObject({ kind: 'reply', ttl: 64 })
  })

  it('dig : réponse, +short (alias), NXDOMAIN, serveur injoignable', () => {
    const sh = new Bash(withLinux())
    const out = sh.run('dig srv1.lab.local').text
    expect(out).toContain('; <<>> DiG 9.18.18-0ubuntu0.22.04.2-Ubuntu <<>> srv1.lab.local')
    expect(out).toContain('status: NOERROR')
    expect(out).toMatch(/;; ANSWER SECTION:\nsrv1\.lab\.local\.\t+\d+\tIN\tA\t192\.168\.10\.1/)
    expect(out).toContain(';; SERVER: 127.0.0.53#53(127.0.0.53) (UDP)')
    expect(sh.run('dig +short intranet.lab.local').text.split('\n')).toEqual([
      'srv1.lab.local.',
      '192.168.10.1'
    ])
    expect(sh.run('dig absent.lab.local').text).toContain('status: NXDOMAIN')
    expect(sh.run('dig @192.168.10.250 srv1.lab.local').text).toContain(';; no servers could be reached')
    expect(sh.run('cat /etc/resolv.conf').text).toContain('nameserver 127.0.0.53')
    expect(sh.run('resolvectl dns').text).toBe('Global:\nLink 2 (eth0): 192.168.10.1')
  })
})

describe('Poste Linux : jonction au domaine', () => {
  it('realm discover, join (sudo, mot de passe), list ; compte d’ordinateur ; pas de GPO', () => {
    const sh = new Bash(withLinux())
    expect(sh.run('realm discover lab.local').text).toContain('configured: no')
    expect(sh.run('realm discover inconnu.local').errors).toBe('realm: No such realm found')
    expect(sh.run('realm join lab.local').errors).toBe('realm: Not authorized to perform this action')
    const wrong = sh.run('sudo realm join -U Administrateur lab.local', ['mauvais'])
    expect(wrong.prompts).toEqual(['Password for Administrateur: '])
    expect(wrong.errors).toBe("realm: Couldn't join realm: Failed to join the domain")
    const dc = server(sh.state)
    const ok = sh.run('sudo realm join -U Administrateur lab.local', [dc.host.localAdminPassword])
    expect(ok.errors).toBe('')
    expect(ok.text).toBe('')
    expect(host(sh.state).host.domain).toBe('lab.local')
    expect(sh.state.domains['lab.local']?.computers.some((c) => c.name === 'LNX1')).toBe(true)
    expect(sh.run('realm list').text).toContain('configured: kerberos-member')
    expect(sh.run('sudo realm join -U Administrateur lab.local', ['x']).errors).toBe(
      'realm: Already joined to this domain'
    )
    const idOut = sh.run('id jdupont@lab.local').text
    expect(idOut).toMatch(
      /^uid=\d+\(jdupont@lab\.local\) gid=\d+\(utilisateurs du domaine@lab\.local\) groups=.*gg_compta@lab\.local/
    )
    expect(sh.run('id inconnu@lab.local').errors).toBe("id: 'inconnu@lab.local': no such user")
    // Les stratégies de groupe ne s'appliquent pas à un poste Linux
    expect(host(sh.state).host.policy.computer).toBeNull()
  })
})

describe('Poste Linux : partage SMB selon les autorisations NTFS (acceptation)', () => {
  function joined(): Bash {
    const sh = new Bash(withShare(withLinux()))
    sh.run('sudo realm join -U Administrateur lab.local', [server(sh.state).host.localAdminPassword])
    return sh
  }

  it('membre de GG_Compta (Modifier) : montage, liste, création de fichier et de dossier', () => {
    const sh = joined()
    expect(sh.run('mount -t cifs //srv1/Compta /mnt/compta -o username=jdupont').errors).toBe(
      'mount: /mnt/compta: must be superuser to use mount.'
    )
    const m = sh.run('sudo mount -t cifs //srv1/Compta /mnt/compta -o username=jdupont,domain=LAB', [
      'Azerty123!'
    ])
    expect(m.prompts).toEqual(['Password for jdupont@//srv1/Compta: '])
    expect(m.errors).toBe('')
    expect(sh.run('mount | grep cifs').text).toContain('//srv1/Compta on /mnt/compta type cifs')
    expect(sh.run('ls /mnt/compta').text).toBe('Budget')
    expect(sh.run('touch /mnt/compta/notes.txt').errors).toBe('')
    expect(sh.run('mkdir /mnt/compta/Archives').errors).toBe('')
    const storage = server(sh.state).storage
    expect(findNode(storage, 'C:\\Compta\\notes.txt')).toMatchObject({ kind: 'file' })
    expect(findNode(storage, 'C:\\Compta\\Archives')).toMatchObject({ kind: 'folder' })
    expect(sh.run('ls /mnt/compta').text).toBe('Archives  Budget  notes.txt')
    sh.run('cd /mnt/compta')
    expect(sh.run('sudo umount /mnt/compta').errors).toBe('umount: /mnt/compta: target is busy.')
    sh.run('cd ~')
    expect(sh.run('sudo umount /mnt/compta').errors).toBe('')
    expect(sh.run('ls /mnt/compta').errors).toBe("ls: cannot access '/mnt/compta': No such file or directory")
  })

  it('GG_Lecture (Lecture et exécution) : liste autorisée, création refusée', () => {
    const sh = joined()
    sh.run('sudo mount -t cifs //srv1/Compta /mnt/compta -o username=lecteur', ['Azerty123!'])
    expect(sh.run('ls /mnt/compta').text).toBe('Budget')
    expect(sh.run('touch /mnt/compta/x.txt').errors).toBe(
      "touch: cannot touch '/mnt/compta/x.txt': Permission denied"
    )
    expect(findNode(server(sh.state).storage, 'C:\\Compta\\x.txt')).toBeUndefined()
  })

  it('compte sans droit NTFS : montage possible (partage), liste refusée ; mot de passe faux : refusé', () => {
    const sh = joined()
    const bad = sh.run('sudo mount -t cifs //srv1/Compta /mnt/compta -o username=jdupont', ['faux'])
    expect(bad.errors).toContain('mount error(13): Permission denied')
    expect(
      sh.run('sudo mount -t cifs //srv1/Absent /mnt/x -o username=jdupont', ['Azerty123!']).errors
    ).toContain('mount error(2): No such file or directory')
    sh.run('sudo mount -t cifs //srv1/Compta /mnt/compta -o username=mmartin', ['Azerty123!'])
    expect(sh.run('ls /mnt/compta').errors).toBe("ls: cannot open directory '/mnt/compta': Permission denied")
  })

  it('smbclient : liste des partages, liste d’un dossier, refus d’accès', () => {
    const sh = joined()
    const list = sh.run('smbclient -L //srv1 -U jdupont', ['Azerty123!'])
    expect(list.prompts).toEqual(['Password for [LAB\\jdupont]:'])
    expect(list.text).toMatch(/\tCompta\s+Disk/)
    expect(list.text).toMatch(/\tIPC\$\s+IPC\s+Remote IPC/)
    expect(sh.run("smbclient //srv1/Compta -U jdupont%Azerty123! -c 'ls'").text).toMatch(/ {2}Budget\s+D\s+0/)
    expect(sh.run("smbclient //srv1/Compta -U mmartin%Azerty123! -c 'ls'").errors).toBe(
      'NT_STATUS_ACCESS_DENIED listing \\*'
    )
    expect(sh.run("smbclient //srv1/Compta -U jdupont%faux -c 'ls'").errors).toBe(
      'session setup failed: NT_STATUS_LOGON_FAILURE'
    )
    expect(sh.run("smbclient //srv1/Absent -U jdupont%Azerty123! -c 'ls'").errors).toBe(
      'tree connect failed: NT_STATUS_BAD_NETWORK_NAME'
    )
  })
})

describe('Poste Linux : format .slab 8', () => {
  it('enregistrer puis rouvrir : système et montages conservés', () => {
    const sh = new Bash(withShare(withLinux()))
    sh.run('sudo realm join -U Administrateur lab.local', [server(sh.state).host.localAdminPassword])
    sh.run('sudo mount -t cifs //srv1/Compta /mnt/compta -o username=jdupont', ['Azerty123!'])
    const parsed = parseSlab(
      serializeSlab(sh.state, { savedAt: '2026-10-07T12:00:00.000Z', appVersion: '2.4.0' })
    )
    if (!parsed.ok) throw new Error(parsed.message)
    expect(parsed.doc.lab).toEqual(sh.state)
    expect(host(parsed.doc.lab).host.mounts).toEqual([
      { source: '//srv1/Compta', target: '/mnt/compta', account: 'LAB\\jdupont' }
    ])
  })
})

describe('fidélité ip addr show <interface> (F-04)', () => {
  it('filtre sur l’interface demandée, erreur iproute2 si inconnue', () => {
    const sh = new Bash(withLinux())
    const eth0 = sh.run('ip addr show eth0').text
    expect(eth0).toContain('2: eth0:')
    expect(eth0).not.toContain('1: lo:')
    expect(sh.run('ip addr show dev eth0').text).toBe(eth0)
    expect(sh.run('ip addr show lo').text).toContain('inet 127.0.0.1/8')
    expect(sh.run('ip addr show xyz').errors).toBe('Device "xyz" does not exist.')
  })
})
