/**
 * Comptes et élévation de droits de la console bash (v2.9) : useradd, usermod, groupadd, passwd,
 * id, su et sudo. Les comptes vivent dans /etc/passwd, /etc/group et /etc/shadow (simulés) ; le
 * mot de passe de /etc/shadow n'est PAS haché : un marqueur `$sim$` précède le mot de passe.
 * Messages d'origine de shadow 4.13, sudo 1.9 et util-linux 2.38 (Debian 12, locale C).
 */
import { CommandFailure, type ExecContext } from '../context'
import type { ToolDef } from '../tools/types'
import { unsimulatedOptionMessage } from '../unsimulated'
import { getopt } from './getopt'
import {
  SHADOW_MARK,
  actor,
  bashUser,
  cloneFiles,
  commitFiles,
  epochDays,
  formatGroup,
  formatPasswd,
  identityOf,
  linuxFiles,
  readGroups,
  readPasswd,
  type GroupEntry,
  type LinuxFiles
} from './linuxfs'

const NAME_RE = /^[a-z_][a-z0-9_-]*\$?$/

/** Échec de verrouillage d'un fichier de comptes pour un utilisateur sans droits (message de shadow). */
const lockFailure = (cmd: string, file: string) =>
  new CommandFailure(
    `${cmd}: Permission denied.\n${cmd}: cannot lock ${file}; try again later.`,
    'PermissionDenied'
  )

/** Modifie les lignes d'un fichier de /etc (mtime = horloge du lab). */
function editLines(
  files: LinuxFiles,
  path: string,
  clock: number,
  edit: (lines: string[]) => string[]
): void {
  const node = files[path]
  if (!node) return
  const lines = (node.content ?? '').split('\n').filter((l) => l !== '')
  node.content = edit(lines).join('\n') + '\n'
  node.mtime = clock
}

// ---------------------------------------------------------------------------
// shadow
// ---------------------------------------------------------------------------

const shadowFields = (files: LinuxFiles, user: string): string[] | null => {
  const line = (files['/etc/shadow']?.content ?? '').split('\n').find((l) => l.split(':')[0] === user)
  return line ? line.split(':') : null
}

/** Mot de passe défini par passwd (marqueur simulé) ? Sinon compte verrouillé ou sans mot de passe. */
const hasPassword = (files: LinuxFiles, user: string): boolean =>
  (shadowFields(files, user)?.[1] ?? '').startsWith(SHADOW_MARK)

const passwordOk = (files: LinuxFiles, user: string, password: string): boolean =>
  hasPassword(files, user) && (shadowFields(files, user)?.[1] ?? '') === `${SHADOW_MARK}${password}`

function setShadowHash(files: LinuxFiles, user: string, hash: string, days: number, clock: number): void {
  editLines(files, '/etc/shadow', clock, (lines) =>
    lines.map((l) => {
      const f = l.split(':')
      if (f[0] !== user) return l
      f[1] = hash
      f[2] = String(days)
      return f.join(':')
    })
  )
}

// ---------------------------------------------------------------------------
// useradd, usermod, groupadd
// ---------------------------------------------------------------------------

const nextFree = (used: number[]): number => {
  let n = 1000
  while (used.includes(n)) n++
  return n
}

/** Groupe désigné par son nom ou son identifiant. */
const findGroup = (groups: GroupEntry[], spec: string) =>
  groups.find((g) => g.name === spec) ??
  (/^\d+$/.test(spec) ? groups.find((g) => g.gid === Number(spec)) : undefined)

