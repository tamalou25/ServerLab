/**
 * Outils de fichiers et de partage de l'invite de commandes : dir, mkdir, rmdir, del, icacls, net
 * (share, use, view). Utilisables aussi depuis PowerShell.
 */
import type { HostDevice, NtfsRight, ServerDevice, ShareRight } from '../../model/schema'
import {
  accessPerms,
  canonicalAcl,
  domainToken,
  effectiveAcl,
  principalName,
  sessionToken,
  type AccessToken
} from './acl'
import {
  adminShares,
  createItem,
  createShare,
  findShare,
  grantNtfs,
  removeItem,
  removeNtfs,
  removeShare,
  setNtfsInheritance
} from './actions'
import { findNode, nodePath, parseUnc } from './paths'
import { mapDrive, openUnc, sessionDrives, unmapDrive } from './smb'
import { verifyCredentials } from '../adds/join'
import { authenticate } from '../adds/credentials'
import { netAccounts, netGroup, netLocalGroup, netUser } from '../adds/net'
import { netStart, netStop } from '../../shell/tools/services'
import type { ExecContext } from '../../shell/context'
import {
  absolutePath,
  formatBytes,
  listFolder,
  nodeAt,
  shellToken,
  translatePath,
  type FsTarget
} from '../../shell/filesystem'
import { formatShortDate } from '../../core/clock'
import type { ToolDef } from '../../shell/tools/types'

const DONE = 'La commande s’est terminée correctement.'

/** « 05/01/2026  08:00 » (colonne date de dir). */
function dirDate(clock: number): string {
  const [date = '', time = ''] = formatShortDate(clock).split(' ')
  return `${date}  ${time.slice(0, 5)}`
}

function resolveOrFail(ctx: ExecContext, path: string): FsTarget | null {
  const r = translatePath(ctx, path)
  if (!r.ok) {
    ctx.write(r.error, 'error')
    return null
  }
  return r.target
}

/** Arguments sans les options /x. */
function positional(args: string[]): string[] {
  return args.filter((a) => !a.startsWith('/'))
}

export const dirTool: ToolDef = {
  name: 'dir',
  synopsis: 'Affiche la liste des fichiers et sous-répertoires d’un répertoire.',
  switches: ['/?'],
  run(ctx, args) {
    const [path = ''] = positional(args)
    const t = resolveOrFail(ctx, path)
    if (!t) return
    const node = nodeAt(t)
    if (node === undefined || node?.kind === 'file') {
      ctx.write('Fichier introuvable', 'error')
      return
    }
    if (!accessPerms(t.server.storage, node?.id ?? null, shellToken(ctx), t.share).has('list')) {
      ctx.write('Accès refusé.', 'error')
      return
    }
    const items = listFolder(t, node)
    const files = items.filter((n) => n.kind === 'file')
    const unc = parseUnc(t.display)
    const volume = unc ? `\\\\${unc.server}\\${unc.share}` : 'C'
    const lines = [
      ` Le volume dans le lecteur ${volume} n’a pas de nom.`,
      ' Le numéro de série du volume est 5A1B-2C3D',
      '',
      ` Répertoire de ${t.display}`,
      ''
    ]
    const clock = node?.modifiedAt ?? 0
    if (node) lines.push(`${dirDate(clock)}    <DIR>          .`, `${dirDate(clock)}    <DIR>          ..`)
    for (const n of items)
      lines.push(
        n.kind === 'folder'
          ? `${dirDate(n.modifiedAt)}    <DIR>          ${n.name}`
          : `${dirDate(n.modifiedAt)}    ${formatBytes(n.size).padStart(14)} ${n.name}`
      )
    const total = files.reduce((sum, f) => sum + f.size, 0)
    lines.push(
      `${String(files.length).padStart(16)} fichier(s)${formatBytes(total).padStart(16)} octets`,
      `${String(items.length - files.length + (node ? 2 : 0)).padStart(16)} Rép(s)  42 345 678 848 octets libres`,
      ''
    )
    ctx.writeLines(lines)
  }
}

