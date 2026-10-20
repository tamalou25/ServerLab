/**
 * Administration d'un serveur Linux depuis la console bash (v2.9, #236) : apt, systemctl,
 * journalctl, ss, ps et outils réseau. Les effets sont réels : un service arrêté ferme son
 * port, un paquet installé démarre son service, un service désactivé ne redémarre pas.
 */
import { describe, expect, it } from 'vitest'
import { parseSlab, serializeSlab, type HostDevice } from '@engine/index'
import { isUnsimulated } from '@engine/shell/unsimulated'
import { Bash, buildLinuxLab } from './linux-lab'

function lab(options: { internet?: boolean } = {}) {
  const l = buildLinuxLab(options)
  return { srv: new Bash(l.state, l.ids.LSRV1!), pc: new Bash(l.state, l.ids.LNX1!), ids: l.ids }
}

/** Le client curl voit-il la page du serveur ? */
function webUp(srv: Bash, pc: Bash): boolean {
  pc.state = srv.state
  return pc.run('curl -I http://192.168.2.10').errors === ''
}

describe('apt : catalogue local et accès au dépôt', () => {
  it('apt update réussit avec Internet, échoue sans (« Temporary failure resolving »)', () => {
    expect(lab().srv.run('sudo apt update').text).toContain(
      'Hit:1 http://deb.debian.org/debian bookworm InRelease'
    )
    const off = lab({ internet: false }).srv
    const r = off.run('sudo apt update')
    expect(r.errors).toContain('W: Failed to fetch http://deb.debian.org/debian/dists/bookworm/InRelease')
    expect(r.errors).toContain("Temporary failure resolving 'deb.debian.org'")
    expect(r.errors).toContain('W: Some index files failed to download.')
  })

  it('apt install sans accès au dépôt : paquet non installé', () => {
    const { srv } = lab({ internet: false })
    const r = srv.run('sudo apt install -y apache2')
    expect(r.errors).toContain(
      'Err:1 http://deb.debian.org/debian bookworm/main amd64 apache2 amd64 2.4.68-1~deb12u1'
    )
    expect(r.errors).toContain('E: Failed to fetch some archives')
    expect(srv.run('systemctl status apache2').errors).toBe('Unit apache2.service could not be found.')
    expect(srv.run('apt list --installed').text).not.toContain('apache2')
  })

  it('paquet introuvable, droits root exigés, confirmation refusée', () => {
    const { srv } = lab()
    expect(srv.run('sudo apt install apache3').errors).toBe('E: Unable to locate package apache3')
    expect(srv.run('sudo apt remove apache3').errors).toBe('E: Unable to locate package apache3')
    expect(srv.run('apt install apache2').errors).toContain('E: Unable to acquire the dpkg frontend lock')
    expect(srv.run('apt update').errors).toContain('E: Unable to lock directory /var/lib/apt/lists/')
    expect(srv.run('sudo apt frobnicate').errors).toBe('E: Invalid operation frobnicate')
    const refused = srv.run('sudo apt install apache2', ['n'])
    expect(refused.text).toContain('Abort.')
    expect(srv.run('systemctl is-active apache2').text).toBe('inactive')
  })

  it('déjà installé, retrait, recherche et liste', () => {
    const { srv } = lab()
    srv.run('sudo apt install -y apache2')
    expect(srv.run('sudo apt install -y apache2').text).toContain(
      'apache2 is already the newest version (2.4.68-1~deb12u1).'
    )
    expect(srv.run('apt list --installed').text).toContain(
      'apache2/stable,now 2.4.68-1~deb12u1 amd64 [installed]'
    )
    expect(srv.run('apt search apache').text).toContain(
      'apache2/stable,now 2.4.68-1~deb12u1 amd64 [installed]'
    )
    expect(srv.run('sudo apt remove nginx').text).toContain(
      "Package 'nginx' is not installed, so not removed"
    )
    expect(srv.run('sudo apt remove -y apache2').text).toContain('Removing apache2 (2.4.68-1~deb12u1) ...')
    expect(srv.run('apt list --installed').text).not.toContain('apache2')
    // L'unité disparaît avec le paquet
    expect(srv.run('systemctl status apache2').errors).toBe('Unit apache2.service could not be found.')
    expect(srv.run('apt search apache').text).not.toContain('[installed]')
  })

  it('poste Ubuntu 22.04 : dépôts jammy et version du catalogue jammy', () => {
    const { pc } = lab()
    expect(pc.run('sudo apt update').text).toContain('Hit:1 http://archive.ubuntu.com/ubuntu jammy InRelease')
    pc.run('sudo apt install -y apache2')
    expect(pc.run('apt list --installed').text).toContain(
      'apache2/jammy,now 2.4.52-1ubuntu4.25 amd64 [installed]'
    )
    // Premier utilisateur Ubuntu : groupe adm, lit le journal sans sudo
    expect(pc.run('journalctl -u apache2').text).toContain(
      'Started apache2.service - The Apache HTTP Server.'
    )
  })
})

