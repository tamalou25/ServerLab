/**
 * Tests golden Apache2 (v2.9, #238) : chaque sortie simulée est comparée, ligne par ligne, à
 * `docs/captures/bash/<nom>.txt` (en-tête « # Source: »). Les captures sont reconstituées d'après les
 * sources Debian du paquet apache2 2.4.68-1~deb12u1 (script a2enmod, apache2ctl, httpd) : pas de VM,
 * docs/fidelite.md, « À vérifier (v2.9 — Linux) », lignes L-70 à L-79.
 *
 * Le déroulé suit UN SEUL lab (serveur LSRV1, poste LNX1) : l'ordre des étapes compte, l'état est partagé
 * (fichiers de /etc/apache2, liens de sites-enabled, journaux, configuration en vigueur).
 */
import { describe, expect, it } from 'vitest'
import { expectGolden } from '../golden/golden'
import { siteFile, writeFile, type Command } from './apache-helpers'
import { Bash, buildLinuxLab } from './linux-lab'

type Who = 'srv' | 'pc'
/** [capture, machine, ligne tapée, réponses aux invites, préparation (non comparée)] */
type Step = [string, Who, string, string[]?, Command[]?]

const page = (dir: string, text: string): Command[] => [
  ['srv', `sudo mkdir -p ${dir}`],
  ['srv', `echo '<h1>${text}</h1>' | sudo tee ${dir}/index.html`]
]

const RELOAD: Command = ['srv', 'sudo systemctl reload apache2']
const RESTART: Command = ['srv', 'sudo systemctl restart apache2']

/** Préparation commune : apache2 installé, deux sites prêts (non activés). */
const SETUP: Command[] = [
  ['srv', 'sudo apt install apache2', ['y']],
  ...page('/var/www/site1', 'Site 1'),
  ...page('/var/www/site2', 'Site 2'),
  ...siteFile('site1', '/var/www/site1', [
    '    ServerAlias www.site1.lab.local',
    '    ErrorLog ${APACHE_LOG_DIR}/site1-error.log',
    '    CustomLog ${APACHE_LOG_DIR}/site1-access.log combined'
  ]),
  ...siteFile('site2', '/var/www/site2')
]

const BROKEN: Command[] = siteFile('casse', '/var/www/site1', ['    DocumentRot /var/www/site1'])

