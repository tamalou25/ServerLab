/**
 * Administration de Samba d'une console bash (v2.9, #239) : `testparm`, `smbpasswd`, `pdbedit` et
 * `smbstatus`, d'après les sources de Samba 4.17.12 (Debian bookworm) : source3/utils/testparm.c,
 * smbpasswd.c, pdbedit.c, status.c et source3/passdb/passdb.c (local_password_change). Mêmes messages
 * (docs/captures/bash/*.txt, docs/fidelite.md L-80 à L-89).
 *
 * La base des utilisateurs Samba est un fichier texte simulé (voir services/linuxsamba.ts) ; aucun
 * mot de passe n'est haché, aucun mot de passe réel n'est manipulé.
 */
import { LAB_EPOCH_MS } from '../../core/clock'
import type { LabState, ServerDevice } from '../../model/schema'
import { effectiveIpv4 } from '../../net/addressing'
import { findUnit } from '../../services/linuxcatalog'
import { fileText } from '../../services/linuxconfig'
import { isInstalled } from '../../services/linuxpackages'
import {
  PASSDB,
  SMB_CONF,
  dumpConf,
  formatPassdb,
  globalChecks,
  hostSambaVersion,
  loadSmbConf,
  serverRole,
  singleParameter,
  findShare,
  type SamUser
} from '../../services/linuxsamba'
import { unitPid, unitStatus } from '../../services/linuxsystem'
import { CommandFailure, type ExecContext } from '../context'
import type { ToolDef } from '../tools/types'
import { unsimulatedOptionMessage } from '../unsimulated'
import { ctimeDate } from './interpreter'
import { cloneFiles, commitFiles, identityOf, readGroups, readPasswd } from './linuxfs'
import { sambaServerOf, type SambaServer } from './sambaaccess'

const installed = (ctx: ExecContext) => isInstalled(ctx.host, 'samba')

// ---------------------------------------------------------------------------------------------
// testparm
// ---------------------------------------------------------------------------------------------

const testparmTool: ToolDef = {
  name: 'testparm',
  synopsis: 'Contrôle smb.conf (testparm -s, --parameter-name=, --section-name=).',
  switches: ['-s', '--suppress-prompt', '--parameter-name=', '--section-name='],
  available: installed,
  run(ctx, args) {
    let silent = false
    let parameter: string | null = null
    let section: string | null = null
    const positional: string[] = []
    for (const a of args) {
      if (a === '-s' || a === '--suppress-prompt') silent = true
      else if (a.startsWith('--parameter-name=')) parameter = a.slice(17)
      else if (a.startsWith('--section-name=')) section = a.slice(15)
      else if (a.startsWith('-'))
        throw new CommandFailure(unsimulatedOptionMessage('testparm', a), 'NotSupported')
      else positional.push(a)
    }
    if (positional.length > 1)
      throw new CommandFailure(
        'testparm avec un nom de machine et une adresse (contrôle hosts allow / hosts deny) n’est pas simulé dans ServerLab.',
        'NotSupported'
      )
    const srv = sambaServerOf(ctx.host)
    const path = positional[0] ?? SMB_CONF
    ctx.write(`Load smb config files from ${path}`, 'error')
    const text = fileText(ctx.host.host.linux?.files, path)
    if (text === null) throw new CommandFailure('Error loading services.', 'ParseError')
    const loaded = loadSmbConf(text)
    ctx.writeLines(loaded.stderr, 'error')
    if (!loaded.ok) throw new CommandFailure('Error loading services.', 'ParseError')
    ctx.write('Loaded services file OK.', 'error')
    ctx.write('Weak crypto is allowed by GnuTLS (e.g. NTLM as a compatibility fallback)', 'error')
    ctx.writeLines(globalChecks(loaded.conf, srv.cctx), 'error')
    if (section === null && parameter === null)
      ctx.writeLines([`Server role: ${serverRole(loaded.conf, srv.cctx)}`, ''], 'error')
    if (!silent) {
      ctx.write('Press enter to see a dump of your service definitions', 'error')
      ctx.ask('', false)
    }
    if (section !== null || parameter !== null) {
      const isGlobal = section === null || section.toLowerCase() === 'global'
      const target = isGlobal ? loaded.conf.global : findShare(loaded.conf, section as string)
      if (!target) throw new CommandFailure(`Unknown section ${section}`, 'NotFound')
      if (parameter !== null) {
        const value = singleParameter(loaded.conf, srv.cctx, target, parameter)
        if (value === null)
          throw new CommandFailure(
            `Parameter ${parameter} unknown for section ${section ?? 'global'}`,
            'NotFound'
          )
        ctx.write(value)
        return
      }
      throw new CommandFailure(
        'testparm --section-name sans --parameter-name n’est pas simulé dans ServerLab : utilisez testparm -s.',
        'NotSupported'
      )
    }
    const dump = dumpConf(loaded.conf, srv.cctx)
    ctx.writeLines(dump.lines)
    for (const name of dump.unmodeled)
      ctx.warn(
        `le paramètre « ${name} » est valide mais non modélisé : sa valeur est recopiée telle que saisie.`
      )
  }
}

