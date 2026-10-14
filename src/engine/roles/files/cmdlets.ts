/**
 * Cmdlets de fichiers (Get-ChildItem, New-Item, Remove-Item, Set-Location, Get-Acl) et du module
 * SmbShare (partages, autorisations de partage, lecteurs mappés).
 */
import type { FsNode, LabState, NtfsAce, ServerDevice, ShareRight, SmbShare } from '../../model/schema'
import { SHARE_RIGHTS } from '../../model/schema'
import type { EngineResult } from '../../core/result'
import { accessPerms, canonicalAcl, effectiveAcl, principalName, sessionToken } from './acl'
import {
  adminShares,
  createItem,
  createShare,
  findShare,
  removeItem,
  removeShare,
  revokeShareAccess,
  setShareAccess
} from './actions'
import { nodePath } from './paths'
import { mapDrive, sessionDrives, unmapDrive } from './smb'
import { setSmb1 } from './smbconfig'
import {
  absolutePath,
  formatBytes,
  lastWrite,
  listFolder,
  nodeAt,
  shellToken,
  translatePath,
  type FsTarget
} from '../../shell/filesystem'
import { psError } from '../../shell/ps/errors'
import type { CmdContext } from '../../shell/ps/interpreter'
import type { BoundArgs, CmdletDef } from '../../shell/ps/registry'
import { flatten, psObject, psToString, type PsObject, type PsValue } from '../../shell/ps/values'
import { onServer } from '../../shell/ps/cmdlets/helpers'

const str = (v: PsValue | undefined): string => psToString(v)
const list = (v: PsValue | undefined): string[] =>
  v === undefined
    ? []
    : flatten([v])
        .map(psToString)
        .filter((x) => x.length > 0)

export function notFound(path: string) {
  return psError(
    `Impossible de trouver le chemin d’accès « ${path} », car il n’existe pas.`,
    'ObjectNotFound',
    'PathNotFound',
    path,
    'ItemNotFoundException'
  )
}

/** Traduit un chemin ou lève l'erreur correspondante. */
export function target(ctx: CmdContext, path: string): FsTarget {
  const r = translatePath(ctx, path)
  if (!r.ok)
    throw psError(
      r.error,
      r.error.startsWith('Accès') ? 'PermissionDenied' : 'ObjectNotFound',
      'PathNotFound',
      path
    )
  return r.target
}

/** Lignes de Get-ChildItem pour un dossier. */
export function childLines(display: string, items: FsNode[]): string[] {
  if (items.length === 0) return []
  return [
    '',
    `    Répertoire : ${display}`,
    '',
    '',
    'Mode                 LastWriteTime         Length Name',
    '----                 -------------         ------ ----',
    ...items.map(
      (n) =>
        `${n.kind === 'folder' ? 'd-----' : '-a----'}        ${lastWrite(n.modifiedAt)}  ${(n.kind === 'file' ? formatBytes(n.size) : '').padStart(13)} ${n.name}`
    ),
    ''
  ]
}

export function denied(path: string) {
  return psError(
    `L’accès au chemin d’accès « ${path} » est refusé.`,
    'PermissionDenied',
    'DirUnauthorizedAccessError',
    path,
    'UnauthorizedAccessException'
  )
}

/** Exécute une action de fichiers en traduisant les erreurs du moteur. */
export function applyFs(ctx: CmdContext, path: string, run: () => EngineResult<unknown>) {
  const result = run()
  if (!result.ok) {
    if (result.error.code === 'AccessDenied') throw denied(path)
    if (result.error.code === 'PathNotFound') throw notFound(path)
    throw psError(result.error.message, 'InvalidOperation', result.error.code, path)
  }
  ctx.state = result.state
}

function fsRights(ace: NtfsAce): string {
  return ace.rights
}

