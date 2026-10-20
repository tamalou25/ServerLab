/**
 * Console bash (v2.9, #235) : comptes et élévation de droits — useradd, usermod, groupadd, passwd,
 * id, su, sudo (règle /etc/sudoers : groupe sudo). Les comptes vivent dans /etc/passwd, /etc/group et
 * /etc/shadow (mot de passe : marqueur `$sim$`, jamais de vrai hachage).
 */
import { describe, expect, it } from 'vitest'
import { shellPrompt } from '@engine/index'
import { Bash } from './bash-helpers'

/** Poste avec un compte bob (mot de passe Bob1), hors groupe sudo. */
function withBob(): Bash {
  const sh = new Bash()
  sh.run('sudo useradd -m -s /bin/bash bob')
  sh.run('sudo passwd bob', ['Bob1', 'Bob1'])
  return sh
}

describe('useradd, groupadd, usermod', () => {
  it('useradd -m -G : /etc/passwd, /etc/group, /etc/shadow et dossier personnel', () => {
    const sh = new Bash()
    expect(sh.run('sudo useradd -m -s /bin/bash -c "Bob Martin" -G sudo,www-data bob').errors).toBe('')
    const passwd = sh.all('cat /etc/passwd').split('\n')
    expect(passwd.at(-1)).toBe('bob:x:1001:1001:Bob Martin:/home/bob:/bin/bash')
    const group = sh.all('cat /etc/group')
    expect(group).toContain('bob:x:1001:')
    expect(group).toContain('sudo:x:27:etudiant,bob')
    expect(group).toContain('www-data:x:33:bob')
    // Compte créé sans mot de passe : verrouillé (!), jour de création = date du lab
    expect(sh.all('sudo cat /etc/shadow').split('\n').at(-1)).toBe('bob:!:20458:0:99999:7:::')
    expect(sh.all('ls -ld /home/bob')).toBe('drwxr-xr-x 2 bob bob 4096 Jan  5 08:00 /home/bob')
    expect(sh.all('id bob')).toBe('uid=1001(bob) gid=1001(bob) groups=1001(bob),27(sudo),33(www-data)')
  })

  it('sans -m, pas de dossier personnel ; shell par défaut /bin/sh ; identifiants suivants', () => {
    const sh = new Bash()
    sh.run('sudo useradd alice')
    sh.run('sudo useradd -u 2000 -g users eve')
    expect(sh.all('cat /etc/passwd').split('\n').slice(-2)).toEqual([
      'alice:x:1001:1001::/home/alice:/bin/sh',
      'eve:x:2000:100::/home/eve:/bin/sh'
    ])
    expect(sh.run('ls /home/alice').errors).toBe("ls: cannot access '/home/alice': No such file or directory")
    expect(sh.all('id eve')).toBe('uid=2000(eve) gid=100(users) groups=100(users)')
  })

  it('useradd : erreurs d’origine', () => {
    const sh = new Bash()
    expect(sh.run('useradd bob').errors).toBe(
      'useradd: Permission denied.\nuseradd: cannot lock /etc/passwd; try again later.'
    )
    expect(sh.run('sudo useradd etudiant').errors).toBe("useradd: user 'etudiant' already exists")
    expect(sh.run('sudo useradd Bob').errors).toBe("useradd: invalid user name 'Bob'")
    expect(sh.run('sudo useradd -G inconnu bob').errors).toBe("useradd: group 'inconnu' does not exist")
    expect(sh.run('sudo useradd -g inconnu bob').errors).toBe("useradd: group 'inconnu' does not exist")
    expect(sh.run('sudo useradd -u 1000 bob').errors).toBe("useradd: UID '1000' already exists")
    expect(sh.run('sudo useradd -u abc bob').errors).toBe("useradd: invalid user ID 'abc'")
    expect(sh.run('sudo useradd www').errors).toBe('')
    sh.run('sudo groupadd compta')
    expect(sh.run('sudo useradd compta').errors).toBe(
      'useradd: group compta exists - if you want to add this user to that group, use -g.'
    )
    expect(sh.run('sudo useradd -g compta compta').errors).toBe('')
    expect(sh.run('sudo useradd -z x').errors).toBe(
      "useradd: invalid option -- 'z'\nUsage: useradd [options] LOGIN"
    )
    expect(sh.run('sudo useradd -k /x bob').errors).toContain('L’option « -k » de useradd existe réellement')
    expect(sh.run('sudo useradd -G').errors).toBe(
      "useradd: option requires an argument -- 'G'\nUsage: useradd [options] LOGIN"
    )
    expect(sh.run('sudo useradd').errors).toContain('Usage: useradd [options] LOGIN')
  })

  it('groupadd : gid automatique, -g, erreurs', () => {
    const sh = new Bash()
    sh.run('sudo groupadd compta')
    sh.run('sudo groupadd -g 2500 rh')
    expect(sh.all('cat /etc/group').split('\n').slice(-2)).toEqual(['compta:x:1001:', 'rh:x:2500:'])
    expect(sh.run('sudo groupadd compta').errors).toBe("groupadd: group 'compta' already exists")
    expect(sh.run('sudo groupadd -g 2500 x').errors).toBe("groupadd: GID '2500' already exists")
    expect(sh.run('sudo groupadd -g abc x').errors).toBe("groupadd: invalid group ID 'abc'")
    expect(sh.run('sudo groupadd "a b"').errors).toBe("groupadd: 'a b' is not a valid group name")
    expect(sh.run('groupadd x').errors).toBe(
      'groupadd: Permission denied.\ngroupadd: cannot lock /etc/group; try again later.'
    )
  })

  it('usermod -aG ajoute, -G remplace, -s, -g, -d, -c', () => {
    const sh = new Bash()
    sh.run('sudo groupadd compta')
    sh.run('sudo useradd -m bob')
    sh.run('sudo usermod -aG sudo,compta bob')
    expect(sh.all('id -Gn bob')).toBe('bob sudo compta')
    sh.run('sudo usermod -aG www-data bob')
    expect(sh.all('id -Gn bob')).toBe('bob sudo www-data compta')
    sh.run('sudo usermod -G compta bob')
    expect(sh.all('id -Gn bob')).toBe('bob compta')
    sh.run('sudo usermod -s /bin/bash -c Bob -d /srv/bob -g compta bob')
    expect(sh.all('cat /etc/passwd').split('\n').at(-1)).toBe(
      'bob:x:1001:1001:Bob:/srv/bob:/bin/bash'.replace(':1001:1001:', ':1001:1001:')
    )
  })

  it('usermod : erreurs d’origine', () => {
    const sh = new Bash()
    expect(sh.run('sudo usermod -aG sudo nobody2').errors).toBe("usermod: user 'nobody2' does not exist")
    expect(sh.run('sudo usermod -aG inconnu etudiant').errors).toBe("usermod: group 'inconnu' does not exist")
    expect(sh.run('usermod -aG sudo etudiant').errors).toBe(
      'usermod: Permission denied.\nusermod: cannot lock /etc/passwd; try again later.'
    )
    expect(sh.run('sudo usermod -a etudiant').errors).toContain(
      'usermod: -a flag is only allowed with the -G flag'
    )
    expect(sh.run('sudo usermod -z etudiant').errors).toBe(
      "usermod: invalid option -- 'z'\nUsage: usermod [options] LOGIN"
    )
  })
})

