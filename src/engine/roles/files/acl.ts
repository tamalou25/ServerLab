/**
 * Autorisations : jetons d'accès (identités d'un compte), ACL NTFS effectives (explicites puis
 * héritées, dans l'ordre canonique), autorisations de partage et accès effectif.
 *
 * Règles simulées, comme sur un vrai serveur :
 * - NTFS : pour chaque droit, la première entrée applicable l'emporte dans l'ordre
 *   « refus explicite, autorisation explicite, refus hérité du parent, autorisation héritée… » ;
 * - partage : cumul des autorisations de tous les groupes, un refus l'emporte toujours ;
 * - accès réseau = le plus restrictif des deux (intersection).
 */
import { isLocalAdmin } from '../../services/localaccounts'
import type {
  Device,
  Domain,
  LabState,
  NtfsAce,
  NtfsRight,
  ShareRight,
  SmbShare,
  Storage
} from '../../model/schema'
import { NTFS_RIGHTS, WELL_KNOWN_SIDS } from '../../model/schema'
import { AD_GROUPS, findPrincipal, groupsOf, isDomainAdmin, objectById } from '../adds/directory'
import { nodePath } from './paths'

/** Droits élémentaires évalués (vue « Accès effectif »). */
export const PERMS = [
  'list',
  'read',
  'execute',
  'write',
  'delete',
  'changePermissions',
  'takeOwnership'
] as const
export type Perm = (typeof PERMS)[number]

export const PERM_LABELS: Record<Perm, string> = {
  list: 'Afficher le contenu du dossier',
  read: 'Lecture de données',
  execute: 'Parcours du dossier / exécution du fichier',
  write: 'Création de fichiers / écriture de données',
  delete: 'Suppression',
  changePermissions: 'Modifier les autorisations',
  takeOwnership: 'Appropriation'
}

const ALL: Perm[] = [...PERMS]
const CHANGE: Perm[] = ['list', 'read', 'execute', 'write', 'delete']

export const NTFS_PERMS: Record<NtfsRight, Perm[]> = {
  FullControl: ALL,
  Modify: CHANGE,
  ReadAndExecute: ['list', 'read', 'execute'],
  ListDirectory: ['list', 'execute'],
  Read: ['list', 'read'],
  Write: ['write']
}

export const SHARE_PERMS: Record<ShareRight, Perm[]> = {
  Full: ALL,
  Change: CHANGE,
  Read: ['list', 'read', 'execute']
}

export const NTFS_RIGHT_LABELS: Record<NtfsRight, string> = {
  FullControl: 'Contrôle total',
  Modify: 'Modification',
  ReadAndExecute: 'Lecture et exécution',
  ListDirectory: 'Affichage du contenu du dossier',
  Read: 'Lecture',
  Write: 'Écriture'
}

export const SHARE_RIGHT_LABELS: Record<ShareRight, string> = {
  Full: 'Contrôle total',
  Change: 'Modifier',
  Read: 'Lecture'
}

/** Identités d'un compte : SID bien connus et objets de l'annuaire (utilisateur, groupes). */
export interface AccessToken {
  /** Compte affiché (LAB\jdupont, SRV1\Administrateur). */
  account: string
  sids: string[]
  /** Membre des Administrateurs de l'ordinateur. */
  admin: boolean
  /** Identifiants SMB donnés à la connexion d'un serveur Samba (net use /user:, v2.9, #239). */
  smb?: { user: string; password: string }
}

const WK = WELL_KNOWN_SIDS

/** Jeton d'un compte du domaine (null si le compte n'existe pas ou est désactivé). */
export function domainToken(domain: Domain, sam: string): AccessToken | null {
  const user = domain.users.find((u) => u.sam.toLowerCase() === sam.toLowerCase())
  if (!user || !user.enabled) return null
  const admin = isDomainAdmin(domain, user.sam)
  return {
    account: `${domain.netbios}\\${user.sam}`,
    sids: [
      user.id,
      ...groupsOf(domain, user.id).map((g) => g.id),
      WK.everyone,
      WK.authenticatedUsers,
      WK.users,
      ...(admin ? [WK.administrators] : [])
    ],
    admin
  }
}