const useraddTool: ToolDef = {
  name: 'useradd',
  synopsis: 'Crée un compte : sudo useradd -m -s /bin/bash -G sudo,www-data jean.',
  run(ctx, args) {
    const o = getopt('useradd', args, {
      usage: 'Usage: useradd [options] LOGIN',
      flags: 'm',
      args: 'sGgcdu',
      long: {
        'create-home': 'm',
        shell: 's',
        groups: 'G',
        gid: 'g',
        comment: 'c',
        'home-dir': 'd',
        uid: 'u'
      },
      unsimulated: 'bDeEfkKlMNopPrRUZ'
    })
    const login = o.rest[0]
    if (login === undefined)
      throw new CommandFailure(
        'Usage: useradd [options] LOGIN\n       useradd -D\n       useradd -D [options]',
        'Usage'
      )
    const files = linuxFiles(ctx)
    const passwd = readPasswd(files)
    const groups = readGroups(files)
    if (!NAME_RE.test(login) || login.length > 32)
      throw new CommandFailure(`useradd: invalid user name '${login}'`, 'InvalidArgument')
    if (passwd.some((p) => p.name === login))
      throw new CommandFailure(`useradd: user '${login}' already exists`, 'AlreadyExists')
    const primary = o.values['g'] !== undefined ? findGroup(groups, o.values['g']) : undefined
    if (o.values['g'] !== undefined && !primary)
      throw new CommandFailure(`useradd: group '${o.values['g']}' does not exist`, 'NotFound')
    const extra = (o.values['G'] ?? '').split(',').filter(Boolean)
    for (const g of extra)
      if (!findGroup(groups, g)) throw new CommandFailure(`useradd: group '${g}' does not exist`, 'NotFound')
    if (o.values['g'] === undefined && groups.some((g) => g.name === login))
      throw new CommandFailure(
        `useradd: group ${login} exists - if you want to add this user to that group, use -g.`,
        'AlreadyExists'
      )
    let uid = nextFree(passwd.map((p) => p.uid))
    if (o.values['u'] !== undefined) {
      if (!/^\d+$/.test(o.values['u']))
        throw new CommandFailure(`useradd: invalid user ID '${o.values['u']}'`, 'InvalidArgument')
      uid = Number(o.values['u'])
      if (passwd.some((p) => p.uid === uid))
        throw new CommandFailure(`useradd: UID '${uid}' already exists`, 'AlreadyExists')
    }
    if (actor(ctx) !== 'root') throw lockFailure('useradd', '/etc/passwd')
    const gid = primary?.gid ?? nextFree(groups.map((g) => g.gid))
    const home = o.values['d'] ?? `/home/${login}`
    const next = cloneFiles(files)
    const clock = ctx.state.clock
    editLines(next, '/etc/passwd', clock, (l) => [
      ...l,
      formatPasswd({
        name: login,
        uid,
        gid,
        comment: o.values['c'] ?? '',
        home,
        shell: o.values['s'] ?? '/bin/sh'
      })
    ])
    editLines(next, '/etc/group', clock, (l) => [
      ...l.map((line) => {
        const g = groups.find((x) => x.name === line.split(':')[0])
        return g && extra.some((e) => findGroup(groups, e)?.name === g.name)
          ? formatGroup({ ...g, members: [...g.members, login] })
          : line
      }),
      ...(primary ? [] : [formatGroup({ name: login, gid, members: [] })])
    ])
    editLines(next, '/etc/shadow', clock, (l) => [...l, `${login}:!:${epochDays(clock)}:0:99999:7:::`])
    if (o.flags.has('m') && !next[home]) {
      const groupName = primary?.name ?? login
      next[home] = { type: 'dir', mode: 0o755, owner: login, group: groupName, mtime: clock }
    }
    commitFiles(ctx, next)
  }
}

const usermodTool: ToolDef = {
  name: 'usermod',
  synopsis: 'Modifie un compte : sudo usermod -aG sudo jean, usermod -s /bin/bash jean.',
  run(ctx, args) {
    const o = getopt('usermod', args, {
      usage: 'Usage: usermod [options] LOGIN',
      flags: 'a',
      args: 'Ggscd',
      long: { append: 'a', groups: 'G', gid: 'g', shell: 's', comment: 'c', home: 'd' },
      unsimulated: 'eflLmopPuUZ'
    })
    if (o.flags.has('a') && o.values['G'] === undefined)
      throw new CommandFailure(
        'usermod: -a flag is only allowed with the -G flag\nUsage: usermod [options] LOGIN',
        'Usage'
      )
    const login = o.rest[0]
    if (login === undefined) throw new CommandFailure('Usage: usermod [options] LOGIN', 'Usage')
    const files = linuxFiles(ctx)
    const passwd = readPasswd(files)
    const groups = readGroups(files)
    const entry = passwd.find((p) => p.name === login)
    if (!entry) throw new CommandFailure(`usermod: user '${login}' does not exist`, 'NotFound')
    const extra = o.values['G'] !== undefined ? o.values['G'].split(',').filter(Boolean) : null
    for (const g of extra ?? [])
      if (!findGroup(groups, g)) throw new CommandFailure(`usermod: group '${g}' does not exist`, 'NotFound')
    const primary = o.values['g'] !== undefined ? findGroup(groups, o.values['g']) : undefined
    if (o.values['g'] !== undefined && !primary)
      throw new CommandFailure(`usermod: group '${o.values['g']}' does not exist`, 'NotFound')
    if (actor(ctx) !== 'root') throw lockFailure('usermod', '/etc/passwd')
    const next = cloneFiles(files)
    const clock = ctx.state.clock
    editLines(next, '/etc/passwd', clock, (lines) =>
      lines.map((line) =>
        line.split(':')[0] === login
          ? formatPasswd({
              ...entry,
              gid: primary?.gid ?? entry.gid,
              shell: o.values['s'] ?? entry.shell,
              comment: o.values['c'] ?? entry.comment,
              home: o.values['d'] ?? entry.home
            })
          : line
      )
    )
    if (extra) {
      const wanted = new Set(extra.map((g) => findGroup(groups, g)?.name))
      editLines(next, '/etc/group', clock, (lines) =>
        lines.map((line) => {
          const g = groups.find((x) => x.name === line.split(':')[0])
          if (!g) return line
          const has = g.members.includes(login)
          // -a : on ajoute ; sans -a : la liste des groupes secondaires est remplacée
          const members = wanted.has(g.name)
            ? has
              ? g.members
              : [...g.members, login]
            : o.flags.has('a') || !has
              ? g.members
              : g.members.filter((m) => m !== login)
          return formatGroup({ ...g, members })
        })
      )
    }
    commitFiles(ctx, next)
  }
}

