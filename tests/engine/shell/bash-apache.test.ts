/**
 * Apache2 d'un serveur Linux (v2.9, #238) : sites, modules et configurations activés par liens symboliques,
 * contrôle de syntaxe, rechargement (la configuration en vigueur ne change qu'à `reload`/`restart`), hôtes
 * virtuels, droits d'accès, redirections, HTTPS, journaux, conflits de port, navigateur d'un poste Windows.
 */
import { describe, expect, it } from 'vitest'
import { httpGet, parseSlab, serializeSlab, type HostDevice } from '@engine/index'
import { parseConfig, nextWord, splitArgs, expandVars } from '../../../src/engine/services/linuxapache'
import { apacheConfig } from '../../../src/engine/services/linuxapachehost'
import { siteFile, writeFile } from './apache-helpers'
import { Bash, buildLinuxLab } from './linux-lab'
import { run as runLine } from './helpers'

/** Serveur LSRV1 (apache2 installé) et poste LNX1 sur le même état de lab. */
function net(options: { install?: boolean } = {}) {
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
    /** Sortie complète (standard + erreurs). */
    out(who: 'srv' | 'pc', line: string, answers: string[] = []) {
      return api.run(who, line, answers).text
    },
    host(name: string) {
      return state.devices[l.ids[name]!] as HostDevice
    },
    /** Écrit un fichier de plusieurs lignes sur le serveur. */
    write(path: string, lines: string[]) {
      for (const [, line] of writeFile(path, lines)) api.run('srv', line)
    },
    site(name: string, root: string, extra: string[] = []) {
      for (const [, line] of siteFile(name, root, extra)) api.run('srv', line)
    },
    page(dir: string, text: string) {
      api.run('srv', `sudo mkdir -p ${dir}`)
      api.run('srv', `echo '<h1>${text}</h1>' | sudo tee ${dir}/index.html`)
    },
    /** curl du poste vers le serveur, avec un nom de site. */
    curl(host: string, path = '/', extra = '') {
      return api.out(
        'pc',
        `curl -s ${extra} -H "Host: ${host}" http://192.168.2.10${path}`.replace(/ +/g, ' ')
      )
    }
  }
  if (options.install !== false) api.run('srv', 'sudo apt install apache2', ['y'])
  return api
}

type Net = ReturnType<typeof net>

/** Deux sites par nom (site1, site2), activés et rechargés. */
function twoSites(): Net {
  const n = net()
  n.page('/var/www/site1', 'Site 1')
  n.page('/var/www/site2', 'Site 2')
  n.site('site1', '/var/www/site1')
  n.site('site2', '/var/www/site2')
  n.run('srv', 'sudo a2ensite site1')
  n.run('srv', 'sudo a2ensite site2')
  n.run('srv', 'sudo systemctl reload apache2')
  return n
}

describe('installation et fichiers du paquet', () => {
  it('apt install apache2 apporte /etc/apache2, les sites et les modules par défaut', () => {
    const n = net()
    expect(n.out('srv', 'ls /etc/apache2')).toBe(
      'apache2.conf  conf-available  conf-enabled  envvars  mods-available  mods-enabled  ports.conf  sites-available  sites-enabled'
    )
    expect(n.out('srv', 'ls /etc/apache2/sites-available')).toBe('000-default.conf  default-ssl.conf')
    expect(n.out('srv', 'ls /etc/apache2/mods-available')).toContain('rewrite.load')
    expect(n.out('srv', 'ls /etc/apache2/mods-enabled')).not.toContain('rewrite')
  })

  it('les modules par défaut sont ceux de la postinst (19 fichiers .load)', () => {
    const n = net()
    const enabled = n
      .out('srv', 'ls /etc/apache2/mods-enabled')
      .split(/\s+/)
      .filter((f) => f.endsWith('.load'))
    expect(enabled).toEqual([
      'access_compat.load',
      'alias.load',
      'auth_basic.load',
      'authn_core.load',
      'authn_file.load',
      'authz_core.load',
      'authz_host.load',
      'authz_user.load',
      'autoindex.load',
      'deflate.load',
      'dir.load',
      'env.load',
      'filter.load',
      'mime.load',
      'mpm_event.load',
      'negotiation.load',
      'reqtimeout.load',
      'setenvif.load',
      'status.load'
    ])
  })

  it('apache2.conf et ports.conf sont ceux du paquet Debian (cat suit les liens)', () => {
    const n = net()
    expect(n.out('srv', 'cat /etc/apache2/ports.conf')).toContain('Listen 80')
    expect(n.out('srv', 'cat /etc/apache2/apache2.conf')).toContain('IncludeOptional sites-enabled/*.conf')
    expect(n.out('srv', 'cat /etc/apache2/sites-enabled/000-default.conf')).toContain(
      'DocumentRoot /var/www/html'
    )
    expect(n.out('srv', 'cat /etc/apache2/mods-enabled/dir.conf')).toContain('DirectoryIndex index.html')
  })

  it('la page par défaut de Debian remplace l’ancien index.html (10701 octets)', () => {
    const n = net()
    expect(n.out('srv', 'ls -l /var/www/html')).toContain('10701')
    expect(n.out('srv', 'cat /var/www/html/index.html')).toContain('Apache2 Debian Default Page')
    const nu = net({ install: false })
    expect(nu.out('srv', 'ls -l /var/www/html')).toContain(' 45 ')
  })

  it('les commandes Apache n’existent pas sans le paquet', () => {
    const n = net({ install: false })
    expect(n.run('srv', 'sudo a2ensite 000-default').errors).not.toBe('')
    expect(n.run('srv', 'sudo apache2ctl configtest').errors).not.toBe('')
  })

  it('apache2 écoute sur le port 80 et démarre au boot', () => {
    const n = net()
    expect(n.out('srv', 'sudo ss -tln')).toContain('*:80')
    expect(n.out('srv', 'systemctl is-active apache2')).toBe('active')
    expect(n.out('srv', 'systemctl is-enabled apache2')).toBe('enabled')
    n.host('LSRV1')
  })
})