/**
 * Jeton d'un compte local (Administrateur ou utilisateur standard) d'un ordinateur ; `admin` :
 * membre du groupe local Administrateurs (base SAM, Lot 2b).
 */
export function localToken(
  hostName: string,
  user: string,
  admin = user.toLowerCase() === 'administrateur'
): AccessToken {
  return {
    account: `${hostName}\\${user}`,
    sids: [
      `local:${hostName.toLowerCase()}:${user.toLowerCase()}`,
      WK.everyone,
      WK.authenticatedUsers,
      WK.users,
      ...(admin ? [WK.administrators] : [])
    ],
    admin
  }
}

/** Jeton de la session ouverte sur un ordinateur (null : aucune session). */
export function sessionToken(state: LabState, hostId: string): AccessToken | null {
  const host = state.devices[hostId]
  if (!host || (host.kind !== 'server' && host.kind !== 'client') || !host.host.session) return null
  const session = host.host.session
  if (session.domain) {
    const domain = Object.values(state.domains).find(
      (d) => d.netbios.toUpperCase() === session.domain?.toUpperCase()
    )
    return domain ? domainToken(domain, session.user) : null
  }
  return localToken(host.name, session.user, isLocalAdmin(state, hostId, session.user))
}

/** Domaine dont un ordinateur est membre. */
export function domainOf(state: LabState, device: Device): Domain | undefined {
  return device.kind === 'server' || device.kind === 'client'
    ? device.host.domain
      ? state.domains[device.host.domain]
      : undefined
    : undefined
}

const WELL_KNOWN_NAMES: Record<string, string> = {
  [WK.everyone]: 'Tout le monde',
  [WK.creatorOwner]: 'CREATEUR PROPRIETAIRE',
  [WK.authenticatedUsers]: 'AUTORITE NT\\Utilisateurs authentifiés',
  [WK.system]: 'AUTORITE NT\\Système',
  [WK.administrators]: 'BUILTIN\\Administrateurs',
  [WK.users]: 'BUILTIN\\Utilisateurs'
}

/** Noms reconnus pour les SID bien connus (français et anglais). */
const WELL_KNOWN_ALIASES: Record<string, string> = {
  'tout le monde': WK.everyone,
  everyone: WK.everyone,
  'utilisateurs authentifiés': WK.authenticatedUsers,
  'authenticated users': WK.authenticatedUsers,
  'autorite nt\\utilisateurs authentifiés': WK.authenticatedUsers,
  'nt authority\\authenticated users': WK.authenticatedUsers,
  système: WK.system,
  system: WK.system,
  'autorite nt\\système': WK.system,
  'nt authority\\system': WK.system,
  administrateurs: WK.administrators,
  administrators: WK.administrators,
  'builtin\\administrateurs': WK.administrators,
  'builtin\\administrators': WK.administrators,
  utilisateurs: WK.users,
  users: WK.users,
  'builtin\\utilisateurs': WK.users,
  'builtin\\users': WK.users,
  'createur proprietaire': WK.creatorOwner,
  'creator owner': WK.creatorOwner
}

/** Nom affiché d'une identité (LAB\GG_Compta, BUILTIN\Administrateurs, Tout le monde…). */
export function principalName(state: LabState, device: Device, principal: string): string {
  const known = WELL_KNOWN_NAMES[principal]
  if (known) return known
  if (principal.startsWith('local:')) {
    const [, host = '', user = ''] = principal.split(':')
    return `${host.toUpperCase()}\\${user.charAt(0).toUpperCase()}${user.slice(1)}`
  }
  const domain = domainOf(state, device)
  const o = domain ? objectById(domain, principal) : undefined
  if (domain && o && o.kind !== 'container')
    return `${domain.netbios}\\${o.kind === 'computer' ? `${o.obj.name}$` : o.obj.sam}`
  return principal
}

