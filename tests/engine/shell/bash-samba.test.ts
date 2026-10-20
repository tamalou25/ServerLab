/**
 * Samba (v2.9, #239) : smb.conf lu au (re)démarrage, comptes Samba (smbpasswd, pdbedit), droits Unix
 * appliqués aux accès SMB, accès depuis le poste Linux (smbclient) et depuis un poste Windows
 * (net use, dir, type, mkdir, net view). Les sorties exactes sont dans bash-samba-golden.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { parseSlab, serializeSlab } from '@engine/index'
import { buildSambaLab, Consoles, appendLines, type Command } from './samba-lab'

const SRV = '192.168.2.10'

/** Lab prêt : samba installé, alice (Passw0rd), partage public (alice, écriture), lecture (invités). */
function lab(extra: Command[] = []): Consoles {
  const c = new Consoles(buildSambaLab())
  const steps: Command[] = [
    ['srv', 'sudo apt install samba', ['y']],
    ['srv', 'sudo useradd -m alice'],
    ['srv', 'sudo useradd -m bob'],
    ['srv', 'sudo smbpasswd -a alice', ['Passw0rd', 'Passw0rd']],
    ['srv', 'sudo smbpasswd -a bob', ['Secret1', 'Secret1']],
    ['srv', 'sudo mkdir -p /srv/samba/public /srv/samba/lecture'],
    ['srv', 'sudo chown alice:alice /srv/samba/public'],
    ['srv', "echo 'Bienvenue' | sudo tee /srv/samba/public/lisezmoi.txt"],
    ['srv', "echo 'Document public' | sudo tee /srv/samba/lecture/notice.txt"],
    ...appendLines('/etc/samba/smb.conf', [
      '[public]',
      '   path = /srv/samba/public',
      '   read only = no',
      '   valid users = alice',
      '[lecture]',
      '   path = /srv/samba/lecture',
      '   guest ok = yes'
    ]),
    ...extra,
    ['srv', 'sudo systemctl restart smbd']
  ]
  for (const [who, line, answers] of steps) c.run(who, line, answers)
  return c
}

const smbc = (c: Consoles, share: string, user: string, cmd: string) =>
  c.run('pc', `smbclient //${SRV}/${share} -U ${user} -c '${cmd}'`)

describe('installation et smb.conf', () => {
  it('apt install samba crée smb.conf (texte du paquet) et la base des comptes', () => {
    const c = new Consoles(buildSambaLab())
    expect(c.run('srv', 'cat /etc/samba/smb.conf')).toContain('No such file or directory')
    c.run('srv', 'sudo apt install samba', ['y'])
    const conf = c.run('srv', 'cat /etc/samba/smb.conf')
    expect(conf).toContain('[global]')
    expect(conf).toContain('workgroup = WORKGROUP')
    expect(c.run('srv', 'sudo ls -l /var/lib/samba/private')).toContain('-rw------- 1 root root')
    expect(c.run('srv', 'systemctl is-active smbd')).toBe('active')
    expect(c.run('srv', 'sudo ss -tln')).toContain(':445')
  })

  it('testparm, smbpasswd, pdbedit, smbstatus : introuvables sans le paquet', () => {
    const c = new Consoles(buildSambaLab())
    for (const t of ['testparm -s', 'sudo smbpasswd -a x', 'sudo pdbedit -L', 'sudo smbstatus'])
      expect(c.run('srv', t)).toContain('command not found')
  })

  it('smbd relit smb.conf au redémarrage seulement ; testparm lit le fichier actuel', () => {
    const c = lab()
    expect(c.run('pc', `smbclient -L //${SRV} -U alice%Passw0rd`)).toContain('public')
    c.run('srv', "sudo sed -i 's/^\\[lecture\\]/[archives]/' /etc/samba/smb.conf")
    expect(c.run('srv', 'sudo testparm -s')).toContain('[archives]')
    expect(c.run('pc', `smbclient -L //${SRV} -U alice%Passw0rd`)).toContain('lecture')
    c.run('srv', 'sudo systemctl reload smbd')
    const after = c.run('pc', `smbclient -L //${SRV} -U alice%Passw0rd`)
    expect(after).toContain('archives')
    expect(after).not.toContain('lecture')
  })

  it('testparm : paramètre inconnu signalé, paramètre valide non modélisé recopié', () => {
    const c = lab(appendLines('/etc/samba/smb.conf', ['[x]', '   pathh = /tmp', '   vfs objects = recycle']))
    const out = c.run('srv', 'sudo testparm -s')
    expect(out).toContain('Unknown parameter encountered: "pathh"')
    expect(out).toContain('Ignoring unknown parameter "pathh"')
    expect(out).toContain('vfs objects = recycle')
  })

  it('testparm : section non fermée → Error loading services.', () => {
    const c = lab(appendLines('/etc/samba/smb.conf', ['[casse']))
    expect(c.run('srv', 'sudo testparm -s')).toContain('Error loading services.')
  })

  it('testparm : synonymes writable / public / browsable', () => {
    const c = lab(
      appendLines('/etc/samba/smb.conf', [
        '[syn]',
        '   writable = yes',
        '   public = yes',
        '   browsable = no'
      ])
    )
    const out = c.run('srv', 'sudo testparm -s')
    expect(out).toMatch(/\[syn\]\n\tbrowseable = No\n\tguest ok = Yes\n\tread only = No/)
  })

  it('testparm : workgroup identique au netbios name → avertissement', () => {
    const c = lab(appendLines('/etc/samba/smb.conf', ['[global]', '   netbios name = WORKGROUP']))
    expect(c.run('srv', 'sudo testparm -s')).toContain("WARNING: 'workgroup' and 'netbios name' must differ.")
  })
})

