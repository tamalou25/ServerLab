/**
 * Console bash (v2.9, #235) : arborescence /etc, /var/www, /var/log, /home sur les fichiers simulés,
 * cat / echo > >> / tee / sed -i / nano, et droits Unix (rwx, propriétaire, groupe) APPLIQUÉS aux accès.
 */
import { describe, expect, it } from 'vitest'
import { parseSlab, serializeSlab, shellPrompt } from '@engine/index'
import { Bash } from './bash-helpers'

describe('arborescence et lecture', () => {
  it('/, /etc, /var/www, /var/log et /home existent avec leurs propriétaires', () => {
    const sh = new Bash()
    expect(sh.all('ls -1 /').split('\n')).toEqual(
      expect.arrayContaining(['etc', 'home', 'var', 'root', 'tmp', 'mnt', 'media'])
    )
    expect(sh.all('ls -1 /etc').split('\n')).toEqual(
      expect.arrayContaining(['passwd', 'group', 'shadow', 'sudoers', 'hostname', 'hosts', 'resolv.conf'])
    )
    expect(sh.all('ls -l /var/www/html')).toContain('-rw-r--r-- 1 root root 45 Jan  5 08:00 index.html')
    expect(sh.all('ls -l /var/log')).toContain('-rw-r----- 1 syslog adm 0 Jan  5 08:00 auth.log')
    expect(sh.all('ls /home')).toBe('etudiant')
    expect(sh.all('ls -ld /home/etudiant')).toBe(
      'drwxr-x--- 2 etudiant etudiant 4096 Jan  5 08:00 /home/etudiant'
    )
  })

  it('cat : fichiers système, noms réels, erreurs d’origine', () => {
    const sh = new Bash()
    expect(sh.all('cat /etc/hostname')).toBe('LNX1')
    expect(sh.all('cat /etc/hosts')).toContain('127.0.1.1 LNX1')
    expect(sh.all('cat /etc/resolv.conf')).toContain('nameserver 127.0.0.53')
    expect(sh.all('cat /etc/passwd')).toContain('etudiant:x:1000:1000:etudiant,,,:/home/etudiant:/bin/bash')
    expect(sh.all('cat /etc/group')).toContain('sudo:x:27:etudiant')
    expect(sh.run('cat /etc/shadow').errors).toBe('cat: /etc/shadow: Permission denied')
    expect(sh.run('cat /nope').errors).toBe('cat: /nope: No such file or directory')
    expect(sh.run('cat /etc').errors).toBe('cat: /etc: Is a directory')
    expect(sh.all('cat -n /etc/hostname')).toBe('     1\tLNX1')
    // Un fichier illisible n’empêche pas la lecture des suivants
    expect(sh.all('cat /nope /etc/hostname')).toBe('cat: /nope: No such file or directory\nLNX1')
  })

  it('cd : dossier, fichier, droit x, invite', () => {
    const sh = new Bash()
    expect(sh.run('cd /root').errors).toBe('bash: cd: /root: Permission denied')
    expect(sh.run('cd /etc/passwd').errors).toBe('bash: cd: /etc/passwd: Not a directory')
    expect(sh.run('cd /nope').errors).toBe('bash: cd: /nope: No such file or directory')
    sh.run('cd /var/www/html')
    expect(shellPrompt(sh.session, sh.state)).toBe('etudiant@LNX1:/var/www/html$ ')
    sh.run('cd ..')
    expect(sh.all('pwd')).toBe('/var/www')
    sh.run('cd')
    expect(shellPrompt(sh.session, sh.state)).toBe('etudiant@LNX1:~$ ')
  })
})