describe('systemctl : l’état du service ferme ou ouvre le port', () => {
  it('apt install démarre le service ; stop ferme le port ; start le rouvre', () => {
    const { srv, pc } = lab()
    expect(srv.run('sudo ss -tulpn').text).not.toContain(':80 ')
    srv.run('sudo apt install -y apache2')
    const open = srv.run('sudo ss -tulpn').text
    expect(open).toMatch(/tcp\s+LISTEN\s+0\s+511\s+\*:80\s+\*:\*\s+users:\(\("apache2",pid=\d+,fd=3\)\)/)
    expect(webUp(srv, pc)).toBe(true)

    srv.run('sudo systemctl stop apache2')
    expect(srv.run('sudo ss -tulpn').text).not.toContain('*:80')
    expect(srv.run('systemctl is-active apache2').text).toBe('inactive')
    expect(webUp(srv, pc)).toBe(false)
    expect(pc.run('curl -I http://192.168.2.10').errors).toBe(
      "curl: (7) Failed to connect to 192.168.2.10 port 80 after 0 ms: Couldn't connect to server"
    )

    srv.run('sudo systemctl start apache2')
    expect(srv.run('sudo ss -tulpn').text).toContain('*:80')
    expect(srv.run('systemctl is-active apache2').text).toBe('active')
    expect(webUp(srv, pc)).toBe(true)
    expect(pc.run('curl -I http://192.168.2.10').text).toContain('Server: Apache/2.4.68 (Debian)')
  })

  it('le service est déclaré à l’écoute pour le reste du moteur (Test-NetConnection, listeningPorts)', async () => {
    const { listeningPorts } = await import('@engine/services/listening')
    const { srv, ids } = lab()
    const device = () => srv.state.devices[ids.LSRV1!] as HostDevice
    expect(listeningPorts(device()).map((p) => p.port)).toEqual([22])
    srv.run('sudo apt install -y apache2 bind9')
    expect(listeningPorts(device()).map((p) => `${p.protocol}${p.port}`)).toEqual([
      'TCP22',
      'TCP53',
      'TCP80',
      'TCP953',
      'UDP53'
    ])
    srv.run('sudo systemctl stop bind9')
    expect(listeningPorts(device()).map((p) => p.port)).toEqual([22, 80])
  })

  it('restart change le PID, reload le conserve', () => {
    const { srv } = lab()
    srv.run('sudo apt install -y apache2')
    const pid = () =>
      /pid=(\d+)/.exec(
        srv
          .run('sudo ss -tulpn')
          .text.split('\n')
          .find((l) => l.includes('apache2')) ?? ''
      )?.[1]
    const before = pid()
    srv.run('sudo systemctl reload apache2')
    expect(pid()).toBe(before)
    srv.run('sudo systemctl restart apache2')
    expect(pid()).not.toBe(before)
    expect(srv.run('sudo journalctl -u apache2 -n 4').text.split('\n')).toHaveLength(4)
  })

  it('enable / disable : au redémarrage, seules les unités activées démarrent', () => {
    const { srv } = lab()
    srv.run('sudo apt install -y apache2')
    expect(srv.run('sudo systemctl disable apache2').text).toBe(
      'Removed "/etc/systemd/system/multi-user.target.wants/apache2.service".'
    )
    expect(srv.run('systemctl is-enabled apache2').text).toBe('disabled')
    // Désactivé mais toujours en cours d'exécution jusqu'au redémarrage
    expect(srv.run('systemctl is-active apache2').text).toBe('active')
    srv.reboot()
    expect(srv.run('systemctl is-active apache2').text).toBe('inactive')
    expect(srv.run('systemctl is-active ssh').text).toBe('active')
    expect(srv.run('sudo systemctl enable apache2').text).toBe(
      'Created symlink /etc/systemd/system/multi-user.target.wants/apache2.service → /lib/systemd/system/apache2.service.'
    )
    srv.reboot()
    expect(srv.run('systemctl is-active apache2').text).toBe('active')
    expect(srv.run('sudo systemctl disable --now apache2').text).toContain('Removed')
    expect(srv.run('systemctl is-active apache2').text).toBe('inactive')
  })

  it('erreurs réelles : unité inconnue, droits, verbe inconnu, reload d’une unité arrêtée', () => {
    const { srv } = lab()
    expect(srv.run('systemctl status inconnu').errors).toBe('Unit inconnu.service could not be found.')
    expect(srv.run('systemctl is-active inconnu').text).toBe('inactive')
    expect(srv.run('systemctl is-enabled inconnu').errors).toBe(
      'Failed to get unit file state for inconnu.service: No such file or directory'
    )
    expect(srv.run('sudo systemctl start inconnu').errors).toBe(
      'Failed to start inconnu.service: Unit inconnu.service not found.'
    )
    expect(srv.run('sudo systemctl stop inconnu').errors).toBe(
      'Failed to stop inconnu.service: Unit inconnu.service not loaded.'
    )
    expect(srv.run('sudo systemctl enable inconnu').errors).toBe(
      'Failed to enable unit: Unit file inconnu.service does not exist.'
    )
    expect(srv.run('systemctl stop ssh').errors).toBe(
      "Failed to stop ssh.service: Interactive authentication required.\nSee system logs and 'systemctl status ssh.service' for details."
    )
    expect(srv.run('systemctl enable ssh').errors).toBe(
      'Failed to enable unit: Interactive authentication required.'
    )
    expect(srv.run('systemctl frobnicate ssh').errors).toBe('Unknown command verb frobnicate.')
    expect(srv.run('systemctl start').errors).toBe('Too few arguments.')
    srv.run('sudo apt install -y apache2')
    srv.run('sudo systemctl stop apache2')
    expect(srv.run('sudo systemctl reload apache2').errors).toBe(
      'Failed to reload apache2.service: Job type reload is not applicable for unit apache2.service.'
    )
  })

  it('deux serveurs Web : le second ne peut pas ouvrir le port 80 (échec journalisé)', () => {
    const { srv } = lab()
    srv.run('sudo apt install -y apache2')
    const r = srv.run('sudo apt install -y nginx')
    expect(r.errors).toContain(
      'Job for nginx.service failed because the control process exited with error code.'
    )
    expect(srv.run('systemctl is-active nginx').text).toBe('failed')
    expect(srv.run('systemctl status nginx').text).toContain('Active: failed (Result: exit-code)')
    expect(srv.run('sudo journalctl -u nginx').text).toContain(
      'Failed to start nginx.service - A high performance web server'
    )
    // Une fois apache2 arrêté, nginx démarre
    srv.run('sudo systemctl stop apache2')
    srv.run('sudo systemctl start nginx')
    expect(srv.run('systemctl is-active nginx').text).toBe('active')
    expect(srv.run('sudo ss -tuln').text).toContain('0.0.0.0:80')
  })
})