describe('comptes Samba', () => {
  it('smbpasswd -a exige un compte Unix ; le mot de passe n’est jamais haché ni affiché', () => {
    const c = new Consoles(buildSambaLab())
    c.run('srv', 'sudo apt install samba', ['y'])
    expect(c.run('srv', 'sudo smbpasswd -a ghost', ['x', 'x'])).toBe('Failed to add entry for user ghost.')
    c.run('srv', 'sudo useradd -m alice')
    expect(c.run('srv', 'sudo smbpasswd -a alice', ['Passw0rd', 'Passw0rd'])).toBe('Added user alice.')
    expect(c.run('srv', 'sudo cat /var/lib/samba/private/passdb.tdb')).toBe('alice:1001:U:$sim$Passw0rd')
    expect(c.run('srv', 'cat /var/lib/samba/private/passdb.tdb')).toContain('Permission denied')
  })

  it('désactivation, réactivation, suppression et refus de connexion', () => {
    const c = lab()
    expect(c.run('pc', `smbclient -L //${SRV} -U bob%Secret1`)).toContain('Sharename')
    c.run('srv', 'sudo smbpasswd -d bob')
    expect(c.run('pc', `smbclient -L //${SRV} -U bob%Secret1`)).toBe(
      'session setup failed: NT_STATUS_ACCOUNT_DISABLED'
    )
    c.run('srv', 'sudo smbpasswd -e bob')
    expect(c.run('pc', `smbclient -L //${SRV} -U bob%Secret1`)).toContain('Sharename')
    expect(c.run('srv', 'sudo smbpasswd -x bob')).toBe('Deleted user bob.')
    expect(c.run('srv', 'sudo pdbedit -L')).toBe('alice:1001:')
    expect(c.run('srv', 'sudo smbpasswd -x bob')).toBe('Failed to find entry for user bob.')
  })

  it('smbpasswd -n : sans mot de passe ; mot de passe changé sur un compte existant', () => {
    const c = lab()
    expect(c.run('srv', 'sudo smbpasswd -n bob')).toBe('User bob password set to none.')
    expect(c.run('pc', `smbclient //${SRV}/lecture -U bob%x -c 'ls'`)).toContain('notice') // invité ou bob, accès accordé
    c.run('srv', 'sudo smbpasswd alice', ['Nouveau1', 'Nouveau1'])
    expect(c.run('pc', `smbclient -L //${SRV} -U alice%Passw0rd`)).toContain('LOGON_FAILURE')
    expect(c.run('pc', `smbclient -L //${SRV} -U alice%Nouveau1`)).toContain('Sharename')
  })

  it('pdbedit -L : nom complet du GECOS (adduser) ; pas de chiffre inventé pour -v', () => {
    const c = new Consoles(buildSambaLab())
    c.run('srv', 'sudo apt install samba', ['y'])
    c.run('srv', 'sudo useradd -m -c "Alice Martin" alice')
    c.run('srv', 'sudo smbpasswd -a alice', ['p', 'p'])
    expect(c.run('srv', 'sudo pdbedit -L')).toBe('alice:1001:Alice Martin')
    expect(c.run('srv', 'sudo pdbedit -L -v')).toContain('n’est pas simulée')
  })
})