const groupaddTool: ToolDef = {
  name: 'groupadd',
  synopsis: 'Crée un groupe : sudo groupadd compta [-g gid].',
  run(ctx, args) {
    const o = getopt('groupadd', args, {
      usage: 'Usage: groupadd [options] GROUP',
      flags: '',
      args: 'g',
      long: { gid: 'g' },
      unsimulated: 'fKOopPrR'
    })
    const name = o.rest[0]
    if (name === undefined) throw new CommandFailure('Usage: groupadd [options] GROUP', 'Usage')
    const files = linuxFiles(ctx)
    const groups = readGroups(files)
    if (!NAME_RE.test(name) || name.length > 32)
      throw new CommandFailure(`groupadd: '${name}' is not a valid group name`, 'InvalidArgument')
    if (groups.some((g) => g.name === name))
      throw new CommandFailure(`groupadd: group '${name}' already exists`, 'AlreadyExists')
    let gid = nextFree(groups.map((g) => g.gid))
    if (o.values['g'] !== undefined) {
      if (!/^\d+$/.test(o.values['g']))
        throw new CommandFailure(`groupadd: invalid group ID '${o.values['g']}'`, 'InvalidArgument')
      gid = Number(o.values['g'])
      if (groups.some((g) => g.gid === gid))
        throw new CommandFailure(`groupadd: GID '${gid}' already exists`, 'AlreadyExists')
    }
    if (actor(ctx) !== 'root') throw lockFailure('groupadd', '/etc/group')
    const next = cloneFiles(files)
    editLines(next, '/etc/group', ctx.state.clock, (l) => [...l, formatGroup({ name, gid, members: [] })])
    commitFiles(ctx, next)
  }
}

// ---------------------------------------------------------------------------
// passwd
// ---------------------------------------------------------------------------

const passwdTool: ToolDef = {
  name: 'passwd',
  synopsis: 'Change un mot de passe : passwd (le sien), sudo passwd jean.',
  run(ctx, args) {
    const o = getopt('passwd', args, {
      usage: 'Usage: passwd [options] [LOGIN]',
      flags: '',
      unsimulated: 'adeiklnqrSuwx'
    })
    const me = bashUser(ctx)
    const root = actor(ctx) === 'root'
    const target = o.rest[0] ?? (ctx.root ? 'root' : me)
    const files = linuxFiles(ctx)
    if (target !== me && !root)
      throw new CommandFailure(
        `passwd: You may not view or modify password information for ${target}.`,
        'PermissionDenied'
      )
    if (!readPasswd(files).some((p) => p.name === target))
      throw new CommandFailure(`passwd: user '${target}' does not exist`, 'NotFound')
    // Un utilisateur qui change son propre mot de passe doit d'abord saisir l'actuel
    if (!root) {
      ctx.write(`Changing password for ${target}.`)
      if (hasPassword(files, target) && !passwordOk(files, target, ctx.ask('Current password: ', true)))
        throw new CommandFailure(
          'passwd: Authentication token manipulation error\npasswd: password unchanged',
          'AuthenticationFailure'
        )
    }
    const first = ctx.ask('New password: ', true)
    if (first === '')
      throw new CommandFailure(
        'No password has been supplied.\npasswd: Authentication token manipulation error\npasswd: password unchanged',
        'AuthenticationFailure'
      )
    const second = ctx.ask('Retype new password: ', true)
    if (first !== second)
      throw new CommandFailure(
        'Sorry, passwords do not match.\npasswd: Authentication token manipulation error\npasswd: password unchanged',
        'AuthenticationFailure'
      )
    const next = cloneFiles(files)
    setShadowHash(next, target, `${SHADOW_MARK}${first}`, epochDays(ctx.state.clock), ctx.state.clock)
    commitFiles(ctx, next)
    ctx.write('passwd: password updated successfully')
  }
}