describe('passwd', () => {
  it('root change le mot de passe de bob : marqueur dans shadow, jamais de vrai hachage', () => {
    const sh = new Bash()
    sh.run('sudo useradd bob')
    const r = sh.run('sudo passwd bob', ['Secret1', 'Secret1'])
    expect(r.text).toBe('passwd: password updated successfully')
    expect(r.prompts).toEqual(['New password: ', 'Retype new password: '])
    expect(sh.all('sudo cat /etc/shadow').split('\n').at(-1)).toBe('bob:$sim$Secret1:20458:0:99999:7:::')
  })

  it('un utilisateur change son propre mot de passe : ancien mot de passe d’abord', () => {
    const sh = withBob()
    sh.run('su - bob', ['Bob1'])
    const ok = sh.run('passwd', ['Bob1', 'Neuf1', 'Neuf1'])
    expect(ok.prompts).toEqual(['Current password: ', 'New password: ', 'Retype new password: '])
    expect(ok.text).toBe('Changing password for bob.\npasswd: password updated successfully')
    const wrong = sh.run('passwd', ['mauvais'])
    expect(wrong.text).toBe(
      'Changing password for bob.\npasswd: Authentication token manipulation error\npasswd: password unchanged'
    )
    const mismatch = sh.run('passwd', ['Neuf1', 'A', 'B'])
    expect(mismatch.errors).toBe(
      'Sorry, passwords do not match.\npasswd: Authentication token manipulation error\npasswd: password unchanged'
    )
    expect(sh.run('passwd', ['Neuf1', '', '']).errors).toContain('No password has been supplied.')
    expect(sh.run('passwd etudiant').errors).toBe(
      'passwd: You may not view or modify password information for etudiant.'
    )
  })

  it('erreurs : compte inconnu, option', () => {
    const sh = new Bash()
    expect(sh.run('sudo passwd nobody2').errors).toBe("passwd: user 'nobody2' does not exist")
    expect(sh.run('passwd -z').errors).toBe("passwd: invalid option -- 'z'\nUsage: passwd [options] [LOGIN]")
    expect(sh.run('passwd -l etudiant').errors).toContain('L’option « -l » de passwd existe réellement')
    // sudo passwd sans nom : mot de passe de root
    sh.run('sudo passwd', ['Root1', 'Root1'])
    expect(sh.all('sudo grep root /etc/shadow')).toContain('')
    expect(sh.all('sudo cat /etc/shadow | grep root')).toBe('root:$sim$Root1:20458:0:99999:7:::')
  })
})

