/**
 * Client SSH simulé (v2.9, #237) : `ssh`, `ssh-keygen` et `ssh-copy-id` d'une console bash, `ssh` des
 * consoles Windows (OpenSSH client intégré). Messages d'OpenSSH 9.2p1 (Debian 12), locale C, repris des
 * sources (`ssh.c`, `sshconnect.c`, `sshconnect2.c`, `ssh-keygen.c`, script `ssh-copy-id`).
 *
 * Une connexion réussit ou est refusée d'après l'état du serveur joint : réseau joignable, sshd démarré
 * et à l'écoute du port, adresse non bannie par fail2ban, clé d'hôte acceptée, puis authentification
 * selon `sshd_config` EN VIGUEUR (PermitRootLogin, PasswordAuthentication, PubkeyAuthentication) et les
 * comptes du serveur (/etc/passwd, /etc/shadow, ~/.ssh/authorized_keys). Chaque tentative est journalisée
 * dans /var/log/auth.log du serveur (services/linuxlog.ts) ; fail2ban compte les échecs.
 *
 * Une session interactive n'est pas simulée (console de lignes) : on exécute une commande distante
 * (`ssh utilisateur@hôte commande`). La saisie des mots de passe est faite par l'élève, jamais devinée.
 */
import { effectiveIpv4 } from '../../net/addressing'
import { ping } from '../../net/diagnostics'
import { isIpv4 } from '../../net/ipv4'
import { isLinuxHost } from '../../model/host'
import type { HostDevice } from '../../model/schema'
import { firstAddress, resolveName } from '../../roles/dns/resolver'
import { sourceAddressFor } from '../../sim/forward'
import { parseSshd, runningConfigText } from '../../services/linuxconfig'
import { isBanned } from '../../services/linuxfail2ban'
import { writeLogs, type LogLine } from '../../services/linuxlog'
import { installedUnits, linuxRelease, linuxSockets, unitPid } from '../../services/linuxsystem'
import {
  PRIVATE_KEY_BODY,
  addKnownHost,
  fingerprint,
  hostKeyOf,
  makeKey,
  parsePublicLine,
  publicLine,
  randomart,
  type KeyType,
  type SimKey
} from '../../services/linuxssh'
import { CommandFailure, type ExecContext } from '../context'
import { createShellSession, executeLine } from '../exec'
import type { ToolDef } from '../tools/types'
import { unsimulatedOptionMessage } from '../unsimulated'
import { hasPassword, passwordOk } from './accounts'
import { primaryGroup } from './filetools'
import {
  bashUser,
  cloneFiles,
  commitFiles,
  commitFilesOf,
  contentOf,
  homeDir,
  homeOf,
  hostFiles,
  linuxFiles,
  mayAccess,
  readPasswd,
  resolvePath,
  type LinuxFiles
} from './linuxfs'

export type Platform = 'linux' | 'windows'

const SSH_USAGE = [
  'usage: ssh [-46AaCfGgKkMNnqsTtVvXxYy] [-B bind_interface]',
  '           [-b bind_address] [-c cipher_spec] [-D [bind_address:]port]',
  '           [-E log_file] [-e escape_char] [-F configfile] [-I pkcs11]',
  '           [-i identity_file] [-J [user@]host[:port]] [-L address]',
  '           [-l login_name] [-m mac_spec] [-O ctl_cmd] [-o option] [-p port]',
  '           [-Q query_option] [-R address] [-S ctl_path] [-W host:port]',
  '           [-w local_tun[:remote_tun]] destination [command [argument ...]]'
]

/** Demande de connexion SSH (arguments déjà analysés). */
export interface SshRequest {
  platform: Platform
  /** Compte sur le serveur. */
  user: string
  /** Nom ou adresse tels que tapés (ils servent aussi de clé de known_hosts). */
  host: string
  port: number
  /** Fichier d'identité demandé (-i). */
  identity: string | null
  /** StrictHostKeyChecking=no : la clé d'hôte est acceptée sans question. */
  acceptHostKey: boolean
  /** PreferredAuthentications=publickey (sonde de ssh-copy-id) : pas de mot de passe. */
  publickeyOnly: boolean
  /** Messages d'erreur et avertissements retenus au lieu d'être affichés (sortie redirigée par ssh-copy-id). */
  quiet: boolean
}