export const APACHE_STEPS: Step[] = [
  ['ls-l-sites-enabled', 'srv', 'ls -l /etc/apache2/sites-enabled'],
  ['apache2ctl-aide', 'srv', 'apache2ctl'],
  ['apache2ctl-configtest', 'srv', 'sudo apache2ctl configtest'],
  ['apache2ctl-S-defaut', 'srv', 'sudo apache2ctl -S'],
  ['a2ensite', 'srv', 'sudo a2ensite site1'],
  ['a2ensite-deja', 'srv', 'sudo a2ensite site1'],
  ['a2ensite-absent', 'srv', 'sudo a2ensite nexiste'],
  ['a2ensite-sans-sudo', 'srv', 'a2ensite site2'],
  ['ls-l-sites-enabled-lien', 'srv', 'ls -l /etc/apache2/sites-enabled'],
  [
    'curl-avant-reload',
    'pc',
    'curl -s -H "Host: site1.lab.local" http://192.168.2.10/ | grep "<title>"',
    [],
    [['srv', 'sudo a2ensite site2']]
  ],
  ['curl-site1', 'pc', 'curl -H "Host: site1.lab.local" http://192.168.2.10/', [], [RELOAD]],
  ['curl-alias-site1', 'pc', 'curl -H "Host: www.site1.lab.local" http://192.168.2.10/'],
  ['curl-site2', 'pc', 'curl -H "Host: site2.lab.local" http://192.168.2.10/'],
  ['curl-par-defaut', 'pc', 'curl -s -H "Host: inconnu.lab.local" http://192.168.2.10/ | grep "<title>"'],
  ['apache2ctl-S-vhosts', 'srv', 'sudo apache2ctl -S'],
  ['curl-404', 'pc', 'curl http://192.168.2.10/nexiste.html'],
  [
    'curl-redirection-dossier',
    'pc',
    'curl -I http://192.168.2.10/docs',
    [],
    [['srv', 'sudo mkdir /var/www/html/docs']]
  ],
  [
    'curl-redirect-permanent',
    'pc',
    'curl -I -H "Host: redir.lab.local" http://192.168.2.10/ancien/page',
    [],
    [
      ...siteFile('redir', '/var/www/site2', ['    Redirect permanent /ancien http://site2.lab.local/']),
      ['srv', 'sudo a2ensite redir'],
      RELOAD
    ]
  ],
  ['access-log-site1', 'srv', 'sudo cat /var/log/apache2/site1-access.log'],
  ['error-log', 'srv', 'sudo cat /var/log/apache2/error.log'],
  [
    'curl-403-refus-configuration',
    'pc',
    'curl -I -H "Host: site3.lab.local" http://192.168.2.10/',
    [],
    [
      ['srv', 'sudo mkdir -p /srv/site3'],
      ['srv', "echo '<h1>Site 3</h1>' | sudo tee /srv/site3/index.html"],
      ...siteFile('site3', '/srv/site3'),
      ['srv', 'sudo a2ensite site3'],
      RELOAD
    ]
  ],
  [
    'curl-403-droits-fichier',
    'pc',
    'curl -I -H "Host: site1.lab.local" http://192.168.2.10/',
    [],
    [['srv', 'sudo chmod 600 /var/www/site1/index.html']]
  ],
  ['error-log-refus', 'srv', 'sudo cat /var/log/apache2/site1-error.log'],
  ['error-log-refus-configuration', 'srv', 'sudo cat /var/log/apache2/error.log | grep AH01630'],
  [
    'apache2ctl-configtest-ok-avertissement',
    'srv',
    'sudo apache2ctl configtest',
    [],
    [
      ['srv', 'sudo chmod 644 /var/www/site1/index.html'],
      ...writeFile('/etc/apache2/sites-available/vide.conf', [
        '<VirtualHost *:80>',
        '    ServerName vide.lab.local',
        '    DocumentRoot /var/www/nexiste',
        '</VirtualHost>'
      ]),
      ['srv', 'sudo a2ensite vide']
    ]
  ],
  [
    'apache2ctl-configtest-directive',
    'srv',
    'sudo apache2ctl configtest',
    [],
    [['srv', 'sudo a2dissite vide'], ...BROKEN, ['srv', 'sudo a2ensite casse']]
  ],
  ['systemctl-reload-echec', 'srv', 'sudo systemctl reload apache2'],
  ['curl-ancienne-configuration', 'pc', 'curl -H "Host: site2.lab.local" http://192.168.2.10/'],
  ['apache2ctl-restart-echec', 'srv', 'sudo apache2ctl restart'],
  ['a2dissite', 'srv', 'sudo a2dissite casse'],
  ['a2dissite-deja', 'srv', 'sudo a2dissite casse'],
  [
    'apache2ctl-configtest-arguments',
    'srv',
    'sudo apache2ctl configtest',
    [],
    [...writeFile('/etc/apache2/sites-available/args.conf', ['ServerName']), ['srv', 'sudo a2ensite args']]
  ],
  [
    'apache2ctl-configtest-module',
    'srv',
    'sudo apache2ctl configtest',
    [],
    [
      ['srv', 'sudo a2dissite args'],
      ...writeFile('/etc/apache2/sites-available/rewrite.conf', [
        '<VirtualHost *:80>',
        '    RewriteEngine On',
        '</VirtualHost>'
      ]),
      ['srv', 'sudo a2ensite rewrite']
    ]
  ],
  ['a2enmod-rewrite', 'srv', 'sudo a2enmod rewrite'],
  ['a2enmod-deja', 'srv', 'sudo a2enmod rewrite'],
  ['a2enmod-absent', 'srv', 'sudo a2enmod nexiste'],
  [
    'apache2ctl-configtest-section',
    'srv',
    'sudo apache2ctl configtest',
    [],
    [
      ['srv', 'sudo a2dissite rewrite'],
      ...writeFile('/etc/apache2/sites-available/ouvert.conf', [
        '<VirtualHost *:80>',
        '    ServerName ouvert.lab.local'
      ]),
      ['srv', 'sudo a2ensite ouvert']
    ]
  ],
  ['a2dissite-section', 'srv', 'sudo a2dissite ouvert'],
  ['a2enconf-security', 'srv', 'sudo a2disconf security'],
  ['a2enconf', 'srv', 'sudo a2enconf security'],
  ['a2enmod-ssl', 'srv', 'sudo a2enmod ssl'],
  ['a2dismod-dependance', 'srv', 'sudo a2dismod socache_shmcb'],
  ['a2ensite-ssl', 'srv', 'sudo a2ensite default-ssl'],
  ['apache2ctl-configtest-ssl', 'srv', 'sudo apache2ctl configtest', [], [RESTART]],
  ['curl-https-certificat', 'pc', 'curl https://192.168.2.10/'],
  ['curl-https-k', 'pc', 'curl -k -I https://192.168.2.10/'],
  ['curl-http-port-tls', 'pc', 'curl -I http://192.168.2.10:443/'],
  ['curl-https-port-clair', 'pc', 'curl -k https://192.168.2.10:80/'],
  ['ss-tln-apache2-ssl', 'srv', 'sudo ss -tln'],
  ['a2dismod-ssl', 'srv', 'sudo a2dismod ssl'],
  ['apache2ctl-configtest-ssl-desactive', 'srv', 'sudo apache2ctl configtest'],
  [
    'apache2ctl-start',
    'srv',
    'sudo apache2ctl start',
    [],
    [['srv', 'sudo a2dissite default-ssl'], ['srv', 'sudo a2dissite site3'], RESTART]
  ],
  [
    'systemctl-restart-sans-listen',
    'srv',
    'sudo systemctl restart apache2',
    [],
    [['srv', "sudo sed -i 's/^Listen 80$/#Listen 80/' /etc/apache2/ports.conf"]]
  ],
  ['journalctl-apache2-sans-listen', 'srv', 'sudo journalctl -u apache2 -n 7'],
  [
    'systemctl-start-conflit-apache2',
    'srv',
    'sudo systemctl start apache2',
    [],
    [
      ['srv', "sudo sed -i 's/^#Listen 80$/Listen 80/' /etc/apache2/ports.conf"],
      ['srv', 'sudo apt install nginx', ['y']]
    ]
  ],
  ['journalctl-apache2-conflit', 'srv', 'sudo journalctl -u apache2 -n 10'],
  [
    'ss-tln-apache2-8080',
    'srv',
    'sudo ss -tln',
    [],
    [
      ['srv', "sudo sed -i 's/^Listen 80$/Listen 8080/' /etc/apache2/ports.conf"],
      [
        'srv',
        "sudo sed -i 's/<VirtualHost \\*:80>/<VirtualHost *:8080>/' /etc/apache2/sites-available/000-default.conf"
      ],
      ['srv', 'sudo systemctl start apache2']
    ]
  ],
  ['curl-port-8080', 'pc', 'curl -I http://192.168.2.10:8080/'],
  ['curl-port-80-nginx', 'pc', 'curl -I http://192.168.2.10/']
]

/** Rejoue le déroulé et transmet la sortie de chaque étape à `visit`. */
export function playApache(visit: (name: string, output: string, line: string) => void): void {
  const lab = buildLinuxLab()
  let state = lab.state
  const shells: Record<Who, Bash> = {
    srv: new Bash(lab.state, lab.ids.LSRV1!),
    pc: new Bash(lab.state, lab.ids.LNX1!)
  }
  const run = (who: Who, line: string, answers: string[] = []) => {
    const shell = shells[who]
    shell.state = state
    const out = shell.real(line, answers)
    state = shell.state
    return out
  }
  for (const [who, line, answers] of SETUP) run(who, line, answers)
  for (const [name, who, line, answers = [], prepare = []] of APACHE_STEPS) {
    for (const [pwho, pline, panswers] of prepare) run(pwho, pline, panswers)
    visit(name, run(who, line, answers), line)
  }
}

describe('captures golden : Apache2 (docs/captures/bash)', () => {
  it('chaque sortie simulée est identique à sa capture', () => {
    playApache((name, output) => {
      expect(() => expectGolden(output === '' ? [] : output.split('\n'), `bash/${name}`), name).not.toThrow()
    })
  })
})
