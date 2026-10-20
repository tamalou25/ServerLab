/**
 * Catalogue local des serveurs Linux (v2.9, #236) : paquets installables avec `apt`, unités
 * systemd qu'ils apportent et ports qu'elles ouvrent. Aucun accès réseau : ce catalogue tient
 * lieu de dépôt Debian / Ubuntu.
 *
 * Versions relevées sur packages.debian.org (bookworm) et packages.ubuntu.com (jammy, noble) le
 * 2026-10-20 ; descriptions courtes : champ « Description » de ces mêmes pages. Descriptions
 * `Description=` des unités : fichiers `debian/*.service` des sources Debian
 * (sources.debian.org) pour apache2, cron, fail2ban, rsyslog et vsftpd ; les autres sont à vérifier
 * (docs/fidelite.md, « À vérifier (v2.9 — Linux) »).
 */

/** Version du système installé (déduite de la distribution du serveur ; un poste est un Ubuntu 22.04). */
export type LinuxRelease = 'debian12' | 'ubuntu2204' | 'ubuntu2404'

export interface ReleaseInfo {
  /** Nom affiché par hostnamectl (PRETTY_NAME de /etc/os-release). */
  prettyName: string
  /** Nom de code de la version (suite apt). */
  codename: string
  /** Suite affichée par `apt search` / `apt list`. */
  suite: string
  /** Dépôts interrogés par `apt update` : [URL, suite, ...]. */
  sources: { url: string; suite: string }[]
}

export const RELEASES: Record<LinuxRelease, ReleaseInfo> = {
  debian12: {
    prettyName: 'Debian GNU/Linux 12 (bookworm)',
    codename: 'bookworm',
    suite: 'stable',
    sources: [
      { url: 'http://deb.debian.org/debian', suite: 'bookworm' },
      { url: 'http://deb.debian.org/debian', suite: 'bookworm-updates' },
      { url: 'http://deb.debian.org/debian-security', suite: 'bookworm-security' }
    ]
  },
  ubuntu2204: {
    prettyName: 'Ubuntu 22.04 LTS',
    codename: 'jammy',
    suite: 'jammy',
    sources: [
      { url: 'http://archive.ubuntu.com/ubuntu', suite: 'jammy' },
      { url: 'http://archive.ubuntu.com/ubuntu', suite: 'jammy-updates' },
      { url: 'http://archive.ubuntu.com/ubuntu', suite: 'jammy-backports' },
      { url: 'http://security.ubuntu.com/ubuntu', suite: 'jammy-security' }
    ]
  },
  ubuntu2404: {
    prettyName: 'Ubuntu 24.04 LTS',
    codename: 'noble',
    suite: 'noble',
    sources: [
      { url: 'http://archive.ubuntu.com/ubuntu', suite: 'noble' },
      { url: 'http://archive.ubuntu.com/ubuntu', suite: 'noble-updates' },
      { url: 'http://archive.ubuntu.com/ubuntu', suite: 'noble-backports' },
      { url: 'http://security.ubuntu.com/ubuntu', suite: 'noble-security' }
    ]
  }
}

/** Socket ouvert par une unité en cours d'exécution. */
export interface ListenSpec {
  proto: 'tcp' | 'udp'
  port: number
  /** File d'attente d'écoute du serveur (colonne Send-Q de `ss -l`) ; 0 pour UDP. */
  backlog: number
  /**
   * Adresses d'écoute : `any` (0.0.0.0 et [::] affichés `*` quand une seule pile écoute),
   * `any4` (0.0.0.0), `any6` (`*` : double pile), `loopback` (127.0.0.1), `ifaces` (127.0.0.1 et
   * chaque adresse IPv4 des cartes).
   */
  bind: 'any4' | 'any6' | 'dual' | 'loopback' | 'ifaces'
}

export interface LinuxUnit {
  /** Nom de l'unité sans le suffixe .service. */
  name: string
  /** Noms alternatifs acceptés (alias systemd, ex. bind9 pour named). */
  aliases?: string[]
  description: string
  /** Paquet qui apporte l'unité. */
  pkg: string
  /** Nom du processus principal (ps, ss). */
  process: string
  /** Ligne de commande du processus (ps aux). */
  command: string
  listens: ListenSpec[]
}

export interface LinuxPackage {
  name: string
  /** Description courte (apt search / apt show). */
  description: string
  versions: Record<LinuxRelease, string>
  /** Installé d'office : sur tous les systèmes (`all`) ou sur un serveur seulement (`server`). */
  base?: 'all' | 'server'
}