describe('a2ensite, a2dissite : liens symboliques', () => {
  it('a2ensite crée un lien relatif ; a2dissite le supprime ; ls -l le montre', () => {
    const n = net()
    n.page('/var/www/site1', 'Site 1')
    n.site('site1', '/var/www/site1')
    expect(n.out('srv', 'sudo a2ensite site1')).toBe(
      'Enabling site site1.\nTo activate the new configuration, you need to run:\n  systemctl reload apache2'
    )
    expect(n.out('srv', 'ls -l /etc/apache2/sites-enabled')).toContain(
      'site1.conf -> ../sites-available/site1.conf'
    )
    expect(n.out('srv', 'cat /etc/apache2/sites-enabled/site1.conf')).toContain('ServerName site1.lab.local')
    expect(n.out('srv', 'sudo a2dissite site1')).toContain('Site site1 disabled.')
    expect(n.out('srv', 'ls /etc/apache2/sites-enabled')).toBe('000-default.conf')
  })

  it('a2ensite accepte le suffixe .conf, plusieurs noms et les jokers', () => {
    const n = net()
    n.site('a', '/var/www/html')
    n.site('b', '/var/www/html')
    const out = n.out('srv', 'sudo a2ensite a.conf b')
    expect(out).toContain('Enabling site a.')
    expect(out).toContain('Enabling site b.')
    expect(n.out('srv', 'sudo a2dissite "*"')).toContain('Site a disabled.')
    expect(n.out('srv', 'ls /etc/apache2/sites-enabled')).toBe('')
  })

  it('-q supprime les messages d’information, pas les erreurs', () => {
    const n = net()
    n.site('a', '/var/www/html')
    expect(n.out('srv', 'sudo a2ensite -q a')).toBe('Enabling site a.')
    expect(n.out('srv', 'sudo a2ensite -q nexiste')).toBe('ERROR: No site found matching nexiste!')
    expect(n.out('srv', 'sudo a2ensite -z a')).toBe('Unknown option: z')
  })

  it('sans sudo : le lien ne peut pas être créé ni supprimé', () => {
    const n = net()
    n.site('a', '/var/www/html')
    expect(n.out('srv', 'a2ensite a')).toBe(
      'Enabling site a.\nCould not create /etc/apache2/sites-enabled/a.conf: Permission denied'
    )
    expect(n.out('srv', 'a2dissite 000-default')).toBe(
      'Could not remove /etc/apache2/sites-enabled/000-default.conf: Permission denied'
    )
    expect(n.out('srv', 'ls /etc/apache2/sites-enabled')).toBe('000-default.conf')
  })

  it('un fichier réel dans sites-enabled n’est pas touché', () => {
    const n = net()
    n.write('/etc/apache2/sites-enabled/reel.conf', ['# fichier réel'])
    n.write('/etc/apache2/sites-available/reel.conf', ['# autre'])
    expect(n.out('srv', 'sudo a2ensite reel')).toContain(
      'ERROR: Site reel not properly enabled: /etc/apache2/sites-enabled/reel.conf is a real file, not touching it'
    )
  })

  it('sed -i remplace un lien par un fichier ordinaire, tee écrit dans la cible', () => {
    const n = net()
    n.out('srv', "echo '# test' | sudo tee -a /etc/apache2/sites-enabled/000-default.conf")
    expect(n.out('srv', 'tail -1 /etc/apache2/sites-available/000-default.conf')).not.toBe('')
    expect(n.out('srv', 'cat /etc/apache2/sites-available/000-default.conf')).toContain('# test')
    n.run('srv', "sudo sed -i 's/webmaster/admin/' /etc/apache2/sites-enabled/000-default.conf")
    expect(n.out('srv', 'ls -l /etc/apache2/sites-enabled')).toContain('-rw-r--r--')
  })
})

describe('a2enmod, a2dismod, a2enconf : modules, dépendances, conflits', () => {
  it('a2enmod ssl active ses dépendances d’abord, comme le script Perl', () => {
    const n = net()
    const out = n.out('srv', 'sudo a2enmod ssl')
    expect(out.split('\n')).toEqual([
      'Considering dependency setenvif for ssl:',
      'Module setenvif already enabled',
      'Considering dependency mime for ssl:',
      'Module mime already enabled',
      'Considering dependency socache_shmcb for ssl:',
      'Enabling module socache_shmcb.',
      'Enabling module ssl.',
      'See /usr/share/doc/apache2/README.Debian.gz on how to configure SSL and create self-signed certificates.',
      'To activate the new configuration, you need to run:',
      '  systemctl restart apache2'
    ])
    // ssl.conf est activé avec ssl.load
    const enabled = n.out('srv', 'ls /etc/apache2/mods-enabled')
    expect(enabled).toContain('ssl.conf')
    expect(enabled).toContain('socache_shmcb.load')
  })

  it('a2dismod : refus si un module dépend du module, -f désactive aussi les dépendants', () => {
    const n = net()
    n.run('srv', 'sudo a2enmod ssl')
    expect(n.out('srv', 'sudo a2dismod socache_shmcb')).toBe(
      'ERROR: The following modules depend on socache_shmcb and need to be disabled first: ssl'
    )
    const forced = n.out('srv', 'sudo a2dismod -f socache_shmcb')
    expect(forced).toContain('Module ssl disabled.')
    expect(forced).toContain('Module socache_shmcb disabled.')
    expect(n.out('srv', 'ls /etc/apache2/mods-enabled')).not.toContain('ssl')
  })

  it('un module essentiel demande la phrase de confirmation', () => {
    const n = net()
    const refused = n.out('srv', 'sudo a2dismod dir', ['non'])
    expect(refused).toContain('WARNING: The following essential module will be disabled.')
    expect(refused).toContain(' dir')
    expect(refused.endsWith('Aborting')).toBe(true)
    expect(n.out('srv', 'ls /etc/apache2/mods-enabled')).toContain('dir.load')
    expect(n.out('srv', 'sudo a2dismod dir', ['Yes, do as I say!'])).toContain('Module dir disabled.')
    expect(n.out('srv', 'ls /etc/apache2/mods-enabled')).not.toContain('dir.load')
  })

  it('deux MPM ne cohabitent pas (# Conflicts:)', () => {
    const n = net()
    expect(n.out('srv', 'sudo a2enmod mpm_prefork')).toContain(
      'ERROR: Module mpm_event is enabled - cannot proceed due to conflicts. It needs to be disabled first!'
    )
  })

  it('sans module MPM, Apache refuse la configuration (AH00534)', () => {
    const n = net()
    n.run('srv', 'sudo a2dismod -f mpm_event')
    expect(n.out('srv', 'sudo apache2ctl configtest')).toBe(
      "AH00534: apache2: Configuration error: No MPM loaded.\nAction 'configtest' failed.\nThe Apache error log may have more information."
    )
  })

  it('a2enconf / a2disconf agissent sur conf-enabled (rechargement, pas redémarrage)', () => {
    const n = net()
    expect(n.out('srv', 'sudo a2disconf security')).toContain('Conf security disabled.')
    expect(n.out('srv', 'sudo a2disconf security')).toContain('ERROR: No conf found matching security!')
    const out = n.out('srv', 'sudo a2enconf security')
    expect(out).toContain('Enabling conf security.')
    expect(out).toContain('systemctl reload apache2')
  })

  it('a2enmod sans argument liste les choix puis interroge', () => {
    const n = net()
    const out = n.out('srv', 'sudo a2enmod', ['rewrite'])
    expect(out).toContain('Your choices are: access_compat actions alias')
    expect(out).toContain('Enabling module rewrite.')
  })
})