// ---------------------------------------------------------------------------
// id
// ---------------------------------------------------------------------------

/**
 * id : identité d'un compte local (id, id -un, id -Gn, id jean). L'outil `id` est déclaré par le
 * module adds, qui y renvoie pour les comptes locaux et traite seul les comptes du domaine (jean@lab.local).
 */
export function runId(ctx: ExecContext, args: string[]): void {
  const o = getopt('id', args, {
    flags: 'ugGnr',
    long: { user: 'u', group: 'g', groups: 'G', name: 'n', real: 'r' },
    unsimulated: 'aZz'
  })
  const files = linuxFiles(ctx)
  const login = o.rest[0] ?? actor(ctx)
  const id = identityOf(files, login)
  if (!id) throw new CommandFailure(`id: '${login}': no such user`, 'NotFound')
  const only = [...'ugG'].filter((f) => o.flags.has(f))
  if (only.length > 1) throw new CommandFailure('id: cannot print "only" of more than one choice', 'Usage')
  if (only.length === 0 && (o.flags.has('n') || o.flags.has('r')))
    throw new CommandFailure('id: cannot print only names or real IDs in default format', 'Usage')
  const names = o.flags.has('n')
  const primary = id.groups[0]
  if (only[0] === 'u') return ctx.write(names ? id.name : String(id.uid))
  if (only[0] === 'g') return ctx.write(names ? (primary?.name ?? '') : String(id.gid))
  if (only[0] === 'G') return ctx.write(id.groups.map((g) => (names ? g.name : String(g.gid))).join(' '))
  ctx.write(
    `uid=${id.uid}(${id.name}) gid=${id.gid}(${primary?.name ?? id.gid}) groups=${id.groups.map((g) => `${g.gid}(${g.name})`).join(',')}`
  )
}

// ---------------------------------------------------------------------------
// su, sudo
// ---------------------------------------------------------------------------

interface SuFrame {
  user: string
  cwd: string
}

const suStack = (ctx: ExecContext): SuFrame[] => {
  const raw = ctx.session.variables['SU_STACK']
  try {
    return typeof raw === 'string' ? (JSON.parse(raw) as SuFrame[]) : []
  } catch {
    return []
  }
}

/** Passe dans la session d'un autre utilisateur (la pile permet à `exit` de revenir). */
function switchUser(ctx: ExecContext, target: string, cwd: string): void {
  const stack = [...suStack(ctx), { user: bashUser(ctx), cwd: ctx.session.cwd }]
  ctx.session = {
    ...ctx.session,
    cwd,
    variables: { ...ctx.session.variables, USER: target, SU_STACK: JSON.stringify(stack) }
  }
}

/** `exit` dans une session ouverte par su : revient à l'utilisateur précédent ; faux s'il n'y en a pas. */
export function leaveSu(ctx: ExecContext): boolean {
  const stack = suStack(ctx)
  const previous = stack.pop()
  if (!previous) return false
  ctx.session = {
    ...ctx.session,
    cwd: previous.cwd,
    variables: { ...ctx.session.variables, USER: previous.user, SU_STACK: JSON.stringify(stack) }
  }
  return true
}

const suTool: ToolDef = {
  name: 'su',
  synopsis: 'Change d’utilisateur : su - jean, sudo su.',
  run(ctx, args) {
    const o = getopt('su', args, { flags: 'l', long: { login: 'l' }, unsimulated: 'cmpsgGwP' })
    const login = o.flags.has('l') || o.rest.includes('-')
    const target = o.rest.find((a) => a !== '-') ?? 'root'
    const files = linuxFiles(ctx)
    const entry = readPasswd(files).find((p) => p.name === target)
    if (!entry)
      throw new CommandFailure(
        `su: user ${target} does not exist or the user entry does not contain all the required fields`,
        'NotFound'
      )
    // root (ou sudo) ne saisit pas de mot de passe ; sinon celui du compte visé
    if (actor(ctx) !== 'root' && !passwordOk(files, target, ctx.ask('Password: ', true)))
      throw new CommandFailure('su: Authentication failure', 'AuthenticationFailure')
    if (entry.shell.endsWith('/nologin') || entry.shell.endsWith('/false')) {
      ctx.write('This account is currently not available.')
      return
    }
    let cwd = ctx.session.cwd
    if (login) {
      if (files[entry.home]?.type === 'dir') cwd = entry.home
      else
        ctx.write(`su: warning: cannot change directory to ${entry.home}: No such file or directory`, 'error')
    }
    switchUser(ctx, target, cwd)
  }
}

