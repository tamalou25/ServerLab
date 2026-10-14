/**
 * Opérations sur les fichiers et les partages d'un serveur, soumises aux autorisations du jeton
 * de l'utilisateur : création, suppression, ACL NTFS (onglet Sécurité, icacls), héritage,
 * partages SMB (New-SmbShare, net share, Partage avancé).
 * Avec `share`, l'opération passe par un partage : droits effectifs = partage ∩ NTFS.
 */
import type { Draft } from 'immer'
import { raise, transact, type EngineResult } from '../../core/result'
import { nextSeq } from '../../model/factory'
import type {
  FsNode,
  LabState,
  NtfsAce,
  NtfsRight,
  ServerDevice,
  ShareAce,
  ShareRight,
  SmbShare,
  Storage
} from '../../model/schema'
import { MAX_FILE_CONTENT, WELL_KNOWN_SIDS } from '../../model/schema'
import { requireDevice } from '../../topology/actions'
import { accessPerms, effectiveAcl, resolvePrincipal, type AccessToken, type Perm } from './acl'
import { findNode, isWithin, normalizeItemName, splitLocalPath, validItemName } from './paths'

export const ACCESS_DENIED = 'Accès refusé.'
export const PATH_NOT_FOUND = 'Le chemin d’accès spécifié est introuvable.'
export const BAD_PATH = 'La syntaxe du nom de fichier, de répertoire ou de volume est incorrecte.'
export const UNKNOWN_ACCOUNT =
  'Aucun mappage entre les noms de compte et les ID de sécurité n’a été effectué.'

/** Partages administratifs présents sur tout serveur (masqués, réservés aux administrateurs). */
export function adminShares(server: ServerDevice): (SmbShare & { special: true; path: string })[] {
  const admins: ShareAce[] = [{ principal: WELL_KNOWN_SIDS.administrators, type: 'Allow', rights: 'Full' }]
  const windows = server.storage.nodes.find((n) => n.id === 'fs-windows')
  return [
    {
      name: 'ADMIN$',
      folderId: windows?.id ?? '',
      description: 'Administration à distance',
      acl: admins,
      special: true,
      path: 'C:\\Windows'
    },
    { name: 'C$', folderId: '', description: 'Partage par défaut', acl: admins, special: true, path: 'C:\\' },
    { name: 'IPC$', folderId: '', description: 'IPC distant', acl: [], special: true, path: '' }
  ]
}

/** Dossier d'un partage (null = racine du volume, pour C$). */
export function shareFolderId(share: SmbShare): string | null {
  return share.folderId === '' ? null : share.folderId
}

/** Partage d'un serveur par nom (partages créés puis partages administratifs). */
export function findShare(server: ServerDevice, name: string): SmbShare | undefined {
  const lower = name.toLowerCase()
  return (
    server.storage.shares.find((s) => s.name.toLowerCase() === lower) ??
    adminShares(server).find((s) => s.name.toLowerCase() === lower && s.name !== 'IPC$')
  )
}

function requireServer(draft: Draft<LabState>, serverId: string): Draft<ServerDevice> {
  const device = requireDevice(draft, serverId)
  if (device.kind !== 'server') raise('NotServer', 'Le stockage simulé n’existe que sur les serveurs.')
  if (!device.powered) raise('PoweredOff', `${device.name} est éteint.`)
  return device
}

/** Nœud existant (null = racine) ou erreur « chemin introuvable ». */
function requireNode(storage: Storage, path: string): FsNode | null {
  if (splitLocalPath(path) === null) raise('InvalidPath', BAD_PATH)
  const node = findNode(storage, path)
  if (node === undefined) raise('PathNotFound', PATH_NOT_FOUND)
  return node
}

/** Vérifie un droit, éventuellement au travers d'un partage. */
function demand(
  storage: Storage,
  nodeId: string | null,
  token: AccessToken,
  perm: Perm,
  share?: SmbShare
): void {
  if (share && !isWithin(storage, nodeId, shareFolderId(share))) raise('AccessDenied', ACCESS_DENIED)
  if (!accessPerms(storage, nodeId, token, share).has(perm)) raise('AccessDenied', ACCESS_DENIED)
}

