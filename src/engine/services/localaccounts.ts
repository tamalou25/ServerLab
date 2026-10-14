/**
 * Base de comptes locale (SAM) d'un serveur membre, d'un serveur autonome ou d'un poste
 * (v2.7, Lot 2b) : utilisateurs et groupes locaux, appartenances.
 *
 * Règles sourcées Microsoft Learn (New-LocalUser, PowerShell 5.1,
 * https://learn.microsoft.com/powershell/module/microsoft.powershell.localaccounts/new-localuser?view=powershell-5.1) :
 * « A user name can't be identical to any other user name or group name on the computer. A user
 * name can't consist only of periods . or spaces. A user name can contain up to 20 uppercase
 * characters or lowercase characters. A user name can't contain the following characters:
 * ", /, \, [, ], :, ;, |, =, ,, +, *, ?, <, >, @ » ; « A password can contain up to 127 characters. »
 *
 * Comptes et groupes intégrés (Administrateur, Invité ; Administrateurs, Utilisateurs, Invités,
 * Utilisateurs du Bureau à distance) : virtuels, stockés seulement une fois modifiés. Le mot de
 * passe d'Administrateur reste `host.localAdminPassword` ; les membres du groupe Utilisateurs du
 * Bureau à distance restent `host.remoteDesktop.users`. Un contrôleur de domaine n'a pas de base
 * locale (message honnête). Libellés français : docs/fidelite.md, « À vérifier (Lot 2) ».
 */
import type { Draft } from 'immer'
import { raise, transact, type EngineResult } from '../core/result'
import type { HostDevice, LabState, LocalGroup, LocalUser } from '../model/schema'

/** Compte local tel qu'affiché (intégré ou créé). */
export interface LocalUserView extends LocalUser {
  builtin: boolean
  /** RID du SID (500 Administrateur, 501 Invité, 1000+ comptes créés). */
  rid: number
}

export interface LocalGroupView {
  name: string
  description: string
  members: string[]
  builtin: boolean
  /** SID bien connu (S-1-5-32-544…) ou RID d'un groupe créé. */
  sid: string
}

const BUILTIN_USERS: (Omit<LocalUser, 'password'> & { rid: number })[] = [
  {
    name: 'Administrateur',
    fullName: '',
    description: 'Compte d’utilisateur d’administration',
    enabled: true,
    passwordNeverExpires: false,
    userMayChangePassword: true,
    rid: 500
  },
  {
    name: 'Invité',
    fullName: '',
    description: 'Compte d’utilisateur invité',
    enabled: false,
    passwordNeverExpires: true,
    userMayChangePassword: false,
    rid: 501
  }
]

/** Nom du groupe local Utilisateurs du Bureau à distance (nom anglais accepté). */
export const RDU_GROUP = 'Utilisateurs du Bureau à distance'

const BUILTIN_GROUPS: { name: string; aliases: string[]; description: string; sid: string }[] = [
  {
    name: 'Administrateurs',
    aliases: ['administrators'],
    description:
      'Les membres du groupe Administrateurs disposent d’un accès complet et illimité à l’ordinateur et au domaine',
    sid: 'S-1-5-32-544'
  },
  {
    name: 'Invités',
    aliases: ['guests'],
    description:
      'Les membres du groupe Invités disposent par défaut du même accès que les membres du groupe Utilisateurs, à l’exception du compte Invité qui est plus restreint',
    sid: 'S-1-5-32-546'
  },
  {
    name: 'Utilisateurs',
    aliases: ['users'],
    description:
      'Les utilisateurs ne peuvent pas effectuer de modifications accidentelles ou intentionnelles à l’échelle du système, mais ils peuvent exécuter la plupart des applications',
    sid: 'S-1-5-32-545'
  },
  {
    name: RDU_GROUP,
    aliases: ['remote desktop users'],
    description: 'Les membres de ce groupe disposent de l’autorisation d’ouvrir une session à distance',
    sid: 'S-1-5-32-555'
  }
]

