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
  'mount.cifs'
]

const KNOWN = { cmd: new Set(CMD), ps: new Set(PS), bash: new Set(BASH) }

/** Vrai si `name` est une commande réelle de ce shell, non simulée. */
export function isUnsimulated(shell: 'cmd' | 'ps' | 'bash', name: string): boolean {
  return KNOWN[shell].has(name.toLowerCase())
}

/** Message affiché à la place de « commande introuvable ». */
export function unsimulatedMessage(shell: 'cmd' | 'ps' | 'bash', name: string): string {
  return shell === 'bash'
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
