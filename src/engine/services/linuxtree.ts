/**
 * Arborescence d'un serveur ou poste Linux neuf (v2.9) : /etc, /var/www, /var/log, /home, /root… et
 * nœuds qu'apportent les paquets installés (openssh-server, fail2ban, apache2). Module de services,
 * sans dépendance à la console : le moteur HTTP d'Apache en a besoin comme la console bash.
 */
import { LINUX_USER } from '../model/factory'
import type { LinuxNode } from '../model/linuxnode'
import type { HostDevice } from '../model/schema'
import { withApacheNodes } from './linuxapache'
import { installedPackages } from './linuxpackages'

export type LinuxFiles = Record<string, LinuxNode>

/** Dossiers de premier niveau d'un système neuf. */
const SYSTEM_DIRS = [
  'bin',
  'boot',
  'dev',
  'etc',
  'home',
  'lib',
  'media',
  'mnt',
  'opt',
  'proc',
  'root',
  'run',
  'sbin',
  'srv',
  'sys',
  'tmp',
  'usr',
  'var'
]

/** Arborescence d'un système neuf : /etc, /var/www, /var/log, /home, /root… */
export function defaultLinuxFiles(user: string): LinuxFiles {
  const files: LinuxFiles = {}
  const dir = (path: string, mode: number, owner = 'root', group = 'root') => {
    files[path] = { type: 'dir', mode, owner, group, mtime: 0 }
  }
  const file = (path: string, mode: number, content: string | undefined, owner = 'root', group = 'root') => {
    files[path] = {
      type: 'file',
      mode,
      owner,
      group,
      mtime: 0,
      ...(content === undefined ? {} : { content })
    }
  }
  dir('/', 0o755)
  for (const d of SYSTEM_DIRS) dir(`/${d}`, 0o755)
  dir('/root', 0o700)
  dir('/tmp', 0o1777)
  dir('/var/www', 0o755)
  dir('/var/www/html', 0o755)
  dir('/etc/ssh', 0o755)
  dir('/etc/rsyslog.d', 0o755)
  dir('/var/log', 0o755, 'root', 'syslog')
  dir(`/home/${user}`, 0o750, user, user)
  const hasUser = user !== 'root'
  file(
    '/etc/passwd',
    0o644,
    [
      'root:x:0:0:root:/root:/bin/bash',
      'daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin',
      'bin:x:2:2:bin:/bin:/usr/sbin/nologin',
      'sys:x:3:3:sys:/dev:/usr/sbin/nologin',
      'www-data:x:33:33:www-data:/var/www:/usr/sbin/nologin',
      'nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin',
      ...(hasUser ? [`${user}:x:1000:1000:${user},,,:/home/${user}:/bin/bash`] : [])
    ].join('\n') + '\n'
  )
  file(
    '/etc/group',
    0o644,
    [
      'root:x:0:',
      'daemon:x:1:',
      'bin:x:2:',
      'sys:x:3:',
      `adm:x:4:${hasUser ? user : ''}`,
      `sudo:x:27:${hasUser ? user : ''}`,
      'www-data:x:33:',
      'shadow:x:42:',
      'users:x:100:',
      'syslog:x:104:',
      'nogroup:x:65534:',
      ...(hasUser ? [`${user}:x:1000:`] : [])
    ].join('\n') + '\n'
  )
  file(
    '/etc/shadow',
    0o640,
    [
      'root:*:20458:0:99999:7:::',
      'daemon:*:20458:0:99999:7:::',
      'www-data:*:20458:0:99999:7:::',
      'nobody:*:20458:0:99999:7:::',
      ...(hasUser ? [`${user}:!:20458:0:99999:7:::`] : [])
    ].join('\n') + '\n',
    'root',
    'shadow'
  )
  file(
    '/etc/sudoers',
    0o440,
    [
      "# This file MUST be edited with the 'visudo' command as root.",
      '',
      '# User privilege specification',
      'root\tALL=(ALL:ALL) ALL',
      '',
      '# Members of the admin group may gain root privileges',
      '%admin ALL=(ALL) ALL',
      '',
      '# Allow members of group sudo to execute any command',
      '%sudo\tALL=(ALL:ALL) ALL',
      ''
    ].join('\n')
  )
  // Contenu fourni par le système (nom du poste, domaine DHCP) tant qu'il n'est pas modifié
  file('/etc/hostname', 0o644, undefined)
  file('/etc/hosts', 0o644, undefined)
  file('/etc/resolv.conf', 0o644, undefined)
  file('/var/www/html/index.html', 0o644, '<html><body><h1>It works!</h1></body></html>\n')
  // Journaux de rsyslog : contenu calculé depuis le journal de l'ordinateur (services/linuxlog.ts)
  file('/var/log/syslog', 0o640, undefined, 'syslog', 'adm')
  file('/var/log/auth.log', 0o640, undefined, 'syslog', 'adm')
  file('/etc/rsyslog.conf', 0o644, undefined)
  return files
}