function fsError(ctx: ExecContext, code: string, message: string): void {
  ctx.write(code === 'AccessDenied' ? 'Accès refusé.' : message, 'error')
}

export const mkdirTool: ToolDef = {
  name: 'mkdir',
  synopsis: 'Crée un répertoire (et les répertoires intermédiaires).',
  run(ctx, args) {
    const [path] = positional(args)
    if (!path) {
      ctx.write('La syntaxe de la commande n’est pas correcte.', 'error')
      return
    }
    const t = resolveOrFail(ctx, path)
    if (!t) return
    if (nodeAt(t) !== undefined) {
      ctx.write(`Un sous-répertoire ou un fichier ${path} existe déjà.`, 'error')
      return
    }
    const r = createItem(ctx.state, t.server.id, t.localPath, 'folder', shellToken(ctx), {
      parents: true,
      ...(t.share ? { share: t.share.name } : {})
    })
    if (!r.ok) fsError(ctx, r.error.code, r.error.message)
    else ctx.state = r.state
  }
}

export const mdTool: ToolDef = { ...mkdirTool, name: 'md' }

export const rmdirTool: ToolDef = {
  name: 'rmdir',
  synopsis: 'Supprime un répertoire (/S : avec son contenu, /Q : sans confirmation).',
  switches: ['/s', '/q'],
  run(ctx, args) {
    const [path] = positional(args)
    const opts = args.map((a) => a.toLowerCase())
    if (!path) {
      ctx.write('La syntaxe de la commande n’est pas correcte.', 'error')
      return
    }
    const t = resolveOrFail(ctx, path)
    if (!t) return
    const node = nodeAt(t)
    if (node === undefined || node?.kind === 'file') {
      ctx.write('Le nom de répertoire n’est pas valide.', 'error')
      return
    }
    const recurse = opts.includes('/s')
    if (recurse && !opts.includes('/q')) {
      const answer = ctx.ask(`${t.display}, êtes-vous sûr (O/N) ? `).trim().toLowerCase()
      if (answer !== 'o') return
    }
    const r = removeItem(ctx.state, t.server.id, t.localPath, shellToken(ctx), {
      recurse,
      ...(t.share ? { share: t.share.name } : {})
    })
    if (!r.ok) fsError(ctx, r.error.code, r.error.message)
    else ctx.state = r.state
  }
}

export const rdTool: ToolDef = { ...rmdirTool, name: 'rd' }

export const delTool: ToolDef = {
  name: 'del',
  synopsis: 'Supprime un fichier.',
  run(ctx, args) {
    const [path] = positional(args)
    if (!path) {
      ctx.write('La syntaxe de la commande n’est pas correcte.', 'error')
      return
    }
    const t = resolveOrFail(ctx, path)
    if (!t) return
    const node = nodeAt(t)
    if (!node || node.kind !== 'file') {
      ctx.write(`Impossible de trouver ${t.display}`, 'error')
      return
    }
    const r = removeItem(ctx.state, t.server.id, t.localPath, shellToken(ctx), {
      ...(t.share ? { share: t.share.name } : {})
    })
    if (!r.ok) fsError(ctx, r.error.code, r.error.message)
    else ctx.state = r.state
  }
}

export const eraseTool: ToolDef = { ...delTool, name: 'erase' }

/** Abréviations icacls des autorisations de base. */
const ICACLS_RIGHTS: Record<string, NtfsRight> = {
  F: 'FullControl',
  M: 'Modify',
  RX: 'ReadAndExecute',
  R: 'Read',
  W: 'Write'
}
const RIGHT_CODES: Record<NtfsRight, string> = {
  FullControl: 'F',
  Modify: 'M',
  ReadAndExecute: 'RX',
  ListDirectory: 'RX',
  Read: 'R',
  Write: 'W'
}