// ---------------------------------------------------------------------------------------------
// smbpasswd
// ---------------------------------------------------------------------------------------------

const SMBPASSWD_USAGE = [
  'When run by root:',
  '    smbpasswd [options] [username]',
  'otherwise:',
  '    smbpasswd [options]',
  '',
  'options:',
  '  -L                   local mode (must be first option)',
  '  -h                   print this usage message',
  '  -s                   use stdin for password prompt',
  '  -c smb.conf file     Use the given path to the smb.conf file',
  '  -D LEVEL             debug level',
  '  -r MACHINE           remote machine',
  '  -U USER              remote username (e.g. SAM/user)',
  '',
  'extra options when run by root or in local mode:',
  '  -a                   add user',
  '  -d                   disable user',
  '  -e                   enable user',
  '  -i                   interdomain trust account',
  '  -m                   machine trust account',
  '  -n                   set no password',
  '  -W                   use stdin ldap admin password',
  '  -w PASSWORD          ldap admin password',
  '  -x                   delete user',
  '  -R ORDER             name resolve order',
  ''
]

/** Enregistre la base des utilisateurs Samba modifiée. */
function savePassdb(ctx: ExecContext, users: SamUser[]): void {
  const files = cloneFiles(sambaServerOf(ctx.host).files)
  const old = files[PASSDB]
  files[PASSDB] = {
    type: 'file',
    mode: old?.mode ?? 0o600,
    owner: 'root',
    group: 'root',
    mtime: ctx.state.clock,
    content: formatPassdb(users)
  }
  commitFiles(ctx, files)
}

const smbpasswdTool: ToolDef = {
  name: 'smbpasswd',
  synopsis: 'Gère les comptes Samba (sudo smbpasswd -a utilisateur, -x, -d, -e, -n).',
  switches: ['-a', '-x', '-d', '-e', '-n', '-s'],
  available: installed,
  run(ctx, args) {
    let add = false
    let del = false
    let disable = false
    let enable = false
    let nopass = false
    let stdinMode = false
    const operands: string[] = []
    for (const a of args) {
      if (a.startsWith('-') && a.length > 1) {
        for (const ch of a.slice(1)) {
          if (ch === 'a') add = true
          else if (ch === 'x') del = true
          else if (ch === 'd') disable = true
          else if (ch === 'e') enable = true
          else if (ch === 'n') nopass = true
          else if (ch === 's') stdinMode = true
          else if (ch === 'L') continue
          else if ('rUcDwRmiWj'.includes(ch))
            throw new CommandFailure(unsimulatedOptionMessage('smbpasswd', `-${ch}`), 'NotSupported')
          else return ctx.writeLines(SMBPASSWD_USAGE)
        }
      } else operands.push(a)
    }
    void stdinMode
    if (!ctx.root) {
      if (add || del || disable || enable || nopass || operands.length > 0)
        return ctx.writeLines(SMBPASSWD_USAGE)
      throw new CommandFailure(
        'smbpasswd sans privilèges (changement du mot de passe de son propre compte via smbd) n’est pas simulé dans ServerLab : utilisez sudo smbpasswd utilisateur.',
        'NotSupported'
      )
    }
    if (operands.length > 1) return ctx.writeLines(SMBPASSWD_USAGE)
    const name = operands[0] ?? 'root'
    const setPassword = !del && !disable && !enable && !nopass
    let password = ''
    if (setPassword) {
      password = ctx.ask('New SMB password:', true)
      if (ctx.ask('Retype new SMB password:', true) !== password) {
        ctx.write('Mismatch - password unchanged.', 'error')
        throw new CommandFailure('Unable to get new password.', 'Mismatch')
      }
    }
    const srv = sambaServerOf(ctx.host)
    const users = [...srv.users]
    const index = users.findIndex((u) => u.name === name)
    const exists = index >= 0
    const fail = (message: string): never => {
      throw new CommandFailure(message, 'SmbPasswd')
    }
    if (exists && del) {
      users.splice(index, 1)
      savePassdb(ctx, users)
      ctx.write(`Deleted user ${name}.`)
      return
    }
    if (!exists && !add) fail(`Failed to find entry for user ${name}.`)
    let user = users[index]
    if (!exists) {
      const unix = readPasswd(srv.files).find((p) => p.name === name)
      if (!unix) fail(`Failed to add entry for user ${name}.`)
      user = { name, uid: unix!.uid, flags: 'U', password: '' }
      users.push(user)
    }
    const u = user as SamUser
    if (nopass && !u.flags.includes('N')) u.flags += 'N'
    if (setPassword) {
      u.flags = u.flags.replace('N', '')
      u.password = password
    }
    if (disable && !u.flags.includes('D')) u.flags += 'D'
    if (enable) u.flags = u.flags.replace('D', '')
    savePassdb(ctx, users)
    if (!exists) ctx.write(`Added user ${name}.`)
    else if (disable) ctx.write(`Disabled user ${name}.`)
    else if (enable) ctx.write(`Enabled user ${name}.`)
    else if (nopass) ctx.write(`User ${name} password set to none.`)
  }
}