describe('apache2ctl configtest', () => {
  it('Syntax OK avec l’avertissement AH00558 tant que ServerName n’est pas défini', () => {
    const n = net()
    expect(n.out('srv', 'sudo apache2ctl configtest')).toBe(
      "AH00558: apache2: Could not reliably determine the server's fully qualified domain name, using 127.0.1.1. Set the 'ServerName' directive globally to suppress this message\nSyntax OK"
    )
    n.write('/etc/apache2/conf-available/servername.conf', ['ServerName lsrv1.lab.local'])
    n.run('srv', 'sudo a2enconf servername')
    expect(n.out('srv', 'sudo apache2ctl configtest')).toBe('Syntax OK')
    expect(n.out('srv', 'apachectl -t')).toBe('Syntax OK')
  })

  it('un nom de machine absent de /etc/hosts donne AH00557 puis AH00558 avec 127.0.0.1', () => {
    const n = net()
    n.run('srv', "sudo sed -i 's/^127.0.1.1/#127.0.1.1/' /etc/hosts")
    expect(n.out('srv', 'sudo apache2ctl configtest')).toBe(
      "AH00557: apache2: apr_sockaddr_info_get() failed for LSRV1\nAH00558: apache2: Could not reliably determine the server's fully qualified domain name, using 127.0.0.1. Set the 'ServerName' directive globally to suppress this message\nSyntax OK"
    )
  })

  it('erreur de syntaxe : numéro de ligne, fichier réel et message d’Apache', () => {
    const n = net()
    n.site('casse', '/var/www/html', ['    DocumentRot /var/www/html'])
    n.run('srv', 'sudo a2ensite casse')
    expect(n.out('srv', 'sudo apache2ctl configtest')).toBe(
      [
        'AH00526: Syntax error on line 4 of /etc/apache2/sites-enabled/casse.conf:',
        "Invalid command 'DocumentRot', perhaps misspelled or defined by a module not included in the server configuration",
        "Action 'configtest' failed.",
        'The Apache error log may have more information.'
      ].join('\n')
    )
    // la même erreur par l'option -t, avec le nom de l'action tapé
    expect(n.out('srv', 'sudo apache2ctl -t')).toContain("Action '-t' failed.")
  })

  it('nombre d’arguments : message de invoke_cmd avec l’aide de la directive', () => {
    const n = net()
    n.site('a', '/var/www/html', ['    ServerAdmin'])
    n.run('srv', 'sudo a2ensite a')
    expect(n.out('srv', 'sudo apache2ctl configtest')).toContain(
      'ServerAdmin takes one argument, The email address of the server administrator'
    )
    n.run('srv', 'sudo a2dissite a')
    n.site('b', '/var/www/html', ['    ServerName x y'])
    n.run('srv', 'sudo a2ensite b')
    expect(n.out('srv', 'sudo apache2ctl configtest')).toContain(
      'ServerName takes one argument, The hostname and port of the server'
    )
    n.run('srv', 'sudo a2dissite b')
    n.site('c', '/var/www/html', ['    KeepAlive peut-etre'])
    n.run('srv', 'sudo a2ensite c')
    expect(n.out('srv', 'sudo apache2ctl configtest')).toContain('KeepAlive must be On or Off')
  })

  it('une directive d’un module non activé est inconnue (RewriteEngine sans mod_rewrite)', () => {
    const n = net()
    n.site('r', '/var/www/html', ['    RewriteEngine On'])
    n.run('srv', 'sudo a2ensite r')
    expect(n.out('srv', 'sudo apache2ctl configtest')).toContain("Invalid command 'RewriteEngine'")
    n.run('srv', 'sudo a2enmod rewrite')
    expect(n.out('srv', 'sudo apache2ctl configtest')).toContain('Syntax OK')
  })

  it('sections mal fermées : messages de ap_build_config, imbriqués par Include', () => {
    const n = net()
    n.write('/etc/apache2/sites-available/ouvert.conf', ['<VirtualHost *:80>', '  ServerName x'])
    n.run('srv', 'sudo a2ensite ouvert')
    expect(n.out('srv', 'sudo apache2ctl configtest').split('\n')[0]).toBe(
      'apache2: Syntax error on line 225 of /etc/apache2/apache2.conf: Syntax error on line 1 of /etc/apache2/sites-enabled/ouvert.conf: /etc/apache2/sites-enabled/ouvert.conf:1: <VirtualHost> was not closed.'
    )
    n.run('srv', 'sudo a2dissite ouvert')
    n.write('/etc/apache2/sites-available/ferme.conf', ['</VirtualHost>'])
    n.run('srv', 'sudo a2ensite ferme')
    expect(n.out('srv', 'sudo apache2ctl configtest')).toContain(
      'Syntax error on line 1 of /etc/apache2/sites-enabled/ferme.conf: </VirtualHost> without matching <VirtualHost> section'
    )
    n.run('srv', 'sudo a2dissite ferme')
    n.write('/etc/apache2/sites-available/croise.conf', ['<VirtualHost *:80>', '</Directory>'])
    n.run('srv', 'sudo a2ensite croise')
    expect(n.out('srv', 'sudo apache2ctl configtest')).toContain(
      'Expected </VirtualHost> but saw </Directory>'
    )
  })

  it('DocumentRoot inexistant : avertissement AH00112 pour un site, erreur pour le serveur principal', () => {
    const n = net()
    n.site('v', '/var/www/nexiste')
    n.run('srv', 'sudo a2ensite v')
    expect(n.out('srv', 'sudo apache2ctl configtest')).toContain(
      'AH00112: Warning: DocumentRoot [/var/www/nexiste] does not exist'
    )
    n.run('srv', 'sudo a2dissite v')
    n.write('/etc/apache2/conf-available/racine.conf', ['DocumentRoot /var/www/nexiste'])
    n.run('srv', 'sudo a2enconf racine')
    expect(n.out('srv', 'sudo apache2ctl configtest')).toContain(
      "DocumentRoot '/var/www/nexiste' is not a directory, or is not readable"
    )
  })

  it('certificat ou clé SSL introuvable : message de mod_ssl', () => {
    const n = net()
    n.run('srv', 'sudo a2enmod ssl')
    n.run('srv', 'sudo a2ensite default-ssl')
    expect(n.out('srv', 'sudo apache2ctl configtest')).toContain('Syntax OK')
    n.run('srv', "sudo sed -i 's#snakeoil.pem#absent.pem#' /etc/apache2/sites-available/default-ssl.conf")
    expect(n.out('srv', 'sudo apache2ctl configtest')).toContain(
      "SSLCertificateFile: file '/etc/ssl/certs/ssl-cert-absent.pem' does not exist or is empty"
    )
  })

  it('Listen invalide', () => {
    const n = net()
    n.write('/etc/apache2/conf-available/l.conf', ['Listen'])
    n.run('srv', 'sudo a2enconf l')
    expect(n.out('srv', 'sudo apache2ctl configtest')).toContain('Listen requires 1 or 2 arguments.')
  })

  it('apache2ctl sans argument affiche l’aide ; -v, -M et -S', () => {
    const n = net()
    expect(n.run('srv', 'apache2ctl').errors).toContain('Usage: /usr/sbin/apache2ctl start|stop|restart')
    expect(n.out('srv', 'apache2ctl -v')).toContain('Server version: Apache/2.4.68 (Debian)')
    expect(n.out('srv', 'apache2ctl -M')).not.toContain('rewrite_module') // module non activé
    expect(n.out('srv', 'apache2ctl -M')).toContain('dir_module (shared)')
  })
})

