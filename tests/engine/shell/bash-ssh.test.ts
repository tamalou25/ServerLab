/**
 * SSH, fail2ban et rsyslog d'un serveur Linux (v2.9, #237) : une connexion est acceptée ou refusée d'après
 * la configuration EN VIGUEUR de sshd (relue au redémarrage seulement), fail2ban bannit après `maxretry`
 * échecs de l'élève (bannissement abstrait), rsyslog copie les journaux vers un collecteur configuré.
 */
import { describe, expect, it } from 'vitest'
import { createShellSession, executeLine, parseSlab, serializeSlab, type HostDevice } from '@engine/index'
import {
  parseDuration,
  parseJails,
  parseRsyslog,
  parseSshd,
  snapshotOnWrite
} from '../../../src/engine/services/linuxconfig'
import {
  PRIVATE_KEY_BODY,
  derivedBytes,
  fingerprint,
  makeKey,
  parsePublicLine,
  randomart,
  sha256
} from '../../../src/engine/services/linuxssh'
import { Bash, buildLinuxLab } from './linux-lab'

const hex = (bytes: number[]) => bytes.map((b) => b.toString(16).padStart(2, '0')).join('')

/** Serveur LSRV1 (compte bob, mot de passe Bob1) et poste LNX1 sur le même état de lab. */
function net() {
  const l = buildLinuxLab()
  const shells = { srv: new Bash(l.state, l.ids.LSRV1!), pc: new Bash(l.state, l.ids.LNX1!) }
  let state = l.state
  const api = {
    ids: l.ids,
    get state() {
      return state
    },
    set state(next) {
      state = next
    },
    run(who: 'srv' | 'pc', line: string, answers: string[] = []) {
      shells[who].state = state
      const r = shells[who].run(line, answers)
      state = shells[who].state
      return r
    },
    host(name: string) {
      return state.devices[l.ids[name]!] as HostDevice
    }
  }
  api.run('srv', 'sudo useradd -m bob')
  api.run('srv', 'sudo passwd bob', ['Bob1', 'Bob1'])
  return api
}

type Net = ReturnType<typeof net>

const sshBob = (n: Net, ...extra: string[]) =>
  n.run('pc', 'ssh -o StrictHostKeyChecking=no bob@192.168.2.10 hostname', extra)

/** Édite une directive de /etc/ssh/sshd_config (sed -i) sans recharger le service. */
const editSshd = (n: Net, from: string, to: string) =>
  n.run('srv', `sudo sed -i 's/^${from}/${to}/' /etc/ssh/sshd_config`)