function aclObject(ctx: CmdContext, t: FsTarget, node: FsNode | null): PsObject {
  const server = t.server
  const entries = canonicalAcl(effectiveAcl(server.storage, node?.id ?? null))
  const rules = entries.map((e) => {
    const identity = principalName(ctx.state, server, e.ace.principal)
    return {
      kind: 'object' as const,
      typeName: 'FileSystemAccessRule',
      text: `${identity} ${e.ace.type}  ${fsRights(e.ace)}`,
      props: {
        FileSystemRights: fsRights(e.ace),
        AccessControlType: e.ace.type,
        IdentityReference: identity,
        IsInherited: e.inherited,
        InheritanceFlags: node?.kind === 'file' ? 'None' : 'ContainerInherit, ObjectInherit',
        PropagationFlags: 'None'
      },
      view: {
        kind: 'list' as const,
        props: [
          'FileSystemRights',
          'AccessControlType',
          'IdentityReference',
          'IsInherited',
          'InheritanceFlags',
          'PropagationFlags'
        ]
      }
    }
  })
  return psObject(
    'DirectorySecurity',
    {
      Path: node?.name ?? t.display,
      Owner: principalName(ctx.state, server, node?.owner ?? 'S-1-5-32-544'),
      Access: rules,
      AreAccessRulesProtected: node ? !node.inherits : true,
      AccessToString: rules.map((r) => r.text).join('\n')
    },
    { kind: 'table', props: ['Path', 'Owner', 'Access'] }
  )
}

function shareObject(server: ServerDevice, share: SmbShare & { path?: string }): PsObject {
  const path = share.path ?? nodePath(server.storage, share.folderId === '' ? null : share.folderId)
  return psObject(
    'SmbShare',
    { Name: share.name, ScopeName: '*', Path: path, Description: share.description, CurrentUsers: 0 },
    { kind: 'table', props: ['Name', 'ScopeName', 'Path', 'Description'] }
  )
}

function shareAccessObjects(state: LabState, server: ServerDevice, share: SmbShare): PsObject[] {
  return share.acl.map((a) =>
    psObject(
      'SmbShareAccessControlEntry',
      {
        Name: share.name,
        ScopeName: '*',
        AccountName: principalName(state, server, a.principal),
        AccessControlType: a.type,
        AccessRight: a.rights
      },
      { kind: 'table', props: ['Name', 'ScopeName', 'AccountName', 'AccessControlType', 'AccessRight'] }
    )
  )
}

function serverOf(ctx: CmdContext): ServerDevice {
  const d = ctx.device
  if (d.kind !== 'server')
    throw psError('Cette commande n’est disponible que sur un serveur.', 'NotImplemented', 'NotServer')
  return d
}

function shareArg(ctx: CmdContext, args: BoundArgs): SmbShare {
  const server = serverOf(ctx)
  const name = str(args['Name'])
  const share = findShare(server, name)
  if (!share)
    throw psError(
      `Aucun objet MSFT_SmbShare trouvé avec la propriété « Name » égale à « ${name} ». Vérifiez la valeur de la propriété et réessayez.`,
      'ObjectNotFound',
      'CmdletizationQuery_NotFound_Name,Get-SmbShare',
      name
    )
  return share
}

/** Applique une action de partage (erreurs : compte inconnu, accès refusé…). */
function applyShare(ctx: CmdContext, result: ReturnType<typeof createShare>): void {
  if (!result.ok)
    throw psError(result.error.message, 'InvalidOperation', result.error.code, '', 'CimException')
  ctx.state = result.state
}