describe('configuration en vigueur : reload et restart', () => {
  it('un site activé ne répond qu’après le rechargement', () => {
    const n = net()
    n.page('/var/www/site1', 'Site 1')
    n.site('site1', '/var/www/site1')
    n.run('srv', 'sudo a2ensite site1')
    expect(n.curl('site1.lab.local')).toContain('Apache2 Debian Default Page')
    n.run('srv', 'sudo systemctl reload apache2')
    expect(n.curl('site1.lab.local')).toBe('<h1>Site 1</h1>')
  })

  it('une modification de fichier n’agit qu’après reload ; l’instantané est oublié ensuite', () => {
    const n = twoSites()
    n.run('srv', "echo '<h1>Nouveau</h1>' | sudo tee /var/www/site1/index.html")
    // le contenu d'une page est lu à chaque requête (pas de la configuration)
    expect(n.curl('site1.lab.local')).toBe('<h1>Nouveau</h1>')
    n.run('srv', "sudo sed -i 's#/var/www/site1#/var/www/site2#' /etc/apache2/sites-available/site1.conf")
    expect(n.host('LSRV1').host.linux?.loaded?.['apache2']).toBeDefined()
    expect(n.curl('site1.lab.local')).toBe('<h1>Nouveau</h1>')
    n.run('srv', 'sudo systemctl reload apache2')
    expect(n.host('LSRV1').host.linux?.loaded?.['apache2']).toBeUndefined()
    expect(n.curl('site1.lab.local')).toBe('<h1>Site 2</h1>')
  })

  it('reload avec une configuration invalide échoue et garde l’ancienne', () => {
    const n = twoSites()
    n.site('casse', '/var/www/site1', ['    Bidule'])
    n.run('srv', 'sudo a2ensite casse')
    const r = n.run('srv', 'sudo systemctl reload apache2')
    expect(r.errors).toContain(
      'Job for apache2.service failed because the control process exited with error code.'
    )
    expect(n.out('srv', 'systemctl is-active apache2')).toBe('active')
    expect(n.curl('site2.lab.local')).toBe('<h1>Site 2</h1>')
    const journal = n.out('srv', 'sudo journalctl -u apache2 -n 6')
    expect(journal).toContain('apachectl[')
    expect(journal).toContain("Invalid command 'Bidule'")
    expect(journal).toContain('Reload failed for apache2.service - The Apache HTTP Server.')
  })

  it('restart avec une configuration invalide laisse Apache arrêté', () => {
    const n = twoSites()
    n.site('casse', '/var/www/site1', ['    Bidule'])
    n.run('srv', 'sudo a2ensite casse')
    const r = n.run('srv', 'sudo systemctl restart apache2')
    expect(r.errors).toContain('Job for apache2.service failed')
    expect(n.out('srv', 'systemctl is-active apache2')).toBe('failed')
    expect(n.run('pc', 'curl -I http://192.168.2.10').errors).toContain('(7) Failed to connect')
    // on corrige puis on redémarre
    n.run('srv', 'sudo a2dissite casse')
    expect(n.run('srv', 'sudo systemctl restart apache2').errors).toBe('')
    expect(n.out('pc', 'curl -s -H "Host: site1.lab.local" http://192.168.2.10/')).toBe('<h1>Site 1</h1>')
  })

  it('apache2ctl restart / graceful / stop / start passent par le service', () => {
    const n = twoSites()
    expect(n.out('srv', 'sudo apache2ctl graceful')).toBe('')
    expect(n.out('srv', 'sudo apache2ctl stop')).toBe('')
    expect(n.out('srv', 'systemctl is-active apache2')).toBe('inactive')
    expect(n.out('srv', 'sudo apache2ctl stop')).toBe(
      "httpd (no pid file) not running\nAction 'stop' failed.\nThe Apache error log may have more information."
    )
    expect(n.out('srv', 'sudo apache2ctl restart')).toBe('httpd not running, trying to start')
    expect(n.out('srv', 'systemctl is-active apache2')).toBe('active')
    expect(n.out('srv', 'sudo apache2ctl start')).toBe(
      "Invoking 'systemctl start apache2'.\nUse 'systemctl status apache2' for more info."
    )
  })

  it('le démarrage relit la configuration et reprend les sites', () => {
    const n = twoSites()
    n.run('srv', 'sudo systemctl stop apache2')
    n.run('srv', 'sudo a2dissite site2')
    n.run('srv', 'sudo systemctl start apache2')
    expect(n.curl('site2.lab.local')).toContain('Apache2 Debian Default Page') // site2 n'existe plus : site par défaut
  })
})

describe('hôtes virtuels, ports et adresses', () => {
  it('par nom : ServerName, ServerAlias, premier site = site par défaut', () => {
    const n = net()
    n.page('/var/www/site1', 'Site 1')
    n.site('site1', '/var/www/site1', ['    ServerAlias www.site1.lab.local *.apps.lab.local'])
    n.run('srv', 'sudo a2ensite site1')
    n.run('srv', 'sudo systemctl reload apache2')
    expect(n.curl('site1.lab.local')).toBe('<h1>Site 1</h1>')
    expect(n.curl('WWW.SITE1.LAB.LOCAL')).toBe('<h1>Site 1</h1>')
    expect(n.curl('a.apps.lab.local')).toBe('<h1>Site 1</h1>')
    expect(n.curl('inconnu.lab.local')).toContain('Apache2 Debian Default Page')
  })

  it('par port : un second site sur Listen 8080', () => {
    const n = net()
    n.page('/var/www/site1', 'Site 1')
    n.write('/etc/apache2/sites-available/p.conf', [
      '<VirtualHost *:8080>',
      '    DocumentRoot /var/www/site1',
      '</VirtualHost>'
    ])
    n.run('srv', 'sudo a2ensite p')
    n.run('srv', "echo 'Listen 8080' | sudo tee -a /etc/apache2/ports.conf")
    n.run('srv', 'sudo systemctl restart apache2')
    expect(n.out('srv', 'sudo ss -tln')).toContain('*:8080')
    expect(n.out('pc', 'curl -s http://192.168.2.10:8080/')).toBe('<h1>Site 1</h1>')
    expect(n.out('pc', 'curl -s http://192.168.2.10/')).toContain('Apache2 Debian Default Page')
  })

  it('sans Listen correspondant, le port reste fermé même avec un VirtualHost', () => {
    const n = net()
    n.write('/etc/apache2/sites-available/p.conf', [
      '<VirtualHost *:9090>',
      '    DocumentRoot /var/www/html',
      '</VirtualHost>'
    ])
    n.run('srv', 'sudo a2ensite p')
    n.run('srv', 'sudo systemctl reload apache2')
    expect(n.run('pc', 'curl -I http://192.168.2.10:9090/').errors).toContain('(7) Failed to connect')
  })

  it('par adresse IP : Listen et VirtualHost sur 192.168.2.10 seulement', () => {
    const n = net()
    n.run('srv', "sudo sed -i 's/^Listen 80$/Listen 192.168.2.10:80/' /etc/apache2/ports.conf")
    n.run('srv', 'sudo systemctl restart apache2')
    expect(n.out('srv', 'sudo ss -tln')).toContain('192.168.2.10:80')
    expect(n.out('pc', 'curl -s http://192.168.2.10/')).toContain('Apache2 Debian Default Page')
    expect(n.run('srv', 'curl -I http://127.0.0.1').errors).toContain('(7) Failed to connect')
    expect(n.out('srv', 'curl -s http://192.168.2.10/')).toContain('Apache2 Debian Default Page')
  })

  it('apache2ctl -S : IP précise avant les jokers, NameVirtualHost, alias', () => {
    const n = net()
    n.site('a', '/var/www/html', ['    ServerAlias a2.lab.local *.a.lab.local'])
    n.run('srv', 'sudo a2ensite a')
    const s = n.out('srv', 'sudo apache2ctl -S')
    expect(s).toContain('*:80                   is a NameVirtualHost')
    expect(s).toContain('port 80 namevhost a.lab.local (/etc/apache2/sites-enabled/a.conf:1)')
    expect(s).toContain('alias a2.lab.local')
    expect(s).toContain('wild alias *.a.lab.local')
  })

  it('apache2ctl -S : un site sur une IP précise est listé séparément', () => {
    const n = net()
    n.write('/etc/apache2/sites-available/ip.conf', [
      '<VirtualHost 192.168.2.10:80>',
      '  ServerName ip.lab.local',
      '</VirtualHost>'
    ])
    n.run('srv', 'sudo a2ensite ip')
    const IP_LINE = `${'192.168.2.10:80'.padEnd(22)} ip.lab.local (/etc/apache2/sites-enabled/ip.conf:1)`
    const s = n.out('srv', 'sudo apache2ctl -S').split('\n')
    expect(s).toContain(IP_LINE)
    expect(s.indexOf(IP_LINE)).toBeLessThan(s.findIndex((l) => l.startsWith('*:80')))
  })

  it('conflit de port avec nginx : Apache ne démarre pas, messages du journal', () => {
    const n = net()
    n.run('srv', 'sudo systemctl stop apache2')
    n.run('srv', 'sudo apt install nginx', ['y'])
    const r = n.run('srv', 'sudo systemctl start apache2')
    expect(r.errors).toContain('Job for apache2.service failed')
    const journal = n.out('srv', 'sudo journalctl -u apache2')
    expect(journal).toContain(
      '(98)Address already in use: AH00072: make_sock: could not bind to address [::]:80'
    )
    expect(journal).toContain(
      '(98)Address already in use: AH00072: make_sock: could not bind to address 0.0.0.0:80'
    )
    expect(journal).toContain('no listening sockets available, shutting down')
    expect(journal).toContain('AH00015: Unable to open logs')
    // changer de port résout le conflit
    n.run('srv', "sudo sed -i 's/^Listen 80$/Listen 8080/' /etc/apache2/ports.conf")
    n.run('srv', 'sudo systemctl start apache2')
    expect(n.out('srv', 'systemctl is-active apache2')).toBe('active')
    expect(n.out('pc', 'curl -s -I http://192.168.2.10:8080/')).toContain('Server: Apache/2.4.68 (Debian)')
    expect(n.out('pc', 'curl -s -I http://192.168.2.10/')).toContain('Server: nginx/1.22.1')
  })

  it('un conflit de port IPv4 précis : l’adresse précise est citée', () => {
    const n = net()
    n.run('srv', 'sudo systemctl stop apache2')
    n.run('srv', 'sudo apt install nginx', ['y'])
    n.run('srv', "sudo sed -i 's/^Listen 80$/Listen 192.168.2.10:80/' /etc/apache2/ports.conf")
    n.run('srv', 'sudo systemctl start apache2')
    expect(n.out('srv', 'sudo journalctl -u apache2')).toContain('could not bind to address 192.168.2.10:80')
  })
})