describe('configuration lue par les services', () => {
  it('sshd : valeurs par défaut de Debian 12, première valeur gagnante, Include et Match', () => {
    expect(parseSshd('#Port 22\n#PermitRootLogin prohibit-password\n')).toEqual({
      ports: [22],
      permitRootLogin: 'prohibit-password',
      passwordAuthentication: true,
      pubkeyAuthentication: true
    })
    const c = parseSshd(
      'PermitRootLogin no\nPermitRootLogin yes\nPort 2222\nPort 22\nPasswordAuthentication no\nMatch User bob\n  PasswordAuthentication yes\n'
    )
    expect(c.permitRootLogin).toBe('no')
    expect(c.ports).toEqual([2222, 22])
    expect(c.passwordAuthentication).toBe(false)
    expect(parseSshd('PermitRootLogin without-password').permitRootLogin).toBe('prohibit-password')
  })

  it('rsyslog : entrées réseau (modules chargés) et règles d’envoi distant', () => {
    const c = parseRsyslog(
      [
        '#module(load="imudp")',
        'module(load="imtcp")',
        'input(type="imtcp" port="514")',
        'input(type="imudp" port="514")',
        'auth,authpriv.* @@10.0.0.9:6514',
        '*.* @10.0.0.8',
        'action(type="omfwd" target="log.lab.local" port="1514" protocol="tcp")'
      ].join('\n')
    )
    expect(c.inputs).toEqual([{ proto: 'tcp', port: 514 }])
    expect(c.forwards).toEqual([
      { facilities: ['auth', 'authpriv'], proto: 'tcp', target: '10.0.0.9', port: 6514 },
      { facilities: ['*'], proto: 'udp', target: '10.0.0.8', port: 514 },
      { facilities: ['*'], proto: 'tcp', target: 'log.lab.local', port: 1514 }
    ])
  })

  it('fail2ban : durées, valeurs par défaut du paquet et prisons de jail.local', () => {
    expect(parseDuration('10m')).toBe(600_000)
    expect(parseDuration('1h')).toBe(3_600_000)
    expect(parseDuration('90')).toBe(90_000)
    expect(parseDuration('-1')).toBe(-1)
    expect(parseDuration('abc')).toBeNull()
    const [sshd] = parseJails('[sshd]\nenabled = true\n=====\n[sshd]\nmaxretry = 3\nbantime = 1h')
    expect(sshd).toMatchObject({
      name: 'sshd',
      enabled: true,
      maxretry: 3,
      findtime: 600_000,
      bantime: 3_600_000
    })
    expect(parseJails('')[0]).toMatchObject({ name: 'sshd', enabled: false, maxretry: 5 })
  })

  it('un service garde sa configuration jusqu’à son redémarrage (instantané)', () => {
    const before = { '/etc/ssh/sshd_config': { type: 'file' as const, content: 'Port 22\n' } }
    const after = { '/etc/ssh/sshd_config': { type: 'file' as const, content: 'Port 2222\n' } }
    const kept = snapshotOnWrite(undefined, before, after)
    expect(kept?.ssh).toBe('Port 22\n')
    // Un instantané existant n'est pas écrasé par une seconde modification
    expect(snapshotOnWrite(kept, after, before)).toBe(kept)
    // Rien ne change : aucun instantané
    expect(snapshotOnWrite(undefined, before, before)).toBeUndefined()
  })
})