/** Dossiers et fichiers qu'un paquet installé apporte (contenu fourni par services/linuxconfig.ts). */
const PACKAGE_NODES: Record<string, [string, LinuxNode][]> = {
  'openssh-server': [
    ['/etc/ssh/sshd_config.d', { type: 'dir', mode: 0o755, owner: 'root', group: 'root', mtime: 0 }],
    ['/etc/ssh/sshd_config', { type: 'file', mode: 0o644, owner: 'root', group: 'root', mtime: 0 }]
  ],
  samba: [
    ['/etc/samba', { type: 'dir', mode: 0o755, owner: 'root', group: 'root', mtime: 0 }],
    ['/etc/samba/smb.conf', { type: 'file', mode: 0o644, owner: 'root', group: 'root', mtime: 0 }],
    ['/var/lib', { type: 'dir', mode: 0o755, owner: 'root', group: 'root', mtime: 0 }],
    ['/var/lib/samba', { type: 'dir', mode: 0o755, owner: 'root', group: 'root', mtime: 0 }],
    ['/var/lib/samba/private', { type: 'dir', mode: 0o700, owner: 'root', group: 'root', mtime: 0 }],
    [
      '/var/lib/samba/private/passdb.tdb',
      { type: 'file', mode: 0o600, owner: 'root', group: 'root', mtime: 0 }
    ],
    ['/var/log/samba', { type: 'dir', mode: 0o750, owner: 'root', group: 'adm', mtime: 0 }]
  ],
  fail2ban: [
    ['/etc/fail2ban', { type: 'dir', mode: 0o755, owner: 'root', group: 'root', mtime: 0 }],
    ['/etc/fail2ban/jail.d', { type: 'dir', mode: 0o755, owner: 'root', group: 'root', mtime: 0 }],
    [
      '/etc/fail2ban/jail.d/defaults-debian.conf',
      { type: 'file', mode: 0o644, owner: 'root', group: 'root', mtime: 0 }
    ],
    ['/var/log/fail2ban.log', { type: 'file', mode: 0o640, owner: 'root', group: 'adm', mtime: 0 }]
  ]
}

/** Arborescence complétée des nœuds des paquets installés (ceux déjà présents ne sont pas touchés). */
export function withPackageFiles(files: LinuxFiles, pkgs: string[]): LinuxFiles {
  const missing = pkgs.flatMap((p) => PACKAGE_NODES[p] ?? []).filter(([path]) => !(path in files))
  const withPkgs = missing.length === 0 ? files : { ...files, ...Object.fromEntries(missing) }
  // apache2 : nœuds du paquet, sauf si /etc/apache2 est déjà matérialisé (a2dissite supprime un lien)
  return pkgs.includes('apache2') ? withApacheNodes(withPkgs) : withPkgs
}

/** Journaux d'Apache créés au démarrage ou à la première requête (ErrorLog et CustomLog des sites). */
function apacheLogNodes(host: HostDevice, files: LinuxFiles): LinuxFiles {
  const extra: LinuxFiles = {}
  for (const e of host.host.eventLog)
    if ((e.source === 'apache2.access' || e.source === 'apache2.error') && e.account && !(e.account in files))
      extra[e.account] = { type: 'file', mode: 0o644, owner: 'root', group: 'adm', mtime: e.time }
  return Object.keys(extra).length === 0 ? files : { ...files, ...extra }
}

/** Fichiers d'un serveur ou poste Linux (par défaut tant qu'aucune écriture n'a eu lieu). */
export function hostFiles(host: HostDevice): LinuxFiles {
  const base = host.host.linux?.files ?? defaultLinuxFiles(host.host.session?.user ?? LINUX_USER)
  const pkgs = installedPackages(host)
  const all = withPackageFiles(base, pkgs)
  return pkgs.includes('apache2') ? apacheLogNodes(host, all) : all
}