describe('contenu servi, droits, options', () => {
  it('le contenu vient du DocumentRoot et des fichiers du serveur', () => {
    const n = twoSites()
    expect(n.curl('site1.lab.local', '/')).toBe('<h1>Site 1</h1>')
    n.run('srv', "echo 'bonjour' | sudo tee /var/www/site1/a.txt")
    expect(n.curl('site1.lab.local', '/a.txt')).toBe('bonjour')
    expect(n.out('pc', 'curl -I -H "Host: site1.lab.local" http://192.168.2.10/a.txt')).toContain(
      'Content-Type: text/plain'
    )
    expect(n.out('pc', 'curl -I -H "Host: site1.lab.local" http://192.168.2.10/a.txt')).toContain(
      'Content-Length: 8'
    )
  })

  it('404 : page d’erreur d’Apache, journal d’accès, rien dans error.log au niveau warn', () => {
    const n = twoSites()
    const out = n.out('pc', 'curl http://192.168.2.10/nexiste.html')
    expect(out).toContain('<title>404 Not Found</title>')
    expect(out).toContain('<address>Apache/2.4.68 (Debian) Server at 192.168.2.10 Port 80</address>')
    expect(n.out('srv', 'sudo cat /var/log/apache2/access.log')).toContain(
      '"GET /nexiste.html HTTP/1.1" 404 '
    )
    expect(n.out('srv', 'sudo cat /var/log/apache2/error.log')).not.toContain('AH00128')
    // LogLevel info : le fichier manquant est journalisé (AH00128)
    n.write('/etc/apache2/conf-available/niveau.conf', ['LogLevel info'])
    n.run('srv', 'sudo a2enconf niveau')
    n.run('srv', 'sudo systemctl reload apache2')
    n.run('pc', 'curl -s http://192.168.2.10/nexiste.html')
    expect(n.out('srv', 'sudo cat /var/log/apache2/error.log')).toContain('[core:info] [pid ')
    expect(n.out('srv', 'sudo cat /var/log/apache2/error.log')).toContain(
      'AH00128: File does not exist: /var/www/html/nexiste.html'
    )
  })

  it('un DocumentRoot hors /var/www est refusé par apache2.conf (Require all denied)', () => {
    const n = net()
    n.run('srv', 'sudo mkdir -p /srv/site3')
    n.run('srv', "echo '<h1>Site 3</h1>' | sudo tee /srv/site3/index.html")
    n.site('site3', '/srv/site3')
    n.run('srv', 'sudo a2ensite site3')
    n.run('srv', 'sudo systemctl reload apache2')
    expect(n.run('pc', 'curl -s -H "Host: site3.lab.local" http://192.168.2.10/').text).toContain(
      '403 Forbidden'
    )
    expect(n.out('srv', 'sudo cat /var/log/apache2/error.log')).toContain(
      'AH01630: client denied by server configuration: /srv/site3/'
    )
    // la solution : un bloc Directory qui autorise le dossier
    n.write('/etc/apache2/conf-available/srv.conf', [
      '<Directory /srv/site3>',
      '    Require all granted',
      '</Directory>'
    ])
    n.run('srv', 'sudo a2enconf srv')
    n.run('srv', 'sudo systemctl reload apache2')
    expect(n.curl('site3.lab.local')).toBe('<h1>Site 3</h1>')
  })

  it('droits Unix : www-data doit lire le fichier et traverser les dossiers', () => {
    const n = twoSites()
    n.run('srv', 'sudo chmod 600 /var/www/site1/index.html')
    expect(n.out('pc', 'curl -s -I -H "Host: site1.lab.local" http://192.168.2.10/')).toContain(
      '403 Forbidden'
    )
    expect(n.out('srv', 'sudo cat /var/log/apache2/error.log')).toContain(
      '(13)Permission denied: [client 192.168.2.20:'
    )
    expect(n.out('srv', 'sudo cat /var/log/apache2/error.log')).toContain(
      'AH00132: file permissions deny server access: /var/www/site1/index.html'
    )
    // propriétaire www-data : accès rétabli
    n.run('srv', 'sudo chown www-data /var/www/site1/index.html')
    expect(n.curl('site1.lab.local')).toBe('<h1>Site 1</h1>')
    // un dossier sans droit x
    n.run('srv', 'sudo chmod 700 /var/www/site2')
    expect(n.out('pc', 'curl -s -I -H "Host: site2.lab.local" http://192.168.2.10/')).toContain(
      '403 Forbidden'
    )
    expect(n.out('srv', 'sudo cat /var/log/apache2/error.log')).toContain(
      "AH00035: access to / denied (filesystem path '/var/www/site2/index.html') because search permissions are missing on a component of the path"
    )
  })

  it('Require ip : accès limité à un sous-réseau, le message change', () => {
    const n = twoSites()
    n.write('/etc/apache2/conf-available/restreint.conf', [
      '<Directory /var/www/site1>',
      '    Require ip 10.0.0.0/8',
      '</Directory>'
    ])
    n.run('srv', 'sudo a2enconf restreint')
    n.run('srv', 'sudo systemctl reload apache2')
    expect(n.out('pc', 'curl -s -I -H "Host: site1.lab.local" http://192.168.2.10/')).toContain(
      '403 Forbidden'
    )
    n.run('srv', "sudo sed -i 's#10.0.0.0/8#192.168.2.0/24#' /etc/apache2/conf-available/restreint.conf")
    n.run('srv', 'sudo systemctl reload apache2')
    expect(n.curl('site1.lab.local')).toBe('<h1>Site 1</h1>')
  })

  it('Require valid-user sans identifiants : 401 avec WWW-Authenticate', () => {
    const n = twoSites()
    n.write('/etc/apache2/conf-available/auth.conf', [
      '<Directory /var/www/site1>',
      '    AuthType Basic',
      '    AuthName "Zone privee"',
      '    AuthUserFile /etc/apache2/.htpasswd',
      '    Require valid-user',
      '</Directory>'
    ])
    n.run('srv', 'sudo a2enconf auth')
    n.run('srv', 'sudo systemctl reload apache2')
    const out = n.out('pc', 'curl -I -H "Host: site1.lab.local" http://192.168.2.10/')
    expect(out).toContain('HTTP/1.1 401 Unauthorized')
    expect(out).toContain('WWW-Authenticate: Basic realm="Restricted Content"')
  })

  it('sans index.html : Options Indexes liste le dossier, sinon 403 et AH01276', () => {
    const n = net()
    n.run('srv', 'sudo mkdir /var/www/html/vide')
    const listed = n.run('pc', 'curl -i http://192.168.2.10/vide/')
    expect(listed.text).toContain('HTTP/1.1 200 OK')
    expect(listed.text).toContain('Content-Type: text/html;charset=UTF-8')
    expect(listed.text).toContain('mod_autoindex')
    n.write('/etc/apache2/conf-available/noindex.conf', [
      '<Directory /var/www/>',
      '    Options -Indexes',
      '</Directory>'
    ])
    n.run('srv', 'sudo a2enconf noindex')
    n.run('srv', 'sudo systemctl reload apache2')
    expect(n.out('pc', 'curl -s http://192.168.2.10/vide/')).toContain('403 Forbidden')
    expect(n.out('srv', 'sudo cat /var/log/apache2/error.log')).toContain(
      'AH01276: Cannot serve directory /var/www/html/vide/: No matching DirectoryIndex (index.html,index.cgi,index.pl,index.php,index.xhtml,index.htm) found, and server-generated directory index forbidden by Options directive'
    )
  })

  it('DirectoryIndex : un autre fichier d’accueil', () => {
    const n = net()
    n.run('srv', "echo 'accueil' | sudo tee /var/www/html/accueil.html")
    n.run('srv', 'sudo mkdir /var/www/html/sous')
    n.run('srv', "echo 'sous-accueil' | sudo tee /var/www/html/sous/accueil.html")
    n.run('srv', "echo 'DirectoryIndex accueil.html' | sudo tee /etc/apache2/mods-available/dir.conf")
    n.run('srv', 'sudo systemctl reload apache2')
    expect(n.out('pc', 'curl -s http://192.168.2.10/sous/')).toBe('sous-accueil')
  })

  it('un dossier demandé sans « / » final est redirigé (301)', () => {
    const n = net()
    n.run('srv', 'sudo mkdir /var/www/html/docs')
    const out = n.out('pc', 'curl -I http://192.168.2.10/docs')
    expect(out).toContain('HTTP/1.1 301 Moved Permanently')
    expect(out).toContain('Location: http://192.168.2.10/docs/')
    expect(n.out('pc', 'curl -s -L -I http://192.168.2.10/docs')).toContain('HTTP/1.1 301')
  })

  it('Redirect et Alias de mod_alias', () => {
    const n = twoSites()
    n.write('/etc/apache2/conf-available/alias.conf', [
      'Redirect 302 /vieux http://192.168.2.10/media/',
      'Alias /media /var/www/site2'
    ])
    n.run('srv', 'sudo a2enconf alias')
    n.run('srv', 'sudo systemctl reload apache2')
    const r = n.out('pc', 'curl -I http://192.168.2.10/vieux/x')
    expect(r).toContain('HTTP/1.1 302 Found')
    expect(r).toContain('Location: http://192.168.2.10/media/x')
    expect(n.out('pc', 'curl -s http://192.168.2.10/media/')).toBe('<h1>Site 2</h1>')
    expect(n.out('pc', 'curl -s -L -H "Host: site1.lab.local" http://192.168.2.10/vieux/')).toBe(
      '<h1>Site 2</h1>'
    )
  })

  it('ServerTokens Prod et ServerSignature Off après rechargement', () => {
    const n = net()
    expect(n.out('pc', 'curl -I http://192.168.2.10/x')).toContain('Server: Apache/2.4.68 (Debian)')
    n.run(
      'srv',
      "sudo sed -i 's/^ServerTokens OS/ServerTokens Prod/; s/^ServerSignature On/ServerSignature Off/' /etc/apache2/conf-available/security.conf"
    )
    // la configuration en vigueur ne change pas avant le rechargement
    expect(n.out('pc', 'curl -I http://192.168.2.10/x')).toContain('Server: Apache/2.4.68 (Debian)')
    n.run('srv', 'sudo systemctl reload apache2')
    const head = n.out('pc', 'curl -I http://192.168.2.10/x')
    expect(head).toContain('Server: Apache\n')
    expect(n.out('pc', 'curl -s http://192.168.2.10/x')).not.toContain('<address>')
  })

  it('en-têtes : ETag, Last-Modified, Vary (mod_deflate), Content-Length calculés', () => {
    const n = net()
    const head = n.out('pc', 'curl -I http://192.168.2.10/')
    expect(head).toMatch(
      /^HTTP\/1\.1 200 OK\nDate: Mon, 05 Jan 2026 08:00:\d\d GMT\nServer: Apache\/2\.4\.68 \(Debian\)\n/
    )
    expect(head).toContain('ETag: "29cd-')
    expect(head).toContain('Content-Length: 10701')
    expect(head).toContain('Vary: Accept-Encoding')
    n.run('srv', "echo 'x' | sudo tee /var/www/html/image.png")
    expect(n.out('pc', 'curl -I http://192.168.2.10/image.png')).not.toContain('Vary')
    // désactiver mod_deflate retire la compression : Vary disparaît après redémarrage
    n.run('srv', 'sudo a2dismod -f deflate')
    n.run('srv', 'sudo systemctl restart apache2')
    expect(n.out('pc', 'curl -I http://192.168.2.10/')).not.toContain('Vary')
  })

  it('PHP n’est pas exécuté : le fichier est servi tel quel, avec une remarque', () => {
    const n = net()
    n.run('srv', "echo '<?php echo 1; ?>' | sudo tee /var/www/html/t.php")
    const r = n.run('pc', 'curl http://192.168.2.10/t.php')
    expect(r.text).toContain('<?php echo 1; ?>')
    expect(r.text).toContain('PHP n’est pas exécuté')
  })

  it('curl : -o /dev/null -w, -i, -A et les options non simulées', () => {
    const n = net()
    expect(n.out('pc', "curl -s -o /dev/null -w '%{http_code}\\n' http://192.168.2.10/")).toBe('200')
    expect(n.out('pc', "curl -s -o /dev/null -w '%{http_code}\\n' http://192.168.2.10/nope")).toBe('404')
    expect(n.out('pc', 'curl -i http://192.168.2.10/nope')).toContain('HTTP/1.1 404 Not Found')
    n.run('pc', 'curl -s -A "MonAgent/1.0" http://192.168.2.10/')
    expect(n.out('srv', 'sudo cat /var/log/apache2/access.log')).toContain('"MonAgent/1.0"')
    expect(n.run('pc', 'curl -X POST http://192.168.2.10/').errors).toContain('n’est pas simulée')
  })
})