/** Connexion établie. */
export interface SshConnection {
  target: HostDevice
  user: string
  ip: string
  method: 'password' | 'publickey'
  pid: number
  port: number
}

export type SshOutcome =
  { ok: true; conn: SshConnection } | { ok: false; reason: 'network' | 'hostkey' | 'denied'; lines: string[] }

// ---------------------------------------------------------------------------------------------
// Identités du client
// ---------------------------------------------------------------------------------------------

const DEFAULT_IDENTITIES = [
  'id_rsa',
  'id_ecdsa',
  'id_ecdsa_sk',
  'id_ed25519',
  'id_ed25519_sk',
  'id_xmss',
  'id_dsa'
]

interface Identity {
  path: string
  key: SimKey
}

/** Paires de clés du client (fichier privé lisible + .pub valide) ; avertissement si -i est introuvable. */
function clientIdentities(ctx: ExecContext, req: SshRequest, warn: (line: string) => void): Identity[] {
  if (req.platform === 'windows') return []
  const files = linuxFiles(ctx)
  const user = bashUser(ctx)
  const paths = req.identity
    ? [resolvePath(ctx, req.identity)]
    : DEFAULT_IDENTITIES.map((n) => `${homeDir(ctx)}/.ssh/${n}`)
  const found: Identity[] = []
  for (const path of paths) {
    const priv = files[path]
    if (priv?.type !== 'file') {
      if (req.identity)
        warn(`Warning: Identity file ${req.identity} not accessible: No such file or directory.`)
      continue
    }
    if (!mayAccess(files, user, path, 4)) continue
    const pub = files[`${path}.pub`]
    const key = pub?.type === 'file' ? parsePublicLine(contentOf(ctx, `${path}.pub`, pub)) : null
    if (key) found.push({ path, key })
  }
  return found
}

/** ~/.ssh/authorized_keys de l'utilisateur contient-il cette clé ? */
function authorizes(files: LinuxFiles, user: string, key: SimKey): boolean {
  const node = files[`${homeOf(files, user)}/.ssh/authorized_keys`]
  return (
    node?.type === 'file' &&
    (node.content ?? '').split('\n').some((line) => parsePublicLine(line)?.blob === key.blob)
  )
}

// ---------------------------------------------------------------------------------------------
// Connexion
// ---------------------------------------------------------------------------------------------

/** Adresse IPv4 de la machine dans le lab ; la machine locale se joint aussi par 127.0.0.1 et son nom. */
function locate(
  ctx: ExecContext,
  host: string
): { ip: string; target?: HostDevice; local: boolean } | { error: string } {
  const here = ctx.host
  const own = here.interfaces.map((i) => effectiveIpv4(i)?.address).filter((a): a is string => !!a)
  if (host === 'localhost' || host === '127.0.0.1' || host.toLowerCase() === here.name.toLowerCase())
    return { ip: '127.0.0.1', target: here, local: true }
  if (own.includes(host)) return { ip: host, target: here, local: true }
  let ip = host
  if (!isIpv4(host)) {
    const r = resolveName(ctx.state, ctx.deviceId, host)
    ctx.addTrace(r.trace)
    const found = firstAddress(r)
    if (!found) return { error: 'name' }
    ip = found
  }
  const target = Object.values(ctx.state.devices).find(
    (d): d is HostDevice =>
      (d.kind === 'server' || d.kind === 'client') &&
      d.powered &&
      d.interfaces.some((i) => effectiveIpv4(i)?.address === ip)
  )
  return target ? { ip, target, local: false } : { ip, local: false }
}

/** Pourquoi une adresse sans machine ne répond pas : réseau inaccessible ou délai dépassé. */
function silence(ctx: ExecContext, ip: string): string {
  const r = ping(ctx.state, ctx.deviceId, ip, { count: 1, size: 56 })
  return r.ok && r.value.outcomes.every((o) => o.kind === 'transmit-failed')
    ? 'Network is unreachable'
    : 'Connection timed out'
}

/** Le texte de fin de ligne ajouté aux messages de journal : « from IP port N ». */
const from = (ip: string, port: number) => `from ${ip} port ${port}`

/**
 * Ouvre une connexion SSH (réseau, clé d'hôte, authentification). Les erreurs sont écrites comme le
 * fait `ssh` (erreur standard) ; `quiet` les renvoie sans les écrire.
 */