export const PACKAGES: LinuxPackage[] = [
  {
    name: 'apache2',
    description: 'Apache HTTP Server',
    versions: {
      debian12: '2.4.68-1~deb12u1',
      ubuntu2204: '2.4.52-1ubuntu4.25',
      ubuntu2404: '2.4.58-1ubuntu8.17'
    }
  },
  {
    name: 'bind9',
    description: 'Internet Domain Name Server',
    versions: {
      debian12: '1:9.18.49-1~deb12u2',
      ubuntu2204: '1:9.18.39-0ubuntu0.22.04.7',
      ubuntu2404: '1:9.18.39-0ubuntu0.24.04.8'
    }
  },
  {
    name: 'bind9-dnsutils',
    description: 'Clients provided with BIND 9',
    versions: {
      debian12: '1:9.18.49-1~deb12u2',
      ubuntu2204: '1:9.18.39-0ubuntu0.22.04.7',
      ubuntu2404: '1:9.18.39-0ubuntu0.24.04.8'
    },
    base: 'all'
  },
  {
    name: 'cron',
    description: 'process scheduling daemon',
    versions: { debian12: '3.0pl1-162', ubuntu2204: '3.0pl1-137ubuntu3', ubuntu2404: '3.0pl1-184ubuntu2' },
    base: 'all'
  },
  {
    name: 'curl',
    description: 'command line tool for transferring data with URL syntax',
    versions: {
      debian12: '7.88.1-10+deb12u15',
      ubuntu2204: '7.81.0-1ubuntu1.30',
      ubuntu2404: '8.5.0-2ubuntu10.16'
    },
    base: 'all'
  },
  {
    name: 'fail2ban',
    description: 'ban hosts that cause multiple authentication errors',
    versions: { debian12: '1.0.2-2', ubuntu2204: '0.11.2-6', ubuntu2404: '1.0.2-3' }
  },
  {
    name: 'isc-dhcp-server',
    description: 'ISC DHCP server for automatic IP address assignment',
    versions: {
      debian12: '4.4.3-P1-2',
      ubuntu2204: '4.4.1-2.3ubuntu2.3',
      ubuntu2404: '4.4.3-P1-4ubuntu2'
    }
  },
  {
    name: 'mariadb-server',
    description: 'MariaDB database server binaries',
    versions: {
      debian12: '1:10.11.19-0+deb12u1',
      ubuntu2204: '1:10.6.22-0ubuntu0.22.04.1',
      ubuntu2404: '1:10.11.13-0ubuntu0.24.04.1'
    }
  },
  {
    name: 'nginx',
    description: 'small, powerful, scalable web/proxy server',
    versions: {
      debian12: '1.22.1-9+deb12u10',
      ubuntu2204: '1.18.0-6ubuntu14.21',
      ubuntu2404: '1.24.0-2ubuntu7.18'
    }
  },
  {
    name: 'openssh-server',
    description: 'secure shell (SSH) server, for secure access from remote machines',
    versions: {
      debian12: '1:9.2p1-2+deb12u10',
      ubuntu2204: '1:8.9p1-3ubuntu0.18',
      ubuntu2404: '1:9.6p1-3ubuntu13.20'
    },
    base: 'server'
  },
  {
    name: 'postfix',
    description: 'High-performance mail transport agent',
    versions: {
      debian12: '3.7.11-0+deb12u1',
      ubuntu2204: '3.6.4-1ubuntu1.4',
      ubuntu2404: '3.8.6-1ubuntu0.1'
    }
  },
  {
    name: 'rsyslog',
    description: 'reliable system and kernel logging daemon',
    versions: {
      debian12: '8.2302.0-1+deb12u1',
      ubuntu2204: '8.2112.0-2ubuntu2.5',
      ubuntu2404: '8.2312.0-3ubuntu9.4'
    },
    base: 'all'
  },
  {
    name: 'samba',
    description: 'SMB/CIFS file, print, and login server for Unix',
    versions: {
      debian12: '2:4.17.12+dfsg-0+deb12u4',
      ubuntu2204: '2:4.15.13+dfsg-0ubuntu1.13',
      ubuntu2404: '2:4.19.5+dfsg-4ubuntu9.7'
    }
  },
  {
    name: 'vsftpd',
    description: 'lightweight, efficient FTP server written for security',
    versions: { debian12: '3.0.3-13', ubuntu2204: '3.0.5-0ubuntu1', ubuntu2404: '3.0.5-0ubuntu3' }
  }
]