function shareOf(server: ServerDevice, name: string | undefined): SmbShare | undefined {
  if (!name) return undefined
  const share = findShare(server, name)
  if (!share) raise('NetworkNameNotFound', 'Le nom de réseau est introuvable.')
  return share
}

/** Propriétaire d'un nouvel élément : Administrateurs pour un administrateur, sinon le compte. */
function ownerOf(token: AccessToken): string {
  return token.admin ? WELL_KNOWN_SIDS.administrators : (token.sids[0] ?? WELL_KNOWN_SIDS.administrators)
}

export interface CreateOptions {
  /** Crée les dossiers parents manquants (mkdir, New-Item). */
  parents?: boolean
  /** Opération au travers de ce partage (accès réseau). */
  share?: string
  size?: number
}

/** Crée un dossier ou un fichier ; renvoie son identifiant. */
export function createItem(
  state: LabState,
  serverId: string,
  path: string,
  kind: 'folder' | 'file',
  token: AccessToken,
  options: CreateOptions = {}
): EngineResult<string> {
  return transact(state, (draft) => {
    const server = requireServer(draft, serverId)
    const storage = server.storage
    const share = shareOf(server as ServerDevice, options.share)
    const parts = splitLocalPath(path)
    if (!parts || parts.length === 0) raise('InvalidPath', BAD_PATH)
    const name = normalizeItemName(parts[parts.length - 1] as string)
    if (!validItemName(name)) raise('InvalidName', BAD_PATH)
    let parentId: string | null = null
    for (const part of parts.slice(0, -1)) {
      const existing: FsNode | undefined = storage.nodes.find(
        (n) => n.parentId === parentId && n.name.toLowerCase() === part.toLowerCase()
      )
      if (existing) {
        if (existing.kind !== 'folder') raise('PathNotFound', PATH_NOT_FOUND)
        parentId = existing.id
        continue
      }
      if (!options.parents) raise('PathNotFound', PATH_NOT_FOUND)
      demand(storage as Storage, parentId, token, 'write', share)
      const id = `fs${nextSeq(draft)}`
      storage.nodes.push(newNode(id, part, parentId, 'folder', token, draft.clock))
      parentId = id
    }
    if (storage.nodes.some((n) => n.parentId === parentId && n.name.toLowerCase() === name.toLowerCase()))
      raise('ItemExists', `Un élément nommé « ${name} » existe déjà.`)
    demand(storage as Storage, parentId, token, 'write', share)
    const id = `fs${nextSeq(draft)}`
    storage.nodes.push({ ...newNode(id, name, parentId, kind, token, draft.clock), size: options.size ?? 0 })
    return id
  })
}

/**
 * Crée au besoin un chemin local (dossiers parents compris) sur un brouillon de serveur, sans
 * contrôle d'autorisation : préparation du système (installation d'un rôle). Renvoie l'élément final.
 */
export function ensureLocalPath(
  draft: Draft<LabState>,
  server: Draft<ServerDevice>,
  path: string,
  kind: 'folder' | 'file',
  size = 0
): string {
  const parts = splitLocalPath(path)
  if (!parts || parts.length === 0) raise('InvalidPath', BAD_PATH)
  let parentId: string | null = null
  parts.forEach((part, index) => {
    const existing = server.storage.nodes.find(
      (n) => n.parentId === parentId && n.name.toLowerCase() === part.toLowerCase()
    )
    if (existing) {
      parentId = existing.id
      return
    }
    const last = index === parts.length - 1
    const id = `fs${nextSeq(draft)}`
    const node = newNode(id, part, parentId, last ? kind : 'folder', SYSTEM_TOKEN, draft.clock)
    server.storage.nodes.push({ ...node, size: last && kind === 'file' ? size : 0 })
    parentId = id
  })
  return parentId as unknown as string
}

/** Propriétaire des éléments créés par le système (groupe Administrateurs). */
const SYSTEM_TOKEN: AccessToken = {
  account: 'BUILTIN\\Administrateurs',
  sids: [WELL_KNOWN_SIDS.administrators],
  admin: true
}

function newNode(
  id: string,
  name: string,
  parentId: string | null,
  kind: 'folder' | 'file',
  token: AccessToken,
  clock: number
): FsNode {
  return {
    id,
    name,
    parentId,
    kind,
    size: 0,
    acl: [],
    inherits: true,
    owner: ownerOf(token),
    modifiedAt: clock,
    system: false
  }
}