describe('écriture : echo > / >>, tee, touch, mkdir', () => {
  it('echo > remplace, >> ajoute, le contenu est conservé dans l’état', () => {
    const sh = new Bash()
    sh.run('echo premier > notes.txt')
    sh.run('echo second >> notes.txt')
    expect(sh.all('cat notes.txt')).toBe('premier\nsecond')
    sh.run('echo neuf > notes.txt')
    expect(sh.all('cat notes.txt')).toBe('neuf')
    expect(sh.all('ls -l notes.txt')).toBe('-rw-r--r-- 1 etudiant etudiant 5 Jan  5 08:00 notes.txt')
  })

  it('la redirection est faite avec les droits de l’utilisateur, pas ceux de sudo', () => {
    const sh = new Bash()
    expect(sh.run('echo 10.0.0.9 nas >> /etc/hosts').errors).toBe('bash: /etc/hosts: Permission denied')
    // Piège classique : sudo ne s’applique pas à la redirection
    expect(sh.run('sudo echo 10.0.0.9 nas >> /etc/hosts').errors).toBe('bash: /etc/hosts: Permission denied')
    expect(sh.run('echo 10.0.0.9 nas | sudo tee -a /etc/hosts').errors).toBe('')
    const hosts = sh.all('cat /etc/hosts')
    expect(hosts).toContain('127.0.0.1 localhost')
    expect(hosts).toContain('10.0.0.9 nas')
  })

  it('tee : écrit et affiche ; -a ajoute ; erreur sur un fichier sans empêcher l’affichage', () => {
    const sh = new Bash()
    expect(sh.all('echo a | tee f1 f2')).toBe('a')
    sh.run('echo b | tee -a f1')
    expect(sh.all('cat f1')).toBe('a\nb')
    expect(sh.all('cat f2')).toBe('a')
    expect(sh.all('echo a | tee /etc/x')).toBe('tee: /etc/x: Permission denied\na')
    expect(sh.all('echo a | tee /etc')).toBe('tee: /etc: Is a directory\na')
  })

  it('touch et mkdir : propriétaire, droits par défaut, dossier parent inscriptible', () => {
    const sh = new Bash()
    sh.run('touch a')
    sh.run('mkdir d')
    expect(sh.all('ls -l')).toBe(
      [
        'total 4',
        '-rw-r--r-- 1 etudiant etudiant    0 Jan  5 08:00 a',
        'drwxr-xr-x 2 etudiant etudiant 4096 Jan  5 08:00 d'
      ].join('\n')
    )
    expect(sh.all('ls -l d')).toBe('total 0')
    expect(sh.run('mkdir /var/www/site').errors).toBe(
      "mkdir: cannot create directory '/var/www/site': Permission denied"
    )
    sh.run('sudo mkdir /var/www/site')
    expect(sh.all('ls -ld /var/www/site')).toContain('drwxr-xr-x 2 root root')
    expect(sh.run('mkdir -p x/y/z').errors).toBe('')
    expect(sh.all('ls x/y')).toBe('z')
    expect(sh.run('mkdir -p /etc/a/b').errors).toBe(
      "mkdir: cannot create directory '/etc/a': Permission denied"
    )
    expect(sh.run('mkdir d').errors).toBe("mkdir: cannot create directory 'd': File exists")
    expect(sh.run('touch /home/etudiant/d/f').errors).toBe('')
    expect(sh.run('touch /root/f').errors).toBe("touch: cannot touch '/root/f': Permission denied")
  })

  it('le premier ls d’une arborescence neuve n’est pas vide', () => {
    const sh = new Bash()
    sh.run('touch b a')
    expect(sh.all('ls')).toBe('a  b')
    expect(sh.all('ls -a')).toBe('.  ..  a  b')
  })
})

