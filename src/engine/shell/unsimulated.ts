/**
 * Commandes réelles connues mais non simulées : au lieu de « commande introuvable » (qui laisse
 * croire à l'élève qu'il s'est trompé de commande), le shell indique que la commande existe sur un
 * vrai système mais n'est pas reproduite par ServerLab (audit F-01, docs/fidelite.md).
 */

/** Commandes cmd.exe / outils Windows réels non simulés (noms en minuscules). */
const CMD = ['taskkill', 'wmic', 'getmac']

/** Applets de commande PowerShell réelles non simulées (noms en minuscules). */
const PS = ['get-process', 'stop-process', 'get-hotfix', 'get-wmiobject', 'get-ciminstance']

/** Commandes Linux réelles non simulées sur le poste Linux. */
const BASH = [
  'netstat',
  'service',
  'arp',
  'route',
  'top',
  'ufw',
  'iptables',
  'nmcli',
  // Éditeurs et commandes de fichiers hors du périmètre simulé (v2.9)
  'vi',
  'vim',
  'emacs',
  'rm',
  'cp',
  'mv',
  'head',
  'tail',
  'wc',
  'less',
  'find',
  'groupdel',
  'userdel',
  'visudo',
  // SSH, journaux (v2.9, #237) : seuls ssh, ssh-keygen, ssh-copy-id, fail2ban-client et logger sont simulés
  'scp',
  'sftp',
  'ssh-add',
  'ssh-agent',
  'ssh-keyscan',
  'sshd',
  'rsyslogd',
  'fail2ban-regex',
  'fail2ban-server',
  // Apache2 (v2.9, #238) : seuls a2ensite, a2dissite, a2enmod, a2dismod, a2enconf, a2disconf, apache2ctl,
  // apachectl et curl sont simulés
  'apache2',
  'a2query',
  'htpasswd',
  'htdigest',
  'ab',
  'openssl',
  'certbot',
  'ln',
  // Samba (v2.9, #239) : seuls testparm, smbpasswd, pdbedit, smbstatus, smbclient (-L et -c ls) sont simulés
  'smbd',
  'nmbd',
  'samba-tool',
  'smbcontrol',
  'smbtree',
  'smbget',
  'smbcacls',
  'nmblookup',
  'wbinfo',
  'winbindd',
  'mount.cifs',
  // Bind9 et isc-dhcp-server (v2.9, #240) : seuls named-checkconf, named-checkzone, rndc (status, reload,
  // reconfig, flush), host, dig, nslookup et dhcpd -t sont simulés
  'named',
  'rndc-confgen',
  'ddns-confgen',
  'dnssec-keygen',
  'dnssec-signzone',
  'named-journalprint',
  'named-compilezone',
  'dhcp-lease-list',
  'dhcrelay',
  'omshell'
]

/**
 * Commandes réelles du shell FreeBSD (tcsh) du pare-feu pfSense, non simulées (v2.10, #247) : seuls pfctl
 * (-sr, -ss, -si, -d, -e), ifconfig, netstat -rn, cat / tail / clog sur le journal du filtre, ping, grep,
 * head et filterparser.php sont simulés.
 */
const PFSENSE = [
  'ls',
  'cd',
  'pwd',
  'vi',
  'ee',
  'ps',
  'top',
  'sockstat',
  'arp',
  'ndp',
  'route',
  'sysctl',
  'dmesg',
  'df',
  'uname',
  'uptime',
  'date',
  'kldstat',
  'pftop',
  'tcpdump',
  'traceroute',
  'host',
  'drill',
  'nslookup',
  'less',
  'more',
  'sed',
  'awk',
  'php',
  'pfssh.php',
  'service',
  'pkg',
  'sh',
  'bash',
  'nc',
  'telnet',
  'ssh',
  'fetch',
  'curl',
  'ping6',
  'whoami',
  'id',
  'hostname',
  'mount',
  'rm',
  'cp',
  'mv'
]

const KNOWN = { cmd: new Set(CMD), ps: new Set(PS), bash: new Set(BASH), pfsense: new Set(PFSENSE) }

/** Vrai si `name` est une commande réelle de ce shell, non simulée. */
export function isUnsimulated(shell: 'cmd' | 'ps' | 'bash' | 'pfsense', name: string): boolean {
  return KNOWN[shell].has(name.toLowerCase())
}

/** Message affiché à la place de « commande introuvable ». */
export function unsimulatedMessage(shell: 'cmd' | 'ps' | 'bash' | 'pfsense', name: string): string {
  return shell === 'bash' || shell === 'pfsense'
    ? `${name}: commande réelle non simulée dans ServerLab`
    : `« ${name} » est une commande réelle qui n’est pas simulée dans ServerLab.`
}

/**
 * Garde-fou des boucles : au-delà de `limit` itérations, ServerLab arrête la boucle (le vrai
 * PowerShell continuerait, une boucle infinie se termine par Ctrl+C).
 */
export function iterationLimitMessage(keyword: string, limit: number): string {
  return `Boucle « ${keyword} » interrompue : plus de ${limit} itérations. Cette limite est propre au simulateur ServerLab (PowerShell n’en a pas).`
}

/**
 * Message d'un paramètre réel d'une applet de commande, accepté par Windows PowerShell mais non
 * reproduit par ServerLab (au lieu d'un « paramètre introuvable » trompeur).
 */
export function unsimulatedParameterMessage(command: string, parameter: string): string {
  return `Le paramètre « -${parameter} » de ${command} existe réellement mais n’est pas simulé dans ServerLab.`
}

/** Élément réel d'IOS non simulé (filtre `| tee`, `interface range macro`…). */
export function unsimulatedIosMessage(name: string): string {
  return `« ${name} » est une fonction réelle d’IOS qui n’est pas simulée dans ServerLab.`
}

/** Option réelle d'un outil de la console (`w32tm /config`, `net time /rtsdomain`…) non simulée. */
export function unsimulatedOptionMessage(tool: string, option: string): string {
  return `L’option « ${option} » de ${tool} existe réellement mais n’est pas simulée dans ServerLab.`
}

/** Fichier réel d'un outil du shell (journaux du pare-feu autres que filter.log) que ServerLab ne reproduit pas. */
export function unsimulatedFileMessage(tool: string, file: string): string {
  return `${tool}: ${file} : ce fichier existe réellement mais n’est pas simulé dans ServerLab.`
}

/** Construction réelle du langage bash (`$(…)`, `&`, `for`, `if`, sous-shell…) que ServerLab ne simule pas. */
export function unsimulatedSyntaxMessage(construct: string): string {
  return `bash: la construction « ${construct} » existe réellement mais n’est pas simulée dans ServerLab.`
}