/** Identité désignée par un nom (LAB\GG_Compta, GG_Compta, Tout le monde, Administrateurs…). */
export function resolvePrincipal(state: LabState, device: Device, name: string): string | undefined {
  const raw = name.trim().replace(/^"|"$/g, '')
  const lower = raw.toLowerCase()
  const known = WELL_KNOWN_ALIASES[lower]
  if (known) return known
  if (/^s-1-[\d-]+$/i.test(raw)) return raw.toUpperCase()
  const local = /^(?:\.|([^\\]+))\\administrateur$/i.exec(raw)
  if (local && (!local[1] || local[1].toLowerCase() === device.name.toLowerCase()))
    return `local:${device.name.toLowerCase()}:administrateur`
  const domain = domainOf(state, device)
  if (!domain) return undefined
  let account = raw
  if (raw.includes('\\')) {
    const [prefix = '', rest = ''] = raw.split('\\')
    if (prefix.toLowerCase() !== domain.netbios.toLowerCase() && prefix.toLowerCase() !== domain.name)
      return undefined
    account = rest
  }
  const found = findPrincipal(domain, account)
  return found && found.kind !== 'container' ? found.obj.id : undefined
}

/** Jeton d'une identité choisie dans l'onglet « Accès effectif » (utilisateur ou groupe). */
export function principalToken(state: LabState, device: Device, principal: string): AccessToken | null {
  const name = principalName(state, device, principal)
  if (WELL_KNOWN_NAMES[principal]) return { account: name, sids: [principal, WK.everyone], admin: false }
  if (principal.startsWith('local:')) {
    const [, host = '', user = ''] = principal.split(':')
    return localToken(host.toUpperCase(), user)
  }
  const domain = domainOf(state, device)
  const o = domain ? objectById(domain, principal) : undefined
  if (!domain || !o || o.kind === 'container') return null
  if (o.kind === 'user') return domainToken(domain, o.obj.sam)
  const groups = groupsOf(domain, principal).map((g) => g.id)
  return {
    account: name,
    sids: [principal, ...groups, WK.everyone, WK.authenticatedUsers],
    admin: groups.some((id) => domain.groups.find((g) => g.id === id)?.name === AD_GROUPS.domainAdmins)
  }
}

/** Entrée de l'ACL effective d'un élément. */
export interface AclEntry {
  ace: NtfsAce
  /** Héritée d'un dossier parent. */
  inherited: boolean
  /** 0 = explicite sur l'élément, 1 = héritée du parent, etc. */
  depth: number
  /** Dossier d'où provient l'entrée (« Hérité de »). */
  source: string
}

/** ACL effective : entrées explicites puis héritées, en remontant tant que l'héritage est actif. */
export function effectiveAcl(storage: Storage, nodeId: string | null): AclEntry[] {
  const entries: AclEntry[] = []
  let depth = 0
  let current = nodeId
  for (;;) {
    const node = current ? storage.nodes.find((n) => n.id === current) : undefined
    const acl = node ? node.acl : storage.rootAcl
    for (const ace of acl)
      entries.push({ ace, inherited: depth > 0, depth, source: nodePath(storage, current) })
    if (!node || !node.inherits) break
    current = node.parentId
    depth++
  }
  return entries
}

/** Ordre canonique : par niveau (explicite d'abord), refus avant autorisations à chaque niveau. */
export function canonicalAcl(entries: AclEntry[]): AclEntry[] {
  return [...entries].sort(
    (a, b) => a.depth - b.depth || (a.ace.type === b.ace.type ? 0 : a.ace.type === 'Deny' ? -1 : 1)
  )
}

/**
 * Droits NTFS effectifs d'un jeton sur un élément (null = racine C:\).
 * Le propriétaire peut toujours modifier les autorisations (droit implicite du propriétaire).
 */