describe('id, whoami', () => {
  it('id : formats par défaut et -u -g -G -n, compte inconnu', () => {
    const sh = new Bash()
    expect(sh.all('id')).toBe('uid=1000(etudiant) gid=1000(etudiant) groups=1000(etudiant),4(adm),27(sudo)')
    expect(sh.all('id -u')).toBe('1000')
    expect(sh.all('id -g')).toBe('1000')
    expect(sh.all('id -G')).toBe('1000 4 27')
    expect(sh.all('id -un')).toBe('etudiant')
    expect(sh.all('id -Gn')).toBe('etudiant adm sudo')
    expect(sh.all('id root')).toBe('uid=0(root) gid=0(root) groups=0(root)')
    expect(sh.all('sudo id')).toBe('uid=0(root) gid=0(root) groups=0(root)')
    expect(sh.run('id nobody2').errors).toBe("id: 'nobody2': no such user")
    expect(sh.run('id -n').errors).toBe('id: cannot print only names or real IDs in default format')
    expect(sh.run('id -ug').errors).toBe('id: cannot print "only" of more than one choice')
    expect(sh.run('id -Q').errors).toBe("id: invalid option -- 'Q'\nTry 'id --help' for more information.")
  })

  it('les comptes du domaine (nom@domaine) restent traités par le module Active Directory', () => {
    const sh = new Bash()
    expect(sh.run('id jdupont@lab.local').errors).toBe("id: 'jdupont@lab.local': no such user")
  })
})

describe('su', () => {
  it('su - bob : mot de passe, dossier personnel, invite, exit revient à etudiant', () => {
    const sh = withBob()
    expect(sh.run('su - bob', ['mauvais']).errors).toBe('su: Authentication failure')
    expect(sh.all('whoami')).toBe('etudiant')
    const r = sh.run('su - bob', ['Bob1'])
    expect(r.prompts).toEqual(['Password: '])
    expect(shellPrompt(sh.session, sh.state)).toBe('bob@LNX1:~$ ')
    expect(sh.all('whoami')).toBe('bob')
    expect(sh.all('pwd')).toBe('/home/bob')
    expect(sh.all('id')).toBe('uid=1001(bob) gid=1001(bob) groups=1001(bob)')
    sh.run('exit')
    expect(sh.all('whoami')).toBe('etudiant')
    expect(shellPrompt(sh.session, sh.state)).toBe('etudiant@LNX1:~$ ')
  })

  it('su sans tiret garde le dossier courant ; compte inconnu, verrouillé, nologin', () => {
    const sh = withBob()
    sh.run('cd /tmp')
    sh.run('su bob', ['Bob1'])
    expect(sh.all('pwd')).toBe('/tmp')
    sh.run('exit')
    expect(sh.run('su nobody2').errors).toBe(
      'su: user nobody2 does not exist or the user entry does not contain all the required fields'
    )
    // root est verrouillé (*) : su root échoue sans sudo
    expect(sh.run('su', ['x']).errors).toBe('su: Authentication failure')
    expect(sh.all('sudo su nobody')).toBe('This account is currently not available.')
    expect(sh.run('su -c ls').errors).toContain('L’option « -c » de su existe réellement')
  })

  it('sudo su et sudo -i : shell root sans mot de passe, invite #, exit revient', () => {
    const sh = new Bash()
    sh.run('sudo su')
    expect(shellPrompt(sh.session, sh.state)).toBe('root@LNX1:/home/etudiant# ')
    expect(sh.all('whoami')).toBe('root')
    expect(sh.all('cat /etc/shadow').split('\n')[0]).toBe('root:*:20458:0:99999:7:::')
    sh.run('exit')
    sh.run('sudo -i')
    expect(shellPrompt(sh.session, sh.state)).toBe('root@LNX1:~# ')
    expect(sh.all('pwd')).toBe('/root')
    sh.run('su - etudiant')
    expect(sh.all('whoami')).toBe('etudiant')
    sh.run('exit')
    expect(sh.all('whoami')).toBe('root')
    sh.run('exit')
    expect(sh.all('whoami')).toBe('etudiant')
  })

  it('exit hors session su ferme la console', () => {
    const sh = new Bash()
    const r = sh.run('exit')
    expect(r.text).toBe('')
  })
})