export function sshConnect(ctx: ExecContext, req: SshRequest): SshOutcome {
  const lines: string[] = []
  const say = (text: string) => {
    if (req.quiet) lines.push(text)
    else ctx.write(text, 'error')
  }
  const fail = (reason: 'network' | 'hostkey' | 'denied', text: string): SshOutcome => {
    say(text)
    return { ok: false, reason, lines }
  }
  const where = locate(ctx, req.host)
  if ('error' in where)
    return fail(
      'network',
      `ssh: Could not resolve hostname ${req.host}: ${req.platform === 'windows' ? 'No such host is known.' : 'Name or service not known'}`
    )
  const { ip, target } = where
  if (!target)
    return fail('network', `ssh: connect to host ${req.host} port ${req.port}: ${silence(ctx, ip)}`)
  const src = where.local ? '127.0.0.1' : (sourceAddressFor(ctx.state, ctx.host, ip) ?? '127.0.0.1')
  const unreachable = `ssh: connect to host ${req.host} port ${req.port}:`
  if (!where.local) {
    const reply = ping(ctx.state, ctx.deviceId, ip, { count: 1, size: 56 })
    if (!reply.ok || !reply.value.outcomes.some((o) => o.kind === 'reply'))
      return fail('network', `${unreachable} ${silence(ctx, ip)}`)
  }
  // Port fermé : aucun sshd, ou fail2ban a banni cette adresse (règle REJECT : « Connection refused »)
  const listening =
    isLinuxHost(target) &&
    linuxSockets(target).some((s) => s.unit.name === 'ssh' && s.proto === 'tcp' && s.port === req.port)
  if (!isLinuxHost(target) || !listening || isBanned(target, ctx.state.clock, src))
    return fail('network', `${unreachable} Connection refused`)

  // Clé d'hôte
  const known = ctx.host.host.linux?.knownHosts ?? []
  if (!known.includes(req.host)) {
    const key = hostKeyOf(target.id)
    if (!req.acceptHostKey) {
      let message = [
        `The authenticity of host '${req.host} (${ip})' can't be established.`,
        `ED25519 key fingerprint is ${fingerprint(key)}.`,
        'This key is not known by any other names.',
        'Are you sure you want to continue connecting (yes/no/[fingerprint])? '
      ].join('\n')
      for (;;) {
        const answer = ctx.ask(message).trim()
        if (answer.toLowerCase() === 'yes' || answer === fingerprint(key)) break
        if (answer === '' || answer.toLowerCase() === 'no')
          return fail('hostkey', 'Host key verification failed.')
        message = "Please type 'yes', 'no' or the fingerprint: "
      }
    }
    ctx.apply(addKnownHost(ctx.state, ctx.deviceId, req.host))
    say(`Warning: Permanently added '${req.host}' (ED25519) to the list of known hosts.`)
  }

  // Authentification (côté serveur : configuration en vigueur et comptes du serveur)
  const config = parseSshd(runningConfigText(target.host.linux, 'ssh'))
  const files = hostFiles(target)
  const entry = readPasswd(files).find((p) => p.name === req.user)
  const loginShell = !!entry && !entry.shell.endsWith('/nologin') && !entry.shell.endsWith('/false')
  const sshd = findSshdPid(target, ctx.state.seq)
  const clientPort = 32768 + ((ctx.state.seq * 37) % 28000)
  const peer = from(src, clientPort)
  const writeAll = (list: LogLine[], failures: number) =>
    ctx.apply(
      writeLogs(
        ctx.state,
        target.id,
        list,
        failures > 0 ? { sshFailures: { from: src, count: failures } } : {}
      )
    )
  const sshdLine = (message: string): LogLine => ({ source: 'sshd', pid: sshd, message })

  const accepted = (method: 'password' | 'publickey', detail = ''): SshOutcome => {
    writeAll(
      [
        sshdLine(`Accepted ${method} for ${req.user} ${peer} ssh2${detail}`),
        sshdLine(
          `pam_unix(sshd:session): session opened for user ${req.user}(uid=${entry?.uid ?? 0}) by (uid=0)`
        )
      ],
      0
    )
    return { ok: true, conn: { target, user: req.user, ip, method, pid: sshd, port: clientPort } }
  }

  // Clés publiques du client, essayées dans l'ordre
  if (config.pubkeyAuthentication) {
    for (const id of clientIdentities(ctx, req, say)) {
      if (!entry || !loginShell || !authorizes(files, req.user, id.key)) continue
      if (req.user === 'root' && config.permitRootLogin === 'no') {
        writeAll([sshdLine(`ROOT LOGIN REFUSED FROM ${src} port ${clientPort}`)], 0)
        continue
      }
      return accepted('publickey', `: ${id.key.type === 'rsa' ? 'RSA' : 'ED25519'} ${fingerprint(id.key)}`)
    }
  } else if (req.platform === 'linux') clientIdentities(ctx, req, say)

  const methods = [
    config.pubkeyAuthentication ? 'publickey' : '',
    config.passwordAuthentication ? 'password' : ''
  ]
    .filter(Boolean)
    .join(',')
  const denied = () => `${req.user}@${req.host}: Permission denied (${methods}).`
  const closed = (word: string) =>
    writeAll([sshdLine(`Connection closed by ${word} ${req.user} ${src} port ${clientPort} [preauth]`)], 0)
  if (req.publickeyOnly || !config.passwordAuthentication) {
    if (!entry) writeAll([sshdLine(`Invalid user ${req.user} ${peer}`)], 1)
    if (!req.publickeyOnly || entry) closed(entry ? 'authenticating user' : 'invalid user')
    return fail(
      'denied',
      req.publickeyOnly ? `${req.user}@${req.host}: Permission denied (publickey).` : denied()
    )
  }

  // Mot de passe : trois essais, comme NumberOfPasswordPrompts
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) say('Permission denied, please try again.')
    const password = ctx.ask(`${req.user}@${req.host}'s password: `, true)
    const valid =
      !!entry &&
      loginShell &&
      hasPassword(files, req.user) &&
      passwordOk(files, req.user, password) &&
      (req.user !== 'root' || config.permitRootLogin === 'yes')
    if (valid) return accepted('password')
    const list: LogLine[] = []
    let failures = 0
    if (!entry) {
      if (attempt === 1) {
        list.push(sshdLine(`Invalid user ${req.user} ${peer}`))
        failures++
      }
      list.push(sshdLine('pam_unix(sshd:auth): check pass; user unknown'))
      list.push(
        sshdLine(
          `pam_unix(sshd:auth): authentication failure; logname= uid=0 euid=0 tty=ssh ruser= rhost=${src}`
        )
      )
      list.push(sshdLine(`Failed password for invalid user ${req.user} ${peer} ssh2`))
    } else {
      list.push(
        sshdLine(
          `pam_unix(sshd:auth): authentication failure; logname= uid=0 euid=0 tty=ssh ruser= rhost=${src}  user=${req.user}`
        )
      )
      list.push(sshdLine(`Failed password for ${req.user} ${peer} ssh2`))
    }
    failures++
    if (attempt === 3)
      list.push(
        sshdLine(
          `Connection closed by ${entry ? 'authenticating' : 'invalid'} user ${req.user} ${src} port ${clientPort} [preauth]`
        )
      )
    writeAll(list, failures)
  }
  return fail('denied', denied())
}