interface SudoRule {
  noPassword: boolean
}

/** Règle de /etc/sudoers qui s'applique à l'utilisateur (nom ou %groupe), commandes ALL uniquement. */
function sudoRule(files: LinuxFiles, user: string): SudoRule | null {
  const id = identityOf(files, user)
  const groups = id?.groups.map((g) => g.name) ?? []
  let found = false
  let noPassword = false
  for (const raw of (files['/etc/sudoers']?.content ?? '').split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const [who = '', ...spec] = line.split(/\s+/)
    const rule = spec.join(' ')
    if (!/^ALL\s*=.*\bALL$/.test(rule)) continue
    const applies = who === 'ALL' || who === user || (who.startsWith('%') && groups.includes(who.slice(1)))
    if (applies) {
      found = true
      noPassword ||= /NOPASSWD:/.test(rule)
    }
  }
  return found ? { noPassword } : null
}

const SUDO_CACHE_MS = 15 * 60 * 1000
const SUDO_LETTERS = 'AbCDEeghHiKklnPpRrSsTtUuVvw'

/**
 * Préfixe `sudo` : vérifie la règle /etc/sudoers (groupe sudo) et le mot de passe, passe en root pour
 * la commande et renvoie la commande à exécuter (null si rien à exécuter).
 */
export function sudoPrefix(ctx: ExecContext, rest: string[]): string[] | null {
  const user = bashUser(ctx)
  let command = rest
  let login: string[] | null = null
  while (command[0]?.startsWith('-') && command[0] !== '--' && command[0].length > 1) {
    const letter = command[0][1] as string
    if (letter === 'i' || letter === 's') login = letter === 'i' ? ['su', '-'] : ['su']
    else if (letter === 'k' || letter === 'K') {
      // sudo -k / -K : oublie le mot de passe retenu ; sans commande, rien d'autre à faire
      const { [`SUDO_TS_${user}`]: _forgotten, ...kept } = ctx.session.variables
      void _forgotten
      ctx.session = { ...ctx.session, variables: kept }
      if (command.length === 1) return null
    } else if (SUDO_LETTERS.includes(letter))
      throw new CommandFailure(unsimulatedOptionMessage('sudo', `-${letter}`), 'NotSupported')
    else
      throw new CommandFailure(`sudo: invalid option -- '${letter}'\nusage: sudo -h | -K | -k | -V`, 'Usage')
    command = command.slice(1)
  }
  if (command[0] === '--') command = command.slice(1)
  if (command.length === 0 && !login) throw new CommandFailure('usage: sudo -h | -K | -k | -V', 'Usage')
  if (user !== 'root') {
    const files = linuxFiles(ctx)
    const rule = sudoRule(files, user)
    const cached = (() => {
      const ts = ctx.session.variables[`SUDO_TS_${user}`]
      return typeof ts === 'string' && ctx.state.clock - Number(ts) < SUDO_CACHE_MS
    })()
    // Compte avec mot de passe défini : sudo le demande (3 essais), sauf NOPASSWD ou jeton récent
    if (hasPassword(files, user) && !rule?.noPassword && !cached) {
      let ok = false
      for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
        ok = passwordOk(files, user, ctx.ask(`[sudo] password for ${user}: `, true))
        if (!ok && attempt < 3) ctx.write('Sorry, try again.', 'error')
      }
      if (!ok) throw new CommandFailure('sudo: 3 incorrect password attempts', 'AuthenticationFailure')
    }
    if (!rule)
      throw new CommandFailure(
        `${user} is not in the sudoers file.  This incident will be reported.`,
        'PermissionDenied'
      )
    ctx.session = {
      ...ctx.session,
      variables: { ...ctx.session.variables, [`SUDO_TS_${user}`]: String(ctx.state.clock) }
    }
  }
  ctx.root = true
  return login ?? command
}

export const accountTools: ToolDef[] = [useraddTool, usermodTool, groupaddTool, passwdTool, suTool]
