/**
 * Cmdlets de contenu et d'éléments du fournisseur FileSystem (Windows PowerShell 5.1) :
 * Get-Content, Set-Content, Add-Content, Out-File, Test-Path, Get-Item, Copy-Item, Rename-Item.
 * Paramètres, alias, valeurs par défaut (encodages) d'après Microsoft Learn :
 * - https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/get-content?view=powershell-5.1
 * - https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/set-content?view=powershell-5.1
 * - https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/add-content?view=powershell-5.1
 * - https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/out-file?view=powershell-5.1
 * - https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/test-path?view=powershell-5.1
 * - https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/get-item?view=powershell-5.1
 * - https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/copy-item?view=powershell-5.1
 * - https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/rename-item?view=powershell-5.1
 * Les erreurs reprennent celles des autres cmdlets de fichiers du simulateur (objet introuvable,
 * accès refusé selon les ACL NTFS).
 */
import { formatShortDate } from '../../core/clock'
import type { FsNode, ServerDevice } from '../../model/schema'
import { copyItem, renameItem, writeFileContent } from './actions'
import { FILE_ENCODINGS, type FileEncoding } from './encoding'
import { accessPermsAt, applyFs, denied, notFound, target } from './cmdlets'
import { formatBytes, nodeAt, shellToken, translatePath, type FsTarget } from '../../shell/filesystem'
import { psError } from '../../shell/ps/errors'
import { formatDefault } from '../../shell/ps/format'
import type { CmdContext } from '../../shell/ps/interpreter'
import type { BoundArgs, CmdletDef, ParamDef } from '../../shell/ps/registry'
import { flatten, getProp, psObject, psToString, type PsObject, type PsValue } from '../../shell/ps/values'
import { unsimulatedParameterMessage } from '../../shell/unsimulated'

const str = (v: PsValue | undefined): string => psToString(v)

/** Paramètres réels déclarés (complétion, pas d'erreur « paramètre introuvable ») mais non simulés. */
function unsimulated(names: string[]): ParamDef[] {
  // Paramètres sans valeur (SwitchParameter sur Learn) : -Wait, -Container
  const switches = new Set(['Wait', 'Container'])
  return names.map((name) => ({ name, type: switches.has(name) ? ('switch' as const) : ('any' as const) }))
}

function rejectUnsimulated(command: string, args: BoundArgs, names: string[]): void {
  for (const name of names)
    if (args[name] !== undefined)
      throw psError(unsimulatedParameterMessage(command, name), 'NotImplemented', 'UnsimulatedParameter')
}

const shareOpt = (t: FsTarget) => (t.share ? { share: t.share.name } : {})

/** Serveur à jour (après une modification de ctx.state). */
const freshServer = (ctx: CmdContext, t: FsTarget) => ctx.state.devices[t.server.id] as ServerDevice

/** Fichier existant et lisible, ou erreur. */
function readableFile(ctx: CmdContext, path: string): { t: FsTarget; node: FsNode } {
  const t = target(ctx, path)
  const node = nodeAt(t)
  if (node === undefined) throw notFound(t.display)
  if (!accessPermsAt(t, node, shellToken(ctx)).has('read')) throw denied(t.display)
  if (node === null || node.kind === 'folder')
    // Libellé à vérifier (aucune sortie française de référence sur Learn)
    throw psError(
      `Impossible de trouver le chemin d’accès « ${t.display} », car il s’agit d’un dossier et non d’un fichier.`,
      'ReadError',
      'GetContentReaderUnauthorizedAccessError',
      t.display,
      'UnauthorizedAccessException'
    )
  return { t, node }
}

/** Lignes d'un texte : séparateurs CRLF ou LF, sans ligne vide finale due au dernier saut de ligne. */
export function contentLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split(/\r?\n/)
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Texte écrit par Set-Content / Add-Content : chaque valeur suivie d'un saut de ligne, sauf -NoNewline. */
function joinValues(values: PsValue[], noNewline: boolean): string {
  const items = flatten(values).map(psToString)
  return noNewline ? items.join('') : items.map((v) => `${v}\r\n`).join('')
}