/** PID du processus sshd qui sert la connexion (dérivé du PID de l'unité et du compteur de l'état). */
function findSshdPid(target: HostDevice, seq: number): number {
  const unit = installedUnits(target).find((u) => u.name === 'ssh')
  return unit ? unitPid(target, unit) + 1000 + (seq % 500) : 0
}

/** Fin de session : journalise la fermeture côté serveur. */
function closeSession(ctx: ExecContext, conn: SshConnection): void {
  ctx.apply(
    writeLogs(ctx.state, conn.target.id, [
      {
        source: 'sshd',
        pid: conn.pid,
        message: `pam_unix(sshd:session): session closed for user ${conn.user}`
      }
    ])
  )
}

/** Exécute une commande sur le serveur joint (session bash de l'utilisateur) et relaie sa sortie. */
function runRemote(ctx: ExecContext, conn: SshConnection, command: string): void {
  const files = hostFiles(conn.target)
  const base = createShellSession(ctx.state, conn.target.id, 'cmd')
  const session = { ...base, cwd: homeOf(files, conn.user), variables: { USER: conn.user } }
  const result = executeLine(ctx.state, session, command, [])
  if (result.prompt) {
    ctx.write(
      `ssh: la commande distante demande une saisie (${result.prompt.message.trim()}) : non simulée par ServerLab.`,
      'error'
    )
    return
  }
  ctx.state = result.state
  ctx.output.push(...result.output)
  if (result.trace) ctx.addTrace(result.trace)
}