describe('sudo et /etc/sudoers', () => {
  it('etudiant (groupe sudo) : sudo sans mot de passe tant qu’aucun n’est défini', () => {
    const sh = new Bash()
    const r = sh.run('sudo whoami')
    expect(r.text).toBe('root')
    expect(r.prompts).toEqual([])
  })

  it('compte avec mot de passe : sudo le demande (3 essais), puis le retient 15 minutes', () => {
    const sh = new Bash()
    sh.run('sudo passwd etudiant', ['Etu1', 'Etu1'])
    sh.run('sudo -k')
    const ok = sh.run('sudo whoami', ['Etu1'])
    expect(ok.prompts).toEqual(['[sudo] password for etudiant: '])
    expect(ok.text).toBe('root')
    // Jeton récent : pas de nouvelle invite
    expect(sh.run('sudo whoami').prompts).toEqual([])
    const bad = new Bash()
    bad.run('sudo passwd etudiant', ['Etu1', 'Etu1'])
    bad.run('sudo -K')
    const r = bad.run('sudo whoami', ['a', 'b', 'c'])
    expect(r.errors).toBe('Sorry, try again.\nSorry, try again.\nsudo: 3 incorrect password attempts')
    expect(r.prompts).toHaveLength(3)
  })

  it('utilisateur hors groupe sudo : refusé après le mot de passe', () => {
    const sh = withBob()
    sh.run('su - bob', ['Bob1'])
    const r = sh.run('sudo ls', ['Bob1'])
    expect(r.prompts).toEqual(['[sudo] password for bob: '])
    expect(r.errors).toBe('bob is not in the sudoers file.  This incident will be reported.')
    expect(sh.run('sudo cat /etc/shadow', ['Bob1']).text).not.toContain('root:')
  })

  it('ajouter bob au groupe sudo, ou lui retirer, change ses droits (règle %sudo de /etc/sudoers)', () => {
    const sh = withBob()
    sh.run('sudo usermod -aG sudo bob')
    sh.run('su - bob', ['Bob1'])
    expect(sh.run('sudo whoami', ['Bob1']).text).toBe('root')
    sh.run('exit')
    sh.run('sudo usermod -G bob bob')
    sh.run('su - bob', ['Bob1'])
    expect(sh.run('sudo whoami', ['Bob1']).errors).toContain('bob is not in the sudoers file')
  })

  it('une règle utilisateur NOPASSWD dans /etc/sudoers supprime la demande de mot de passe', () => {
    const sh = withBob()
    expect(sh.run('echo "bob ALL=(ALL) NOPASSWD: ALL" | sudo tee -a /etc/sudoers').errors).toBe('')
    sh.run('su - bob', ['Bob1'])
    const r = sh.run('sudo whoami')
    expect(r.prompts).toEqual([])
    expect(r.text).toBe('root')
  })

  it('sudo : le droit d’édition de /etc/sudoers est lui-même protégé (0440 root)', () => {
    const sh = new Bash()
    expect(sh.all('ls -l /etc/sudoers')).toContain('-r--r----- 1 root root')
    expect(sh.run('cat /etc/sudoers').errors).toBe('cat: /etc/sudoers: Permission denied')
    expect(sh.all('sudo cat /etc/sudoers')).toContain('%sudo\tALL=(ALL:ALL) ALL')
  })

  it('erreurs et options de sudo', () => {
    const sh = new Bash()
    expect(sh.run('sudo foo').errors).toBe('sudo: foo: command not found')
    expect(sh.run('foo').errors).toBe('foo: command not found')
    expect(sh.run('sudo').errors).toBe('usage: sudo -h | -K | -k | -V')
    expect(sh.run('sudo -z ls').errors).toBe("sudo: invalid option -- 'z'\nusage: sudo -h | -K | -k | -V")
    expect(sh.run('sudo -l').errors).toContain('L’option « -l » de sudo existe réellement')
    expect(sh.run('sudo -u bob ls').errors).toContain('L’option « -u » de sudo existe réellement')
  })

  it('la commande sudo reste en root pour la ligne seulement', () => {
    const sh = new Bash()
    sh.run('sudo touch /etc/zz')
    expect(sh.all('ls -l /etc/zz')).toContain('root root')
    expect(sh.run('touch /etc/zz2').errors).toBe("touch: cannot touch '/etc/zz2': Permission denied")
    // Chaque étape d’un tube est évaluée séparément
    expect(sh.all('sudo cat /etc/shadow | grep root')).toBe('root:*:20458:0:99999:7:::')
  })
})