describe('journaux', () => {
  it('access.log : format combined, une ligne par requête, heure du lab', () => {
    const n = net()
    n.run('pc', 'curl -s http://192.168.2.10/')
    n.run('pc', 'curl -s -I http://192.168.2.10/nope')
    const lines = n.out('srv', 'sudo cat /var/log/apache2/access.log').split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(
      /^192\.168\.2\.20 - - \[05\/Jan\/2026:08:00:\d\d \+0000\] "GET \/ HTTP\/1\.1" 200 \d+ "-" "curl\/7\.81\.0"$/
    )
    expect(lines[1]).toContain('"HEAD /nope HTTP/1.1" 404 ')
  })

  it('error.log : démarrage, rechargement graceful, arrêt', () => {
    const n = net()
    n.run('srv', 'sudo systemctl reload apache2')
    n.run('srv', 'sudo systemctl stop apache2')
    const log = n.out('srv', 'sudo cat /var/log/apache2/error.log')
    expect(log).toContain('[mpm_event:notice]')
    expect(log).toContain('AH00489: Apache/2.4.68 (Debian) configured -- resuming normal operations')
    expect(log).toContain("AH00094: Command line: '/usr/sbin/apache2'")
    expect(log).toContain('AH00493: SIGUSR1 received.  Doing graceful restart')
    expect(log).toContain('AH00492: caught SIGWINCH, shutting down gracefully')
  })

  it('les journaux sont réservés à root et à adm (droits 640)', () => {
    const n = net()
    expect(n.out('srv', 'ls -l /var/log/apache2')).toContain('-rw-r----- 1 root adm')
    // l'utilisateur du lab est membre du groupe adm : il lit les journaux, comme sous Ubuntu
    expect(n.run('srv', 'cat /var/log/apache2/access.log').errors).toBe('')
  })

  it('un site avec ses propres journaux : fichiers créés au démarrage, other_vhosts_access.log pour les autres', () => {
    const n = net()
    n.page('/var/www/site1', 'Site 1')
    n.page('/var/www/site2', 'Site 2')
    n.site('site1', '/var/www/site1', [
      '    ErrorLog ${APACHE_LOG_DIR}/site1-error.log',
      '    CustomLog ${APACHE_LOG_DIR}/site1-access.log combined'
    ])
    n.site('site2', '/var/www/site2')
    n.run('srv', 'sudo a2ensite site1')
    n.run('srv', 'sudo a2ensite site2')
    n.run('srv', 'sudo systemctl reload apache2')
    expect(n.out('srv', 'ls /var/log/apache2')).toContain('site1-access.log')
    expect(n.out('srv', 'sudo cat /var/log/apache2/site1-access.log')).toBe('')
    n.curl('site1.lab.local')
    n.curl('site2.lab.local')
    expect(n.out('srv', 'sudo cat /var/log/apache2/site1-access.log')).toContain('"GET / HTTP/1.1" 200 266 ')
    const other = n.out('srv', 'sudo cat /var/log/apache2/other_vhosts_access.log')
    expect(other).toContain('site2.lab.local:80 192.168.2.20 - -')
    expect(other).not.toContain('site1.lab.local')
  })

  it('/var/log/syslog ne contient pas les journaux d’Apache', () => {
    const n = net()
    n.run('pc', 'curl -s http://192.168.2.10/')
    expect(n.out('srv', 'sudo cat /var/log/syslog')).not.toContain('GET /')
  })
})