// ---------------------------------------------------------------------------------------------
// ssh
// ---------------------------------------------------------------------------------------------

/** Compte qui se connecte par défaut : l'utilisateur de la session du client. */
function defaultUser(ctx: ExecContext, platform: Platform): string {
  return platform === 'windows' ? ctx.user.name : bashUser(ctx)
}

export function runSsh(ctx: ExecContext, args: string[], platform: Platform): void {
  let port = 22
  let login: string | null = null
  let identity: string | null = null
  let acceptHostKey = false
  const operands: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    if (operands.length > 0) {
      operands.push(a)
      continue
    }
    const value = () => {
      if (i + 1 >= args.length) {
        ctx.writeLines(
          [`ssh: option requires an argument -- '${a.replace(/^-/, '')}'`, ...SSH_USAGE],
          'error'
        )
        throw new CommandFailure('', 'Usage')
      }
      return args[++i] as string
    }
    if (a === '-p') port = Number(value())
    else if (a.startsWith('-p') && /^-p\d+$/.test(a)) port = Number(a.slice(2))
    else if (a === '-l') login = value()
    else if (a === '-i') identity = value()
    else if (a === '-o' || a.startsWith('-o')) {
      const opt = a === '-o' ? value() : a.slice(2)
      const [k = '', v = ''] = opt.split(/[=\s]+/)
      if (
        k.toLowerCase() === 'stricthostkeychecking' &&
        ['no', 'off', 'accept-new'].includes(v.toLowerCase())
      )
        acceptHostKey = true
      else if (!(k.toLowerCase() === 'stricthostkeychecking' && ['yes', 'ask'].includes(v.toLowerCase())))
        throw new CommandFailure(unsimulatedOptionMessage('ssh', `-o ${k}`), 'NotSupported')
    } else if (a.startsWith('-')) throw new CommandFailure(unsimulatedOptionMessage('ssh', a), 'NotSupported')
    else operands.push(a)
  }
  const [destination, ...command] = operands
  if (!destination) {
    ctx.writeLines(SSH_USAGE, 'error')
    return
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    ctx.write(`Bad port '${port}'`, 'error')
    return
  }
  const at = destination.lastIndexOf('@')
  const user = at >= 0 ? destination.slice(0, at) : (login ?? defaultUser(ctx, platform))
  const host = at >= 0 ? destination.slice(at + 1) : destination
  const outcome = sshConnect(ctx, {
    platform,
    user,
    host,
    port,
    identity,
    acceptHostKey,
    publickeyOnly: false,
    quiet: false
  })
  if (!outcome.ok) return
  if (command.length > 0) runRemote(ctx, outcome.conn, command.join(' '))
  else
    ctx.write(
      'ssh : la session interactive n’est pas simulée par ServerLab (console de lignes). Ajoutez la commande à exécuter : ssh utilisateur@hôte commande.',
      'warning'
    )
  closeSession(ctx, outcome.conn)
}

export const sshTool: ToolDef = {
  name: 'ssh',
  synopsis: 'Se connecte à une machine en SSH (ssh [-p port] [-i clé] utilisateur@hôte [commande]).',
  run: (ctx, args) => runSsh(ctx, args, 'linux')
}

/** ssh.exe des consoles Windows (client OpenSSH intégré à Windows). */
export const sshWindowsTool: ToolDef = {
  name: 'ssh',
  synopsis: 'Se connecte à une machine Linux en SSH (ssh [-p port] utilisateur@hôte [commande]).',
  run: (ctx, args) => runSsh(ctx, args, 'windows')
}

// ---------------------------------------------------------------------------------------------
// ssh-keygen
// ---------------------------------------------------------------------------------------------