/** « LAB\GG_Compta:(OI)(CI)M » → compte et droits. */
function parseGrant(spec: string): { account: string; rights: NtfsRight[] } | null {
  const i = spec.lastIndexOf(':')
  if (i <= 0) return null
  const account = spec.slice(0, i)
  const codes = spec
    .slice(i + 1)
    .replace(/\((OI|CI|IO|NP|I)\)/gi, '')
    .replace(/[()]/g, ',')
    .split(',')
    .map((x) => x.trim().toUpperCase())
    .filter((x) => x.length > 0)
  const rights = codes.map((c) => ICACLS_RIGHTS[c])
  if (rights.length === 0 || rights.some((r) => !r)) return null
  return { account, rights: rights as NtfsRight[] }
}

function icaclsSummary(ctx: ExecContext, ok: number, failed: number): void {
  ctx.write(`${ok} fichiers correctement traités ; échec du traitement de ${failed} fichiers`)
}

export const icaclsTool: ToolDef = {
  name: 'icacls',
  handlesHelp: true,
  synopsis: 'Affiche ou modifie les listes de contrôle d’accès (ACL) des fichiers et dossiers.',
  switches: [
    '/grant',
    '/grant:r',
    '/deny',
    '/remove',
    '/remove:g',
    '/remove:d',
    '/inheritance:e',
    '/inheritance:d',
    '/inheritance:r',
    '/?'
  ],
  run(ctx, args) {
    const [path, ...rest] = args
    if (!path || path === '/?') {
      ctx.writeLines([
        'ICACLS nom /grant[:r] Sid:perm [...]',
        'ICACLS nom /deny Sid:perm [...]',
        'ICACLS nom /remove[:g|:d] Sid [...]',
        'ICACLS nom /inheritance:e|d|r',
        '',
        'perm : F (accès complet), M (accès en modification), RX (lecture et exécution), R (lecture seule), W (écriture seule)',
        'Les indicateurs (OI) et (CI) appliquent l’autorisation aux fichiers et sous-dossiers (toujours le cas ici).'
      ])
      return
    }
    const t = resolveOrFail(ctx, path)
    if (!t) return
    const node = nodeAt(t)
    if (node === undefined) {
      ctx.writeLines([`${t.display}: Le fichier spécifié est introuvable.`], 'error')
      icaclsSummary(ctx, 0, 1)
      return
    }
    const token = shellToken(ctx)
    if (rest.length === 0) {
      // Affichage : entrées explicites puis héritées, dans l'ordre canonique
      const entries = canonicalAcl(effectiveAcl(t.server.storage, node?.id ?? null))
      const flags = node?.kind === 'file' ? '' : '(OI)(CI)'
      const lines = entries.map((e, i) => {
        const name = principalName(ctx.state, t.server, e.ace.principal)
        const text = `${name}:${e.inherited ? '(I)' : ''}${flags}${e.ace.type === 'Deny' ? '(DENY)' : ''}(${RIGHT_CODES[e.ace.rights]})`
        return i === 0 ? `${t.display} ${text}` : `${' '.repeat(t.display.length + 1)}${text}`
      })
      ctx.writeLines([...lines, ''])
      icaclsSummary(ctx, 1, 0)
      return
    }
    // Modification
    let state = ctx.state
    const fail = (message: string) => {
      ctx.write(`${t.display}: ${message}`, 'error')
      icaclsSummary(ctx, 0, 1)
    }
    for (let i = 0; i < rest.length; i++) {
      const option = (rest[i] as string).toLowerCase()
      if (option === '/grant' || option === '/grant:r' || option === '/deny') {
        const specs: string[] = []
        while (i + 1 < rest.length && !(rest[i + 1] as string).startsWith('/'))
          specs.push(rest[++i] as string)
        for (const spec of specs) {
          const grant = parseGrant(spec)
          if (!grant) {
            ctx.write(`Paramètre non valide « ${spec} »`, 'error')
            return
          }
          const r = grantNtfs(
            state,
            t.server.id,
            t.localPath,
            {
              principal: grant.account,
              type: option === '/deny' ? 'Deny' : 'Allow',
              rights: grant.rights,
              replace: option === '/grant:r'
            },
            token
          )
          if (!r.ok) {
            fail(r.error.code === 'AccessDenied' ? 'Accès refusé.' : r.error.message)
            return
          }
          state = r.state
        }
      } else if (option.startsWith('/remove')) {
        const type = option === '/remove:g' ? 'Allow' : option === '/remove:d' ? 'Deny' : 'all'
        const accounts: string[] = []
        while (i + 1 < rest.length && !(rest[i + 1] as string).startsWith('/'))
          accounts.push(rest[++i] as string)
        for (const account of accounts) {
          const r = removeNtfs(state, t.server.id, t.localPath, account, type, token)
          if (!r.ok) {
            fail(r.error.code === 'AccessDenied' ? 'Accès refusé.' : r.error.message)
            return
          }
          state = r.state
        }
      } else if (option.startsWith('/inheritance:')) {
        const mode = option.slice(13)
        const map = { e: 'enable', d: 'convert', r: 'remove' } as const
        const m = map[mode as keyof typeof map]
        if (!m) {
          ctx.write(`Paramètre non valide « ${rest[i] ?? ''} »`, 'error')
          return
        }
        const r = setNtfsInheritance(state, t.server.id, t.localPath, m, token)
        if (!r.ok) {
          fail(r.error.code === 'AccessDenied' ? 'Accès refusé.' : r.error.message)
          return
        }
        state = r.state
      } else {
        ctx.write(`Paramètre non valide « ${rest[i] ?? ''} »`, 'error')
        return
      }
    }
    ctx.state = state
    ctx.write(`fichier traité : ${t.display}`)
    icaclsSummary(ctx, 1, 0)
  }
}