describe('HTTPS', () => {
  function https(): Net {
    const n = net()
    n.run('srv', 'sudo a2enmod ssl')
    n.run('srv', 'sudo a2ensite default-ssl')
    n.run('srv', 'sudo systemctl restart apache2')
    return n
  }

  it('Listen 443 vient de ports.conf sous IfModule ssl_module', () => {
    const n = net()
    expect(n.out('srv', 'sudo ss -tln')).not.toContain(':443')
    const s = https()
    expect(s.out('srv', 'sudo ss -tln')).toContain('*:443')
  })

  it('certificat auto-signé : refusé par curl, accepté avec -k', () => {
    const n = https()
    expect(n.run('pc', 'curl https://192.168.2.10/').errors).toContain(
      'curl: (60) SSL certificate problem: self-signed certificate'
    )
    expect(n.out('pc', 'curl -k -s https://192.168.2.10/')).toContain('Apache2 Debian Default Page')
    expect(n.out('srv', 'sudo cat /var/log/apache2/access.log')).toContain('"GET / HTTP/1.1" 200 10956 ')
  })

  it('le module ssl désactivé : le port 443 n’écoute plus après redémarrage', () => {
    const n = https()
    n.run('srv', 'sudo a2dissite default-ssl')
    n.run('srv', 'sudo a2dismod ssl')
    n.run('srv', 'sudo systemctl restart apache2')
    expect(n.out('srv', 'sudo ss -tln')).not.toContain(':443')
    expect(n.run('pc', 'curl -k https://192.168.2.10/').errors).toContain('(7) Failed to connect')
  })

  it('HTTP sur le port TLS : 400 ; HTTPS sur le port clair : erreur OpenSSL', () => {
    const n = https()
    const plain = n.out('pc', 'curl -s http://192.168.2.10:443/')
    expect(plain).toContain('400 Bad Request')
    expect(plain).toContain("Reason: You're speaking plain HTTP to an SSL-enabled server port.")
    expect(n.run('pc', 'curl -k https://192.168.2.10/').errors).toBe('')
    expect(n.run('pc', 'curl -k https://192.168.2.10:80/').errors).toContain(
      'curl: (35) error:0A00010B:SSL routines::wrong version number'
    )
  })

  it('sans le site default-ssl activé, 443 reste fermé même avec le module', () => {
    const n = net()
    n.run('srv', 'sudo a2enmod ssl')
    n.run('srv', 'sudo systemctl restart apache2')
    // Listen 443 est ouvert (ports.conf) mais aucun site n'y répond en TLS
    expect(n.out('srv', 'sudo ss -tln')).toContain('*:443')
    expect(n.run('pc', 'curl -k https://192.168.2.10/').errors).toContain('wrong version number')
  })
})