describe('ssh : connexion acceptée ou refusée selon sshd_config', () => {
  it('mot de passe : accepté, refusé, trois essais, clé d’hôte demandée la première fois', () => {
    const n = net()
    const r = n.run('pc', 'ssh bob@192.168.2.10 hostname', ['yes', 'Bob1'])
    expect(r.text).toContain('LSRV1')
    expect(r.errors).toContain("Warning: Permanently added '192.168.2.10' (ED25519)")
    expect(n.host('LNX1').host.linux?.knownHosts).toEqual(['192.168.2.10'])
    // Deuxième connexion : plus de question
    expect(n.run('pc', 'ssh bob@192.168.2.10 hostname', ['Bob1']).text).toBe('LSRV1')
    const bad = n.run('pc', 'ssh bob@192.168.2.10 hostname', ['a', 'b', 'c'])
    expect(bad.errors.split('\n').filter((l) => l === 'Permission denied, please try again.')).toHaveLength(2)
    expect(bad.errors).toContain('bob@192.168.2.10: Permission denied (publickey,password).')
  })

  it('PermitRootLogin : refusé par défaut, accepté après « yes » ET redémarrage du service', () => {
    const n = net()
    n.run('srv', 'sudo passwd root', ['Root1', 'Root1'])
    const root = () =>
      n.run('pc', 'ssh -o StrictHostKeyChecking=no root@192.168.2.10 hostname', ['Root1', 'Root1', 'Root1'])
    expect(root().errors).toContain('root@192.168.2.10: Permission denied')
    editSshd(n, '#PermitRootLogin prohibit-password', 'PermitRootLogin yes')
    // Le fichier est modifié mais sshd garde l'ancienne configuration
    expect(root().errors).toContain('Permission denied')
    n.run('srv', 'sudo systemctl restart ssh')
    expect(n.run('pc', 'ssh root@192.168.2.10 hostname', ['Root1']).text).toBe('LSRV1')
    // PermitRootLogin no refuse même avec le bon mot de passe
    editSshd(n, 'PermitRootLogin yes', 'PermitRootLogin no')
    n.run('srv', 'sudo systemctl reload ssh')
    expect(n.run('pc', 'ssh root@192.168.2.10 hostname', ['Root1', 'Root1', 'Root1']).errors).toContain(
      'Permission denied'
    )
  })

  it('PasswordAuthentication no : refus immédiat (publickey) ; la clé installée par ssh-copy-id suffit', () => {
    const n = net()
    n.run('pc', 'ssh-keygen -t ed25519', ['', '', ''])
    const copy = n.run('pc', 'ssh-copy-id -o StrictHostKeyChecking=no bob@192.168.2.10', ['Bob1'])
    expect(copy.errors).toContain('existe réellement') // option -o de ssh-copy-id : honnête
    const ok = n.run('pc', 'ssh-copy-id bob@192.168.2.10', ['yes', 'Bob1'])
    expect(ok.text).toContain('Number of key(s) added: 1')
    editSshd(n, '#PasswordAuthentication yes', 'PasswordAuthentication no')
    n.run('srv', 'sudo systemctl restart ssh')
    expect(n.run('pc', 'ssh bob@192.168.2.10 whoami').text).toBe('bob')
    // Un compte sans clé installée est refusé sans invite de mot de passe
    n.run('srv', 'sudo useradd -m eve')
    n.run('srv', 'sudo passwd eve', ['Eve1', 'Eve1'])
    const eve = n.run('pc', 'ssh eve@192.168.2.10 whoami')
    expect(eve.errors).toBe('eve@192.168.2.10: Permission denied (publickey).')
    // authorized_keys du serveur : droits stricts
    const files = n.run('srv', 'sudo ls -la /home/bob/.ssh').text
    expect(files).toContain('drwx------')
    expect(files).toContain('-rw-------')
  })

  it('Port : l’ancien port est refusé, le nouveau accepté, ss et ssh -p le voient après redémarrage', () => {
    const n = net()
    editSshd(n, '#Port 22', 'Port 2222')
    expect(n.run('srv', 'sudo ss -tln').text).toContain(':22 ')
    n.run('srv', 'sudo systemctl restart ssh')
    expect(n.run('srv', 'sudo ss -tln').text).toContain(':2222 ')
    expect(sshBob(n, 'Bob1').errors).toContain('port 22: Connection refused')
    expect(n.run('pc', 'ssh -p 2222 bob@192.168.2.10 hostname', ['yes', 'Bob1']).text).toContain('LSRV1')
  })

  it('un sshd arrêté ou une machine hors réseau : « Connection refused » / « timed out »', () => {
    const n = net()
    n.run('srv', 'sudo systemctl stop ssh')
    expect(sshBob(n).errors).toContain('ssh: connect to host 192.168.2.10 port 22: Connection refused')
    expect(n.run('pc', 'ssh bob@10.9.9.9 id').errors).toContain('Connection timed out')
    expect(n.run('pc', 'ssh bob@introuvable id').errors).toContain('Could not resolve hostname introuvable')
  })

  it('compte inexistant, shell nologin et compte sans mot de passe : toujours refusés', () => {
    const n = net()
    n.run('srv', 'sudo useradd -m -s /usr/sbin/nologin svc')
    n.run('srv', 'sudo passwd svc', ['Svc1', 'Svc1'])
    expect(
      n.run('pc', 'ssh -o StrictHostKeyChecking=no svc@192.168.2.10 id', ['Svc1', 'Svc1', 'Svc1']).errors
    ).toContain('Permission denied')
    expect(n.run('pc', 'ssh nobody2@192.168.2.10 id', ['a', 'a', 'a']).errors).toContain('Permission denied')
    expect(n.run('pc', 'ssh admin@192.168.2.10 id', ['', '', '']).errors).toContain('Permission denied')
  })

  it('options non simulées : message honnête ; session interactive non simulée', () => {
    const n = net()
    expect(n.run('pc', 'ssh -L 80:localhost:80 bob@192.168.2.10').errors).toContain('existe réellement')
    const r = n.run('pc', 'ssh -o StrictHostKeyChecking=no bob@192.168.2.10', ['Bob1'])
    expect(r.text).toContain('session interactive')
  })

  it('la commande distante s’exécute sur le serveur avec les droits du compte', () => {
    const n = net()
    n.run('pc', 'ssh -o StrictHostKeyChecking=no bob@192.168.2.10 touch note.txt', ['Bob1'])
    expect(n.run('srv', 'sudo ls -l /home/bob/note.txt').text).toContain('bob bob')
    expect(n.run('pc', 'ssh bob@192.168.2.10 cat /etc/shadow', ['Bob1']).errors).toContain(
      'Permission denied'
    )
  })
})