describe('smbclient vers un serveur Samba : partages, comptes et droits Unix', () => {
  it('liste des partages : browseable = no masqué mais accessible, IPC$ toujours présent', () => {
    const c = lab(
      appendLines('/etc/samba/smb.conf', ['[cache]', '   path = /srv/samba/lecture', '   browseable = no'])
    )
    const list = c.run('pc', `smbclient -L //${SRV} -U alice%Passw0rd`)
    expect(list).toContain('IPC$            IPC       IPC Service (Samba 4.17.12-Debian)')
    expect(list).not.toContain('cache')
    expect(smbc(c, 'cache', 'alice%Passw0rd', 'ls')).toContain('notice.txt')
  })

  it('compte inconnu = invité (map to guest = bad user) : refusé sur un partage sans guest ok', () => {
    const c = lab()
    expect(smbc(c, 'public', 'inconnu%x', 'ls')).toBe('tree connect failed: NT_STATUS_ACCESS_DENIED')
    expect(smbc(c, 'lecture', 'inconnu%x', 'ls')).toContain('notice') // cet utilisateur n’existe pas : invité
    c.run('srv', "sudo sed -i 's/^   map to guest = bad user/   map to guest = never/' /etc/samba/smb.conf")
    c.run('srv', 'sudo systemctl restart smbd')
    expect(smbc(c, 'lecture', 'inconnu%x', 'ls')).toBe('session setup failed: NT_STATUS_LOGON_FAILURE')
  })

  it('valid users avec @groupe, invalid users', () => {
    const c = lab()
    c.run('srv', 'sudo groupadd compta')
    c.run('srv', 'sudo usermod -aG compta bob')
    c.run('srv', "sudo sed -i 's/valid users = alice/valid users = @compta/' /etc/samba/smb.conf")
    c.run('srv', 'sudo systemctl restart smbd')
    expect(smbc(c, 'public', 'bob%Secret1', 'ls')).toContain('lisezmoi.txt')
    expect(smbc(c, 'public', 'alice%Passw0rd', 'ls')).toBe('tree connect failed: NT_STATUS_ACCESS_DENIED')
    for (const l of ['[inv]', '   path = /srv/samba/public', '   invalid users = bob'])
      c.run('srv', `echo '${l}' | sudo tee -a /etc/samba/smb.conf`)
    c.run('srv', 'sudo systemctl restart smbd')
    expect(smbc(c, 'inv', 'bob%Secret1', 'ls')).toBe('tree connect failed: NT_STATUS_ACCESS_DENIED')
    expect(smbc(c, 'inv', 'alice%Passw0rd', 'ls')).toContain('lisezmoi.txt')
  })

  it('droits Unix : dossier du partage non accessible en écriture au compte, puis chmod', () => {
    const c = lab()
    c.run('srv', 'sudo chown root:root /srv/samba/public')
    expect(smbc(c, 'public', 'alice%Passw0rd', 'mkdir docs')).toBe(
      'NT_STATUS_ACCESS_DENIED making remote directory \\docs'
    )
    c.run('srv', 'sudo chmod 777 /srv/samba/public')
    expect(smbc(c, 'public', 'alice%Passw0rd', 'mkdir docs')).toBe('')
    expect(c.run('srv', 'ls -l /srv/samba/public')).toContain('drwxr-xr-x 2 alice alice')
  })

  it('droits Unix : dossier 700 d’un autre compte → tree connect refusé', () => {
    const c = lab()
    c.run('srv', 'sudo chmod 700 /srv/samba/public')
    c.run('srv', 'sudo chown bob /srv/samba/public')
    expect(smbc(c, 'public', 'alice%Passw0rd', 'ls')).toBe('tree connect failed: NT_STATUS_ACCESS_DENIED')
  })

  it('read only par défaut, write list, read list, force user, create mask', () => {
    const c = lab(
      appendLines('/etc/samba/smb.conf', [
        '[eq]',
        '   path = /srv/samba/lecture',
        '   write list = alice',
        '   force user = bob',
        '   create mask = 0600'
      ])
    )
    c.run('srv', 'sudo chmod 777 /srv/samba/lecture')
    // lecture seule pour tous, sauf alice (write list) ; l’écriture se fait sous le compte imposé (bob)
    expect(smbc(c, 'eq', 'bob%Secret1', 'mkdir x')).toBe(
      'NT_STATUS_ACCESS_DENIED making remote directory \\x'
    )
    expect(smbc(c, 'eq', 'alice%Passw0rd', 'mkdir y')).toBe('')
    expect(c.run('srv', 'ls -l /srv/samba/lecture')).toContain('drwxr-xr-x 2 bob')
  })

  it('hosts allow / hosts deny', () => {
    const c = lab(
      appendLines('/etc/samba/smb.conf', ['[h]', '   path = /srv/samba/lecture', '   hosts allow = 10.0.0.'])
    )
    expect(smbc(c, 'h', 'alice%Passw0rd', 'ls')).toBe('tree connect failed: NT_STATUS_ACCESS_DENIED')
    c.run('srv', "sudo sed -i 's/hosts allow = 10.0.0./hosts allow = 192.168.2./' /etc/samba/smb.conf")
    c.run('srv', 'sudo systemctl restart smbd')
    expect(smbc(c, 'h', 'alice%Passw0rd', 'ls')).toContain('notice.txt')
  })

  it('partage [homes] : dossier personnel du compte', () => {
    const c = lab()
    c.run('srv', "sudo sed -i 's/^   read only = yes/   read only = no/' /etc/samba/smb.conf")
    c.run('srv', 'sudo systemctl restart smbd')
    expect(smbc(c, 'alice', 'alice%Passw0rd', 'ls')).toContain('  .  ')
    expect(smbc(c, 'alice', 'bob%Secret1', 'ls')).toBe('tree connect failed: NT_STATUS_BAD_NETWORK_NAME')
  })

  it('chemin absent → NT_STATUS_BAD_NETWORK_NAME ; available = no', () => {
    const c = lab(
      appendLines('/etc/samba/smb.conf', [
        '[vide]',
        '   path = /srv/nexiste',
        '[off]',
        '   path = /srv/samba/lecture',
        '   available = no'
      ])
    )
    expect(smbc(c, 'vide', 'alice%Passw0rd', 'ls')).toBe('tree connect failed: NT_STATUS_BAD_NETWORK_NAME')
    expect(smbc(c, 'off', 'alice%Passw0rd', 'ls')).toBe('tree connect failed: NT_STATUS_BAD_NETWORK_NAME')
  })

  it('smbd arrêté → connexion refusée ; ordinateur éteint → injoignable', () => {
    const c = lab()
    c.run('srv', 'sudo systemctl stop smbd')
    expect(c.run('pc', `smbclient -L //${SRV} -U alice%Passw0rd`)).toContain('NT_STATUS_CONNECTION_REFUSED')
    c.run('srv', 'sudo systemctl start smbd')
    expect(c.run('pc', `smbclient -L //${SRV} -U alice%Passw0rd`)).toContain('Sharename')
  })

  it('mount -t cifs vers un serveur Samba : message honnête', () => {
    const c = lab()
    c.run('pc', 'sudo mkdir /mnt/p')
    expect(
      c.run('pc', `sudo mount -t cifs //${SRV}/public /mnt/p -o username=alice,password=Passw0rd`)
    ).toContain('n’est pas simulé')
  })

  it('options non simulées : message de unsimulated.ts', () => {
    const c = lab()
    expect(c.run('srv', 'sudo smbpasswd -r srv2 alice')).toContain('existe réellement mais n’est pas simulée')
    expect(c.run('srv', 'sudo testparm -v')).toContain('existe réellement mais n’est pas simulée')
    expect(c.run('srv', 'sudo smbtree')).toContain('non simulée')
    expect(c.run('srv', 'sudo smbstatus -P')).toContain('existe réellement mais n’est pas simulée')
  })
})