/** Compte utilisé pour une connexion réseau : session, ou identifiants /user: fournis. */
function connectionToken(
  ctx: ExecContext,
  user: string | null,
  password: string | null,
  serverName?: string
): AccessToken | null {
  if (!user) return sessionToken(ctx.state, ctx.deviceId)
  const [domainPart, sam] = user.includes('\\') ? (user.split('\\') as [string, string]) : [null, user]
  // Compte local du serveur visé (SRV2\tech) : base de comptes locale de cet ordinateur (Lot 2b)
  const target = serverName
    ? Object.values(ctx.state.devices).find(
        (d): d is HostDevice =>
          (d.kind === 'server' || d.kind === 'client') && d.name.toLowerCase() === serverName.toLowerCase()
      )
    : undefined
  if (target && domainPart?.toLowerCase() === target.name.toLowerCase())
    return authenticate(ctx.state, target, user, password ?? '')
  const domain = Object.values(ctx.state.domains).find(
    (d) =>
      (domainPart
        ? d.netbios.toLowerCase() === domainPart.toLowerCase() || d.name === domainPart.toLowerCase()
        : true) && d.users.some((u) => u.sam.toLowerCase() === sam.toLowerCase())
  )
  if (!domain) return null
  if (
    !verifyCredentials(ctx.state, ctx.deviceId, {
      user: sam,
      password: password ?? '',
      domain: domain.netbios
    })
  )
    return null
  return domainToken(domain, sam)
}

function systemError(ctx: ExecContext, code: number, message: string): void {
  ctx.writeLines([`Erreur système ${code}.`, '', message, ''], 'error')
}

/** Codes d'erreur système de « net share nom=chemin » (ERROR_NONE_MAPPED = 1332). */
const NET_SHARE_ERRORS: Record<string, number> = { AccessDenied: 5, ShareExists: 2118, UnknownAccount: 1332 }

