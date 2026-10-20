/**
 * Système de fichiers Linux simulé (v2.9) : arborescence /etc, /var, /home… sur des nœuds
 * `{ type, mode, owner, group, content }`, droits Unix (rwx, propriétaire, groupe) APPLIQUÉS aux accès
 * de la console bash. Les utilisateurs et groupes ne sont pas un état à part : ils sont lus dans le
 * contenu de /etc/passwd, /etc/group, /etc/shadow et /etc/sudoers, comme sur un vrai système.
 *
 * État : champ FACULTATIF `host.linux` (absent = arborescence par défaut, calculée à la lecture).
 * Le schéma `LinuxFsSchema` est destiné au format .slab 27 ; tant qu'il n'y est pas déclaré, l'état
 * vit en mémoire seulement (voir le rapport de l'issue #235).
 */
import { z } from 'zod'
import { transact } from '../../core/result'
import { LAB_EPOCH_MS } from '../../core/clock'
import { LINUX_USER } from '../../model/factory'
import { MAX_FILE_CONTENT, type Host } from '../../model/schema'
import { CommandFailure, type ExecContext } from '../context'

export const LinuxNodeSchema = z.object({
  type: z.enum(['file', 'dir']),
  /** Droits Unix sur 12 bits (0o755, 0o4755, 0o1777…). */
  mode: z.number().int().min(0).max(0o7777),
  owner: z.string(),
  group: z.string(),
  /** Contenu texte d'un fichier ; absent = contenu fourni par le système (hostname, hosts, resolv.conf) ou vide. */
  content: z.string().max(MAX_FILE_CONTENT).optional(),
  /** Date de modification : horloge du lab (ms). */
  mtime: z.number().default(0)
})
export type LinuxNode = z.infer<typeof LinuxNodeSchema>

/** Champ facultatif `host.linux` : chemin absolu → nœud. */
export const LinuxFsSchema = z.object({ files: z.record(z.string(), LinuxNodeSchema) })
export type LinuxFs = z.infer<typeof LinuxFsSchema>
export type LinuxFiles = Record<string, LinuxNode>
type LinuxHost = Host & { linux?: LinuxFs }

/** Marqueur de mot de passe de /etc/shadow : AUCUN hachage réel, le mot de passe suit le marqueur. */
export const SHADOW_MARK = '$sim$'

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

/** Utilisateur de la session de la console : `su` le remplace pour la durée de la session. */
export function bashUser(ctx: ExecContext): string {
  const v = ctx.session.variables['USER']
  if (typeof v === 'string' && v !== '') return v
  return ctx.host.host.session?.user ?? LINUX_USER
}

/** Utilisateur effectif des contrôles d'accès : root sous sudo. */
export const actor = (ctx: ExecContext): string => (ctx.root ? 'root' : bashUser(ctx))

/** Nombre d'octets UTF-8 d'un texte. */
export function byteLength(text: string): number {
  let n = 0
  for (const ch of text) {
    const c = ch.codePointAt(0) as number
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4
  }
  return n
}

/** Jours écoulés depuis le 01/01/1970 à l'horloge du lab (champ « dernier changement » de shadow). */
export const epochDays = (clock: number) => Math.floor((LAB_EPOCH_MS + clock) / 86_400_000)

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
  file('/var/log/syslog', 0o640, '', 'syslog', 'adm')
  file('/var/log/auth.log', 0o640, '', 'syslog', 'adm')
  return files
}

/** Fichiers du poste (par défaut tant qu'aucune écriture n'a eu lieu). */
export function linuxFiles(ctx: ExecContext): LinuxFiles {
  const host = ctx.host.host as LinuxHost
  return host.linux?.files ?? defaultLinuxFiles(host.session?.user ?? LINUX_USER)
}

/** Copie modifiable des fichiers (l'état est gelé par immer). */
export const cloneFiles = (files: LinuxFiles): LinuxFiles => JSON.parse(JSON.stringify(files)) as LinuxFiles

/** Enregistre l'arborescence modifiée dans l'état. */
export function commitFiles(ctx: ExecContext, files: LinuxFiles): void {
  const id = ctx.deviceId
  ctx.apply(
    transact(ctx.state, (draft) => {
      const d = draft.devices[id]
      if (d && (d.kind === 'client' || d.kind === 'server')) (d.host as LinuxHost).linux = { files }
      return undefined
    })
  )
}