export const fileCmdlets: CmdletDef[] = [
  {
    name: 'Get-ChildItem',
    aliases: ['dir', 'ls', 'gci'],
    module: 'Management',
    synopsis: 'Liste le contenu d’un dossier (local ou partagé).',
    params: [
      { name: 'Path', type: 'string', position: 0 },
      { name: 'Force', type: 'switch' }
    ],
    run(ctx, args) {
      const path = args['Path'] !== undefined ? str(args['Path']) : ''
      const t = target(ctx, path)
      const node = nodeAt(t)
      if (node === undefined) throw notFound(absolutePath(ctx.session.cwd, path))
      const token = shellToken(ctx)
      const perms = accessPermsAt(t, node, token)
      if (!perms.has('list')) throw denied(t.display)
      if (node?.kind === 'file') {
        ctx.writeLines(childLines(t.display.split('\\').slice(0, -1).join('\\'), [node]))
        return []
      }
      ctx.writeLines(childLines(t.display, listFolder(t, node)))
      return []
    }
  },
  {
    name: 'New-Item',
    aliases: ['ni'],
    module: 'Management',
    synopsis: 'Crée un dossier ou un fichier.',
    params: [
      { name: 'Path', type: 'string', position: 0, mandatory: true },
      { name: 'Name', type: 'string' },
      { name: 'ItemType', type: 'string', aliases: ['Type'], validateSet: ['Directory', 'File'] },
      { name: 'Value', type: 'string' },
      { name: 'Force', type: 'switch' }
    ],
    run(ctx, args) {
      const raw =
        args['Name'] !== undefined ? `${str(args['Path'])}\\${str(args['Name'])}` : str(args['Path'])
      const kind = str(args['ItemType']).toLowerCase() === 'directory' ? 'folder' : 'file'
      const value = args['Value'] !== undefined ? str(args['Value']) : undefined
      return createAndShow(ctx, raw, kind, value?.length ?? 0, value)
    }
  },
  {
    name: 'mkdir',
    aliases: ['md'],
    module: 'Management',
    synopsis: 'Crée un dossier (et ses dossiers parents).',
    params: [{ name: 'Path', type: 'string', position: 0, mandatory: true }],
    run(ctx, args) {
      return createAndShow(ctx, str(args['Path']), 'folder', 0)
    }
  },
  {
    name: 'Remove-Item',
    aliases: ['rm', 'del', 'rmdir', 'rd', 'ri', 'erase'],
    module: 'Management',
    synopsis: 'Supprime un dossier ou un fichier.',
    params: [
      { name: 'Path', type: 'string', position: 0, mandatory: true },
      { name: 'Recurse', type: 'switch' },
      { name: 'Force', type: 'switch' }
    ],
    run(ctx, args) {
      const path = str(args['Path'])
      const t = target(ctx, path)
      const node = nodeAt(t)
      if (node === undefined) throw notFound(t.display)
      let recurse = args['Recurse'] === true
      if (node && !recurse && listFolder(t, node).length > 0) {
        ctx.writeLines([
          '',
          'Confirmer',
          `L’élément situé à ${t.display} a des enfants et le paramètre Recurse n’a pas été spécifié. Si vous continuez, tous les enfants seront supprimés avec l’élément. Voulez-vous vraiment continuer ?`
        ])
        const answer = ctx
          .ask(
            '[O] Oui  [T] Oui pour tout  [N] Non  [U] Non pour tout  [S] Suspendre  [?] Aide (la valeur par défaut est « O ») : '
          )
          .trim()
          .toLowerCase()
        if (answer !== '' && answer !== 'o' && answer !== 't') return []
        recurse = true
      }
      applyFs(ctx, t.display, () =>
        removeItem(ctx.state, t.server.id, t.localPath, shellToken(ctx), {
          recurse,
          ...(t.share ? { share: t.share.name } : {})
        })
      )
      return []
    }
  },
  {
    name: 'Set-Location',
    aliases: ['cd', 'chdir', 'sl'],
    module: 'Management',
    synopsis: 'Change le dossier courant.',
    params: [{ name: 'Path', type: 'string', position: 0 }],
    run(ctx, args) {
      const path = args['Path'] !== undefined ? str(args['Path']) : ''
      if (path === '') return []
      const t = target(ctx, path)
      const node = nodeAt(t)
      if (node === undefined || node?.kind === 'file') throw notFound(t.display)
      ctx.session = { ...ctx.session, cwd: t.display.replace(/\\$/, '') || 'C:\\' }
      if (/^[A-Z]:$/.test(ctx.session.cwd)) ctx.session = { ...ctx.session, cwd: `${ctx.session.cwd}\\` }
      return []
    }
  },
  {
    name: 'Get-Acl',
    module: 'Security',
    synopsis: 'Affiche les autorisations NTFS d’un dossier ou d’un fichier.',
    params: [{ name: 'Path', type: 'string', position: 0 }],
    run(ctx, args) {
      const path = args['Path'] !== undefined ? str(args['Path']) : ''
      const t = target(ctx, path)
      const node = nodeAt(t)
      if (node === undefined) throw notFound(t.display)
      return [aclObject(ctx, t, node)]
    }
  },
  {
    name: 'New-SmbShare',
    module: 'SmbShare',
    synopsis: 'Partage un dossier sur le réseau.',
    available: onServer,
    params: [
      { name: 'Name', type: 'string', mandatory: true, position: 0 },
      { name: 'Path', type: 'string', mandatory: true, position: 1 },
      { name: 'Description', type: 'string' },
      { name: 'FullAccess', type: 'string[]' },
      { name: 'ChangeAccess', type: 'string[]' },
      { name: 'ReadAccess', type: 'string[]' },
      { name: 'NoAccess', type: 'string[]' },
      { name: 'FolderEnumerationMode', type: 'string', validateSet: ['AccessBased', 'Unrestricted'] }
    ],
    run(ctx, args) {
      const server = serverOf(ctx)
      const path = absolutePath(ctx.session.cwd, str(args['Path']))
      applyShare(
        ctx,
        createShare(
          ctx.state,
          server.id,
          {
            name: str(args['Name']),
            path,
            description: str(args['Description']),
            full: list(args['FullAccess']),
            change: list(args['ChangeAccess']),
            read: list(args['ReadAccess']),
            noAccess: list(args['NoAccess'])
          },
          shellToken(ctx)
        )
      )
      const updated = ctx.state.devices[server.id] as ServerDevice
      const share = findShare(updated, str(args['Name']))
      return share ? [shareObject(updated, share)] : []
    }
  },
  {
    name: 'Get-SmbServerConfiguration',
    module: 'SmbShare',
    synopsis: 'Affiche la configuration du serveur SMB.',
    params: [],
    run(ctx) {
      return [
        psObject(
          'SmbServerConfiguration',
          {
            EnableSMB1Protocol: ctx.host.host.smb1,
            EnableSMB2Protocol: true,
            EncryptData: false,
            RequireSecuritySignature: false
          },
          {
            kind: 'list',
            props: ['EnableSMB1Protocol', 'EnableSMB2Protocol', 'EncryptData', 'RequireSecuritySignature']
          }
        )
      ]
    }
  },
  {
    name: 'Set-SmbServerConfiguration',
    module: 'SmbShare',
    synopsis: 'Modifie la configuration du serveur SMB (protocole SMB 1.0).',
    params: [
      { name: 'EnableSMB1Protocol', type: 'bool' },
      { name: 'Force', type: 'switch' }
    ],
    run(ctx, args) {
      if (args['EnableSMB1Protocol'] === undefined) return []
      if (args['Force'] !== true && !ctx.confirm(ctx.host.name, 'Set-SmbServerConfiguration')) return []
      ctx.apply(setSmb1(ctx.state, ctx.deviceId, args['EnableSMB1Protocol'] === true))
      return []
    }
  },
  {
    name: 'Get-SmbShare',
    module: 'SmbShare',
    synopsis: 'Liste les partages du serveur.',
    available: onServer,
    params: [{ name: 'Name', type: 'string', position: 0 }],
    run(ctx, args) {
      const server = serverOf(ctx)
      if (args['Name'] !== undefined) return [shareObject(server, shareArg(ctx, args))]
      return [...adminShares(server), ...server.storage.shares].map((s) => shareObject(server, s))
    }
  },
  {
    name: 'Remove-SmbShare',
    module: 'SmbShare',
    synopsis: 'Arrête le partage d’un dossier.',
    available: onServer,
    params: [
      { name: 'Name', type: 'string', mandatory: true, position: 0 },
      { name: 'Force', type: 'switch' }
    ],
    run(ctx, args) {
      const share = shareArg(ctx, args)
      if (args['Force'] !== true && !ctx.confirm(`*,${share.name}`, 'Remove-Share')) return []
      applyShare(ctx, removeShare(ctx.state, ctx.deviceId, share.name, shellToken(ctx)))
      return []
    }
  },
  {
    name: 'Get-SmbShareAccess',
    module: 'SmbShare',
    synopsis: 'Affiche les autorisations d’un partage.',
    available: onServer,
    params: [{ name: 'Name', type: 'string', mandatory: true, position: 0 }],
    run(ctx, args) {
      return shareAccessObjects(ctx.state, serverOf(ctx), shareArg(ctx, args))
    }
  },
  {
    name: 'Grant-SmbShareAccess',
    module: 'SmbShare',
    synopsis: 'Accorde une autorisation de partage (Full, Change, Read).',
    available: onServer,
    params: [
      { name: 'Name', type: 'string', mandatory: true, position: 0 },
      { name: 'AccountName', type: 'string[]', mandatory: true },
      { name: 'AccessRight', type: 'string', mandatory: true, validateSet: [...SHARE_RIGHTS, 'Custom'] },
      { name: 'Force', type: 'switch' }
    ],
    run(ctx, args) {
      const share = shareArg(ctx, args)
      if (args['Force'] !== true && !ctx.confirm(`*,${share.name}`, 'Grant-Access')) return []
      for (const account of list(args['AccountName']))
        applyShare(
          ctx,
          setShareAccess(
            ctx.state,
            ctx.deviceId,
            share.name,
            account,
            { type: 'Allow', rights: str(args['AccessRight']) as ShareRight },
            shellToken(ctx)
          )
        )
      return shareAccessObjects(ctx.state, serverOf(ctx), shareArg(ctx, args))
    }
  },
  ...(
    [
      ['Revoke', 'Retire les autorisations accordées à un compte sur un partage.', 'Allow'],
      ['Unblock', 'Retire le refus d’accès d’un compte sur un partage.', 'Deny']
    ] as const
  ).map(([verb, synopsis, type]): CmdletDef => ({
    name: `${verb}-SmbShareAccess`,
    module: 'SmbShare',
    synopsis,
    available: onServer,
    params: [
      { name: 'Name', type: 'string', mandatory: true, position: 0 },
      { name: 'AccountName', type: 'string[]', mandatory: true },
      { name: 'Force', type: 'switch' }
    ],
    run(ctx, args) {
      const share = shareArg(ctx, args)
      if (args['Force'] !== true && !ctx.confirm(`*,${share.name}`, `${verb}-Access`)) return []
      for (const account of list(args['AccountName']))
        applyShare(
          ctx,
          revokeShareAccess(ctx.state, ctx.deviceId, share.name, account, type, shellToken(ctx))
        )
      return shareAccessObjects(ctx.state, serverOf(ctx), shareArg(ctx, args))
    }
  })),
  {
    name: 'Block-SmbShareAccess',
    module: 'SmbShare',
    synopsis: 'Refuse l’accès à un partage pour un compte.',
    available: onServer,
    params: [
      { name: 'Name', type: 'string', mandatory: true, position: 0 },
      { name: 'AccountName', type: 'string[]', mandatory: true },
      { name: 'Force', type: 'switch' }
    ],
    run(ctx, args) {
      const share = shareArg(ctx, args)
      if (args['Force'] !== true && !ctx.confirm(`*,${share.name}`, 'Block-Access')) return []
      for (const account of list(args['AccountName']))
        applyShare(
          ctx,
          setShareAccess(
            ctx.state,
            ctx.deviceId,
            share.name,
            account,
            { type: 'Deny', rights: 'Full' },
            shellToken(ctx)
          )
        )
      return shareAccessObjects(ctx.state, serverOf(ctx), shareArg(ctx, args))
    }
  },
  {
    name: 'New-SmbMapping',
    module: 'SmbShare',
    synopsis: 'Connecte un lecteur réseau.',
    params: [
      { name: 'LocalPath', type: 'string', position: 0 },
      { name: 'RemotePath', type: 'string', mandatory: true, position: 1 },
      { name: 'Persistent', type: 'bool' }
    ],
    run(ctx, args) {
      const letter = str(args['LocalPath']).replace(/:$/, '')
      const op = mapDrive(
        ctx.state,
        ctx.deviceId,
        letter,
        str(args['RemotePath']),
        sessionToken(ctx.state, ctx.deviceId),
        {
          persistent: args['Persistent'] === true
        }
      )
      ctx.addTrace(op.trace)
      if (!op.ok)
        throw psError(
          op.message,
          'InvalidOperation',
          `Windows System Error ${op.code},New-SmbMapping`,
          str(args['RemotePath']),
          'CimException'
        )
      ctx.state = op.state
      return [mappingObject(`${letter.toUpperCase()}:`, str(args['RemotePath']))]
    }
  },
  {
    name: 'Get-SmbMapping',
    module: 'SmbShare',
    synopsis: 'Liste les lecteurs réseau connectés.',
    params: [],
    run(ctx) {
      return sessionDrives(ctx.host, shellToken(ctx).account).map((d) =>
        mappingObject(`${d.letter}:`, d.path)
      )
    }
  },
  {
    name: 'Remove-SmbMapping',
    module: 'SmbShare',
    synopsis: 'Déconnecte un lecteur réseau.',
    params: [
      { name: 'LocalPath', type: 'string', mandatory: true, position: 0 },
      { name: 'Force', type: 'switch' }
    ],
    run(ctx, args) {
      const letter = str(args['LocalPath']).replace(/:$/, '')
      if (args['Force'] !== true && !ctx.confirm(`${letter.toUpperCase()}:`, 'Remove-SmbMapping')) return []
      const op = unmapDrive(ctx.state, ctx.deviceId, letter, shellToken(ctx).account)
      if (!op.ok) throw psError(op.message, 'ObjectNotFound', 'CmdletizationQuery_NotFound', letter)
      ctx.state = op.state
      return []
    }
  }
]