describe('journalctl, ss, ps et valeurs dérivées', () => {
  it('journalctl -u lit le journal de l’équipement ; alias bind9 → named', () => {
    const { srv } = lab()
    expect(srv.run('sudo journalctl -u apache2').text).toBe('-- No entries --')
    srv.run('sudo apt install -y bind9')
    const text = srv.run('sudo journalctl -u bind9.service').text
    expect(text).toMatch(
      /^Jan 05 08:00:0\d LSRV1 systemd\[1\]: Starting named\.service - BIND Domain Name Server\.\.\.$/m
    )
    expect(srv.run('sudo journalctl').text).toContain('Started named.service')
    // Sans sudo sur Debian : le journal n'est pas lisible
    expect(srv.run('journalctl -u bind9').errors).toContain(
      "Users in groups 'adm', 'systemd-journal' can see all messages."
    )
  })

  it('ss : écoutes dérivées des services (named sur les adresses des cartes), sans processus hors sudo', () => {
    const { srv } = lab()
    srv.run('sudo apt install -y bind9')
    const withProc = srv.run('sudo ss -tulpn').text
    expect(withProc).toContain('192.168.2.10:53')
    expect(withProc).toContain('127.0.0.1:953')
    expect(withProc).toMatch(
      /udp\s+UNCONN\s+0\s+0\s+192\.168\.2\.10:53\s+0\.0\.0\.0:\*\s+users:\(\("named",pid=\d+,fd=\d+\)\)/
    )
    const plain = srv.run('ss -tuln').text
    expect(plain).not.toContain('users:')
    expect(srv.run('ss -x').errors).toContain('existe réellement mais n’est pas simulée')
  })

  it('ps aux liste les services actifs ; un service arrêté disparaît', () => {
    const { srv } = lab()
    srv.run('sudo apt install -y apache2')
    expect(srv.run('ps aux').text).toContain('/usr/sbin/apache2 -k start')
    srv.run('sudo systemctl stop apache2')
    expect(srv.run('ps aux').text).not.toContain('apache2')
    expect(srv.run('ps aux').text).toContain('/usr/sbin/sshd -D')
  })

  it('valeurs non modélisées : « - » et remarque honnête, jamais de valeur inventée', () => {
    const { srv } = lab()
    const free = srv.run('free -h')
    expect(free.text).toContain('Mem:               -')
    expect(free.text).toContain('la mémoire n’est pas modélisée')
    expect(srv.run('df -h').text).toContain('Filesystem      Size  Used Avail Use% Mounted on')
    expect(srv.run('uname -r').text).toContain('n’est pas modélisée')
    expect(srv.real('uname -a')).toBe('Linux LSRV1 x86_64 GNU/Linux')
    const ctl = srv.run('hostnamectl').text
    expect(ctl).toContain('Operating System: Debian GNU/Linux 12 (bookworm)')
    expect(ctl).toContain('Static hostname: LSRV1')
    expect(srv.run('ps').text).toContain('PID TTY')
  })

  it('options non simulées : message honnête', () => {
    const { pc } = lab()
    expect(pc.run('df -x tmpfs').errors).toContain('existe réellement mais n’est pas simulée')
  })
})