/** Contenu de /etc/resolv.conf d'Ubuntu (résolveur local systemd-resolved). */
export function resolvConfLines(domain: string | null): string[] {
  return [
    '# This is /run/systemd/resolve/stub-resolv.conf managed by man:systemd-resolved(8).',
    '# Do not edit.',
    '#',
    "# This file might be symlinked as /etc/resolv.conf. If you're looking at",
    '# /etc/resolv.conf and seeing this text, you have followed the symlink.',
    '#',
    '# Run "resolvectl status" to see details about the uplink DNS servers',
    '# currently in use.',
    '',
    'nameserver 127.0.0.53',
    'options edns0 trust-ad',
    `search ${domain ?? '.'}`
  ]
}

/** Contenu d'un fichier (contenus système calculés tant que le fichier n'a pas été modifié). */
export function contentOf(ctx: ExecContext, path: string, node: LinuxNode): string {
  if (node.content !== undefined) return node.content
  if (path === '/etc/hostname') return `${ctx.host.name}\n`
  if (path === '/etc/hosts')
    return [
      '127.0.0.1 localhost',
      `127.0.1.1 ${ctx.host.name}`,
      '',
      '# The following lines are desirable for IPv6 capable hosts',
      '::1     ip6-localhost ip6-loopback',
      ''
    ].join('\n')
  if (path === '/etc/resolv.conf') return `${resolvConfLines(ctx.host.host.domain).join('\n')}\n`
  return ''
}

// ---------------------------------------------------------------------------
// Chemins
// ---------------------------------------------------------------------------

export const parentOf = (path: string): string => path.replace(/\/[^/]*$/, '') || '/'
export const baseOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1)
export const joinPath = (dir: string, name: string): string => (dir === '/' ? `/${name}` : `${dir}/${name}`)