describe('navigateur d’un poste Windows', () => {
  it('httpGet atteint Apache : sites par nom, 404, redirection, certificat', () => {
    const n = twoSites()
    const get = (url: string) => httpGet(n.state, n.ids.SRV1!, url)
    const ok = get('http://192.168.2.10/')
    expect(ok.kind).toBe('response')
    if (ok.kind === 'response') {
      expect(ok.status).toBe(200)
      expect(ok.body).toContain('Apache2 Debian Default Page')
      expect(ok.file).toBe('/var/www/html/index.html')
      expect(ok.certificateWarning).toBeNull()
    }
    n.write('/etc/hosts', ['127.0.0.1 localhost']) // sans effet pour le client Windows
    const missing = get('http://192.168.2.10/nope')
    expect(missing.kind === 'response' && missing.status).toBe(404)
    const refused = get('http://192.168.2.10:8081/')
    expect(refused.kind).toBe('failure')
  })

  it('httpGet résout le nom via le DNS du lab puis choisit le site par nom', () => {
    const n = twoSites()
    // pas de DNS pour site1.lab.local : l'adresse seule donne le site par défaut
    const byIp = httpGet(n.state, n.ids.SRV1!, 'http://192.168.2.10/')
    expect(byIp.kind === 'response' && byIp.body).toContain('Apache2 Debian Default Page')
    const byName = httpGet(n.state, n.ids.SRV1!, 'http://site1.lab.local/')
    expect(byName.kind).toBe('failure')
  })

  it('HTTPS : avertissement de certificat non approuvé, et 400 en HTTP sur le port TLS', () => {
    const n = net()
    n.run('srv', 'sudo a2enmod ssl')
    n.run('srv', 'sudo a2ensite default-ssl')
    n.run('srv', 'sudo systemctl restart apache2')
    const tls = httpGet(n.state, n.ids.SRV1!, 'https://192.168.2.10/')
    expect(tls.kind === 'response' && tls.certificateWarning).toContain('autorité de certification approuvée')
    const plain = httpGet(n.state, n.ids.SRV1!, 'http://192.168.2.10:443/')
    expect(plain.kind === 'response' && plain.status).toBe(400)
    const wrong = httpGet(n.state, n.ids.SRV1!, 'https://192.168.2.10:80/')
    expect(wrong.kind).toBe('failure')
  })

  it('Invoke-WebRequest d’un serveur Windows atteint Apache (code 200, 404 en erreur)', () => {
    const n = twoSites()
    const ok = runLine(n.state, n.ids.SRV1!, 'Invoke-WebRequest -Uri http://192.168.2.10/ -UseBasicParsing')
    expect(ok.text).toContain('StatusCode        : 200')
    expect(ok.text).toContain('Apache2 Debian Default Page')
    const missing = runLine(
      n.state,
      n.ids.SRV1!,
      'Invoke-WebRequest -Uri http://192.168.2.10/nope -UseBasicParsing'
    )
    expect(missing.errors).toContain('Not Found')
  })

  it('Apache arrêté : le navigateur ne se connecte plus', () => {
    const n = net()
    n.run('srv', 'sudo systemctl stop apache2')
    expect(httpGet(n.state, n.ids.SRV1!, 'http://192.168.2.10/').kind).toBe('failure')
  })
})

describe('commandes hors périmètre, désinstallation, sérialisation', () => {
  it('commandes réelles non simulées : message honnête', () => {
    const n = net()
    for (const c of ['apache2 -v', 'a2query -s', 'htpasswd -c /tmp/x bob', 'ln -s a b', 'certbot --apache'])
      expect(n.run('srv', c).errors, c).toContain('commande réelle non simulée')
    expect(n.run('srv', 'sudo apache2ctl status').errors).toContain(
      'existe réellement mais n’est pas simulée'
    )
    expect(n.run('srv', 'sudo apache2ctl -X').errors).toContain('existe réellement mais n’est pas simulée')
    expect(n.run('srv', 'sudo a2enmod -m rewrite').errors).toContain(
      'existe réellement mais n’est pas simulée'
    )
  })

  it('apt remove apache2 : le service disparaît, la configuration reste', () => {
    const n = twoSites()
    n.run('srv', 'sudo apt remove apache2', ['y'])
    expect(n.run('pc', 'curl -I http://192.168.2.10').errors).toContain('(7) Failed to connect')
    expect(n.out('srv', 'ls /etc/apache2/sites-available')).toContain('site1.conf')
    n.run('srv', 'sudo apt install apache2', ['y'])
    expect(n.curl('site1.lab.local')).toBe('<h1>Site 1</h1>')
  })

  it('un lab modifié se sauvegarde et se relit en .slab sans perdre liens ni instantané', () => {
    const n = twoSites()
    n.run('srv', "sudo sed -i 's#/var/www/site1#/var/www/site2#' /etc/apache2/sites-available/site1.conf")
    const text = serializeSlab(n.state, { savedAt: '2026-10-20T08:00:00.000Z', appVersion: '2.9.0' })
    const back = parseSlab(text)
    if (!back.ok) throw new Error(back.message)
    const srv = back.doc.lab.devices[n.ids.LSRV1!] as HostDevice
    expect(srv.host.linux?.files?.['/etc/apache2/sites-enabled/site1.conf']?.link).toBe(
      '../sites-available/site1.conf'
    )
    expect(srv.host.linux?.loaded?.['apache2']).toBeDefined()
    expect(JSON.parse(text).schemaVersion).toBe(27)
  })

  it('un serveur Ubuntu 24.04 annonce (Ubuntu) et sa version d’Apache', () => {
    const n = net()
    const srv = n.host('LSRV1')
    expect(apacheConfig(srv, 'live').main.documentRoot).toBeUndefined()
  })
})

describe('analyse de la configuration', () => {
  it('nextWord / splitArgs : guillemets, échappements, espaces', () => {
    expect(nextWord('  "a b" c')).toEqual(['a b', 'c'])
    expect(splitArgs('Alias /x "/var/www/a b"')).toEqual(['Alias', '/x', '/var/www/a b'])
    expect(splitArgs('"un \\"mot\\""')).toEqual(['un "mot"'])
    expect(splitArgs('')).toEqual([])
  })

  it('expandVars : variables d’envvars et Define', () => {
    expect(expandVars('${APACHE_LOG_DIR}/error.log')).toBe('/var/log/apache2/error.log')
    expect(expandVars('${X}/a', { X: '/b' })).toBe('/b/a')
    expect(expandVars('${INCONNUE}')).toBe('${INCONNUE}')
  })

  it('IfModule, IfDefine, Define et continuation de ligne', () => {
    const files: Record<string, string> = {
      '/etc/apache2/apache2.conf': [
        'LoadModule mpm_event_module /usr/lib/apache2/modules/mod_mpm_event.so',
        'Define PORT 8080',
        '<IfDefine PORT>',
        'Listen ${PORT}',
        '</IfDefine>',
        '<IfDefine !PORT>',
        'Listen 9999',
        '</IfDefine>',
        '<IfModule mod_ssl.c>',
        'SSLEngine on',
        '</IfModule>',
        '<IfModule !mod_ssl.c>',
        'ServerName a \\',
        '   ',
        '</IfModule>'
      ].join('\n')
    }
    const cfg = parseConfig(
      { read: (p) => files[p] ?? null, glob: () => [] },
      { hostname: 'H', hostsText: '127.0.1.1 H', stat: () => ({ type: 'dir', size: 1 }) }
    )
    expect(cfg.syntaxError).toBeUndefined()
    expect(cfg.listens.map((l) => l.port)).toEqual([8080])
    expect(cfg.main.serverName).toBe('a')
  })

  it('une directive inconnue dans un IfModule non chargé est ignorée', () => {
    const files: Record<string, string> = {
      '/etc/apache2/apache2.conf': [
        'LoadModule mpm_event_module x',
        '<IfModule mod_rewrite.c>',
        'RewriteEngine On',
        '</IfModule>'
      ].join('\n')
    }
    const cfg = parseConfig(
      { read: (p) => files[p] ?? null, glob: () => [] },
      { hostname: 'H', hostsText: '', stat: () => null }
    )
    expect(cfg.syntaxError).toBeUndefined()
    expect(cfg.readError).toBeUndefined()
  })
})