function netShare(ctx: ExecContext, args: string[]): void {
  const server = ctx.device.kind === 'server' ? (ctx.device as ServerDevice) : null
  if (!server) {
    ctx.write('Aucune entrée dans la liste.')
    return
  }
  const token = shellToken(ctx)
  const [first, ...rest] = args
  if (!first) {
    const rows = [...adminShares(server), ...server.storage.shares].map((s) => {
      const path = 'path' in s ? (s.path as string) : nodePath(server.storage, s.folderId)
      return `${s.name.padEnd(13)}${path.padEnd(32)}${s.description}`
    })
    ctx.writeLines([
      '',
      `${'Nom partage'.padEnd(13)}${'Ressource'.padEnd(32)}Remarque`,
      '',
      '-'.repeat(79),
      ...rows,
      DONE,
      ''
    ])
    return
  }
  const eq = first.indexOf('=')
  if (eq > 0) {
    // net share Nom=C:\chemin [/grant:compte,droit] [/remark:"texte"]
    const name = first.slice(0, eq)
    const path = absolutePath(ctx.session.cwd, first.slice(eq + 1))
    const input: Parameters<typeof createShare>[2] = { name, path, full: [], change: [], read: [] }
    for (const opt of rest) {
      const lower = opt.toLowerCase()
      if (lower.startsWith('/grant:')) {
        const [account = '', right = 'read'] = opt.slice(7).split(',')
        const key =
          right.toLowerCase() === 'full' ? 'full' : right.toLowerCase() === 'change' ? 'change' : 'read'
        input[key]?.push(account)
      } else if (lower.startsWith('/remark:')) input.description = opt.slice(8)
    }
    const r = createShare(ctx.state, server.id, input, token)
    if (!r.ok) {
      systemError(ctx, NET_SHARE_ERRORS[r.error.code] ?? 2, r.error.message)
      return
    }
    ctx.state = r.state
    ctx.writeLines([`${name} a été partagé correctement.`, ''])
    return
  }
  if (rest.some((o) => o.toLowerCase() === '/delete')) {
    const r = removeShare(ctx.state, server.id, first, token)
    if (!r.ok) {
      systemError(
        ctx,
        r.error.code === 'AccessDenied' ? 5 : 2310,
        r.error.code === 'AccessDenied' ? 'Accès refusé.' : 'Ce partage n’existe pas.'
      )
      return
    }
    ctx.state = r.state
    ctx.writeLines([`${first} a été supprimé.`, ''])
    return
  }
  const share = findShare(server, first)
  if (!share) {
    systemError(ctx, 2310, 'Ce partage n’existe pas.')
    return
  }
  const rights: Record<ShareRight, string> = { Full: 'FULL', Change: 'CHANGE', Read: 'READ' }
  const perms = share.acl.map(
    (a) =>
      `${principalName(ctx.state, server, a.principal)}, ${a.type === 'Deny' ? 'DENY ' : ''}${rights[a.rights]}`
  )
  ctx.writeLines([
    `${'Nom du partage'.padEnd(23)}${share.name}`,
    `${'Chemin'.padEnd(23)}${nodePath(server.storage, share.folderId === '' ? null : share.folderId)}`,
    `${'Remarque'.padEnd(23)}${share.description}`,
    `${'Nombre maximal d’utilisateurs'.padEnd(23)} Pas de limite`,
    `${'Utilisateurs'.padEnd(23)}`,
    `${'Mise en cache'.padEnd(23)}Mise en cache manuelle des documents`,
    `${'Autorisation'.padEnd(23)}${perms[0] ?? ''}`,
    ...perms.slice(1).map((p) => `${' '.repeat(23)}${p}`),
    '',
    DONE,
    ''
  ])
}