/** Enfants directs d'un dossier. */
export function childrenOf(files: LinuxFiles, dir: string): string[] {
  const prefix = dir === '/' ? '/' : `${dir}/`
  return Object.keys(files)
    .filter((p) => p !== dir && p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
    .sort((a, b) => baseOf(a).localeCompare(baseOf(b)))
}

/** Le chemin et tous ses descendants. */
export const subtree = (files: LinuxFiles, path: string): string[] =>
  Object.keys(files)
    .filter((p) => p === path || p.startsWith(path === '/' ? '/' : `${path}/`))
    .sort()

/** Résolution de chemin à partir d'un dossier courant (., .., ~). */
export function absolutePath(cwd: string, home: string, path: string): string {
  const expanded = path === '~' ? home : path.startsWith('~/') ? `${home}${path.slice(1)}` : path
  const absolute = expanded.startsWith('/') ? expanded : `${cwd.replace(/\/$/, '')}/${expanded}`
  const parts: string[] = []
  for (const part of absolute.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

// ---------------------------------------------------------------------------
// Utilisateurs et groupes (lus dans les fichiers /etc)
// ---------------------------------------------------------------------------

export interface PasswdEntry {
  name: string
  uid: number
  gid: number
  comment: string
  home: string
  shell: string
}
export interface GroupEntry {
  name: string
  gid: number
  members: string[]
}

const dataLines = (text: string) => text.split('\n').filter((l) => l !== '' && !l.startsWith('#'))

export function readPasswd(files: LinuxFiles): PasswdEntry[] {
  return dataLines(files['/etc/passwd']?.content ?? '').flatMap((l) => {
    const f = l.split(':')
    return f.length >= 7
      ? [
          {
            name: f[0] as string,
            uid: Number(f[2]),
            gid: Number(f[3]),
            comment: f[4] as string,
            home: f[5] as string,
            shell: f[6] as string
          }
        ]
      : []
  })
}

export function readGroups(files: LinuxFiles): GroupEntry[] {
  return dataLines(files['/etc/group']?.content ?? '').flatMap((l) => {
    const f = l.split(':')
    return f.length >= 4
      ? [{ name: f[0] as string, gid: Number(f[2]), members: (f[3] as string).split(',').filter(Boolean) }]
      : []
  })
}

export const formatPasswd = (e: PasswdEntry): string =>
  `${e.name}:x:${e.uid}:${e.gid}:${e.comment}:${e.home}:${e.shell}`
export const formatGroup = (g: GroupEntry): string => `${g.name}:x:${g.gid}:${g.members.join(',')}`

/** Identité d'un utilisateur : identifiants, groupe principal et groupes secondaires. */
export interface Identity {
  name: string
  uid: number
  gid: number
  /** Groupe principal en premier, puis les groupes dont l'utilisateur est membre. */
  groups: GroupEntry[]
}

export function identityOf(files: LinuxFiles, user: string): Identity | null {
  const entry = readPasswd(files).find((p) => p.name === user)
  if (!entry) return null
  const all = readGroups(files)
  const primary = all.find((g) => g.gid === entry.gid) ?? {
    name: String(entry.gid),
    gid: entry.gid,
    members: []
  }
  const others = all.filter((g) => g.gid !== entry.gid && g.members.includes(user))
  return { name: user, uid: entry.uid, gid: entry.gid, groups: [primary, ...others] }
}

/** Dossier personnel d'un utilisateur (champ 6 de /etc/passwd). */
export function homeOf(files: LinuxFiles, user: string): string {
  return readPasswd(files).find((p) => p.name === user)?.home ?? (user === 'root' ? '/root' : `/home/${user}`)
}

// ---------------------------------------------------------------------------
// Droits
// ---------------------------------------------------------------------------

/** Droit demandé : r (4), w (2), x (1). */
export type Want = 4 | 2 | 1

/** L'utilisateur a-t-il ce droit sur le nœud ? (root passe, sauf x sur un fichier sans aucun bit x.) */
export function hasPerm(files: LinuxFiles, user: string, node: LinuxNode, want: Want): boolean {
  const id = identityOf(files, user)
  if (!id) return false
  if (id.uid === 0) return want !== 1 || node.type === 'dir' || (node.mode & 0o111) !== 0
  const shift = node.owner === user ? 6 : id.groups.some((g) => g.name === node.group) ? 3 : 0
  return ((node.mode >> shift) & want) !== 0
}

/** Droit x sur chaque dossier traversé pour atteindre `path` (hors dernier élément). */
export function canTraverse(files: LinuxFiles, user: string, path: string): boolean {
  let dir = path
  while (dir !== '/') {
    dir = parentOf(dir)
    const n = files[dir]
    if (n && !hasPerm(files, user, n, 1)) return false
  }
  return true
}

/** Accès r/w/x complet (chemin traversable + droit sur le nœud). */
export function mayAccess(files: LinuxFiles, user: string, path: string, want: Want): boolean {
  const node = files[path]
  return !!node && canTraverse(files, user, path) && hasPerm(files, user, node, want)
}

/** rwxr-xr-x (avec s, S, t, T pour les bits spéciaux). */
export function modeString(mode: number): string {
  const bits = (shift: number, special: boolean, sym: string) => {
    const r = mode & (4 << shift) ? 'r' : '-'
    const w = mode & (2 << shift) ? 'w' : '-'
    const x = mode & (1 << shift)
    const xs = special ? (x ? sym : sym.toUpperCase()) : x ? 'x' : '-'
    return `${r}${w}${xs}`
  }
  return bits(6, !!(mode & 0o4000), 's') + bits(3, !!(mode & 0o2000), 's') + bits(0, !!(mode & 0o1000), 't')
}

/** « Try 'cmd --help' for more information. » après une erreur d'utilisation. */
export function usageError(cmd: string, message: string): CommandFailure {
  return new CommandFailure(`${cmd}: ${message}\nTry '${cmd} --help' for more information.`, 'Usage')
}

/** Option inconnue (getopt) : `cat: invalid option -- 'z'`. */
export function invalidOption(cmd: string, option: string): CommandFailure {
  return usageError(cmd, `invalid option -- '${option}'`)
}

/** Dossier personnel de l'utilisateur de la session. */
export const homeDir = (ctx: ExecContext): string => homeOf(linuxFiles(ctx), bashUser(ctx))

/** Chemin absolu normalisé (., .., ~) à partir du dossier courant de la session. */
export const resolvePath = (ctx: ExecContext, path: string): string =>
  absolutePath(ctx.session.cwd, homeDir(ctx), path)