// ---------------------------------------------------------------------------------------------
// pdbedit
// ---------------------------------------------------------------------------------------------

/** Nom complet affiché : GECOS entier, ou la partie avant la première virgule s'il y en a trois (passdb.c). */
function fullName(comment: string): string {
  return (comment.match(/,/g) ?? []).length === 3 ? comment.slice(0, comment.indexOf(',')) : comment
}

const pdbeditTool: ToolDef = {
  name: 'pdbedit',
  synopsis:
    'Liste ou supprime les comptes Samba (sudo pdbedit -L, pdbedit -L -u compte, pdbedit -x -u compte).',
  switches: ['-L', '-u', '-x'],
  available: installed,
  run(ctx, args) {
    let list = false
    let del = false
    let user: string | null = null
    for (let i = 0; i < args.length; i++) {
      const a = args[i] as string
      if (a === '-L' || a === '--list') list = true
      else if (a === '-x' || a === '--delete') del = true
      else if (a === '-u' || a === '--user') user = args[++i] ?? null
      else if (a.startsWith('--user=')) user = a.slice(7)
      else throw new CommandFailure(unsimulatedOptionMessage('pdbedit', a), 'NotSupported')
    }
    if (!ctx.root) {
      ctx.write(`tdbsam_open: Failed to open/create TDB passwd [${PASSDB}]`, 'error')
      throw new CommandFailure("Can't initialize passdb backend.", 'AccessDenied')
    }
    const srv = sambaServerOf(ctx.host)
    if (del) {
      if (user === null) throw new CommandFailure('Username not specified! (use -u option)', 'Usage')
      const rest = srv.users.filter((u) => u.name !== user)
      if (rest.length === srv.users.length)
        throw new CommandFailure(`user ${user} does not exist in the passdb`, 'NotFound')
      savePassdb(ctx, rest)
      return
    }
    if (!list && user === null)
      throw new CommandFailure(
        'pdbedit sans -L, -u ou -x (création, modification, export) n’est pas simulé dans ServerLab : utilisez smbpasswd -a pour ajouter un compte.',
        'NotSupported'
      )
    const passwd = readPasswd(srv.files)
    const row = (u: SamUser) =>
      `${u.name}:${passwd.find((p) => p.name === u.name)?.uid ?? u.uid}:${fullName(passwd.find((p) => p.name === u.name)?.comment ?? '')}`
    if (user !== null) {
      const found = srv.users.find((u) => u.name === user)
      if (!found) throw new CommandFailure('Username not found!', 'NotFound')
      ctx.write(row(found))
      return
    }
    ctx.writeLines([...srv.users].sort((a, b) => (a.name < b.name ? -1 : 1)).map(row))
  }
}

// ---------------------------------------------------------------------------------------------
// smbstatus
// ---------------------------------------------------------------------------------------------

export interface SmbSession {
  client: string
  clientIp: string
  user: string
  since: number
  shares: string[]
}

/** Sessions SMB ouvertes vers ce serveur : connexions mémorisées par les postes clients (smbLogins). */
export function sambaSessions(state: LabState, server: ServerDevice): SmbSession[] {
  const out: SmbSession[] = []
  for (const d of Object.values(state.devices)) {
    if ((d.kind !== 'server' && d.kind !== 'client') || d.id === server.id || !d.powered) continue
    for (const login of d.host.linux?.smbLogins ?? []) {
      if (login.server !== server.name.toLowerCase()) continue
      const ip = d.interfaces.map((i) => effectiveIpv4(i)?.address).find((a) => !!a)
      out.push({
        client: d.name,
        clientIp: ip ?? '0.0.0.0',
        user: login.user,
        since: login.time,
        shares: login.shares
      })
    }
  }
  return out.sort((a, b) => a.since - b.since)
}