describe('journaux : /var/log/auth.log et syslog alimentés par les actions simulées', () => {
  it('un système neuf a des journaux vides (auth.log) ; les actions de systemd arrivent dans syslog', () => {
    const n = net()
    expect(n.run('srv', 'sudo cat /var/log/auth.log').text).toBe('')
    n.run('srv', 'sudo systemctl restart ssh')
    expect(n.run('srv', 'cat /var/log/syslog').text).toContain('systemd[1]: Started ssh.service')
    expect(n.run('srv', 'sudo cat /var/log/auth.log').text).not.toContain('systemd')
  })

  it('connexions réussies et échouées dans auth.log (format Debian 12 : horodatage ISO)', () => {
    const n = net()
    sshBob(n, 'mauvais', 'mauvais', 'mauvais')
    sshBob(n, 'Bob1')
    const log = n.run('srv', 'sudo cat /var/log/auth.log').text
    expect(log).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00 LSRV1 sshd\[\d+\]: /)
    expect(log).toContain('Failed password for bob from 192.168.2.20 port ')
    expect(log).toContain('Accepted password for bob from 192.168.2.20 port ')
    expect(log).toContain('session opened for user bob(uid=')
    expect(log).toContain('session closed for user bob')
    // Utilisateur inconnu
    n.run('pc', 'ssh ghost@192.168.2.10 id', ['a', 'a', 'a'])
    const again = n.run('srv', 'sudo cat /var/log/auth.log').text
    expect(again).toContain('Invalid user ghost from 192.168.2.20 port ')
    expect(again).toContain('Failed password for invalid user ghost from')
  })

  it('droits : auth.log est lisible par le groupe adm seulement', () => {
    const n = net()
    expect(n.run('srv', 'ls -l /var/log/auth.log').text).toContain('-rw-r----- 1 syslog adm')
  })

  it('logger écrit dans syslog avec l’étiquette de l’utilisateur ; -t change l’étiquette', () => {
    const n = net()
    n.run('srv', 'logger bonjour monde')
    n.run('srv', 'logger -t monappli demarrage')
    const log = n.run('srv', 'cat /var/log/syslog').text
    expect(log).toContain(' LSRV1 admin: bonjour monde')
    expect(log).toContain(' LSRV1 monappli: demarrage')
    // poste Ubuntu : horodatage traditionnel
    n.run('pc', 'logger hello')
    expect(n.run('pc', 'cat /var/log/syslog').text).toMatch(
      /^[A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} LNX1 etudiant: hello/m
    )
  })
})