describe('réseau : ip neigh, traceroute, nslookup, dig', () => {
  it('ip neigh : voisins du segment ; traceroute : chemin vers Internet', () => {
    const { srv } = lab()
    const neigh = srv.run('ip neigh').text.split('\n')
    expect(neigh).toHaveLength(3)
    expect(neigh[0]).toMatch(/^192\.168\.2\.1 dev eth0 lladdr ([0-9a-f]{2}:){5}[0-9a-f]{2} REACHABLE$/)
    const tr = srv.run('traceroute -n 8.8.8.8').text.split('\n')
    expect(tr[0]).toBe('traceroute to 8.8.8.8 (8.8.8.8), 30 hops max, 60 byte packets')
    expect(tr[1]).toMatch(/^ 1 {2}192\.168\.2\.254 {2}/)
    expect(tr[2]).toMatch(/^ 2 {2}8\.8\.8\.8 {2}/)
    expect(srv.run('traceroute nexiste.example.org').errors).toContain('Name or service not known')
  })

  it('nslookup et dig interrogent le DNS du serveur ; Debian 12 : pas de resolvectl', () => {
    const { srv, pc } = lab()
    expect(srv.run('nslookup www.example.com').text).toContain('Address: 93.184.215.14')
    expect(srv.run('dig www.example.com').text).toContain(';; SERVER: 8.8.8.8#53(8.8.8.8) (UDP)')
    expect(srv.run('dig www.example.com').text).toContain('DiG 9.18.49-1~deb12u2-Debian')
    expect(srv.run('resolvectl status').errors).toBe('resolvectl: command not found')
    // Le poste Ubuntu garde le résolveur local
    expect(pc.run('dig www.example.com').text).toContain(';; SERVER: 127.0.0.53#53(127.0.0.53) (UDP)')
    expect(pc.run('resolvectl dns').text).toContain('8.8.8.8')
    expect(srv.run('nslookup -type=MX example.com').errors).toContain(
      'existe réellement mais n’est pas simulée'
    )
  })

  it('curl : connexion refusée, nom introuvable, serveur Windows (IIS) non concerné', () => {
    const { srv } = lab()
    expect(srv.run('curl http://nexiste.example.org').errors).toBe(
      'curl: (6) Could not resolve host: nexiste.example.org'
    )
    expect(srv.run('curl -I http://localhost').errors).toContain(
      'curl: (7) Failed to connect to localhost port 80'
    )
    srv.run('sudo apt install -y nginx')
    expect(srv.run('curl -I http://localhost').text).toContain('Server: nginx/1.22.1')
  })
})