const timestring = (srv: SambaServer, clock: number) =>
  `${ctimeDate(clock + (srv.host.host.clockOffsetSeconds ?? 0) * 1000, LAB_EPOCH_MS)} UTC`

const smbstatusTool: ToolDef = {
  name: 'smbstatus',
  synopsis: 'Connexions Samba en cours (sudo smbstatus, -p processus, -S partages).',
  switches: ['-p', '-S', '-b', '-L'],
  available: installed,
  run(ctx, args) {
    let procs = false
    let shares = false
    let locks = false
    let brief = false
    for (const a of args) {
      if (a === '-p' || a === '--processes') procs = true
      else if (a === '-S' || a === '--shares') shares = true
      else if (a === '-L' || a === '--locks') locks = true
      else if (a === '-b' || a === '--brief') brief = true
      else throw new CommandFailure(unsimulatedOptionMessage('smbstatus', a), 'NotSupported')
    }
    if (!ctx.root) throw new CommandFailure('smbstatus only works as root!', 'AccessDenied')
    const srv = sambaServerOf(ctx.host)
    const server = ctx.host as ServerDevice
    const unit = findUnit('smbd')
    const running = !!unit && unitStatus(ctx.host, unit).active
    const sessions = running ? sambaSessions(ctx.state, server) : []
    const showProcs = !(shares || locks) || procs
    const showLocks = !(shares || procs) || locks
    const showShares = !(procs || locks) || shares
    const passwd = readPasswd(srv.files)
    if (showProcs) {
      ctx.writeLines([
        '',
        `Samba version ${hostSambaVersion(ctx.host)}`,
        `${'PID'.padEnd(7)} ${'Username'.padEnd(12)} ${'Group'.padEnd(12)} ${'Machine'.padEnd(41)} ${'Protocol Version'.padEnd(17)} ${'Encryption'.padEnd(20)} ${'Signing'.padEnd(21)}`,
        '-'.repeat(136)
      ])
      const base = unit ? unitPid(ctx.host, unit) : 0
      sessions.forEach((s, i) => {
        const id = identityOf(srv.files, s.user)
        const uid = passwd.find((p) => p.name === s.user)
        const group =
          id?.groups[0]?.name ?? readGroups(srv.files).find((g) => g.gid === uid?.gid)?.name ?? '-1'
        const machine = `${s.clientIp} (ipv4:${s.clientIp}:${49152 + ((s.since / 1000 + i * 13) % 16000)})`
        ctx.write(
          `${String(base + 11 + i * 7).padEnd(7)} ${`${s.user.padEnd(12)} ${group.padEnd(12)}`.padEnd(25)} ${machine.padEnd(41)} ${'SMB3_11'.padEnd(17)} ${'-'.padEnd(20)} ${'partial(AES-128-CMAC)'.padEnd(21)}`
        )
      })
      if (procs) return
    }
    if (showShares) {
      if (brief) return
      ctx.writeLines([
        '',
        `${'Service'.padEnd(12)} ${'pid'.padEnd(7)} ${'Machine'.padEnd(13)} ${'Connected at'.padEnd(32)} ${'Encryption'.padEnd(12)} ${'Signing'.padEnd(12)}`,
        '-'.repeat(93)
      ])
      const base = unit ? unitPid(ctx.host, unit) : 0
      sessions.forEach((s, i) => {
        for (const share of s.shares)
          ctx.write(
            `${share.padEnd(12)} ${String(base + 11 + i * 7).padEnd(7)} ${s.clientIp.padEnd(13)} ${timestring(srv, s.since).padEnd(32)} ${'-'.padEnd(12)} ${'-'.padEnd(12)}`
          )
      })
      ctx.write('')
      if (shares) return
    }
    if (showLocks) {
      if (!running) {
        ctx.write('/run/samba/locking.tdb not initialised', 'error')
        ctx.write('This is normal if an SMB client has never connected to your server.', 'error')
        return
      }
      ctx.write('No locked files', 'error')
      ctx.write('')
    }
  }
}

export const sambaBashTools: ToolDef[] = [testparmTool, smbpasswdTool, pdbeditTool, smbstatusTool]