describe('fail2ban : bannissement abstrait après N échecs', () => {
  function withF2b() {
    const n = net()
    n.run('srv', 'sudo apt install -y fail2ban')
    return n
  }
  const fail = (n: Net, times = 1) => {
    for (let i = 0; i < times; i++)
      n.run('pc', 'ssh -o StrictHostKeyChecking=no bob@192.168.2.10 id', ['x', 'x', 'x'])
  }

  it('la prison sshd est active dès l’installation (jail.d/defaults-debian.conf)', () => {
    const n = withF2b()
    expect(n.run('srv', 'sudo fail2ban-client status').text).toContain('Jail list:\tsshd')
    expect(n.run('srv', 'cat /etc/fail2ban/jail.d/defaults-debian.conf').text).toBe('[sshd]\nenabled = true')
    expect(n.run('srv', 'sudo fail2ban-client get sshd maxretry').text).toBe('5')
    expect(n.run('srv', 'sudo fail2ban-client get sshd bantime').text).toBe('600')
  })

  it('cinq échecs (maxretry) bannissent l’adresse : connexion refusée, journal, status', () => {
    const n = withF2b()
    fail(n) // 3 échecs
    expect(n.run('srv', 'sudo fail2ban-client status sshd').text).toContain('Currently banned:\t0')
    fail(n) // le 5e échec bannit
    const st = n.run('srv', 'sudo fail2ban-client status sshd').text
    expect(st).toContain('Currently banned:\t1')
    expect(st).toContain('Banned IP list:\t192.168.2.20')
    expect(sshBob(n, 'Bob1').errors).toContain('port 22: Connection refused')
    const log = n.run('srv', 'sudo cat /var/log/fail2ban.log').text
    expect(log).toMatch(/fail2ban\.filter +\[\d+\]: INFO {4}\[sshd\] Found 192\.168\.2\.20 - /)
    expect(log).toMatch(/fail2ban\.actions +\[\d+\]: NOTICE {2}\[sshd\] Ban 192\.168\.2\.20/)
  })

  it('le bannissement expire après bantime ; unbanip le lève tout de suite', () => {
    const n = withF2b()
    fail(n, 2)
    expect(sshBob(n, 'Bob1').errors).toContain('Connection refused')
    n.state = { ...n.state, clock: n.state.clock + 11 * 60_000 }
    expect(sshBob(n, 'Bob1').text).toBe('LSRV1')
    // Nouveau bannissement puis levée manuelle
    n.run('srv', 'sudo fail2ban-client set sshd banip 192.168.2.20')
    expect(sshBob(n, 'Bob1').errors).toContain('Connection refused')
    expect(n.run('srv', 'sudo fail2ban-client set sshd unbanip 192.168.2.20').text).toBe('1')
    expect(n.run('srv', 'sudo fail2ban-client set sshd unbanip 192.168.2.20').text).toBe('0')
    expect(sshBob(n, 'Bob1').text).toBe('LSRV1')
  })

  it('fail2ban arrêté : aucun bannissement ; les bannissements sont levés tant qu’il est arrêté', () => {
    const n = withF2b()
    n.run('srv', 'sudo systemctl stop fail2ban')
    fail(n, 3)
    expect(sshBob(n, 'Bob1').text).toBe('LSRV1')
    expect(n.run('srv', 'sudo fail2ban-client status').errors).toContain('Failed to access socket path')
  })

  it('maxretry et bantime de jail.local, pris en compte au rechargement ; ignoreip protège une adresse', () => {
    const n = withF2b()
    n.run('srv', "echo '[sshd]\nmaxretry = 2' | sudo tee /etc/fail2ban/jail.local")
    // Fichier modifié, configuration non rechargée : toujours 5
    expect(n.run('srv', 'sudo fail2ban-client get sshd maxretry').text).toBe('5')
    n.run('srv', 'sudo fail2ban-client reload')
    expect(n.run('srv', 'sudo fail2ban-client get sshd maxretry').text).toBe('2')
    fail(n)
    expect(n.run('srv', 'sudo fail2ban-client status sshd').text).toContain('Currently banned:\t1')
    n.run('srv', 'sudo fail2ban-client set sshd unbanip 192.168.2.20')
    n.run('srv', "echo '[sshd]\nignoreip = 192.168.2.0/24' | sudo tee /etc/fail2ban/jail.local")
    n.run('srv', 'sudo systemctl restart fail2ban')
    fail(n, 2)
    expect(n.run('srv', 'sudo fail2ban-client status sshd').text).toContain('Currently banned:\t0')
  })

  it('droits et erreurs du client : sans sudo, prison inconnue, commande non installée', () => {
    const n = withF2b()
    expect(n.run('srv', 'fail2ban-client status').errors).toContain('Permission denied to socket')
    expect(n.run('srv', 'sudo fail2ban-client status nope').text).toContain(
      "Sorry but the jail 'nope' does not exist"
    )
    expect(n.run('srv', 'sudo fail2ban-client ping').text).toBe('Server replied: pong')
    expect(n.run('srv', 'sudo fail2ban-client set sshd addignoreip 1.2.3.4').errors).toContain(
      'existe réellement'
    )
    // Poste sans fail2ban
    expect(n.run('pc', 'fail2ban-client status').errors).toBe('fail2ban-client: command not found')
  })

  it('aucune attaque générée : sans saisie de l’élève, le compteur d’échecs reste à zéro', () => {
    const n = withF2b()
    n.run('pc', 'ssh -o StrictHostKeyChecking=no bob@192.168.2.10 id', ['Bob1'])
    const st = n.run('srv', 'sudo fail2ban-client status sshd').text
    expect(st).toContain('Total failed:\t0')
    expect(st).toContain('Total banned:\t0')
  })
})