/** Caractères interdits dans un nom de compte (Learn, New-LocalUser). */
const FORBIDDEN = /["/\\[\]:;|=,+*?<>@]/

type AnyState = LabState | Draft<LabState>

function host(state: AnyState, deviceId: string): HostDevice {
  const d = state.devices[deviceId]
  if (!d || (d.kind !== 'server' && d.kind !== 'client'))
    raise('NotSupported', 'Cet équipement n’a pas de base de comptes locale.')
  return d as HostDevice
}

/** Contrôleur de domaine : pas de base SAM locale. */
export function isDomainControllerHost(state: AnyState, deviceId: string): boolean {
  return Object.values(state.domains).some((d) => d.controllers.includes(deviceId))
}

function requireSam(state: AnyState, deviceId: string): HostDevice {
  const h = host(state, deviceId)
  if (isDomainControllerHost(state, deviceId))
    raise(
      'NoLocalSamOnDc',
      'Un contrôleur de domaine n’a pas de base de comptes locale : gérez les comptes dans Active Directory (New-ADUser, New-ADGroup).'
    )
  return h
}

/** Utilisateurs locaux : intégrés (éventuellement modifiés), puis comptes créés. */
export function localUsers(state: LabState, deviceId: string): LocalUserView[] {
  const d = state.devices[deviceId]
  if (!d || (d.kind !== 'server' && d.kind !== 'client')) return []
  const stored = d.host.localUsers
  const builtins = BUILTIN_USERS.map((b) => {
    const override = stored.find((u) => u.name.toLowerCase() === b.name.toLowerCase())
    return {
      ...b,
      ...(override ?? {}),
      name: b.name,
      password: b.rid === 500 ? d.host.localAdminPassword : (override?.password ?? ''),
      builtin: true,
      rid: b.rid
    }
  })
  const created = stored
    .filter((u) => !BUILTIN_USERS.some((b) => b.name.toLowerCase() === u.name.toLowerCase()))
    .map((u, i) => ({ ...u, builtin: false, rid: 1000 + i }))
  return [...builtins, ...created]
}

export function findLocalUser(state: LabState, deviceId: string, name: string): LocalUserView | undefined {
  const lower = localName(state, deviceId, name).toLowerCase()
  return localUsers(state, deviceId).find((u) => u.name.toLowerCase() === lower)
}

/** « SRV2\\jdoe » ou « .\\jdoe » → « jdoe » (compte local de cet ordinateur). */
function localName(state: AnyState, deviceId: string, name: string): string {
  const d = state.devices[deviceId]
  const m = /^([^\\]+)\\(.+)$/.exec(name.trim())
  if (m && (m[1] === '.' || m[1]?.toLowerCase() === d?.name.toLowerCase())) return m[2] ?? ''
  return name.trim()
}

/** Groupes locaux : intégrés (membres implicites + ajoutés), puis groupes créés. */
export function localGroups(state: LabState, deviceId: string): LocalGroupView[] {
  const d = state.devices[deviceId]
  if (!d || (d.kind !== 'server' && d.kind !== 'client')) return []
  const domain = d.host.domain ? state.domains[d.host.domain] : undefined
  const implicit: Record<string, string[]> = {
    Administrateurs: ['Administrateur', ...(domain ? [`${domain.netbios}\\Admins du domaine`] : [])],
    Invités: ['Invité', ...(domain ? [`${domain.netbios}\\Invités du domaine`] : [])],
    Utilisateurs: domain ? [`${domain.netbios}\\Utilisateurs du domaine`] : []
  }
  const stored = d.host.localGroups
  const builtins = BUILTIN_GROUPS.map((b) => {
    const extra = stored.find((g) => g.name.toLowerCase() === b.name.toLowerCase())
    const members =
      b.name === RDU_GROUP ? [...d.host.remoteDesktop.users] : [...(implicit[b.name] ?? []), ...(extra?.members ?? [])]
    return { name: b.name, description: extra?.description || b.description, members, builtin: true, sid: b.sid }
  })
  const created = stored
    .filter((g) => !BUILTIN_GROUPS.some((b) => b.name.toLowerCase() === g.name.toLowerCase()))
    .map((g, i) => ({ ...g, builtin: false, sid: `rid:${1100 + i}` }))
  return [...builtins, ...created]
}

/** Groupe par nom (les noms anglais des groupes intégrés sont acceptés). */
export function findLocalGroup(state: LabState, deviceId: string, name: string): LocalGroupView | undefined {
  const lower = name.trim().toLowerCase()
  const builtin = BUILTIN_GROUPS.find((b) => b.name.toLowerCase() === lower || b.aliases.includes(lower))
  const target = builtin ? builtin.name.toLowerCase() : lower
  return localGroups(state, deviceId).find((g) => g.name.toLowerCase() === target)
}

/** Le compte local est-il administrateur de l'ordinateur ? */
export function isLocalAdmin(state: LabState, deviceId: string, user: string): boolean {
  const name = localName(state, deviceId, user).toLowerCase()
  const admins = findLocalGroup(state, deviceId, 'Administrateurs')
  return !!admins?.members.some((m) => m.toLowerCase() === name)
}

function validateName(state: LabState, deviceId: string, name: string, kind: 'user' | 'group'): string {
  const n = name.trim()
  if (!n || /^[.\s]+$/.test(n))
    raise('InvalidName', `Le nom « ${name} » n’est pas valide : il ne peut pas être composé uniquement de points ou d’espaces.`)
  if (kind === 'user' && n.length > 20)
    raise('InvalidName', `Le nom « ${n} » n’est pas valide : un nom d’utilisateur contient au plus 20 caractères.`)
  if (FORBIDDEN.test(n))
    raise('InvalidName', `Le nom « ${n} » n’est pas valide : il contient un caractère interdit (" / \\ [ ] : ; | = , + * ? < > @).`)
  if (findLocalUser(state, deviceId, n))
    raise(kind === 'user' ? 'UserExists' : 'NameInUse', `Le nom « ${n} » est déjà utilisé par un utilisateur de cet ordinateur.`)
  if (findLocalGroup(state, deviceId, n))
    raise(kind === 'group' ? 'GroupExists' : 'NameInUse', `Le nom « ${n} » est déjà utilisé par un groupe de cet ordinateur.`)
  return n
}

function validatePassword(password: string): void {
  if (password.length > 127)
    raise('InvalidPassword', 'Le mot de passe n’est pas valide : il contient au plus 127 caractères.')
}

export interface NewLocalUserInput {
  name: string
  /** Absent : compte sans mot de passe (-NoPassword). */
  password?: string
  fullName?: string
  description?: string
  disabled?: boolean
  passwordNeverExpires?: boolean
  userMayNotChangePassword?: boolean
}

/** Crée un utilisateur local (New-LocalUser). Il n'est membre d'aucun groupe. */
export function newLocalUser(state: LabState, deviceId: string, input: NewLocalUserInput): EngineResult<string> {
  return transact(state, (draft) => {
    requireSam(state, deviceId)
    const name = validateName(state, deviceId, input.name, 'user')
    validatePassword(input.password ?? '')
    const d = host(draft, deviceId) as Draft<HostDevice>
    d.host.localUsers.push({
      name,
      fullName: input.fullName ?? '',
      description: input.description ?? '',
      enabled: !input.disabled,
      password: input.password ?? '',
      passwordNeverExpires: !!input.passwordNeverExpires,
      userMayChangePassword: !input.userMayNotChangePassword
    })
    return name
  })
}

export interface LocalUserPatch {
  fullName?: string
  description?: string
  password?: string
  enabled?: boolean
  passwordNeverExpires?: boolean
  userMayChangePassword?: boolean
}

/** Modifie un utilisateur local (Set-LocalUser, Enable/Disable-LocalUser). */
export function setLocalUser(
  state: LabState,
  deviceId: string,
  name: string,
  patch: LocalUserPatch
): EngineResult {
  return transact(state, (draft) => {
    requireSam(state, deviceId)
    const user = findLocalUser(state, deviceId, name)
    if (!user) raise('UserNotFound', `L’utilisateur ${name} est introuvable.`)
    if (patch.password !== undefined) validatePassword(patch.password)
    const d = host(draft, deviceId) as Draft<HostDevice>
    if (user.rid === 500 && patch.password !== undefined) d.host.localAdminPassword = patch.password
    let stored = d.host.localUsers.find((u) => u.name.toLowerCase() === user.name.toLowerCase())
    if (!stored) {
      const { builtin: _b, rid: _r, ...base } = user
      stored = { ...base, password: user.rid === 500 ? '' : base.password }
      d.host.localUsers.push(stored)
      stored = d.host.localUsers[d.host.localUsers.length - 1] as LocalUser
    }
    const { password, ...rest } = patch
    Object.assign(stored, rest)
    if (password !== undefined && user.rid !== 500) stored.password = password
    return undefined
  })
}

/** Supprime un utilisateur local (Remove-LocalUser) ; les comptes intégrés ne se suppriment pas. */
export function removeLocalUser(state: LabState, deviceId: string, name: string): EngineResult {
  return transact(state, (draft) => {
    requireSam(state, deviceId)
    const user = findLocalUser(state, deviceId, name)
    if (!user) raise('UserNotFound', `L’utilisateur ${name} est introuvable.`)
    if (user.builtin)
      raise('BuiltinAccount', `Le compte intégré ${user.name} ne peut pas être supprimé.`)
    const d = host(draft, deviceId) as Draft<HostDevice>
    const lower = user.name.toLowerCase()
    d.host.localUsers = d.host.localUsers.filter((u) => u.name.toLowerCase() !== lower)
    for (const g of d.host.localGroups) g.members = g.members.filter((m) => m.toLowerCase() !== lower)
    return undefined
  })
}

/** Crée un groupe local (New-LocalGroup). */
export function newLocalGroup(
  state: LabState,
  deviceId: string,
  input: { name: string; description?: string }
): EngineResult<string> {
  return transact(state, (draft) => {
    requireSam(state, deviceId)
    const name = validateName(state, deviceId, input.name, 'group')
    const d = host(draft, deviceId) as Draft<HostDevice>
    d.host.localGroups.push({ name, description: input.description ?? '', members: [] })
    return name
  })
}

/** Membre normalisé : compte local (nom) ou compte du domaine de l'ordinateur (NETBIOS\\nom). */
function resolveMember(state: LabState, deviceId: string, member: string): string {
  const d = host(state, deviceId)
  const local = findLocalUser(state, deviceId, member) ?? undefined
  if (local) return local.name
  const localGroup = !member.includes('\\') ? findLocalGroup(state, deviceId, member) : undefined
  if (localGroup) return localGroup.name
  const domain = d.host.domain ? state.domains[d.host.domain] : undefined
  const m = /^([^\\]+)\\(.+)$/.exec(member.trim())
  if (domain && m && (m[1]?.toLowerCase() === domain.netbios.toLowerCase() || m[1]?.toLowerCase() === domain.name)) {
    const sam = (m[2] ?? '').toLowerCase()
    const found =
      domain.users.find((u) => u.sam.toLowerCase() === sam) ?? domain.groups.find((g) => g.sam.toLowerCase() === sam || g.name.toLowerCase() === sam)
    if (found) return `${domain.netbios}\\${found.sam}`
  }
  raise('PrincipalNotFound', `Le principal ${member} est introuvable.`)
}

/** Ajoute des membres à un groupe local (Add-LocalGroupMember). */
export function addLocalGroupMembers(
  state: LabState,
  deviceId: string,
  group: string,
  members: string[]
): EngineResult {
  return transact(state, (draft) => {
    const g = findLocalGroup(state, deviceId, group)
    if (g?.name !== RDU_GROUP) requireSam(state, deviceId)
    if (!g) raise('GroupNotFound', `Le groupe ${group} est introuvable.`)
    const d = host(draft, deviceId) as Draft<HostDevice>
    if (g.name === RDU_GROUP) {
      // Membres conservés tels quels (comptes du domaine résolus par le Bureau à distance)
      for (const m of members) {
        if (d.host.remoteDesktop.users.some((u) => u.toLowerCase() === m.toLowerCase()))
          raise('MemberExists', `${m} est déjà membre du groupe ${g.name}.`)
        d.host.remoteDesktop.users.push(m)
      }
      return undefined
    }
    let stored = d.host.localGroups.find((x) => x.name.toLowerCase() === g.name.toLowerCase())
    if (!stored) {
      d.host.localGroups.push({ name: g.name, description: '', members: [] })
      stored = d.host.localGroups[d.host.localGroups.length - 1] as LocalGroup
    }
    for (const m of members) {
      const name = resolveMember(state, deviceId, m)
      if (g.members.some((x) => x.toLowerCase() === name.toLowerCase()) || stored.members.includes(name))
        raise('MemberExists', `${m} est déjà membre du groupe ${g.name}.`)
      stored.members.push(name)
    }
    return undefined
  })
}

/** Retire des membres d'un groupe local (Remove-LocalGroupMember). */
export function removeLocalGroupMembers(
  state: LabState,
  deviceId: string,
  group: string,
  members: string[]
): EngineResult {
  return transact(state, (draft) => {
    const g = findLocalGroup(state, deviceId, group)
    if (g?.name !== RDU_GROUP) requireSam(state, deviceId)
    if (!g) raise('GroupNotFound', `Le groupe ${group} est introuvable.`)
    const d = host(draft, deviceId) as Draft<HostDevice>
    const lowered = members.map((m) => m.toLowerCase())
    const matches = (u: string) =>
      lowered.includes(u.toLowerCase()) || lowered.includes((u.split('\\')[1] ?? '').toLowerCase())
    if (g.name === RDU_GROUP) {
      d.host.remoteDesktop.users = d.host.remoteDesktop.users.filter((u) => !matches(u))
      return undefined
    }
    const stored = d.host.localGroups.find((x) => x.name.toLowerCase() === g.name.toLowerCase())
    for (const m of members) {
      const lower = m.toLowerCase()
      const present = stored?.members.some(
        (x) => x.toLowerCase() === lower || x.split('\\')[1]?.toLowerCase() === lower
      )
      if (!present) raise('MemberNotFound', `${m} n’est pas membre du groupe ${g.name}.`)
    }
    if (stored) stored.members = stored.members.filter((x) => !matches(x))
    return undefined
  })
}
