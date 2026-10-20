/**
 * Configuration des services Linux simulés (v2.9, #237) : SSH (`sshd_config`), rsyslog
 * (`rsyslog.conf`, `rsyslog.d/*.conf`) et fail2ban (`jail.d/*.conf`, `jail.local`).
 *
 * Les textes par défaut sont ceux des paquets Debian 12 (sources.debian.org) ; ils tiennent lieu de
 * contenu tant que le fichier n'a pas été modifié. Seules les directives modélisées sont lues
 * (docs/fidelite.md, « À vérifier (v2.9 — Linux) ») ; les autres sont ignorées sans erreur.
 *
 * Comme sur un vrai système, un service ne relit sa configuration qu'à son (re)démarrage ou à un
 * `reload` : `host.linux.loaded` garde le texte en vigueur tant que les fichiers ont changé depuis
 * (voir `snapshotOnWrite`). Fonctions pures, sans dépendance à la console.
 */

import { SMB_CONF_DEFAULT } from './linuxsambadata'
import { APACHE_DIR, APACHE_PROVIDED, buildConfig, withApacheNodes, type ConfigSource } from './linuxapache'

/** Fichiers vus par ce module : le champ `host.linux.files` (absent = arborescence par défaut). */
export type ConfigFiles =
  Record<string, { type: 'file' | 'dir'; content?: string; link?: string }> | undefined

export const SSHD_CONFIG = '/etc/ssh/sshd_config'
export const SSHD_DROPIN_DIR = '/etc/ssh/sshd_config.d'
export const RSYSLOG_CONF = '/etc/rsyslog.conf'
export const RSYSLOG_DIR = '/etc/rsyslog.d'
export const JAIL_DIR = '/etc/fail2ban/jail.d'
export const JAIL_LOCAL = '/etc/fail2ban/jail.local'
export const SMB_CONF = '/etc/samba/smb.conf'

/** /etc/fail2ban/jail.d/defaults-debian.conf du paquet fail2ban 1.0.2-2 (active la prison sshd). */
export const FAIL2BAN_DEFAULTS_DEBIAN = '[sshd]\nenabled = true\n'