describe('rsyslog : envoi distant vers un collecteur', () => {
  /** LNX1 reçoit en TCP 514 ; LSRV1 lui envoie tout. */
  function collector(proto: '@@' | '@' = '@@') {
    const n = net()
    const module = proto === '@@' ? 'imtcp' : 'imudp'
    n.run('pc', `sudo sed -i 's/^#module(load="${module}")/module(load="${module}")/' /etc/rsyslog.conf`)
    n.run(
      'pc',
      `sudo sed -i 's/^#input(type="${module}" port="514")/input(type="${module}" port="514")/' /etc/rsyslog.conf`
    )
    n.run('pc', 'sudo systemctl restart rsyslog')
    n.run('srv', `echo '*.* ${proto}192.168.2.20:514' | sudo tee /etc/rsyslog.d/50-remote.conf`)
    return n
  }

  it('la règle n’agit qu’après le redémarrage de rsyslog ; le message arrive avec le nom de l’expéditeur', () => {
    const n = collector()
    n.run('srv', 'logger avant')
    n.run('srv', 'sudo systemctl restart rsyslog')
    n.run('srv', 'logger apres')
    const remote = n.run('pc', 'cat /var/log/syslog').text
    expect(remote).not.toContain('avant')
    expect(remote).toMatch(/ LSRV1 admin: apres$/m)
  })

  it('les messages d’authentification vont dans auth.log du collecteur', () => {
    const n = collector()
    n.run('srv', 'sudo systemctl restart rsyslog')
    sshBob(n, 'Bob1')
    const auth = n.run('pc', 'cat /var/log/auth.log').text
    expect(auth).toMatch(/ LSRV1 sshd\[\d+\]: Accepted password for bob from 192\.168\.2\.20/)
    expect(n.run('pc', 'cat /var/log/syslog').text).not.toContain('Accepted password')
  })

  it('UDP (@) exige imudp ; un collecteur sans entrée réseau ou arrêté ne reçoit rien', () => {
    const udp = collector('@')
    udp.run('srv', 'sudo systemctl restart rsyslog')
    udp.run('srv', 'logger via-udp')
    expect(udp.run('pc', 'cat /var/log/syslog').text).toContain('via-udp')

    const mismatch = collector('@@')
    mismatch.run('srv', "echo '*.* @192.168.2.20:514' | sudo tee /etc/rsyslog.d/50-remote.conf")
    mismatch.run('srv', 'sudo systemctl restart rsyslog')
    mismatch.run('srv', 'logger mauvais-protocole')
    expect(mismatch.run('pc', 'cat /var/log/syslog').text).not.toContain('mauvais-protocole')

    const stopped = collector()
    stopped.run('srv', 'sudo systemctl restart rsyslog')
    stopped.run('pc', 'sudo systemctl stop rsyslog')
    stopped.run('srv', 'logger collecteur-arrete')
    expect(stopped.run('pc', 'cat /var/log/syslog').text).not.toContain('collecteur-arrete')
  })

  it('collecteur injoignable : le message reste local', () => {
    const n = collector()
    n.run('srv', "echo '*.* @@10.9.9.9:514' | sudo tee /etc/rsyslog.d/50-remote.conf")
    n.run('srv', 'sudo systemctl restart rsyslog')
    expect(n.run('srv', 'logger perdu').errors).toBe('')
    expect(n.run('srv', 'cat /var/log/syslog').text).toContain('perdu')
  })
})