function netUse(ctx: ExecContext, args: string[]): void {
  const host = ctx.host
  const account = shellToken(ctx).account
  const drives = sessionDrives(host, account)
  const opts = args.filter((a) => a.startsWith('/'))
  const values = args.filter((a) => !a.startsWith('/'))
  if (args.length === 0) {
    const rows = drives.map((d) => {
      const reachable = openUnc(ctx.state, ctx.deviceId, d.path, sessionToken(ctx.state, ctx.deviceId)).ok
      return `${(reachable ? 'OK' : 'Non disponible').padEnd(13)}${`${d.letter}:`.padEnd(10)}${d.path.padEnd(26)}Réseau de fichiers`
    })
    ctx.writeLines([
      'Les nouvelles connexions seront mémorisées.',
      '',
      '',
      `${'État'.padEnd(13)}${'Local'.padEnd(10)}${'Distant'.padEnd(26)}Réseau`,
      '',
      '-'.repeat(79),
      ...(rows.length === 0 ? ['Aucune entrée dans la liste.'] : [...rows, DONE]),
      ''
    ])
    return
  }
  if (opts.some((o) => o.toLowerCase() === '/delete' || o.toLowerCase() === '/d')) {
    const letter = (values[0] ?? '').replace(/:$/, '')
    const op = unmapDrive(ctx.state, ctx.deviceId, letter, account)
    if (!op.ok) {
      systemError(ctx, op.code, op.message)
      return
    }
    ctx.state = op.state
    ctx.writeLines([letter === '*' ? DONE : `${letter.toUpperCase()}: a été supprimé.`, ''])
    return
  }
  const [local, remote] = values[0]?.startsWith('\\\\') ? [null, values[0]] : [values[0] ?? null, values[1]]
  if (!remote) {
    ctx.write(
      'La syntaxe de cette commande est :\n\nNET USE [nom_périphérique | *] [\\\\ordinateur\\partage] [/USER:[domaine\\]utilisateur] [/PERSISTENT:{YES | NO}] [/DELETE]',
      'error'
    )
    return
  }
  const userOpt = opts.find((o) => o.toLowerCase().startsWith('/user:'))
  const user = userOpt ? userOpt.slice(6) : null
  let password: string | null = values[2] ?? null
  if (user && password === null)
    password = ctx.ask(
      `Entrez le mot de passe pour « ${user} » pour vous connecter à « ${parseUnc(remote)?.server ?? remote} » : `,
      true
    )
  const token = connectionToken(ctx, user, password, parseUnc(remote)?.server)
  if (user && !token) {
    systemError(ctx, 1326, 'Le nom d’utilisateur ou le mot de passe est incorrect.')
    return
  }
  const persistentOpt = opts.find((o) => o.toLowerCase().startsWith('/persistent:'))
  const persistent = persistentOpt ? persistentOpt.toLowerCase().endsWith(':yes') : true
  if (!local) {
    // Connexion sans lettre : vérifie seulement l'accès au partage
    const opened = openUnc(ctx.state, ctx.deviceId, remote, token)
    ctx.addTrace(opened.trace)
    if (!opened.ok) systemError(ctx, opened.code, opened.error)
    else ctx.writeLines([DONE, ''])
    return
  }
  let letter = local.replace(/:$/, '').toUpperCase()
  if (letter === '*') {
    const used = new Set(sessionDrives(host, account).map((d) => d.letter))
    letter = [...'ZYXWVUTSRQPONMLKJIHGFED'].find((l) => !used.has(l)) ?? 'Z'
  }
  const op = mapDrive(ctx.state, ctx.deviceId, letter, remote, token, { persistent })
  ctx.addTrace(op.trace)
  if (!op.ok) {
    systemError(ctx, op.code, op.message)
    return
  }
  ctx.state = op.state
  ctx.writeLines(
    [local === '*' ? `Le lecteur ${letter}: est maintenant connecté à ${remote}.` : '', DONE, ''].filter(
      (l, i) => i > 0 || l
    )
  )
}

function netView(ctx: ExecContext, args: string[]): void {
  const target = args.find((a) => a.startsWith('\\\\'))
  if (!target) {
    systemError(ctx, 6118, 'La liste des serveurs de ce groupe de travail n’est pas disponible actuellement.')
    return
  }
  const opened = openUnc(
    ctx.state,
    ctx.deviceId,
    `${target.replace(/\\$/, '')}\\IPC$`,
    sessionToken(ctx.state, ctx.deviceId)
  )
  ctx.addTrace(opened.trace)
  if (!opened.ok && opened.code === 53) {
    systemError(ctx, 53, opened.error)
    return
  }
  const unc = parseUnc(target)
  const server = Object.values(ctx.state.devices).find(
    (d): d is ServerDevice =>
      d.kind === 'server' && d.name.toLowerCase() === (unc?.server ?? '').toLowerCase()
  )
  const shares = server ? server.storage.shares.filter((s) => !s.name.endsWith('$')) : []
  const drives = sessionDrives(ctx.host, shellToken(ctx).account)
  ctx.writeLines([
    `Ressources partagées de ${target}`,
    '',
    '',
    '',
    `${'Nom partage'.padEnd(13)}${'Type'.padEnd(8)}${'Utilisé comme'.padEnd(15)}Commentaire`,
    '',
    '-'.repeat(79),
    ...shares.map((s) => {
      const used = drives.find((d) => d.path.toLowerCase() === `${target}\\${s.name}`.toLowerCase())
      return `${s.name.padEnd(13)}${'Disque'.padEnd(8)}${(used ? `${used.letter}:` : '').padEnd(15)}${s.description}`
    }),
    DONE,
    ''
  ])
}