describe('sed -i (sous-ensemble : commande s)', () => {
  const lab = () => {
    const sh = new Bash()
    sh.run('echo "ServerName a.lab" > conf')
    sh.run('echo "Listen 80" >> conf')
    sh.run('echo "Listen 8080" >> conf')
    return sh
  }

  it('première occurrence, g, Nième, & et groupes, séparateur libre, -E', () => {
    const sh = lab()
    sh.run("sed -i 's/Listen/Port/' conf")
    expect(sh.all('cat conf')).toBe('ServerName a.lab\nPort 80\nPort 8080')
    sh.run("sed -i 's/0/_/g' conf")
    expect(sh.all('cat conf')).toBe('ServerName a.lab\nPort 8_\nPort 8_8_')
    sh.run("sed -i 's|a.lab|b.lab|' conf")
    expect(sh.all('cat conf')).toContain('ServerName b.lab')
    sh.run("sed -i 's/Port/[&]/' conf")
    expect(sh.all('cat conf')).toContain('[Port] 8_')
    sh.run("sed -i -E 's/(Server)(Name)/\\2\\1/' conf")
    expect(sh.all('cat conf')).toContain('NameServer b.lab')
    sh.run("sed -i 's/_/X/2' conf")
    expect(sh.all('cat conf')).toContain('[Port] 8_8X')
  })

  it('plusieurs commandes (-e, ;), sans -i la sortie s’affiche et le fichier reste inchangé', () => {
    const sh = lab()
    expect(sh.all("sed -e 's/Listen/L/' -e 's/80/90/' conf")).toBe('ServerName a.lab\nL 90\nL 9080')
    expect(sh.all("sed 's/lab/LAB/;s/Server/S/' conf").split('\n')[0]).toBe('SName a.LAB')
    expect(sh.all('cat conf').split('\n')[1]).toBe('Listen 80')
    expect(sh.all("echo abc | sed 's/b/X/'")).toBe('aXc')
  })

  it('sed -i n’exige pas le droit w sur le fichier mais w+x sur le dossier (fichier temporaire)', () => {
    const sh = lab()
    sh.run('chmod 400 conf')
    expect(sh.run("sed -i 's/Listen/L/' conf").errors).toBe('')
    expect(sh.all('cat conf')).toContain('L 80')
    expect(sh.run("sed -i 's/a/b/' /etc/hosts").errors).toMatch(
      /^sed: couldn't open temporary file \/etc\/sed[A-Za-z0-9]{6}: Permission denied$/
    )
    expect(sh.run("sed -i 's/a/b/' conf2").errors).toBe("sed: can't read conf2: No such file or directory")
    expect(sh.run("sed -i 's/a/b/' /etc/shadow").errors).toBe(
      "sed: can't read /etc/shadow: Permission denied"
    )
    expect(sh.run("sed -i 's/a/b/' /etc").errors).toBe("sed: couldn't edit /etc: not a regular file")
    // Avec sudo, /etc/hosts se modifie
    expect(sh.run("sudo sed -i 's/localhost/lo/' /etc/hosts").errors).toBe('')
    expect(sh.all('cat /etc/hosts')).toContain('127.0.0.1 lo')
  })

  it('erreurs de syntaxe d’origine', () => {
    const sh = lab()
    expect(sh.run("sed -i 's/a/b' conf").errors).toBe(
      "sed: -e expression #1, char 5: unterminated `s' command"
    )
    expect(sh.run("sed 's/a/b/z' conf").errors).toBe("sed: -e expression #1, char 7: unknown option to `s'")
    expect(sh.run("sed 'p' conf").errors).toBe("sed: -e expression #1, char 1: unknown command: `p'")
    expect(sh.run('sed').errors).toContain('Usage: sed')
    expect(sh.run('sed -Q x conf').errors).toBe("sed: invalid option -- 'Q'")
  })
})

describe('nano et éditeurs', () => {
  it('nano : message honnête (console en lignes), vi / vim non simulés', () => {
    const sh = new Bash()
    const out = sh.run('nano /etc/hosts').errors
    expect(out).toContain('nano: éditeur plein écran non simulé dans ServerLab')
    expect(out).toContain('sed -i')
    expect(sh.run('vim a').errors).toBe('vim: commande réelle non simulée dans ServerLab')
  })
})