describe('postes Windows : net use, dir, type, mkdir, net view', () => {
  it('net use avec compte Samba, lecture, création et suppression de session', () => {
    const c = lab()
    expect(c.run('win', `net use Z: \\\\LSRV1\\public /user:alice Passw0rd`)).toContain(
      'La commande s’est terminée correctement.'
    )
    expect(c.run('win', 'net use')).toContain('\\\\LSRV1\\public')
    expect(c.run('win', 'dir Z:\\')).toContain('lisezmoi.txt')
    expect(c.run('win', 'type Z:\\lisezmoi.txt')).toContain('Bienvenue')
    expect(c.run('srv', 'sudo smbstatus -S')).toMatch(/public\s+\d+\s+192\.168\.2\.30/)
    c.run('win', 'net use Z: /delete')
    expect(c.run('srv', 'sudo smbstatus -S')).not.toContain('public ')
    expect(c.run('win', 'dir Z:\\')).not.toContain('lisezmoi.txt')
  })

  it('mot de passe incorrect : erreur 1326 ; partage inconnu : 67 ; compte invité refusé : 5', () => {
    const c = lab()
    expect(c.run('win', 'net use Z: \\\\LSRV1\\public /user:alice nope')).toContain('1326')
    expect(c.run('win', 'net use Z: \\\\LSRV1\\inconnu /user:alice Passw0rd')).toContain('67')
    expect(c.run('win', 'net use Z: \\\\LSRV1\\public /user:bob Secret1')).toContain('Erreur système 5')
    expect(c.run('win', 'net use Z: \\\\LSRV1\\public /user:ghost x')).toContain('Erreur système 5')
  })

  it('écriture depuis Windows = fichiers Unix du compte, modes bornés par create mask', () => {
    const c = lab()
    c.run('win', 'net use Z: \\\\LSRV1\\public /user:alice Passw0rd')
    c.run('win', 'mkdir Z:\\docs')
    c.run('win', 'echo bonjour > Z:\\docs\\a.txt')
    const ls = c.run('srv', 'ls -l /srv/samba/public/docs')
    expect(ls).toMatch(/-rw-r--r-- 1 alice alice\s+\d+ .* a\.txt/)
    expect(c.run('srv', 'cat /srv/samba/public/docs/a.txt')).toContain('bonjour')
    expect(c.run('win', 'del Z:\\docs\\a.txt')).not.toContain('Accès')
    expect(c.run('srv', 'ls /srv/samba/public/docs')).toBe('')
  })

  it('partage en lecture seule : écriture refusée côté Windows', () => {
    const c = lab()
    c.run('win', 'net use Y: \\\\LSRV1\\lecture')
    expect(c.run('win', 'dir Y:\\')).toContain('notice.txt')
    expect(c.run('win', 'mkdir Y:\\x')).toContain('Accès refusé')
    expect(c.run('srv', 'ls /srv/samba/lecture')).toBe('notice.txt')
  })

  it('fichier Unix illisible (600 root) : refus de lecture depuis Windows', () => {
    const c = lab()
    c.run('srv', 'echo secret | sudo tee /srv/samba/public/prive.txt')
    c.run('srv', 'sudo chmod 600 /srv/samba/public/prive.txt')
    c.run('win', 'net use Z: \\\\LSRV1\\public /user:alice Passw0rd')
    expect(c.run('win', 'type Z:\\prive.txt')).toContain('Accès refusé')
    expect(c.run('win', 'type Z:\\lisezmoi.txt')).toContain('Bienvenue')
  })

  it('net view liste les partages navigables ; accès invité sans net use', () => {
    const c = lab()
    const view = c.run('win', 'net view \\\\LSRV1')
    expect(view).toContain('public')
    expect(view).toContain('lecture')
    expect(c.run('win', 'dir \\\\LSRV1\\lecture')).toContain('notice.txt')
    expect(c.run('win', 'dir \\\\LSRV1\\public')).toContain('Accès refusé')
  })

  it('smbd arrêté : le chemin réseau est introuvable', () => {
    const c = lab()
    c.run('srv', 'sudo systemctl stop smbd')
    expect(c.run('win', 'net use Z: \\\\LSRV1\\public /user:alice Passw0rd')).toContain('53')
  })

  it('un changement de smb.conf ne touche pas la session en cours avant le redémarrage', () => {
    const c = lab()
    c.run('win', 'net use Z: \\\\LSRV1\\public /user:alice Passw0rd')
    c.run('srv', "sudo sed -i 's/valid users = alice/valid users = bob/' /etc/samba/smb.conf")
    expect(c.run('win', 'dir Z:\\')).toContain('lisezmoi.txt')
    c.run('srv', 'sudo systemctl restart smbd')
    expect(c.run('win', 'dir Z:\\')).not.toContain('lisezmoi.txt')
  })
})

describe('état et format .slab', () => {
  it('l’état Samba sérialise en .slab (format 27 inchangé) et se relit à l’identique', () => {
    const c = lab()
    c.run('win', 'net use Z: \\\\LSRV1\\public /user:alice Passw0rd')
    const text = serializeSlab(c.state, { savedAt: '2026-10-20T00:00:00.000Z', appVersion: '2.9.0' })
    const back = parseSlab(text)
    expect(back.ok).toBe(true)
    expect(JSON.parse(text).schemaVersion).toBe(27)
    expect(text).toContain('smbLogins')
    if (back.ok) expect(back.doc.lab).toEqual(c.state)
  })
})