/** /etc/ssh/sshd_config d'openssh-server 1:9.2p1-2+deb12u10 (sources.debian.org, debian/patches appliqués). */
export const SSHD_CONFIG_DEFAULT =
  [
    '#\t$OpenBSD: sshd_config,v 1.104 2021/07/02 05:11:21 dtucker Exp $',
    '',
    '# This is the sshd server system-wide configuration file.  See',
    '# sshd_config(5) for more information.',
    '',
    '# This sshd was compiled with PATH=/usr/bin:/bin:/usr/sbin:/sbin',
    '',
    '# The strategy used for options in the default sshd_config shipped with',
    '# OpenSSH is to specify options with their default value where',
    '# possible, but leave them commented.  Uncommented options override the',
    '# default value.',
    '',
    'Include /etc/ssh/sshd_config.d/*.conf',
    '',
    '#Port 22',
    '#AddressFamily any',
    '#ListenAddress 0.0.0.0',
    '#ListenAddress ::',
    '',
    '#HostKey /etc/ssh/ssh_host_rsa_key',
    '#HostKey /etc/ssh/ssh_host_ecdsa_key',
    '#HostKey /etc/ssh/ssh_host_ed25519_key',
    '',
    '# Ciphers and keying',
    '#RekeyLimit default none',
    '',
    '# Logging',
    '#SyslogFacility AUTH',
    '#LogLevel INFO',
    '',
    '# Authentication:',
    '',
    '#LoginGraceTime 2m',
    '#PermitRootLogin prohibit-password',
    '#StrictModes yes',
    '#MaxAuthTries 6',
    '#MaxSessions 10',
    '',
    '#PubkeyAuthentication yes',
    '',
    '# Expect .ssh/authorized_keys2 to be disregarded by default in future.',
    '#AuthorizedKeysFile\t.ssh/authorized_keys .ssh/authorized_keys2',
    '',
    '#AuthorizedPrincipalsFile none',
    '',
    '#AuthorizedKeysCommand none',
    '#AuthorizedKeysCommandUser nobody',
    '',
    '# For this to work you will also need host keys in /etc/ssh/ssh_known_hosts',
    '#HostbasedAuthentication no',
    "# Change to yes if you don't trust ~/.ssh/known_hosts for",
    '# HostbasedAuthentication',
    '#IgnoreUserKnownHosts no',
    "# Don't read the user's ~/.rhosts and ~/.shosts files",
    '#IgnoreRhosts yes',
    '',
    '# To disable tunneled clear text passwords, change to no here!',
    '#PasswordAuthentication yes',
    '#PermitEmptyPasswords no',
    '',
    '# Change to yes to enable challenge-response passwords (beware issues with',
    '# some PAM modules and threads)',
    'KbdInteractiveAuthentication no',
    '',
    '# Kerberos options',
    '#KerberosAuthentication no',
    '#KerberosOrLocalPasswd yes',
    '#KerberosTicketCleanup yes',
    '#KerberosGetAFSToken no',
    '',
    '# GSSAPI options',
    '#GSSAPIAuthentication no',
    '#GSSAPICleanupCredentials yes',
    '#GSSAPIStrictAcceptorCheck yes',
    '#GSSAPIKeyExchange no',
    '',
    "# Set this to 'yes' to enable PAM authentication, account processing,",
    '# and session processing. If this is enabled, PAM authentication will',
    '# be allowed through the KbdInteractiveAuthentication and',
    '# PasswordAuthentication.  Depending on your PAM configuration,',
    '# PAM authentication via KbdInteractiveAuthentication may bypass',
    '# the setting of "PermitRootLogin prohibit-password".',
    '# If you just want the PAM account and session checks to run without',
    '# PAM authentication, then enable this but set PasswordAuthentication',
    "# and KbdInteractiveAuthentication to 'no'.",
    'UsePAM yes',
    '',
    '#AllowAgentForwarding yes',
    '#AllowTcpForwarding yes',
    '#GatewayPorts no',
    'X11Forwarding yes',
    '#X11DisplayOffset 10',
    '#X11UseLocalhost yes',
    '#PermitTTY yes',
    'PrintMotd no',
    '#PrintLastLog yes',
    '#TCPKeepAlive yes',
    '#PermitUserEnvironment no',
    '#Compression delayed',
    '#ClientAliveInterval 0',
    '#ClientAliveCountMax 3',
    '#UseDNS no',
    '#PidFile /var/run/sshd.pid',
    '#MaxStartups 10:30:100',
    '#PermitTunnel no',
    '#ChrootDirectory none',
    '#VersionAddendum none',
    '',
    '# no default banner path',
    '#Banner none',
    '',
    '# Allow client to pass locale environment variables',
    'AcceptEnv LANG LC_*',
    '',
    '# override default of no subsystems',
    'Subsystem\tsftp\t/usr/lib/openssh/sftp-server',
    '',
    '# Example of overriding settings on a per-user basis',
    '#Match User anoncvs',
    '#\tX11Forwarding no',
    '#\tAllowTcpForwarding no',
    '#\tPermitTTY no',
    '#\tForceCommand cvs server'
  ].join('\n') + '\n'