/** Supprime un élément (récursivement avec `recurse`) ; les partages du dossier sont arrêtés. */
export function removeItem(
  state: LabState,
  serverId: string,
  path: string,
  token: AccessToken,
  options: { recurse?: boolean; share?: string } = {}
): EngineResult {
  return transact(state, (draft) => {
    const server = requireServer(draft, serverId)
    const storage = server.storage
    const share = shareOf(server as ServerDevice, options.share)
    const node = requireNode(storage as Storage, path)
    if (!node) raise('AccessDenied', ACCESS_DENIED)
    if (node.system) raise('AccessDenied', ACCESS_DENIED)
    const ids = new Set([node.id])
    let changed = true
    while (changed) {
      changed = false
      for (const n of storage.nodes)
        if (n.parentId && ids.has(n.parentId) && !ids.has(n.id)) {
          ids.add(n.id)
          changed = true
        }
    }
    if (ids.size > 1 && !options.recurse) raise('NotEmpty', 'Le répertoire n’est pas vide.')
    for (const id of ids) demand(storage as Storage, id, token, 'delete', share)
    storage.nodes = storage.nodes.filter((n) => !ids.has(n.id))
    storage.shares = storage.shares.filter((s) => !ids.has(s.folderId))
    return undefined
  })
}

/**
 * Encodages des cmdlets de contenu de Windows PowerShell 5.1 (paramètre -Encoding de Set-Content,
 * Add-Content, Out-File, Export-Csv) :
 * https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/set-content?view=powershell-5.1
 */
export const FILE_ENCODINGS = [
  'ASCII',
  'BigEndianUnicode',
  'BigEndianUTF32',
  'Default',
  'OEM',
  'String',
  'Unicode',
  'Unknown',
  'UTF7',
  'UTF8',
  'UTF32'
] as const
export type FileEncoding = (typeof FILE_ENCODINGS)[number]

/** Octets d'un texte en UTF-8. */
function utf8Bytes(text: string): number {
  let n = 0
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4
  }
  return n
}

/**
 * Taille en octets d'un texte encodé : UTF-16 (Unicode, BigEndianUnicode), UTF-32 et UTF-8 de
 * Windows PowerShell 5.1 précédés de leur marque d'ordre des octets (BOM) ; ASCII, Default (ANSI),
 * OEM : un octet par caractère. `bom` = faux pour un ajout à un fichier existant.
 */
export function encodedSize(text: string, encoding: FileEncoding, bom = true): number {
  switch (encoding) {
    case 'Unicode':
    case 'BigEndianUnicode':
    case 'String':
    case 'Unknown':
      return (bom ? 2 : 0) + text.length * 2
    case 'UTF32':
    case 'BigEndianUTF32':
      return (bom ? 4 : 0) + [...text].length * 4
    case 'UTF8':
      return (bom ? 3 : 0) + utf8Bytes(text)
    case 'UTF7':
      return utf8Bytes(text)
    default:
      return [...text].length
  }
}

export interface WriteContentOptions {
  /** Ajoute à la fin du contenu existant (Add-Content, Out-File -Append). */
  append?: boolean
  /** Encodage de l'écriture (taille du fichier) ; ANSI (Default) par défaut. */
  encoding?: FileEncoding
  /** Opération au travers de ce partage (accès réseau). */
  share?: string
}

/**
 * Écrit le contenu texte d'un fichier, créé s'il n'existe pas dans un dossier existant
 * (Set-Content, Add-Content, Out-File). Exige l'écriture sur le fichier, ou sur le dossier parent
 * pour une création. Renvoie l'identifiant du fichier.
 */