function mappingObject(local: string, remote: string): PsObject {
  return psObject(
    'SmbMapping',
    { Status: 'OK', LocalPath: local, RemotePath: remote },
    { kind: 'table', props: ['Status', 'LocalPath', 'RemotePath'] }
  )
}

/** Droits effectifs à un emplacement traduit (au travers du partage le cas échéant). */
export function accessPermsAt(t: FsTarget, node: FsNode | null, token: ReturnType<typeof shellToken>) {
  return accessPerms(t.server.storage, node?.id ?? null, token, t.share)
}

/** Création (New-Item, mkdir) avec la sortie « Répertoire : … ». */
function createAndShow(
  ctx: CmdContext,
  raw: string,
  kind: 'folder' | 'file',
  size: number,
  content?: string
): PsValue[] {
  const t = target(ctx, raw)
  const existing = nodeAt(t)
  if (existing !== undefined)
    throw psError(
      `Un élément avec le nom spécifié ${t.display} existe déjà.`,
      'ResourceExists',
      'DirectoryExist',
      t.display,
      'IOException'
    )
  applyFs(ctx, t.display, () =>
    createItem(ctx.state, t.server.id, t.localPath, kind, shellToken(ctx), {
      parents: kind === 'folder',
      size,
      ...(content !== undefined ? { content } : {}),
      ...(t.share ? { share: t.share.name } : {})
    })
  )
  const server = ctx.state.devices[t.server.id] as ServerDevice
  const created = nodeAt({ ...t, server })
  const parent = t.display.split('\\').slice(0, -1).join('\\') || t.display
  if (created) ctx.writeLines(childLines(parent, [created]))
  return []
}