const KEYGEN_USAGE = [
  'usage: ssh-keygen [-q] [-a rounds] [-b bits] [-C comment] [-f output_keyfile]',
  '                  [-m format] [-N new_passphrase] [-O option]',
  '                  [-t dsa | ecdsa | ecdsa-sk | ed25519 | ed25519-sk | rsa]',
  '                  [-w provider] [-Z cipher]'
]

const defaultKeyType = (ctx: ExecContext): KeyType =>
  linuxRelease(ctx.host) === 'ubuntu2404' ? 'ed25519' : 'rsa'

function keygenFingerprint(ctx: ExecContext, file: string): void {
  const files = linuxFiles(ctx)
  const given = resolvePath(ctx, file)
  const path = files[given]?.type === 'file' && given.endsWith('.pub') ? given : `${given}.pub`
  const node = files[path.endsWith('.pub') ? path : given]
  if (!node || node.type !== 'file') {
    ctx.write(`${file}: No such file or directory`, 'error')
    return
  }
  const text = contentOf(ctx, path, node)
  const key = parsePublicLine(text)
  if (!key) {
    ctx.write(`${file} is not a public key file.`, 'error')
    return
  }
  const comment = text.trim().split(/\s+/).slice(2).join(' ')
  ctx.write(`${key.bits} ${fingerprint(key)} ${comment} (${key.type === 'rsa' ? 'RSA' : 'ED25519'})`)
}

export const sshKeygenTool: ToolDef = {
  name: 'ssh-keygen',
  synopsis: 'Génère une paire de clés SSH (ssh-keygen -t ed25519, -l -f fichier).',
  run(ctx, args) {
    let type: KeyType | null = null
    let bits: number | null = null
    let file: string | null = null
    let comment: string | null = null
    let passphrase: string | null = null
    let quiet = false
    let list = false
    for (let i = 0; i < args.length; i++) {
      const a = args[i] as string
      const value = () => args[++i] as string
      if (a === '-t') {
        const t = value()
        if (t !== 'rsa' && t !== 'ed25519') {
          if (['dsa', 'ecdsa', 'ecdsa-sk', 'ed25519-sk'].includes(t))
            throw new CommandFailure(unsimulatedOptionMessage('ssh-keygen', `-t ${t}`), 'NotSupported')
          ctx.write(`unknown key type ${t}`, 'error')
          return
        }
        type = t
      } else if (a === '-b') bits = Number(value())
      else if (a === '-f') file = value()
      else if (a === '-C') comment = value()
      else if (a === '-N') passphrase = value()
      else if (a === '-q') quiet = true
      else if (a === '-l') list = true
      else if (a === '-lf') {
        list = true
        file = value()
      } else throw new CommandFailure(unsimulatedOptionMessage('ssh-keygen', a), 'NotSupported')
    }
    if (list) {
      if (!file) {
        ctx.writeLines(KEYGEN_USAGE, 'error')
        return
      }
      return keygenFingerprint(ctx, file)
    }
    const keyType = type ?? defaultKeyType(ctx)
    if (keyType === 'rsa' && bits !== null && (!Number.isInteger(bits) || bits < 1024 || bits % 8 !== 0)) {
      ctx.write('Invalid RSA key length: minimum is 1024 bits', 'error')
      return
    }
    if (keyType === 'ed25519' && bits !== null && bits !== 256) {
      ctx.write('Invalid ED25519 key length: must be 256 bits', 'error')
      return
    }
    const user = bashUser(ctx)
    const home = homeDir(ctx)
    const defaultFile = `${home}/.ssh/id_${keyType}`
    if (!quiet) ctx.write(`Generating public/private ${keyType} key pair.`)
    const path =
      file !== null
        ? resolvePath(ctx, file)
        : (() => {
            const answer = ctx.ask(`Enter file in which to save the key (${defaultFile}): `).trim()
            return answer === '' ? defaultFile : resolvePath(ctx, answer)
          })()
    const files = cloneFiles(linuxFiles(ctx))
    const dir = path.slice(0, path.lastIndexOf('/')) || '/'
    if (dir === `${home}/.ssh` && !files[dir] && !quiet) ctx.write(`Created directory '${dir}'.`, 'error')
    if (files[path]) {
      const answer = ctx.ask(`${path} already exists.\nOverwrite (y/n)? `)
      if (!/^y/i.test(answer)) return
    }
    if (passphrase === null) {
      const first = ctx.ask('Enter passphrase (empty for no passphrase): ', true)
      const second = ctx.ask('Enter same passphrase again: ', true)
      if (first !== second) {
        ctx.write('Passphrases do not match.  Try again.', 'error')
        return
      }
      passphrase = first
    }
    if (passphrase !== '')
      throw new CommandFailure(
        'ssh-keygen : les clés protégées par une phrase secrète ne sont pas simulées par ServerLab (laissez-la vide).',
        'NotSupported'
      )
    if (!files[dir]) {
      const parentOk = dir === `${home}/.ssh` && mayAccess(files, user, home, 2)
      if (!parentOk) {
        ctx.write(`Saving key "${path}" failed: No such file or directory`, 'error')
        return
      }
      files[dir] = {
        type: 'dir',
        mode: 0o700,
        owner: user,
        group: primaryGroup(files, user),
        mtime: ctx.state.clock
      }
    } else if (!mayAccess(files, user, dir, 2)) {
      ctx.write(`Saving key "${path}" failed: Permission denied`, 'error')
      return
    }
    const key = makeKey(`${ctx.deviceId}:${user}:${ctx.state.seq}:${keyType}`, keyType, bits ?? undefined)
    const text = comment ?? `${user}@${ctx.host.name}`
    const group = primaryGroup(files, user)
    files[path] = {
      type: 'file',
      mode: 0o600,
      owner: user,
      group,
      mtime: ctx.state.clock,
      content: `-----BEGIN OPENSSH PRIVATE KEY-----\n${PRIVATE_KEY_BODY}\n-----END OPENSSH PRIVATE KEY-----\n`
    }
    files[`${path}.pub`] = {
      type: 'file',
      mode: 0o644,
      owner: user,
      group,
      mtime: ctx.state.clock,
      content: `${publicLine(key, text)}\n`
    }
    commitFiles(ctx, files)
    if (quiet) return
    ctx.writeLines([
      `Your identification has been saved in ${path}`,
      `Your public key has been saved in ${path}.pub`,
      'The key fingerprint is:',
      `${fingerprint(key)} ${text}`,
      "The key's randomart image is:",
      ...randomart(key)
    ])
  }
}