/** Écriture du contenu (création au besoin) par la commande du moteur. */
function write(
  ctx: CmdContext,
  path: string,
  text: string,
  options: { append?: boolean; encoding: FileEncoding }
) {
  const t = target(ctx, path)
  applyFs(ctx, t.display, () =>
    writeFileContent(ctx.state, t.server.id, t.localPath, text, shellToken(ctx), {
      ...options,
      ...shareOpt(t)
    })
  )
}

/** Objet FileInfo / DirectoryInfo (Get-Item, -PassThru), affiché comme Get-ChildItem. */
export function itemObject(display: string, node: FsNode | null): PsObject {
  const folder = node === null || node.kind === 'folder'
  const parent = display.split('\\').slice(0, -1).join('\\') || display
  const props: Record<string, PsValue> = {
    Name: node?.name ?? display,
    FullName: display,
    Mode: folder ? 'd-----' : '-a----',
    LastWriteTime: formatShortDate(node?.modifiedAt ?? 0),
    ...(folder ? { Parent: parent } : { Length: node.size, DirectoryName: parent })
  }
  return {
    ...psObject(folder ? 'DirectoryInfo' : 'FileInfo', props, {
      kind: 'table',
      props: ['Mode', 'LastWriteTime', 'Length', 'Name'],
      render: renderItems
    }),
    text: display
  }
}

/** Rendu « Répertoire : … » des objets FileInfo / DirectoryInfo. */
function renderItems(objects: PsObject[]): string[] {
  const lines: string[] = []
  let current = ''
  for (const o of objects) {
    const full = str(getProp(o, 'FullName'))
    const parent = full.split('\\').slice(0, -1).join('\\') || full
    if (parent !== current) {
      current = parent
      lines.push(
        '',
        `    Répertoire : ${parent}`,
        '',
        '',
        'Mode                 LastWriteTime         Length Name',
        '----                 -------------         ------ ----'
      )
    }
    const [date = '', time = ''] = str(getProp(o, 'LastWriteTime')).split(' ')
    const length = getProp(o, 'Length')
    lines.push(
      `${str(getProp(o, 'Mode'))}        ${date}     ${time.slice(0, 5)}  ${(length === null ? '' : formatBytes(Number(length))).padStart(13)} ${str(getProp(o, 'Name'))}`
    )
  }
  if (lines.length > 0) lines.push('')
  return lines
}

const ENCODING: ParamDef = { name: 'Encoding', type: 'string', validateSet: [...FILE_ENCODINGS] }

/** Paramètres communs de Set-Content et Add-Content. */
const SET_PARAMS: ParamDef[] = [
  { name: 'Path', type: 'string', position: 0, mandatory: true },
  { name: 'Value', type: 'any', position: 1, mandatory: true, pipeline: true },
  ENCODING,
  { name: 'NoNewline', type: 'switch' },
  { name: 'PassThru', type: 'switch' },
  { name: 'Force', type: 'switch' },
  ...unsimulated(['LiteralPath', 'Filter', 'Include', 'Exclude', 'Credential', 'Stream'])
]
const SET_UNSIMULATED = ['LiteralPath', 'Filter', 'Include', 'Exclude', 'Credential', 'Stream']

function setOrAdd(name: string, append: boolean): CmdletDef['run'] {
  return (ctx, args, input) => {
    rejectUnsimulated(name, args, SET_UNSIMULATED)
    const values = args['Value'] !== undefined ? [args['Value']] : input
    const text = joinValues(values, args['NoNewline'] === true)
    const encoding = (str(args['Encoding']) || 'Default') as FileEncoding
    write(ctx, str(args['Path']), text, { append, encoding })
    return args['PassThru'] === true ? flatten(values).map(psToString) : []
  }
}

const GET_UNSIMULATED = [
  'LiteralPath',
  'Filter',
  'Include',
  'Exclude',
  'Credential',
  'Stream',
  'Wait',
  'Delimiter',
  'ReadCount'
]