export const netTool: ToolDef = {
  name: 'net',
  synopsis:
    'Partages (share), lecteurs (use, view), comptes (user, localgroup, group, accounts), services (start, stop).',
  help: {
    syntax: [
      'net user [<UserName> {<Password> | *} [<Options>]] [/domain]',
      'net user [<UserName> {<Password> | *} /add [<Options>] [/domain]]',
      'net user [<UserName> [/delete] [/domain]]',
      'net user username [/active: {yes | no}]',
      'net localgroup [<GroupName> <Name> […] {/add |  /delete} [/domain]',
      'net group [<GroupName> <UserName>[ ...] {/add | /delete} [/domain]]',
      'net accounts [/forcelogoff:{minutes | no}] [/minpwlen:length] [/maxpwage:{days | unlimited}] [/minpwage:days] [/uniquepw:number] [/domain]',
      'net start [service]',
      'net stop service'
    ],
    url: 'https://learn.microsoft.com/fr-fr/windows-server/administration/windows-commands/net-user'
  },
  switches: [
    'share',
    'use',
    'view',
    'user',
    'localgroup',
    'group',
    'accounts',
    'start',
    'stop',
    '/add',
    '/domain',
    '/active:yes',
    '/active:no',
    '/delete',
    '/persistent:yes',
    '/persistent:no',
    '/user:'
  ],
  run(ctx, args) {
    const [sub = '', ...rest] = args
    switch (sub.toLowerCase()) {
      case 'share':
        netShare(ctx, rest)
        return
      case 'use':
        netUse(ctx, rest)
        return
      case 'view':
        netView(ctx, rest)
        return
      case 'user':
      case 'users':
        netUser(ctx, rest)
        return
      case 'localgroup':
        netLocalGroup(ctx, rest)
        return
      case 'group':
      case 'groups':
        netGroup(ctx, rest)
        return
      case 'accounts':
        netAccounts(ctx, rest)
        return
      case 'start':
        netStart(ctx, rest)
        return
      case 'stop':
        netStop(ctx, rest)
        return
      case 'time':
        ctx.write(`La sous-commande NET ${sub.toUpperCase()} n’est pas simulée.`, 'error')
        return
      default:
        ctx.writeLines([
          'La syntaxe de cette commande est :',
          '',
          'NET',
          '    [ ACCOUNTS | COMPUTER | CONFIG | CONTINUE | FILE | GROUP | HELP |',
          '      HELPMSG | LOCALGROUP | PAUSE | SESSION | SHARE | START |',
          '      STATISTICS | STOP | TIME | USE | USER | VIEW ]',
          ''
        ])
    }
  }
}

/** Change le dossier courant de l'invite de commandes (cd). */
export function changeDirectory(ctx: ExecContext, path: string): void {
  if (path.startsWith('\\\\')) {
    ctx.write('CMD ne prend pas en charge les chemins d’accès UNC en tant que répertoires en cours.', 'error')
    return
  }
  const t = resolveOrFail(ctx, path)
  if (!t) return
  const node = findNode(t.server.storage, t.localPath)
  if (node === undefined || node?.kind === 'file') {
    ctx.write('Le chemin d’accès spécifié est introuvable.', 'error')
    return
  }
  ctx.session = { ...ctx.session, cwd: t.display }
}

export const fileTools: ToolDef[] = [
  dirTool,
  mkdirTool,
  mdTool,
  rmdirTool,
  rdTool,
  delTool,
  eraseTool,
  icaclsTool,
  netTool
]