/** /etc/rsyslog.conf de rsyslog 8.2302.0-1+deb12u1 (sources.debian.org, debian/rsyslog.conf). */
export const RSYSLOG_CONF_DEFAULT =
  [
    '# /etc/rsyslog.conf configuration file for rsyslog',
    '#',
    '# For more information install rsyslog-doc and see',
    '# /usr/share/doc/rsyslog-doc/html/configuration/index.html',
    '',
    '',
    '#################',
    '#### MODULES ####',
    '#################',
    '',
    'module(load="imuxsock") # provides support for local system logging',
    'module(load="imklog")   # provides kernel logging support',
    '#module(load="immark")  # provides --MARK-- message capability',
    '',
    '# provides UDP syslog reception',
    '#module(load="imudp")',
    '#input(type="imudp" port="514")',
    '',
    '# provides TCP syslog reception',
    '#module(load="imtcp")',
    '#input(type="imtcp" port="514")',
    '',
    '',
    '###########################',
    '#### GLOBAL DIRECTIVES ####',
    '###########################',
    '',
    '#',
    '# Set the default permissions for all log files.',
    '#',
    '$FileOwner root',
    '$FileGroup adm',
    '$FileCreateMode 0640',
    '$DirCreateMode 0755',
    '$Umask 0022',
    '',
    '#',
    '# Where to place spool and state files',
    '#',
    '$WorkDirectory /var/spool/rsyslog',
    '',
    '#',
    '# Include all config files in /etc/rsyslog.d/',
    '#',
    '$IncludeConfig /etc/rsyslog.d/*.conf',
    '',
    '',
    '###############',
    '#### RULES ####',
    '###############',
    '',
    '#',
    '# Log anything besides private authentication messages to a single log file',
    '#',
    '*.*;auth,authpriv.none\t\t-/var/log/syslog',
    '',
    '#',
    '# Log commonly used facilities to their own log file',
    '#',
    'auth,authpriv.*\t\t\t/var/log/auth.log',
    'cron.*\t\t\t\t-/var/log/cron.log',
    'kern.*\t\t\t\t-/var/log/kern.log',
    'mail.*\t\t\t\t-/var/log/mail.log',
    'user.*\t\t\t\t-/var/log/user.log',
    '',
    '#',
    '# Emergencies are sent to everybody logged in.',
    '#',
    '*.emerg\t\t\t\t:omusrmsg:*'
  ].join('\n') + '\n'

/** Contenu fourni par le paquet tant que le fichier n'est pas modifié (chemin → texte). */
const PROVIDED: Record<string, string> = {
  ...APACHE_PROVIDED,
  [SSHD_CONFIG]: SSHD_CONFIG_DEFAULT,
  [RSYSLOG_CONF]: RSYSLOG_CONF_DEFAULT,
  [SMB_CONF]: SMB_CONF_DEFAULT,
  [`${JAIL_DIR}/defaults-debian.conf`]: FAIL2BAN_DEFAULTS_DEBIAN
}

/** Contenu par défaut d'un fichier fourni par un paquet (undefined si le chemin n'en a pas). */
export const providedText = (path: string): string | undefined => PROVIDED[path]