export function writeFileContent(
  state: LabState,
  serverId: string,
  path: string,
  text: string,
  token: AccessToken,
  options: WriteContentOptions = {}
): EngineResult<string> {
  const encoding = options.encoding ?? 'Default'
  return transact(state, (draft) => {
    const server = requireServer(draft, serverId)
    const storage = server.storage
    const share = shareOf(server as ServerDevice, options.share)
    const parts = splitLocalPath(path)
    if (!parts || parts.length === 0) raise('InvalidPath', BAD_PATH)
    const existing = findNode(storage as Storage, path)
    if (existing === null || existing?.kind === 'folder') raise('AccessDenied', ACCESS_DENIED)
    let target: Draft<FsNode>
    if (existing === undefined) {
      const parentPath = `C:\\${parts.slice(0, -1).join('\\')}`
      const parent = findNode(storage as Storage, parentPath)
      if (parent === undefined || parent?.kind === 'file') raise('PathNotFound', PATH_NOT_FOUND)
      const name = normalizeItemName(parts[parts.length - 1] as string)
      if (!validItemName(name)) raise('InvalidName', BAD_PATH)
      demand(storage as Storage, parent?.id ?? null, token, 'write', share)
      target = newNode(`fs${nextSeq(draft)}`, name, parent?.id ?? null, 'file', token, draft.clock)
      storage.nodes.push(target)
      target = storage.nodes[storage.nodes.length - 1] as Draft<FsNode>
    } else {
      demand(storage as Storage, existing.id, token, 'write', share)
      target = storage.nodes.find((n) => n.id === existing.id) as Draft<FsNode>
    }
    const append = options.append === true && existing !== undefined
    const content = append ? `${target.content ?? ''}${text}` : text
    if (content.length > MAX_FILE_CONTENT)
      raise(
        'ContentTooLarge',
        `Le contenu dépasse la taille maximale d’un fichier simulé (${MAX_FILE_CONTENT} caractères, limite de ServerLab).`
      )
    target.content = content
    target.size = append ? target.size + encodedSize(text, encoding, false) : encodedSize(text, encoding)
    target.modifiedAt = draft.clock
    return target.id
  })
}

/** ACL explicite modifiable d'un élément (racine : ACL du volume). */
function aclOf(storage: Draft<Storage>, node: FsNode | null): Draft<NtfsAce>[] {
  if (!node) return storage.rootAcl
  return (storage.nodes.find((n) => n.id === node.id) as Draft<FsNode>).acl
}

function setAcl(storage: Draft<Storage>, node: FsNode | null, acl: NtfsAce[]): void {
  if (!node) storage.rootAcl = acl
  else (storage.nodes.find((n) => n.id === node.id) as Draft<FsNode>).acl = acl
}

/** Droits NTFS minimaux équivalents à une sélection de cases (Contrôle total implique tout…). */
export function minimalRights(rights: NtfsRight[]): NtfsRight[] {
  const set = new Set(rights)
  if (set.has('FullControl')) return ['FullControl']
  if (set.has('Modify')) return ['Modify']
  const result: NtfsRight[] = []
  if (set.has('ReadAndExecute')) result.push('ReadAndExecute')
  else {
    if (set.has('ListDirectory')) result.push('ListDirectory')
    if (set.has('Read')) result.push('Read')
  }
  if (set.has('Write')) result.push('Write')
  return result
}

export interface AceChange {
  principal: string
  type: 'Allow' | 'Deny'
  rights: NtfsRight[]
  /** Remplace les entrées existantes de ce type pour ce compte (icacls /grant:r, onglet Sécurité). */
  replace?: boolean
}

/** Ajoute (ou remplace) des autorisations NTFS explicites ; `principal` est un nom de compte. */
export function grantNtfs(
  state: LabState,
  serverId: string,
  path: string,
  change: AceChange,
  token: AccessToken
): EngineResult {
  return transact(state, (draft) => {
    const server = requireServer(draft, serverId)
    const storage = server.storage
    const node = requireNode(storage as Storage, path)
    demand(storage as Storage, node?.id ?? null, token, 'changePermissions')
    const principal = resolvePrincipal(draft as LabState, server as ServerDevice, change.principal)
    if (!principal) raise('UnknownAccount', UNKNOWN_ACCOUNT)
    let acl = [...aclOf(storage, node)] as NtfsAce[]
    if (change.replace) acl = acl.filter((a) => !(a.principal === principal && a.type === change.type))
    for (const rights of minimalRights(change.rights))
      if (!acl.some((a) => a.principal === principal && a.type === change.type && a.rights === rights))
        acl.push({ principal, type: change.type, rights })
    setAcl(storage, node, acl)
    return undefined
  })
}