export const contentCmdlets: CmdletDef[] = [
  {
    name: 'Get-Content',
    aliases: ['cat', 'gc', 'type'],
    module: 'Management',
    synopsis: 'Obtient le contenu d’un fichier, ligne par ligne.',
    params: [
      { name: 'Path', type: 'string', position: 0, mandatory: true },
      { name: 'TotalCount', type: 'int', aliases: ['First', 'Head'] },
      { name: 'Tail', type: 'int', aliases: ['Last'] },
      { name: 'Raw', type: 'switch' },
      ENCODING,
      { name: 'Force', type: 'switch' },
      ...unsimulated(GET_UNSIMULATED)
    ],
    run(ctx, args) {
      rejectUnsimulated('Get-Content', args, GET_UNSIMULATED)
      const { node } = readableFile(ctx, str(args['Path']))
      const text = node.content ?? ''
      if (args['Raw'] === true) return text === '' ? [] : [text]
      let lines = contentLines(text)
      if (args['TotalCount'] !== undefined && Number(args['TotalCount']) >= 0)
        lines = lines.slice(0, Number(args['TotalCount']))
      if (args['Tail'] !== undefined && Number(args['Tail']) >= 0)
        lines = Number(args['Tail']) === 0 ? [] : lines.slice(-Number(args['Tail']))
      return lines
    }
  },
  {
    name: 'Set-Content',
    aliases: ['sc'],
    module: 'Management',
    synopsis: 'Écrit ou remplace le contenu d’un fichier.',
    params: SET_PARAMS,
    run: setOrAdd('Set-Content', false)
  },
  {
    name: 'Add-Content',
    aliases: ['ac'],
    module: 'Management',
    synopsis: 'Ajoute du contenu à la fin d’un fichier.',
    params: SET_PARAMS,
    run: setOrAdd('Add-Content', true)
  },
  {
    name: 'Out-File',
    module: 'Utility',
    synopsis: 'Envoie la sortie (mise en forme comme dans la console) dans un fichier.',
    params: [
      { name: 'FilePath', type: 'string', position: 0, mandatory: true, aliases: ['Path'] },
      { ...ENCODING, position: 1 },
      { name: 'Append', type: 'switch' },
      { name: 'NoClobber', type: 'switch', aliases: ['NoOverwrite'] },
      { name: 'NoNewline', type: 'switch' },
      { name: 'Force', type: 'switch' },
      { name: 'InputObject', type: 'any', pipeline: true },
      ...unsimulated(['LiteralPath', 'Width'])
    ],
    run(ctx, args, input) {
      rejectUnsimulated('Out-File', args, ['LiteralPath', 'Width'])
      const path = str(args['FilePath'])
      const t = target(ctx, path)
      if (args['NoClobber'] === true && args['Append'] !== true && nodeAt(t) !== undefined)
        // Libellé à vérifier (aucune sortie française de référence sur Learn)
        throw psError(
          `Le fichier « ${t.display} » existe déjà.`,
          'ResourceExists',
          'NoClobber',
          t.display,
          'IOException'
        )
      const values = args['InputObject'] !== undefined ? [args['InputObject']] : input
      const lines = formatDefault(values)
      const text =
        args['NoNewline'] === true
          ? flatten(values).map(psToString).join('')
          : lines.map((l) => `${l}\r\n`).join('')
      // Encodage par défaut d'Out-File dans Windows PowerShell 5.1 : Unicode (UTF-16 LE)
      const encoding = (str(args['Encoding']) || 'Unicode') as FileEncoding
      write(ctx, path, text, { append: args['Append'] === true, encoding })
      return []
    }
  },
  {
    name: 'Test-Path',
    module: 'Management',
    synopsis: 'Indique si un chemin existe (True / False).',
    params: [
      { name: 'Path', type: 'string', position: 0, mandatory: true },
      { name: 'PathType', type: 'string', aliases: ['Type'], validateSet: ['Any', 'Container', 'Leaf'] },
      { name: 'IsValid', type: 'switch' },
      ...unsimulated(['LiteralPath', 'Filter', 'Include', 'Exclude', 'Credential', 'NewerThan', 'OlderThan'])
    ],
    run(ctx, args) {
      rejectUnsimulated('Test-Path', args, [
        'LiteralPath',
        'Filter',
        'Include',
        'Exclude',
        'Credential',
        'NewerThan',
        'OlderThan'
      ])
      const r = translatePath(ctx, str(args['Path']))
      if (args['IsValid'] === true) return [r.ok]
      if (!r.ok) return [false]
      const node = nodeAt(r.target)
      if (node === undefined) return [false]
      const type = str(args['PathType']) || 'Any'
      const folder = node === null || node.kind === 'folder'
      return [type === 'Any' || (type === 'Container') === folder]
    }
  },
  {
    name: 'Get-Item',
    aliases: ['gi'],
    module: 'Management',
    synopsis: 'Obtient un fichier ou un dossier (sans son contenu).',
    params: [
      { name: 'Path', type: 'string', position: 0, mandatory: true },
      { name: 'Force', type: 'switch' },
      ...unsimulated(['LiteralPath', 'Filter', 'Include', 'Exclude', 'Credential', 'Stream'])
    ],
    run(ctx, args) {
      rejectUnsimulated('Get-Item', args, SET_UNSIMULATED)
      const t = target(ctx, str(args['Path']))
      const node = nodeAt(t)
      if (node === undefined) throw notFound(t.display)
      return [itemObject(t.display.replace(/\\$/, '') || t.display, node)]
    }
  },
  {
    name: 'Copy-Item',
    aliases: ['copy', 'cp', 'cpi'],
    module: 'Management',
    synopsis: 'Copie un fichier ou un dossier.',
    params: [
      { name: 'Path', type: 'string', position: 0, mandatory: true },
      { name: 'Destination', type: 'string', position: 1 },
      { name: 'Recurse', type: 'switch' },
      { name: 'Force', type: 'switch' },
      { name: 'PassThru', type: 'switch' },
      ...unsimulated([
        'LiteralPath',
        'Filter',
        'Include',
        'Exclude',
        'Credential',
        'Container',
        'ToSession',
        'FromSession'
      ])
    ],
    run(ctx, args) {
      rejectUnsimulated('Copy-Item', args, [
        'LiteralPath',
        'Filter',
        'Include',
        'Exclude',
        'Credential',
        'Container',
        'ToSession',
        'FromSession'
      ])
      const src = target(ctx, str(args['Path']))
      if (nodeAt(src) === undefined) throw notFound(src.display)
      // Destination par défaut : dossier courant
      const dst = target(ctx, args['Destination'] !== undefined ? str(args['Destination']) : '.')
      if (dst.server.id !== src.server.id)
        throw psError(
          'La copie entre deux serveurs n’est pas simulée dans ServerLab.',
          'NotImplemented',
          'UnsimulatedCopy'
        )
      let createdId = ''
      applyFs(ctx, src.display, () => {
        const r = copyItem(ctx.state, src.server.id, src.localPath, dst.localPath, shellToken(ctx), {
          recurse: args['Recurse'] === true,
          ...shareOpt(src),
          ...(dst.share ? { destinationShare: dst.share.name } : {})
        })
        if (r.ok) createdId = r.value
        return r
      })
      if (args['PassThru'] !== true) return []
      const server = freshServer(ctx, src)
      const node = server.storage.nodes.find((n) => n.id === createdId) ?? null
      const existing = nodeAt(dst)
      const display =
        existing === null || existing?.kind === 'folder'
          ? `${dst.display.replace(/\\$/, '')}\\${node?.name ?? ''}`
          : dst.display
      return [itemObject(display, node)]
    }
  },
  {
    name: 'Rename-Item',
    aliases: ['ren', 'rni'],
    module: 'Management',
    synopsis: 'Renomme un fichier ou un dossier.',
    params: [
      { name: 'Path', type: 'string', position: 0, mandatory: true },
      { name: 'NewName', type: 'string', position: 1, mandatory: true },
      { name: 'Force', type: 'switch' },
      { name: 'PassThru', type: 'switch' },
      ...unsimulated(['LiteralPath', 'Credential'])
    ],
    run(ctx, args) {
      rejectUnsimulated('Rename-Item', args, ['LiteralPath', 'Credential'])
      const t = target(ctx, str(args['Path']))
      if (nodeAt(t) === undefined) throw notFound(t.display)
      const newName = str(args['NewName'])
      applyFs(ctx, t.display, () =>
        renameItem(ctx.state, t.server.id, t.localPath, newName, shellToken(ctx), shareOpt(t))
      )
      if (args['PassThru'] !== true) return []
      const display = `${t.display.split('\\').slice(0, -1).join('\\')}\\${newName}`
      const renamed = nodeAt({
        ...t,
        server: freshServer(ctx, t),
        localPath: `${t.localPath.split('\\').slice(0, -1).join('\\')}\\${newName}`
      })
      return [itemObject(display, renamed ?? null)]
    }
  }
]