export function ntfsPerms(storage: Storage, nodeId: string | null, token: AccessToken): Set<Perm> {
  const entries = canonicalAcl(effectiveAcl(storage, nodeId)).filter((e) =>
    token.sids.includes(e.ace.principal)
  )
  const result = new Set<Perm>()
  for (const perm of PERMS) {
    const first = entries.find((e) => NTFS_PERMS[e.ace.rights].includes(perm))
    if (first?.ace.type === 'Allow') result.add(perm)
  }
  const owner = nodeId ? storage.nodes.find((n) => n.id === nodeId)?.owner : WK.administrators
  if (owner && token.sids.includes(owner)) result.add('changePermissions')
  return result
}

/** Droits accordés par un partage : cumul des autorisations, un refus l'emporte. */
export function sharePerms(share: SmbShare, token: AccessToken): Set<Perm> {
  const allow = new Set<Perm>()
  const deny = new Set<Perm>()
  for (const ace of share.acl) {
    if (!token.sids.includes(ace.principal)) continue
    for (const p of SHARE_PERMS[ace.rights]) (ace.type === 'Allow' ? allow : deny).add(p)
  }
  return new Set([...allow].filter((p) => !deny.has(p)))
}

/** Accès effectif par droit, avec ce qui le limite (onglet « Accès effectif »). */
export interface EffectiveRight {
  perm: Perm
  label: string
  allowed: boolean
  /** « Partage », « Autorisations de fichiers » ou les deux. */
  limitedBy: string[]
}

export function effectiveAccess(
  storage: Storage,
  nodeId: string | null,
  token: AccessToken,
  share?: SmbShare
): EffectiveRight[] {
  const ntfs = ntfsPerms(storage, nodeId, token)
  const viaShare = share ? sharePerms(share, token) : null
  return PERMS.map((perm) => {
    const limitedBy = [
      ...(viaShare && !viaShare.has(perm) ? ['Partage'] : []),
      ...(!ntfs.has(perm) ? ['Autorisations de fichiers'] : [])
    ]
    return { perm, label: PERM_LABELS[perm], allowed: limitedBy.length === 0, limitedBy }
  })
}

/** Droits effectifs (partage ∩ NTFS si l'accès passe par un partage). */
export function accessPerms(
  storage: Storage,
  nodeId: string | null,
  token: AccessToken,
  share?: SmbShare
): Set<Perm> {
  const ntfs = ntfsPerms(storage, nodeId, token)
  if (!share) return ntfs
  const viaShare = sharePerms(share, token)
  return new Set([...ntfs].filter((p) => viaShare.has(p)))
}

/** Droits inclus dans chaque autorisation de base (cases de l'onglet Sécurité). */
export const NTFS_IMPLIES: Record<NtfsRight, NtfsRight[]> = {
  FullControl: [...NTFS_RIGHTS],
  Modify: ['Modify', 'ReadAndExecute', 'ListDirectory', 'Read', 'Write'],
  ReadAndExecute: ['ReadAndExecute', 'ListDirectory', 'Read'],
  ListDirectory: ['ListDirectory'],
  Read: ['Read'],
  Write: ['Write']
}

/** Autorisations de base cochées pour une liste de droits (inclusions comprises). */
export function expandNtfsRights(rights: readonly NtfsRight[]): Set<NtfsRight> {
  return new Set(rights.flatMap((r) => NTFS_IMPLIES[r]))
}

/**
 * Coche ou décoche une autorisation en respectant les inclusions : cocher Modifier coche Lecture,
 * décocher Lecture décoche Modifier et Contrôle total ; tout cocher revient à Contrôle total.
 */
export function toggleNtfsRight(current: ReadonlySet<NtfsRight>, right: NtfsRight, on: boolean): NtfsRight[] {
  const next = new Set(current)
  if (on) for (const r of NTFS_IMPLIES[right]) next.add(r)
  else for (const r of NTFS_RIGHTS) if (NTFS_IMPLIES[r].includes(right)) next.delete(r)
  if (NTFS_RIGHTS.every((r) => next.has(r))) next.add('FullControl')
  return [...next]
}