describe('clés SSH simulées', () => {
  it('SHA-256 : vecteurs de référence (FIPS 180-4)', () => {
    expect(hex(sha256([...'abc'].map((c) => c.charCodeAt(0))))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    )
    expect(hex(sha256([]))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })

  it('clés déterministes au format OpenSSH, empreinte et randomart de 11 lignes', () => {
    const k = makeKey('graine', 'ed25519')
    expect(makeKey('graine', 'ed25519')).toEqual(k)
    expect(makeKey('autre', 'ed25519').blob).not.toBe(k.blob)
    expect(k.blob.startsWith('AAAAC3NzaC1lZDI1NTE5AAAAI')).toBe(true)
    expect(fingerprint(k)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/)
    expect(randomart(k)).toHaveLength(11)
    expect(randomart(k)[0]).toBe('+--[ED25519 256]--+')
    expect(randomart(k)[10]).toBe('+----[SHA256]-----+')
    const rsa = makeKey('graine', 'rsa')
    expect(rsa.blob.startsWith('AAAAB3NzaC1yc2EAAAADAQABAAABgQ')).toBe(true)
    expect(parsePublicLine(`${rsa.name} ${rsa.blob} u@h`)).toMatchObject({ type: 'rsa', bits: 3072 })
    expect(randomart(rsa)[0]).toBe('+---[RSA 3072]----+')
    expect(derivedBytes('x', 40)).toHaveLength(40)
    expect(PRIVATE_KEY_BODY.length).toBeGreaterThan(0)
  })

  it('ssh-keygen : fichiers, droits 600/644, écrasement demandé, phrase secrète refusée honnêtement', () => {
    const n = net()
    n.run('pc', 'ssh-keygen -t rsa -f mykey', ['', ''])
    expect(n.run('pc', 'ls -l mykey mykey.pub').text).toContain('-rw-------')
    expect(n.run('pc', 'cat mykey').text).toContain('BEGIN OPENSSH PRIVATE KEY')
    expect(n.run('pc', 'cat mykey.pub').text).toMatch(/^ssh-rsa AAAAB3NzaC1yc2E\S+ etudiant@LNX1$/)
    const again = n.run('pc', 'ssh-keygen -t rsa -f mykey', ['n'])
    expect(again.text).not.toContain('Your identification')
    expect(n.run('pc', 'ssh-keygen -t ed25519 -f k2', ['secret', 'secret']).errors).toContain(
      'phrase secrète'
    )
    expect(n.run('pc', 'ssh-keygen -t dsa').errors).toContain('existe réellement')
    expect(n.run('pc', 'ssh-keygen -t ed25519 -f k3', ['a', 'b']).errors).toContain(
      'Passphrases do not match'
    )
  })

  it('ssh-copy-id : sans clé, mauvais mot de passe, serveur injoignable', () => {
    const n = net()
    expect(n.run('pc', 'ssh-copy-id bob@192.168.2.10').errors).toContain('ERROR: No identities found')
    n.run('pc', 'ssh-keygen -t ed25519', ['', '', ''])
    const bad = n.run('pc', 'ssh-copy-id -p 2222 bob@192.168.2.10')
    expect(bad.errors).toContain('ERROR: ssh: connect to host 192.168.2.10 port 2222: Connection refused')
    expect(n.run('pc', 'ssh-copy-id').errors).toContain('Usage: /usr/bin/ssh-copy-id')
  })
})

describe('commandes non simulées et clients Windows', () => {
  it('scp, sftp et sshd : message honnête', () => {
    const n = net()
    for (const cmd of ['scp a.txt bob@192.168.2.10:/tmp', 'sftp bob@192.168.2.10', 'sshd -t'])
      expect(n.run('pc', cmd).errors).toContain('commande réelle non simulée')
  })

  it('le client OpenSSH de Windows (cmd, PowerShell) joint le serveur Linux', () => {
    const n = net()
    for (const kind of ['cmd', 'powershell'] as const) {
      const session = createShellSession(n.state, n.ids.SRV1!, kind)
      const r = executeLine(n.state, session, 'ssh -o StrictHostKeyChecking=no bob@192.168.2.10 hostname', [
        'Bob1'
      ])
      expect(r.output.map((l) => l.text).join('\n')).toContain('LSRV1')
      n.state = r.state
    }
    // Les échecs d'un client Windows sont journalisés comme les autres, avec son adresse
    const session = createShellSession(n.state, n.ids.SRV1!, 'cmd')
    executeLine(n.state, session, 'ssh bob@192.168.2.10 hostname', ['a', 'b', 'c'])
    const log = n.run('srv', 'sudo cat /var/log/auth.log').text
    expect(log).toContain('Accepted password for bob from 192.168.2.1 port')
    expect(n.host('SRV1').host.linux?.knownHosts).toEqual(['192.168.2.10'])
  })
})

describe('état : champs facultatifs de host.linux, format .slab inchangé', () => {
  it('un serveur neuf ne stocke rien ; les nouveaux champs sont absents tant qu’ils ne servent pas', () => {
    const n = net()
    expect(n.host('LSRV1').host.linux?.loaded).toBeUndefined()
    expect(n.host('LSRV1').host.linux?.bans).toBeUndefined()
    expect(n.host('LNX1').host.linux?.knownHosts).toBeUndefined()
  })

  it('configuration en vigueur, bannissements et serveurs connus survivent à l’enregistrement', () => {
    const n = net()
    n.run('srv', 'sudo apt install -y fail2ban')
    editSshd(n, '#Port 22', 'Port 2222')
    n.run('srv', 'sudo fail2ban-client set sshd banip 192.168.2.20')
    sshBob(n, 'Bob1') // refusé : banni
    n.run('pc', 'ssh -p 2222 -o StrictHostKeyChecking=no bob@192.168.2.10 id', ['x']) // refusé aussi
    const text = serializeSlab(n.state, { savedAt: '2026-10-20T08:00:00.000Z', appVersion: '2.9.0' })
    const parsed = parseSlab(text)
    if (!parsed.ok) throw new Error(parsed.message)
    const linux = (parsed.doc.lab.devices[n.ids.LSRV1!] as HostDevice).host.linux
    expect(linux?.loaded?.ssh).toContain('#Port 22')
    expect(linux?.bans).toHaveLength(1)
    expect(linux?.packages).toContain('fail2ban')
    expect(linux?.files?.['/etc/ssh/sshd_config']?.content).toContain('Port 2222')
  })

  it('apt install conserve les fichiers déjà modifiés et tee conserve les paquets', () => {
    const n = net()
    n.run('srv', 'echo bonjour | sudo tee /etc/motd')
    n.run('srv', 'sudo apt install -y fail2ban')
    expect(n.run('srv', 'cat /etc/motd').text).toBe('bonjour')
    n.run('srv', 'echo x | sudo tee /etc/x')
    expect(n.run('srv', 'apt list --installed').text).toContain('fail2ban/')
  })

  it('un redémarrage de l’ordinateur relit les fichiers (configuration en vigueur oubliée)', () => {
    const n = net()
    editSshd(n, '#Port 22', 'Port 2222')
    n.run('srv', 'sudo ss -tln')
    const shell = new Bash(n.state, n.ids.LSRV1!)
    shell.reboot()
    expect(shell.run('sudo ss -tln').text).toContain(':2222 ')
  })
})