/** Retire les autorisations explicites d'un compte (toutes, ou seulement autoriser / refuser). */
export function removeNtfs(
  state: LabState,
  serverId: string,
  path: string,
  account: string,
  type: 'Allow' | 'Deny' | 'all',
  token: AccessToken
): EngineResult {
  return transact(state, (draft) => {
    const server = requireServer(draft, serverId)
    const storage = server.storage
    const node = requireNode(storage as Storage, path)
    demand(storage as Storage, node?.id ?? null, token, 'changePermissions')
    const acl = aclOf(storage, node) as NtfsAce[]
    // Entrée d'un compte supprimé (SID inconnu) : désignée par son identifiant, elle reste retirable
    const orphan = acl.some((a) => a.principal === account) ? account : undefined
    const principal = orphan ?? resolvePrincipal(draft as LabState, server as ServerDevice, account)
    if (!principal) raise('UnknownAccount', UNKNOWN_ACCOUNT)
    setAcl(
      storage,
      node,
      acl.filter((a) => !(a.principal === principal && (type === 'all' || a.type === type)))
    )
    return undefined
  })
}

/** Remplace toutes les autorisations explicites d'une identité (cases de l'onglet Sécurité). */
export function setNtfsEntry(
  state: LabState,
  serverId: string,
  path: string,
  principal: string,
  rights: { allow: NtfsRight[]; deny: NtfsRight[] },
  token: AccessToken
): EngineResult {
  return transact(state, (draft) => {
    const server = requireServer(draft, serverId)
    const storage = server.storage
    const node = requireNode(storage as Storage, path)
    demand(storage as Storage, node?.id ?? null, token, 'changePermissions')
    const acl = (aclOf(storage, node) as NtfsAce[]).filter((a) => a.principal !== principal)
    for (const r of minimalRights(rights.deny)) acl.push({ principal, type: 'Deny', rights: r })
    for (const r of minimalRights(rights.allow)) acl.push({ principal, type: 'Allow', rights: r })
    setAcl(storage, node, acl)
    return undefined
  })
}

/**
 * Héritage : `enable` le réactive ; `convert` le désactive en copiant les autorisations héritées ;
 * `remove` le désactive en supprimant les autorisations héritées.
 */
export function setNtfsInheritance(
  state: LabState,
  serverId: string,
  path: string,
  mode: 'enable' | 'convert' | 'remove',
  token: AccessToken
): EngineResult {
  return transact(state, (draft) => {
    const server = requireServer(draft, serverId)
    const storage = server.storage
    const node = requireNode(storage as Storage, path)
    if (!node) raise('InvalidOperation', 'La racine du volume n’hérite d’aucune autorisation.')
    demand(storage as Storage, node.id, token, 'changePermissions')
    const target = storage.nodes.find((n) => n.id === node.id) as Draft<FsNode>
    if (mode === 'enable') {
      target.inherits = true
      return undefined
    }
    if (mode === 'convert' && target.inherits) {
      const inherited = effectiveAcl(storage as Storage, node.id)
        .filter((e) => e.inherited)
        .map((e) => ({ ...e.ace }))
      for (const ace of inherited)
        if (
          !target.acl.some(
            (a) => a.principal === ace.principal && a.type === ace.type && a.rights === ace.rights
          )
        )
          target.acl.push(ace)
    }
    target.inherits = false
    return undefined
  })
}