describe('droits Unix appliqués', () => {
  it('chmod octal et symbolique, ls -l', () => {
    const sh = new Bash()
    sh.run('touch f')
    const mode = () => sh.all('ls -l f').split(' ')[0]
    sh.run('chmod 600 f')
    expect(mode()).toBe('-rw-------')
    sh.run('chmod 4755 f')
    expect(mode()).toBe('-rwsr-xr-x')
    sh.run('chmod 0644 f')
    expect(mode()).toBe('-rw-r--r--')
    sh.run('chmod u+x f')
    expect(mode()).toBe('-rwxr--r--')
    sh.run('chmod go-r,o+w f')
    expect(mode()).toBe('-rwx----w-')
    sh.run('chmod a=rx f')
    expect(mode()).toBe('-r-xr-xr-x')
    sh.run('chmod +w f')
    // Sans « qui », le umask 022 retire w à g et o
    expect(mode()).toBe('-rwxr-xr-x')
    expect(sh.run('chmod g=u f').errors).toContain("invalid mode: 'g=u'")
    expect(sh.run('chmod 888 f').errors).toContain("invalid mode: '888'")
    sh.run('chmod -x f')
    expect(mode()).toBe('-rw-r--r--')
  })

  it('un fichier en 000 est refusé en lecture et en écriture, root passe', () => {
    const sh = new Bash()
    sh.run('echo secret > f')
    sh.run('chmod 000 f')
    expect(sh.run('cat f').errors).toBe('cat: f: Permission denied')
    expect(sh.run('echo x >> f').errors).toBe('bash: f: Permission denied')
    expect(sh.run('sed s/a/b/ f').errors).toBe("sed: can't read f: Permission denied")
    expect(sh.all('sudo cat f')).toBe('secret')
    // Le propriétaire peut rétablir les droits
    sh.run('chmod 600 f')
    expect(sh.all('cat f')).toBe('secret')
  })

  it('droits du groupe et des autres : root:www-data 640', () => {
    const sh = new Bash()
    sh.run('echo secret | sudo tee /srv/f')
    sh.run('sudo chown root:www-data /srv/f')
    sh.run('sudo chmod 640 /srv/f')
    expect(sh.all('ls -l /srv/f')).toContain('-rw-r----- 1 root www-data')
    expect(sh.run('cat /srv/f').errors).toBe('cat: /srv/f: Permission denied')
    sh.run('sudo usermod -aG www-data etudiant')
    expect(sh.all('cat /srv/f')).toBe('secret')
    // Mais le groupe n’a pas le droit w
    expect(sh.run('echo x >> /srv/f').errors).toBe('bash: /srv/f: Permission denied')
    sh.run('sudo chmod 660 /srv/f')
    expect(sh.run('echo x >> /srv/f').errors).toBe('')
    expect(sh.all('cat /srv/f')).toBe('secret\nx')
  })

  it('droit x sur un dossier : traversée et cd ; droit r : listage', () => {
    const sh = new Bash()
    sh.run('mkdir d')
    sh.run('echo hi > d/f')
    sh.run('chmod 600 d')
    expect(sh.run('cat d/f').errors).toBe('cat: d/f: Permission denied')
    expect(sh.run('cd d').errors).toBe('bash: cd: d: Permission denied')
    // Droit r sans x : les noms se listent
    expect(sh.all('ls d')).toBe('f')
    sh.run('chmod 100 d')
    expect(sh.all('cat d/f')).toBe('hi')
    expect(sh.run('ls d').errors).toBe("ls: cannot open directory 'd': Permission denied")
    sh.run('chmod 755 d')
    expect(sh.all('ls d')).toBe('f')
  })

  it('droit w sur le dossier : création et refus (mode 555)', () => {
    const sh = new Bash()
    sh.run('mkdir ro')
    sh.run('chmod 555 ro')
    expect(sh.run('touch ro/x').errors).toBe("touch: cannot touch 'ro/x': Permission denied")
    expect(sh.run('mkdir ro/x').errors).toBe("mkdir: cannot create directory 'ro/x': Permission denied")
    expect(sh.run('echo a > ro/x').errors).toBe('bash: ro/x: Permission denied')
  })

  it('chmod -R, chown -R, chown utilisateur:groupe, utilisateur:, :groupe', () => {
    const sh = new Bash()
    sh.run('sudo mkdir -p /srv/site/css')
    sh.run('sudo touch /srv/site/css/a.css')
    sh.run('sudo chown -R www-data:www-data /srv/site')
    sh.run('sudo chmod -R 750 /srv/site')
    expect(sh.all('sudo ls -l /srv/site/css')).toContain('-rwxr-x--- 1 www-data www-data')
    sh.run('sudo chown etudiant: /srv/site')
    expect(sh.all('ls -ld /srv/site')).toContain('drwxr-x--- 3 etudiant etudiant')
    sh.run('sudo chown :adm /srv/site')
    expect(sh.all('ls -ld /srv/site')).toContain('etudiant adm')
    expect(sh.run('sudo chown 33 /srv/site').errors).toBe('')
    expect(sh.all('ls -ld /srv/site')).toContain('www-data adm')
  })

  it('chown / chmod par un utilisateur ordinaire', () => {
    const sh = new Bash()
    sh.run('touch f')
    expect(sh.run('chown root f').errors).toBe("chown: changing ownership of 'f': Operation not permitted")
    expect(sh.run('chown etudiant:adm f').errors).toBe('')
    expect(sh.run('chown :www-data f').errors).toBe(
      "chown: changing ownership of 'f': Operation not permitted"
    )
    expect(sh.run('chmod 777 /etc/hosts').errors).toBe(
      "chmod: changing permissions of '/etc/hosts': Operation not permitted"
    )
    expect(sh.run('chmod 777 /root/x').errors).toBe("chmod: cannot access '/root/x': Permission denied")
    expect(sh.run('chown').errors).toContain('chown: missing operand')
    expect(sh.run('chown root').errors).toContain("chown: missing operand after 'root'")
    expect(sh.run('chmod -R').errors).toContain('chmod: missing operand')
  })
})