/** Chemin absolu normalisé (., ..) d'une cible de lien relative au dossier du lien. */
export function resolveLink(linkPath: string, target: string): string {
  const base = target.startsWith('/') ? target : `${linkPath.replace(/\/[^/]*$/, '')}/${target}`
  const parts: string[] = []
  for (const part of base.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

/** Texte d'un fichier de configuration (liens symboliques suivis) ; null s'il n'existe pas. */
export function fileText(files: ConfigFiles, path: string, depth = 0): string | null {
  const node = files?.[path]
  if (node?.link !== undefined)
    return depth > 8 ? null : fileText(files, resolveLink(path, node.link), depth + 1)
  if (node?.type === 'file' && node.content !== undefined) return node.content
  if (path in PROVIDED && (!node || node.type === 'file')) return PROVIDED[path] as string
  return node?.type === 'file' ? '' : null
}

/** Fichiers `dir/*suffix` (triés par nom, comme le glob du shell). */
export function dropIns(files: ConfigFiles, dir: string, suffix: string): string[] {
  const names = new Set<string>(Object.keys(PROVIDED).filter((p) => p.startsWith(`${dir}/`)))
  for (const [p, n] of Object.entries(files ?? {}))
    if (n.type === 'file' && p.startsWith(`${dir}/`)) names.add(p)
  return [...names]
    .filter((p) => !p.slice(dir.length + 1).includes('/') && p.endsWith(suffix))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/** Lignes d'un texte, directives `Include dir/*.conf` développées sur place. */
function expandIncludes(files: ConfigFiles, text: string, include: RegExp): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    const m = include.exec(line.trim())
    if (!m) {
      out.push(line)
      continue
    }
    const glob = m[1] as string
    const slash = glob.lastIndexOf('/')
    const dir = glob.slice(0, slash)
    const suffix = glob.slice(slash + 1).replace(/^\*/, '')
    for (const p of dropIns(files, dir, suffix)) out.push(...(fileText(files, p) ?? '').split('\n'))
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// sshd
// ---------------------------------------------------------------------------------------------

export type PermitRootLogin = 'yes' | 'prohibit-password' | 'forced-commands-only' | 'no'

export interface SshdConfig {
  /** Ports d'écoute (directive Port, répétable) ; 22 par défaut. */
  ports: number[]
  permitRootLogin: PermitRootLogin
  passwordAuthentication: boolean
  pubkeyAuthentication: boolean
}

/** Texte de la configuration de sshd, `Include` développé (c'est ce texte que sshd garde en mémoire). */
export function sshdConfigText(files: ConfigFiles): string {
  return expandIncludes(files, fileText(files, SSHD_CONFIG) ?? '', /^Include\s+(\S+\/\*\.conf)$/i).join('\n')
}

/** Lit une configuration sshd : la première valeur d'une directive l'emporte (comme sshd), Match ignoré. */
export function parseSshd(text: string): SshdConfig {
  const seen = new Map<string, string>()
  const ports: number[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const m = /^(\S+?)(?:\s+|\s*=\s*)(.+)$/.exec(line)
    if (!m) continue
    const key = (m[1] as string).toLowerCase()
    const value = (m[2] as string).trim()
    if (key === 'match') break
    if (key === 'port') {
      const n = Number(value)
      if (Number.isInteger(n) && n > 0 && n < 65536) ports.push(n)
    } else if (!seen.has(key)) seen.set(key, value.toLowerCase())
  }
  const root = seen.get('permitrootlogin')
  // « without-password » est l'ancien nom de prohibit-password
  const permit: PermitRootLogin =
    root === 'yes' || root === 'no' || root === 'forced-commands-only' ? root : 'prohibit-password'
  return {
    ports: ports.length > 0 ? ports : [22],
    permitRootLogin: permit,
    passwordAuthentication: seen.get('passwordauthentication') !== 'no',
    pubkeyAuthentication: seen.get('pubkeyauthentication') !== 'no'
  }
}

// ---------------------------------------------------------------------------------------------
// rsyslog
// ---------------------------------------------------------------------------------------------

export interface RsyslogForward {
  /** Installations concernées par la règle (`auth`, `authpriv`…) ; `*` = toutes. */
  facilities: string[]
  proto: 'tcp' | 'udp'
  target: string
  port: number
}

export interface RsyslogConfig {
  /** Protocoles et ports sur lesquels rsyslog reçoit des messages d'autres machines. */
  inputs: { proto: 'tcp' | 'udp'; port: number }[]
  forwards: RsyslogForward[]
}

/** Texte de la configuration de rsyslog, `$IncludeConfig` développé. */
export function rsyslogConfigText(files: ConfigFiles): string {
  return expandIncludes(
    files,
    fileText(files, RSYSLOG_CONF) ?? '',
    /^\$IncludeConfig\s+(\S+\/\*\.conf)$/i
  ).join('\n')
}

/** Lit les entrées réseau et les règles d'envoi distant (`*.* @@hôte:port` TCP, `@hôte` UDP). */
export function parseRsyslog(text: string): RsyslogConfig {
  const inputs: RsyslogConfig['inputs'] = []
  const forwards: RsyslogForward[] = []
  const loaded = new Set<string>()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const mod = /^module\(\s*load="(imtcp|imudp)"/.exec(line) ?? /^\$ModLoad\s+(imtcp|imudp)\b/i.exec(line)
    if (mod) loaded.add(mod[1] as string)
    const input = /^input\(\s*type="(imtcp|imudp)"\s+port="(\d+)"/.exec(line)
    if (input && loaded.has(input[1] as string))
      inputs.push({ proto: input[1] === 'imtcp' ? 'tcp' : 'udp', port: Number(input[2]) })
    const legacy = /^\$(InputTCPServerRun|UDPServerRun)\s+(\d+)/i.exec(line)
    if (legacy) {
      const tcp = (legacy[1] as string).toLowerCase() === 'inputtcpserverrun'
      if (loaded.has(tcp ? 'imtcp' : 'imudp'))
        inputs.push({ proto: tcp ? 'tcp' : 'udp', port: Number(legacy[2]) })
    }
    const fwd = /^(\S+)\s+(@@?)(\[[^\]]+\]|[^\s:]+)(?::(\d+))?\s*$/.exec(line)
    if (fwd) {
      const facilities = (fwd[1] as string)
        .split(';')
        .flatMap((sel) => (sel.split('.')[0] ?? '*').split(','))
        .map((f) => f.toLowerCase())
      forwards.push({
        facilities: facilities.includes('*') ? ['*'] : facilities,
        proto: fwd[2] === '@@' ? 'tcp' : 'udp',
        target: (fwd[3] as string).replace(/^\[|\]$/g, ''),
        port: Number(fwd[4] ?? 514)
      })
    }
    const omfwd = /^action\(\s*type="omfwd"\s+(.*)\)$/.exec(line)
    if (omfwd) {
      const arg = (name: string) => new RegExp(`${name}="([^"]*)"`).exec(omfwd[1] as string)?.[1]
      const target = arg('target')
      if (target)
        forwards.push({
          facilities: ['*'],
          proto: arg('protocol') === 'udp' ? 'udp' : 'tcp',
          target,
          port: Number(arg('port') ?? 514)
        })
    }
  }
  return { inputs, forwards }
}

// ---------------------------------------------------------------------------------------------
// fail2ban
// ---------------------------------------------------------------------------------------------

export interface JailConfig {
  name: string
  enabled: boolean
  /** Échecs tolérés dans `findtime` avant le bannissement. */
  maxretry: number
  /** Fenêtre de comptage des échecs (ms). */
  findtime: number
  /** Durée du bannissement (ms) ; -1 = définitif. */
  bantime: number
  ignoreip: string[]
  logpath: string
}

const UNIT_SECONDS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
  w: 604800,
  mo: 2592000,
  y: 31536000
}

/** Durée fail2ban (« 600 », « 10m », « 1h », « 1d », « 1w ») en ms ; -1 = définitif. */
export function parseDuration(text: string): number | null {
  const m = /^(-?\d+)\s*(mo|[smhdwy])?[a-z]*$/i.exec(text.trim())
  if (!m) return null
  const n = Number(m[1])
  if (n < 0) return -1
  return n * (UNIT_SECONDS[(m[2] ?? 's').toLowerCase()] ?? 1) * 1000
}

/** Valeurs de jail.conf (paquet fail2ban 1.0.2-2) reprises par ce module. */
const JAIL_CONF_BASE = [
  '[DEFAULT]',
  'ignoreip = 127.0.0.1/8 ::1',
  'bantime  = 10m',
  'findtime  = 10m',
  'maxretry = 5',
  '[sshd]',
  'port    = ssh',
  'logpath = /var/log/auth.log'
].join('\n')

const SEPARATOR = '\n=====\n'

/** Texte de la configuration de fail2ban : jail.d/*.conf, jail.local, jail.d/*.local, dans l'ordre de lecture. */
export function jailConfigText(files: ConfigFiles): string {
  return [
    ...dropIns(files, JAIL_DIR, '.conf').map((p) => fileText(files, p) ?? ''),
    fileText(files, JAIL_LOCAL) ?? '',
    ...dropIns(files, JAIL_DIR, '.local').map((p) => fileText(files, p) ?? '')
  ].join(SEPARATOR)
}

/** Prisons définies par une configuration (fichiers séparés par « ===== »), jail.conf du paquet en tête. */
export function parseJails(text: string): JailConfig[] {
  const sections = new Map<string, Map<string, string>>()
  for (const source of [JAIL_CONF_BASE, ...text.split(SEPARATOR)]) {
    let current = ''
    for (const raw of source.split('\n')) {
      const line = raw.trim()
      if (line === '' || line.startsWith('#') || line.startsWith(';')) continue
      const sec = /^\[(.+)\]$/.exec(line)
      if (sec) {
        current = sec[1] as string
        if (!sections.has(current)) sections.set(current, new Map())
        continue
      }
      const kv = /^([A-Za-z_][\w.-]*)\s*[=:]\s*(.*)$/.exec(line)
      if (kv && current !== '')
        sections.get(current)?.set((kv[1] as string).toLowerCase(), (kv[2] as string).trim())
    }
  }
  const defaults = sections.get('DEFAULT') ?? new Map<string, string>()
  const value = (jail: string, key: string) => sections.get(jail)?.get(key) ?? defaults.get(key)
  return [...sections.keys()]
    .filter((n) => n !== 'DEFAULT' && n !== 'INCLUDES')
    .map((name) => ({
      name,
      enabled: /^(true|yes|1|on)$/i.test(value(name, 'enabled') ?? 'false'),
      maxretry: Number(value(name, 'maxretry')) || 5,
      findtime: parseDuration(value(name, 'findtime') ?? '10m') ?? 600_000,
      bantime: parseDuration(value(name, 'bantime') ?? '10m') ?? 600_000,
      ignoreip: (value(name, 'ignoreip') ?? '').split(/[\s,]+/).filter(Boolean),
      logpath: value(name, 'logpath') ?? ''
    }))
}

// ---------------------------------------------------------------------------------------------
// apache2
// ---------------------------------------------------------------------------------------------

/** Source de configuration d'Apache lue dans les fichiers (nœuds du paquet compris). */
export function apacheSource(files: ConfigFiles): ConfigSource {
  const all = withApacheNodes(files ?? {})
  return {
    read: (path) => fileText(all, path),
    glob: (dir, suffix) => dropIns(all, dir, suffix)
  }
}

/** Fichiers de configuration lus par Apache (c'est ce texte qu'il garde en mémoire) ; null sans /etc/apache2. */
export function apacheBundleText(files: ConfigFiles): string | null {
  if (!files || !(APACHE_DIR in files)) return null
  return JSON.stringify(buildConfig(apacheSource(files)).files)
}

/** Source de configuration relue d'un instantané (`apacheBundleText`). */
export function bundleSource(text: string): ConfigSource {
  let bundle: Record<string, string> = {}
  try {
    bundle = JSON.parse(text) as Record<string, string>
  } catch {
    bundle = {}
  }
  return {
    read: (path) => bundle[path] ?? null,
    glob: (dir, suffix) =>
      Object.keys(bundle)
        .filter(
          (p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/') && p.endsWith(suffix)
        )
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  }
}

/** Contenu de /etc/hosts (celui du fichier, sinon le contenu par défaut d'un système neuf). */
export function hostsTextOf(files: ConfigFiles, hostname: string): string {
  const node = files?.['/etc/hosts']
  if (node?.content !== undefined) return node.content
  return [
    '127.0.0.1 localhost',
    `127.0.1.1 ${hostname}`,
    '',
    '# The following lines are desirable for IPv6 capable hosts',
    '::1     ip6-localhost ip6-loopback',
    ''
  ].join('\n')
}

// ---------------------------------------------------------------------------------------------
// Configuration en vigueur
// ---------------------------------------------------------------------------------------------

/** Unités dont la configuration est lue à leur (re)démarrage. */
export const CONFIGURED_UNITS = ['ssh', 'rsyslog', 'fail2ban', 'apache2', 'smbd']

/** Texte de configuration actuel (fichiers) d'une unité ; null si l'unité n'a pas de configuration modélisée. */
export function configTextOf(unit: string, files: ConfigFiles): string | null {
  if (unit === 'ssh') return sshdConfigText(files)
  if (unit === 'rsyslog') return rsyslogConfigText(files)
  if (unit === 'fail2ban') return jailConfigText(files)
  if (unit === 'apache2') return apacheBundleText(files)
  if (unit === 'smbd') return fileText(files, SMB_CONF)
  return null
}

interface LinuxConfigState {
  files?: ConfigFiles
  loaded?: Record<string, string>
}

/** Configuration en vigueur : instantané du dernier (re)démarrage, sinon fichiers actuels. */
export function runningConfigText(linux: LinuxConfigState | undefined, unit: string): string {
  return linux?.loaded?.[unit] ?? configTextOf(unit, linux?.files) ?? ''
}

/**
 * Instantanés à garder quand les fichiers passent de `before` à `after` : pour chaque service dont la
 * configuration change et dont aucun instantané n'existe encore, l'ancien texte reste en vigueur
 * jusqu'au prochain (re)démarrage.
 */
export function snapshotOnWrite(
  loaded: Record<string, string> | undefined,
  before: ConfigFiles,
  after: ConfigFiles
): Record<string, string> | undefined {
  let next = loaded
  for (const unit of CONFIGURED_UNITS) {
    if (next?.[unit] !== undefined) continue
    const old = configTextOf(unit, before)
    if (old !== null && old !== configTextOf(unit, after)) next = { ...next, [unit]: old }
  }
  return next
}