export const UNITS: LinuxUnit[] = [
  {
    name: 'apache2',
    description: 'The Apache HTTP Server',
    pkg: 'apache2',
    process: 'apache2',
    command: '/usr/sbin/apache2 -k start',
    listens: [{ proto: 'tcp', port: 80, bind: 'any6', backlog: 511 }]
  },
  {
    name: 'cron',
    description: 'Regular background program processing daemon',
    pkg: 'cron',
    process: 'cron',
    command: '/usr/sbin/cron -f',
    listens: []
  },
  {
    name: 'isc-dhcp-server',
    description: 'LSB: DHCP server',
    pkg: 'isc-dhcp-server',
    process: 'dhcpd',
    command: '/usr/sbin/dhcpd -4 -q -cf /etc/dhcp/dhcpd.conf',
    listens: [{ proto: 'udp', port: 67, bind: 'any4', backlog: 0 }]
  },
  {
    name: 'mariadb',
    description: 'MariaDB database server',
    pkg: 'mariadb-server',
    process: 'mariadbd',
    command: '/usr/sbin/mariadbd',
    listens: [{ proto: 'tcp', port: 3306, bind: 'loopback', backlog: 80 }]
  },
  {
    name: 'named',
    aliases: ['bind9'],
    description: 'BIND Domain Name Server',
    pkg: 'bind9',
    process: 'named',
    command: '/usr/sbin/named -f -u bind',
    listens: [
      { proto: 'tcp', port: 53, bind: 'ifaces', backlog: 10 },
      { proto: 'udp', port: 53, bind: 'ifaces', backlog: 0 },
      { proto: 'tcp', port: 953, bind: 'loopback', backlog: 10 }
    ]
  },
  {
    name: 'nginx',
    description: 'A high performance web server and a reverse proxy server',
    pkg: 'nginx',
    process: 'nginx',
    command: 'nginx: master process /usr/sbin/nginx -g daemon on; master_process on;',
    listens: [{ proto: 'tcp', port: 80, bind: 'dual', backlog: 511 }]
  },
  {
    name: 'nmbd',
    description: 'Samba NMB Daemon',
    pkg: 'samba',
    process: 'nmbd',
    command: '/usr/sbin/nmbd --foreground --no-process-group',
    listens: [
      { proto: 'udp', port: 137, bind: 'any4', backlog: 0 },
      { proto: 'udp', port: 138, bind: 'any4', backlog: 0 }
    ]
  },
  {
    name: 'postfix',
    description: 'Postfix Mail Transport Agent',
    pkg: 'postfix',
    process: 'master',
    command: '/usr/lib/postfix/sbin/master -w',
    listens: [{ proto: 'tcp', port: 25, bind: 'dual', backlog: 100 }]
  },
  {
    name: 'rsyslog',
    description: 'System Logging Service',
    pkg: 'rsyslog',
    process: 'rsyslogd',
    command: '/usr/sbin/rsyslogd -n -iNONE',
    listens: []
  },
  {
    name: 'smbd',
    description: 'Samba SMB Daemon',
    pkg: 'samba',
    process: 'smbd',
    command: '/usr/sbin/smbd --foreground --no-process-group',
    listens: [
      { proto: 'tcp', port: 139, bind: 'any4', backlog: 50 },
      { proto: 'tcp', port: 445, bind: 'any4', backlog: 50 }
    ]
  },
  {
    name: 'ssh',
    aliases: ['sshd'],
    description: 'OpenBSD Secure Shell server',
    pkg: 'openssh-server',
    process: 'sshd',
    command: 'sshd: /usr/sbin/sshd -D [listener] 0 of 10-100 startups',
    listens: [{ proto: 'tcp', port: 22, bind: 'dual', backlog: 128 }]
  },
  {
    name: 'vsftpd',
    description: 'vsftpd FTP server',
    pkg: 'vsftpd',
    process: 'vsftpd',
    command: '/usr/sbin/vsftpd /etc/vsftpd.conf',
    listens: [{ proto: 'tcp', port: 21, bind: 'any6', backlog: 32 }]
  },
  // En dernier : unitPid() dérive le PID du rang de l'unité, les unités existantes gardent le leur
  {
    name: 'fail2ban',
    description: 'Fail2Ban Service',
    pkg: 'fail2ban',
    process: 'fail2ban-server',
    command: '/usr/bin/python3 /usr/bin/fail2ban-server -xf start',
    listens: []
  }
]

export function findPackage(name: string): LinuxPackage | undefined {
  return PACKAGES.find((p) => p.name === name)
}

/** Unité désignée par son nom (avec ou sans `.service`) ou un alias. */
export function findUnit(name: string): LinuxUnit | undefined {
  const bare = name.replace(/\.service$/, '')
  return UNITS.find((u) => u.name === bare || u.aliases?.includes(bare))
}