// ---------------------------------------------------------------------------------------------
// ssh-copy-id
// ---------------------------------------------------------------------------------------------

const COPY_ID = '/usr/bin/ssh-copy-id'

const COPY_ID_USAGE = [
  `Usage: ${COPY_ID} [-h|-?|-f|-n|-s] [-i [identity_file]] [-p port] [-F alternative ssh_config file] [[-o <ssh -o options>] ...] [user@]hostname`,
  '\t-f: force mode -- copy keys without trying to check if they are already installed',
  '\t-n: dry run    -- no keys are actually copied',
  '\t-s: use sftp   -- use sftp instead of executing remote-commands. Can be useful if the remote only allows sftp',
  '\t-h|-?: print this help'
]

export const sshCopyIdTool: ToolDef = {
  name: 'ssh-copy-id',
  synopsis: 'Installe votre clé publique sur un serveur (ssh-copy-id utilisateur@hôte).',
  run(ctx, args) {
    let identity: string | null = null
    let port: number | null = null
    const operands: string[] = []
    for (let i = 0; i < args.length; i++) {
      const a = args[i] as string
      if (a === '-i') identity = args[++i] ?? null
      else if (a === '-p') port = Number(args[++i])
      else if (a === '-h' || a === '-?') return ctx.writeLines(COPY_ID_USAGE, 'error')
      else if (a.startsWith('-'))
        throw new CommandFailure(unsimulatedOptionMessage('ssh-copy-id', a), 'NotSupported')
      else operands.push(a)
    }
    if (operands.length !== 1) {
      if (operands.length > 1)
        ctx.write(
          `${COPY_ID}: ERROR: Too many arguments.  Expecting a target hostname, got: ${args.join(' ')}\n`,
          'error'
        )
      return ctx.writeLines(COPY_ID_USAGE, 'error')
    }
    const files = linuxFiles(ctx)
    const home = homeDir(ctx)
    const user = bashUser(ctx)
    // Fichier de clé publique : -i, sinon le plus récent des ~/.ssh/id*.pub
    let pubPath: string | null
    if (identity !== null) {
      const resolved = resolvePath(ctx, identity)
      pubPath = resolved.endsWith('.pub') ? resolved : `${resolved}.pub`
      const priv = pubPath.slice(0, -4)
      for (const f of [pubPath, priv]) {
        if (files[f]?.type !== 'file') {
          ctx.write(`\n${COPY_ID}: ERROR: failed to open ID file '${f}': No such file or directory`, 'error')
          return
        }
      }
    } else {
      const found = Object.entries(files)
        .filter(([p, n]) => n.type === 'file' && p.startsWith(`${home}/.ssh/id`) && p.endsWith('.pub'))
        .sort((a, b) => b[1].mtime - a[1].mtime || (a[0] < b[0] ? -1 : 1))
      pubPath = found[0]?.[0] ?? null
    }
    const node = pubPath ? files[pubPath] : undefined
    if (!pubPath || !node || node.type !== 'file') {
      ctx.write(`${COPY_ID}: ERROR: No identities found`, 'error')
      return
    }
    const pubLine = contentOf(ctx, pubPath, node).trim()
    const key = parsePublicLine(pubLine)
    if (!key) {
      ctx.write(`${COPY_ID}: ERROR: No identities found`, 'error')
      return
    }
    ctx.write(`${COPY_ID}: INFO: Source of key(s) to be installed: "${pubPath}"`, 'error')
    const destination = operands[0] as string
    const at = destination.lastIndexOf('@')
    const target = {
      user: at >= 0 ? destination.slice(0, at) : user,
      host: at >= 0 ? destination.slice(at + 1) : destination
    }
    const base: SshRequest = {
      platform: 'linux',
      ...target,
      port: port ?? 22,
      identity: pubPath.slice(0, -4),
      acceptHostKey: false,
      publickeyOnly: true,
      quiet: true
    }
    ctx.write(
      `${COPY_ID}: INFO: attempting to log in with the new key(s), to filter out any that are already installed`,
      'error'
    )
    const probe = sshConnect(ctx, base)
    if (probe.ok) {
      closeSession(ctx, probe.conn)
      ctx.writeLines(
        [
          '',
          `${COPY_ID}: WARNING: All keys were skipped because they already exist on the remote system.`,
          '\t\t(if you think this is a mistake, you may want to use -f option)',
          ''
        ],
        'error'
      )
      return
    }
    if (probe.reason !== 'denied') {
      ctx.writeLines(['', `${COPY_ID}: ${probe.lines.map((l) => `ERROR: ${l}`).join('\n')}`, ''], 'error')
      return
    }
    ctx.write(
      `${COPY_ID}: INFO: 1 key(s) remain to be installed -- if you are prompted now it is to install the new keys`,
      'error'
    )
    // Installation : connexion par mot de passe puis ajout à ~/.ssh/authorized_keys du compte
    const real = sshConnect(ctx, { ...base, identity: null, publickeyOnly: false, quiet: false })
    if (!real.ok) return
    const remote = hostFiles(real.conn.target)
    const next = cloneFiles(remote)
    const rhome = homeOf(next, real.conn.user)
    const group = primaryGroup(next, real.conn.user)
    const now = ctx.state.clock
    if (!next[`${rhome}/.ssh`])
      next[`${rhome}/.ssh`] = { type: 'dir', mode: 0o700, owner: real.conn.user, group, mtime: now }
    const authPath = `${rhome}/.ssh/authorized_keys`
    const existing = next[authPath]
    const old = existing?.content ?? ''
    next[authPath] = {
      type: 'file',
      mode: existing?.mode ?? 0o600,
      owner: existing?.owner ?? real.conn.user,
      group: existing?.group ?? group,
      mtime: now,
      content: `${old}${old !== '' && !old.endsWith('\n') ? '\n' : ''}${pubLine}\n`
    }
    commitFilesOf(ctx, real.conn.target.id, next)
    closeSession(ctx, real.conn)
    const opts = `${port !== null ? `-p '${port}' ` : ''}'${destination}'`
    ctx.writeLines([
      '',
      'Number of key(s) added: 1',
      '',
      `Now try logging into the machine, with:   "ssh ${opts}"`,
      'and check to make sure that only the key(s) you wanted were added.',
      ''
    ])
  }
}

export const sshBashTools: ToolDef[] = [sshTool, sshKeygenTool, sshCopyIdTool]