describe('état : format .slab et commandes encore non simulées', () => {
  it('paquets et services survivent à l’enregistrement', () => {
    const { srv, ids } = lab()
    srv.run('sudo apt install -y apache2')
    srv.run('sudo systemctl stop apache2')
    srv.run('sudo systemctl disable apache2')
    const text = serializeSlab(srv.state, { savedAt: '2026-10-20T08:00:00.000Z', appVersion: '2.9.0' })
    const parsed = parseSlab(text)
    if (!parsed.ok) throw new Error(parsed.message)
    const again = new Bash(parsed.doc.lab, ids.LSRV1!)
    expect(again.run('apt list --installed').text).toContain('apache2/stable,now')
    expect(again.run('systemctl is-active apache2').text).toBe('inactive')
    expect(again.run('systemctl is-enabled apache2').text).toBe('disabled')
    expect(again.run('sudo journalctl -u apache2').text).toContain('Stopped apache2.service')
    // Un serveur neuf ne stocke rien : paquets de base, aucun état de service
    const fresh = (lab().srv.state.devices[ids.LSRV1!] as HostDevice).host
    expect(fresh.linux?.packages).toBeUndefined()
    expect(fresh.services).toEqual({})
  })

  it('ce qui devient simulé n’est plus « non simulé » ; le reste le reste', () => {
    for (const name of [
      'ss',
      'systemctl',
      'journalctl',
      'uname',
      'ps',
      'apt',
      'apt-get',
      'nslookup',
      'traceroute'
    ])
      expect(isUnsimulated('bash', name), name).toBe(false)
    for (const name of ['netstat', 'ufw', 'iptables', 'top', 'service'])
      expect(isUnsimulated('bash', name), name).toBe(true)
  })
})