const SHARE_NAME_INVALID = /[\\/[\]:|<>+=;,?*"]/

export interface ShareInput {
  name: string
  path: string
  description?: string
  /** Comptes par niveau d'autorisation (noms : LAB\GG_Compta, Tout le monde…). */
  full?: string[]
  change?: string[]
  read?: string[]
  noAccess?: string[]
}

/** Crée un partage (réservé aux administrateurs du serveur). */
export function createShare(
  state: LabState,
  serverId: string,
  input: ShareInput,
  token: AccessToken
): EngineResult {
  return transact(state, (draft) => {
    const server = requireServer(draft, serverId)
    if (!token.admin) raise('AccessDenied', ACCESS_DENIED)
    const name = input.name.trim()
    if (!name || name.length > 80 || SHARE_NAME_INVALID.test(name))
      raise('InvalidName', `Le nom de partage « ${input.name} » n’est pas valide.`)
    if (findShare(server as ServerDevice, name))
      raise('ShareExists', 'Le nom de partage existe déjà sur ce serveur.')
    const node = requireNode(server.storage as Storage, input.path)
    if (!node || node.kind !== 'folder')
      raise('InvalidPath', 'Seul un dossier du volume (autre que la racine) peut être partagé.')
    const acl: ShareAce[] = []
    const add = (names: string[] | undefined, type: 'Allow' | 'Deny', rights: ShareRight) => {
      for (const n of names ?? []) {
        const principal = resolvePrincipal(draft as LabState, server as ServerDevice, n)
        if (!principal) raise('UnknownAccount', UNKNOWN_ACCOUNT)
        acl.push({ principal, type, rights })
      }
    }
    add(input.noAccess, 'Deny', 'Full')
    add(input.full, 'Allow', 'Full')
    add(input.change, 'Allow', 'Change')
    add(input.read, 'Allow', 'Read')
    server.storage.shares.push({
      name,
      folderId: node.id,
      description: input.description ?? '',
      acl: acl.length > 0 ? acl : [{ principal: WELL_KNOWN_SIDS.everyone, type: 'Allow', rights: 'Read' }]
    })
    return undefined
  })
}

function requireOwnShare(server: Draft<ServerDevice>, name: string): Draft<SmbShare> {
  const share = server.storage.shares.find((s) => s.name.toLowerCase() === name.trim().toLowerCase())
  if (!share) {
    if (adminShares(server as ServerDevice).some((s) => s.name.toLowerCase() === name.trim().toLowerCase()))
      raise('SpecialShare', 'Les partages administratifs ne peuvent pas être modifiés.')
    raise('ShareNotFound', 'Le nom de réseau est introuvable.')
  }
  return share
}

export function removeShare(
  state: LabState,
  serverId: string,
  name: string,
  token: AccessToken
): EngineResult {
  return transact(state, (draft) => {
    const server = requireServer(draft, serverId)
    if (!token.admin) raise('AccessDenied', ACCESS_DENIED)
    const share = requireOwnShare(server, name)
    server.storage.shares = server.storage.shares.filter((s) => s !== share)
    return undefined
  })
}

/**
 * Autorisation de partage d'un compte : `rights` null = révoquer (toutes ses entrées),
 * type Deny = bloquer (Block-SmbShareAccess), Allow = accorder (Grant-SmbShareAccess).
 */
export function setShareAccess(
  state: LabState,
  serverId: string,
  name: string,
  account: string,
  change: { type: 'Allow' | 'Deny'; rights: ShareRight } | null,
  token: AccessToken
): EngineResult {
  return transact(state, (draft) => {
    const server = requireServer(draft, serverId)
    if (!token.admin) raise('AccessDenied', ACCESS_DENIED)
    const share = requireOwnShare(server, name)
    const principal = resolvePrincipal(draft as LabState, server as ServerDevice, account)
    if (!principal) raise('UnknownAccount', UNKNOWN_ACCOUNT)
    share.acl = share.acl.filter(
      (a) => a.principal !== principal || (change !== null && a.type !== change.type)
    )
    if (change) share.acl.push({ principal, type: change.type, rights: change.rights })
    return undefined
  })
}

/** Retire les entrées « autoriser » (Revoke) ou « refuser » (Unblock) d'un compte sur un partage. */
export function revokeShareAccess(
  state: LabState,
  serverId: string,
  name: string,
  account: string,
  type: 'Allow' | 'Deny',
  token: AccessToken
): EngineResult {
  return transact(state, (draft) => {
    const server = requireServer(draft, serverId)
    if (!token.admin) raise('AccessDenied', ACCESS_DENIED)
    const share = requireOwnShare(server, name)
    const principal = resolvePrincipal(draft as LabState, server as ServerDevice, account)
    if (!principal) raise('UnknownAccount', UNKNOWN_ACCOUNT)
    share.acl = share.acl.filter((a) => !(a.principal === principal && a.type === type))
    return undefined
  })
}

/** Remplace l'ACL d'un partage (boîte « Autorisations » du Partage avancé). */
export function setShareAcl(
  state: LabState,
  serverId: string,
  name: string,
  acl: ShareAce[],
  token: AccessToken
): EngineResult {
  return transact(state, (draft) => {
    const server = requireServer(draft, serverId)
    if (!token.admin) raise('AccessDenied', ACCESS_DENIED)
    requireOwnShare(server, name).acl = acl
    return undefined
  })
}