describe('options et cas limites', () => {
  it('options inconnues et options réelles non simulées', () => {
    const sh = new Bash()
    expect(sh.run('ls -j').errors).toBe("ls: invalid option -- 'j'\nTry 'ls --help' for more information.")
    expect(sh.run('ls --foo').errors).toBe(
      "ls: unrecognized option '--foo'\nTry 'ls --help' for more information."
    )
    expect(sh.run('ls -R').errors).toContain('L’option « -R » de ls existe réellement mais n’est pas simulée')
    expect(sh.run('cat -A f').errors).toContain('L’option « -A » de cat existe réellement')
    expect(sh.run('touch').errors).toBe(
      "touch: missing file operand\nTry 'touch --help' for more information."
    )
  })

  it('ls : plusieurs cibles triées, fichiers avant dossiers, -a, -1, -d', () => {
    const sh = new Bash()
    sh.run('mkdir d')
    sh.run('touch d/x f')
    expect(sh.all('ls d f')).toBe('f\n\nd:\nx')
    expect(sh.all('ls -1 /var')).toBe('log\nwww')
    expect(sh.all('ls -d d')).toBe('d')
    expect(sh.all('ls -la d').split('\n')[1]).toMatch(
      /^drwxr-xr-x 2 etudiant etudiant 4096 Jan {2}5 08:00 \.$/
    )
  })

  it('montages CIFS : le point de montage est listé dans /mnt', () => {
    const sh = new Bash()
    sh.run('echo x > ~/f')
    expect(sh.all('ls /mnt')).toBe('')
    expect(sh.run('cd /mnt').errors).toBe('')
  })
})

describe('état Linux dans le format .slab', () => {
  it('l’arborescence modifiée vit dans host.linux (champ facultatif, format 27 à venir)', () => {
    const sh = new Bash()
    expect((sh.host.host as { linux?: unknown }).linux).toBeUndefined()
    sh.run('echo salut > f')
    const linux = (sh.host.host as { linux?: { files: Record<string, { content?: string }> } }).linux
    expect(linux?.files['/home/etudiant/f']?.content).toBe('salut\n')
  })

  it('un lab enregistré puis rouvert reste utilisable (arborescence par défaut tant que le champ n’est pas au format)', () => {
    const sh = new Bash()
    sh.run('echo salut > f')
    const reopened = parseSlab(
      serializeSlab(sh.state, { savedAt: '2026-10-20T12:00:00.000Z', appVersion: '2.9.0' })
    )
    if (!reopened.ok) throw new Error(reopened.message)
    const again = new Bash(reopened.doc.lab)
    expect(again.all('cat /etc/hostname')).toBe('LNX1')
  })
})
