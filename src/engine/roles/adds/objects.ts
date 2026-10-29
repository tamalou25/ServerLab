/**
 * Gestion des objets de l'annuaire : unités d'organisation, utilisateurs, groupes, membres.
 */
import type { Draft } from 'immer'
import { logEvent } from '../../core/eventlog'
import { logAudited } from '../gpo/auditpolicy'
import { raise, transact, type EngineResult } from '../../core/result'
import type { AdGroup, Domain, LabState } from '../../model/schema'
import {
  assertNameAvailable,
  assertSamAvailable,
  defaultContainer,
  domainDn,
  findPrincipal,
  newAdId,
  objectById,
  passwordMeetsPolicy,
  PASSWORD_POLICY_ERROR,
  resolveContainerDn,
  type AdObject
} from './directory'
import { domainPasswordPolicy } from '../gpo/scope'

export function requireDomain(draft: Draft<LabState>, name: string): Draft<Domain> {
  const domain = draft.domains[name.toLowerCase()]
  if (!domain) raise('DomainNotFound', `Le domaine ${name} est introuvable.`)
  return domain
}

/** Conteneur cible d'un -Path (DN) ; à défaut le conteneur par défaut. */
function targetContainer(
  domain: Draft<Domain>,
  path: string | undefined,
  fallback: 'Users' | 'Computers' | null
): string | null {
  if (!path || path.trim() === '') return fallback ? defaultContainer(domain as Domain, fallback) : null
  const resolved = resolveContainerDn(domain as Domain, path)
  if (resolved === undefined)
    raise(
      'DirectoryObjectNotFound',
      `Objet de répertoire non trouvé : « ${path} » n’existe pas sous « ${domainDn(domain)} ».`
    )
  return resolved
}

function notFound(domain: Domain, identity: string): never {
  raise(
    'ADIdentityNotFound',
    `Impossible de trouver un objet avec l’identité « ${identity} » sous « ${domainDn(domain)} ».`
  )
}

export interface OuInput {
  name: string
  path?: string
  description?: string
  protectedFromDeletion?: boolean
}

export function addOrganizationalUnit(
  state: LabState,
  domainName: string,
  input: OuInput
): EngineResult<string> {
  return transact(state, (draft) => {
    const domain = requireDomain(draft, domainName)
    const name = input.name.trim()
    if (!name || /[,=+<>#;"\\]/.test(name))
      raise('InvalidName', `Le nom « ${input.name} » n’est pas valide pour une unité d’organisation.`)
    const parentId = targetContainer(domain, input.path, null)
    assertNameAvailable(domain, parentId, name)
    const id = newAdId(draft)
    domain.containers.push({
      id,
      name,
      parentId,
      kind: 'ou',
      description: input.description ?? '',
      protected: input.protectedFromDeletion ?? true,
      builtin: false,
      gpLinks: [],
      blockInheritance: false
    })
    return id
  })
}

export interface UserInput {
  name: string
  sam?: string
  givenName?: string
  surname?: string
  upn?: string
  path?: string
  password?: string
  enabled?: boolean
  mustChangePassword?: boolean
  description?: string
  passwordNeverExpires?: boolean
}

export interface UserResult {
  id: string
  /** Erreur de mot de passe : le compte est créé mais reste désactivé (comportement réel). */
  passwordError: string | null
}

export function addUser(
  state: LabState,
  domainName: string,
  input: UserInput,
  logOn?: string
): EngineResult<UserResult> {
  return transact(state, (draft) => {
    const domain = requireDomain(draft, domainName)
    const name = input.name.trim()
    if (!name) raise('InvalidName', 'Le nom de l’utilisateur est obligatoire.')
    const sam = (input.sam?.trim() || name).slice(0, 20)
    if (/["/\\[\]:;|=,+*?<>@]/.test(sam))
      raise('InvalidSam', `Le nom d’ouverture de session « ${sam} » contient des caractères non autorisés.`)
    const parentId = targetContainer(domain, input.path, 'Users')
    if (parentId === null)
      raise('InvalidPath', 'Un utilisateur doit être créé dans un conteneur ou une unité d’organisation.')
    assertSamAvailable(domain, sam)
    assertNameAvailable(domain, parentId, name)
    let passwordError: string | null = null
    const password = input.password ?? ''
    let enabled = input.enabled ?? false
    if (enabled || password) {
      if (!passwordMeetsPolicy(password, sam, domainPasswordPolicy(domain as Domain))) {
        passwordError = PASSWORD_POLICY_ERROR
        enabled = false
      }
    }
    const id = newAdId(draft)
    domain.users.push({
      id,
      sam,
      name,
      givenName: input.givenName ?? '',
      surname: input.surname ?? '',
      upn: input.upn ?? '',
      parentId,
      password: passwordError ? '' : password,
      enabled,
      mustChangePassword: !!input.mustChangePassword,
      description: input.description ?? '',
      builtin: false,
      passwordNeverExpires: !!input.passwordNeverExpires,
      whenCreated: draft.clock,
      lastLogon: null,
      badPwdCount: 0,
      lastBadPassword: null,
      lockoutTime: null,
      spns: [],
      passwordLastSet: draft.clock,
      compromised: false
    })
    // Groupe principal : Utilisateurs du domaine
    domain.groups.find((g) => g.name === 'Utilisateurs du domaine')?.members.push(id)
    const dc = domain.controllers[0]
    if (dc)
      logAudited(draft, dc, 'accountManagement', 'success', {
        level: 'information',
        source: 'Security-Auditing',
        eventId: 4720,
        log: 'Sécurité',
        message: `Un compte d’utilisateur a été créé. Nouveau compte : ${domain.netbios}\\${sam}${logOn ? ` (par ${logOn})` : ''}.`
      })
    return { id, passwordError }
  })
}

export interface GroupInput {
  name: string
  sam?: string
  scope: AdGroup['scope']
  category?: AdGroup['category']
  path?: string
  description?: string
}

export function addGroup(state: LabState, domainName: string, input: GroupInput): EngineResult<string> {
  return transact(state, (draft) => {
    const domain = requireDomain(draft, domainName)
    const name = input.name.trim()
    if (!name) raise('InvalidName', 'Le nom du groupe est obligatoire.')
    const sam = (input.sam?.trim() || name).slice(0, 63)
    const parentId = targetContainer(domain, input.path, 'Users')
    if (parentId === null)
      raise('InvalidPath', 'Un groupe doit être créé dans un conteneur ou une unité d’organisation.')
    assertSamAvailable(domain, sam)
    assertNameAvailable(domain, parentId, name)
    const id = newAdId(draft)
    domain.groups.push({
      id,
      sam,
      name,
      parentId,
      scope: input.scope,
      category: input.category ?? 'Security',
      members: [],
      description: input.description ?? '',
      builtin: false
    })
    return id
  })
}

/** Règles d'imbrication selon l'étendue des groupes. */
function memberAllowed(group: AdGroup, member: AdObject): string | null {
  if (member.kind !== 'group') return null
  if (member.obj.id === group.id) return 'Un groupe ne peut pas être membre de lui-même.'
  if (member.obj.scope === 'DomainLocal' && group.scope !== 'DomainLocal')
    return `Le groupe de domaine local « ${member.obj.name} » ne peut pas être membre du groupe ${group.scope === 'Global' ? 'global' : 'universel'} « ${group.name} ».`
  if (member.obj.scope === 'Universal' && group.scope === 'Global')
    return `Le groupe universel « ${member.obj.name} » ne peut pas être membre du groupe global « ${group.name} ».`
  return null
}

/** Évènements de modification d'un groupe de sécurité (ajout / retrait d'un membre), selon l'étendue. */
const MEMBERSHIP_EVENTS: Record<AdGroup['scope'], { added: number; removed: number; label: string }> = {
  Global: { added: 4728, removed: 4729, label: 'global' },
  DomainLocal: { added: 4732, removed: 4733, label: 'local' },
  Universal: { added: 4756, removed: 4757, label: 'universel' }
}

function logMembership(
  draft: Draft<LabState>,
  domain: Draft<Domain>,
  group: Draft<AdGroup>,
  member: string,
  added: boolean
): void {
  const dc = domain.controllers[0]
  if (!dc || group.category !== 'Security') return
  const ev = MEMBERSHIP_EVENTS[group.scope]
  logAudited(draft, dc, 'accountManagement', 'success', {
    level: 'information',
    source: 'Security-Auditing',
    eventId: added ? ev.added : ev.removed,
    log: 'Sécurité',
    message: `Un membre a été ${added ? 'ajouté à' : 'supprimé d’'}un groupe ${ev.label} de sécurité. Membre : ${domain.netbios}\\${member}. Groupe : ${domain.netbios}\\${group.sam}.`
  })
}

/** Nom d'ouverture de session d'un membre (ordinateur : NOM$). */
const memberSam = (m: { kind: string; obj: { name: string; sam?: string } }) =>
  m.kind === 'computer' ? `${m.obj.name}$` : (m.obj.sam ?? m.obj.name)

export function addGroupMembers(
  state: LabState,
  domainName: string,
  groupIdentity: string,
  members: string[]
): EngineResult {
  return transact(state, (draft) => {
    const domain = requireDomain(draft, domainName)
    const group = findPrincipal(domain as Domain, groupIdentity)
    if (!group || group.kind !== 'group') notFound(domain as Domain, groupIdentity)
    const target = domain.groups.find((g) => g.id === group.obj.id) as Draft<AdGroup>
    for (const m of members) {
      const member = findPrincipal(domain as Domain, m)
      if (!member) notFound(domain as Domain, m)
      const err = memberAllowed(target as AdGroup, member)
      if (err) raise('InvalidMember', err)
      if (!target.members.includes(member.obj.id)) {
        target.members.push(member.obj.id)
        logMembership(draft, domain, target, memberSam(member), true)
      }
    }
    return undefined
  })
}

export function removeGroupMembers(
  state: LabState,
  domainName: string,
  groupIdentity: string,
  members: string[]
): EngineResult {
  return transact(state, (draft) => {
    const domain = requireDomain(draft, domainName)
    const group = findPrincipal(domain as Domain, groupIdentity)
    if (!group || group.kind !== 'group') notFound(domain as Domain, groupIdentity)
    const target = domain.groups.find((g) => g.id === group.obj.id) as Draft<AdGroup>
    for (const m of members) {
      const member = findPrincipal(domain as Domain, m)
      if (!member) notFound(domain as Domain, m)
      if (!target.members.includes(member.obj.id))
        raise('NotMember', `« ${member.obj.name} » n’est pas membre du groupe « ${target.name} ».`)
      target.members = target.members.filter((id) => id !== member.obj.id)
      logMembership(draft, domain, target, memberSam(member), false)
    }
    return undefined
  })
}

export function setAccountEnabled(
  state: LabState,
  domainName: string,
  identity: string,
  enabled: boolean
): EngineResult {
  return transact(state, (draft) => {
    const domain = requireDomain(draft, domainName)
    const found = findPrincipal(domain as Domain, identity)
    if (!found || (found.kind !== 'user' && found.kind !== 'computer')) notFound(domain as Domain, identity)
    if (found.kind === 'user') {
      const user = domain.users.find((u) => u.id === found.obj.id)
      if (user && enabled && !user.password && domainPasswordPolicy(domain as Domain).minLength > 0)
        raise(
          'PasswordRequired',
          `${PASSWORD_POLICY_ERROR} Définissez d’abord un mot de passe pour ce compte.`
        )
      if (user) user.enabled = enabled
    } else {
      const c = domain.computers.find((x) => x.id === found.obj.id)
      if (c) c.enabled = enabled
    }
    return undefined
  })
}

export function resetPassword(
  state: LabState,
  domainName: string,
  identity: string,
  password: string,
  mustChange = false
): EngineResult {
  return transact(state, (draft) => {
    const domain = requireDomain(draft, domainName)
    const found = findPrincipal(domain as Domain, identity)
    if (!found || found.kind !== 'user') notFound(domain as Domain, identity)
    if (!passwordMeetsPolicy(password, found.obj.sam, domainPasswordPolicy(domain as Domain)))
      raise('PasswordPolicy', PASSWORD_POLICY_ERROR)
    const user = domain.users.find((u) => u.id === found.obj.id)
    if (user) {
      user.password = password
      user.passwordLastSet = draft.clock
      user.mustChangePassword = mustChange
    }
    return undefined
  })
}

export function setUserProperties(
  state: LabState,
  domainName: string,
  identity: string,
  props: {
    description?: string
    givenName?: string
    surname?: string
    upn?: string
    mustChangePassword?: boolean
    passwordNeverExpires?: boolean
  }
): EngineResult {
  return transact(state, (draft) => {
    const domain = requireDomain(draft, domainName)
    const found = findPrincipal(domain as Domain, identity)
    if (!found || found.kind !== 'user') notFound(domain as Domain, identity)
    const user = domain.users.find((u) => u.id === found.obj.id)
    if (user)
      Object.assign(user, Object.fromEntries(Object.entries(props).filter(([, v]) => v !== undefined)))
    return undefined
  })
}

/** Déplace un objet vers un autre conteneur (DN cible). */
export function moveObject(
  state: LabState,
  domainName: string,
  objectId: string,
  targetPath: string
): EngineResult {
  return transact(state, (draft) => {
    const domain = requireDomain(draft, domainName)
    const target = resolveContainerDn(domain as Domain, targetPath)
    if (target === undefined)
      raise('DirectoryObjectNotFound', `Objet de répertoire non trouvé : « ${targetPath} ».`)
    const found = objectById(domain as Domain, objectId)
    if (!found) raise('NotFound', 'Objet introuvable.')
    if (found.kind === 'container') {
      // Interdit de déplacer une OU dans sa propre descendance
      let cursor: string | null = target
      while (cursor) {
        if (cursor === objectId)
          raise(
            'InvalidMove',
            'Impossible de déplacer une unité d’organisation dans l’une de ses sous-unités.'
          )
        cursor = domain.containers.find((c) => c.id === cursor)?.parentId ?? null
      }
      if (found.obj.builtin) raise('Builtin', 'Les conteneurs intégrés ne peuvent pas être déplacés.')
    } else if (target === null)
      raise('InvalidPath', 'Seules les unités d’organisation peuvent se trouver à la racine du domaine.')
    assertNameAvailable(domain, target, found.obj.name)
    const list =
      found.kind === 'container'
        ? domain.containers
        : found.kind === 'user'
          ? domain.users
          : found.kind === 'group'
            ? domain.groups
            : domain.computers
    const item = (list as { id: string; parentId: string | null }[]).find((x) => x.id === objectId)
    if (item) item.parentId = target
    return undefined
  })
}

/** Supprime un objet (OU vide ou récursivement, protection contre la suppression accidentelle). */
export function removeObject(
  state: LabState,
  domainName: string,
  objectId: string,
  recursive = false
): EngineResult {
  return transact(state, (draft) => {
    const domain = requireDomain(draft, domainName)
    const found = objectById(domain as Domain, objectId)
    if (!found) raise('NotFound', 'Objet introuvable.')
    if (found.kind !== 'computer' && found.obj.builtin)
      raise('Builtin', `L’objet intégré « ${found.obj.name} » ne peut pas être supprimé.`)
    if (found.kind === 'container' && found.obj.protected)
      raise(
        'AccessDenied',
        `Vous ne disposez pas des privilèges suffisants pour supprimer « ${found.obj.name} », ou cet objet est protégé contre les suppressions accidentelles.`
      )
    const toDelete = new Set([objectId])
    if (found.kind === 'container') {
      let changed = true
      while (changed) {
        changed = false
        for (const o of [...domain.containers, ...domain.users, ...domain.groups, ...domain.computers]) {
          if (o.parentId && toDelete.has(o.parentId) && !toDelete.has(o.id)) {
            toDelete.add(o.id)
            changed = true
          }
        }
      }
      if (toDelete.size > 1 && !recursive)
        raise(
          'NotEmpty',
          `L’unité d’organisation « ${found.obj.name} » contient des objets : utilisez -Recursive pour la supprimer avec son contenu.`
        )
      if (domain.containers.some((c) => toDelete.has(c.id) && c.protected && c.id !== objectId))
        raise(
          'AccessDenied',
          'Une sous-unité d’organisation est protégée contre les suppressions accidentelles.'
        )
    }
    // Corbeille Active Directory : objets conservés avec leurs attributs et appartenances
    if (domain.recycleBin) {
      const memberOf = (id: string) => domain.groups.filter((g) => g.members.includes(id)).map((g) => g.id)
      const at = draft.clock
      for (const c of domain.containers)
        if (toDelete.has(c.id))
          domain.deletedObjects.push({ kind: 'container', obj: { ...c }, memberOf: [], deletedAt: at })
      for (const u of domain.users)
        if (toDelete.has(u.id))
          domain.deletedObjects.push({ kind: 'user', obj: { ...u }, memberOf: memberOf(u.id), deletedAt: at })
      for (const g of domain.groups)
        if (toDelete.has(g.id))
          domain.deletedObjects.push({
            kind: 'group',
            obj: { ...g },
            memberOf: memberOf(g.id),
            deletedAt: at
          })
      for (const c of domain.computers)
        if (toDelete.has(c.id))
          domain.deletedObjects.push({
            kind: 'computer',
            obj: { ...c },
            memberOf: memberOf(c.id),
            deletedAt: at
          })
    }
    domain.containers = domain.containers.filter((c) => !toDelete.has(c.id))
    domain.users = domain.users.filter((u) => !toDelete.has(u.id))
    domain.groups = domain.groups.filter((g) => !toDelete.has(g.id))
    domain.computers = domain.computers.filter((c) => !toDelete.has(c.id))
    for (const g of domain.groups) g.members = g.members.filter((m) => !toDelete.has(m))
    return undefined
  })
}

/** Modifie la protection contre la suppression accidentelle d'une OU. */
export function setOuProtection(
  state: LabState,
  domainName: string,
  ouId: string,
  protectedFromDeletion: boolean
): EngineResult {
  return transact(state, (draft) => {
    const domain = requireDomain(draft, domainName)
    const ou = domain.containers.find((c) => c.id === ouId && c.kind === 'ou')
    if (!ou) raise('NotFound', 'Unité d’organisation introuvable.')
    ou.protected = protectedFromDeletion
    return undefined
  })
}

/** Active la Corbeille Active Directory (Enable-ADOptionalFeature) : opération irréversible. */
export function enableRecycleBin(state: LabState, domainName: string): EngineResult {
  return transact(state, (draft) => {
    const domain = requireDomain(draft, domainName)
    if (domain.recycleBin)
      raise('AlreadyEnabled', 'La fonctionnalité Corbeille est déjà activée pour cette forêt.')
    domain.recycleBin = true
    return undefined
  })
}

/** Identifiant de l'événement de restauration d'un objet supprimé (comme l'audit 5138). */
export const RESTORED_EVENT_ID = 5138

/**
 * Restaure un objet supprimé de la Corbeille (Restore-ADObject) avec ses attributs et ses
 * appartenances aux groupes encore présents. `targetId` : conteneur de destination (par défaut le
 * dernier parent connu, qui doit exister).
 */
export function restoreDeletedObject(
  state: LabState,
  domainName: string,
  objectId: string,
  targetId?: string | null
): EngineResult {
  return transact(state, (draft) => {
    const domain = requireDomain(draft, domainName)
    const index = domain.deletedObjects.findIndex((d) => d.obj.id === objectId)
    const entry = domain.deletedObjects[index]
    if (!entry) raise('NotFound', 'Objet supprimé introuvable dans la Corbeille Active Directory.')
    const parent = targetId === undefined ? entry.obj.parentId : targetId
    if (parent !== null && !domain.containers.some((c) => c.id === parent))
      raise(
        'ParentDeleted',
        'L’opération n’a pas pu être effectuée, car le parent de l’objet est supprimé : restaurez d’abord le conteneur parent ou indiquez -TargetPath.'
      )
    const name = entry.obj.name.toLowerCase()
    const taken = [...domain.users, ...domain.groups, ...domain.computers, ...domain.containers].some(
      (o) => o.parentId === parent && o.name.toLowerCase() === name
    )
    if (taken) raise('AlreadyExists', `Un objet nommé « ${entry.obj.name} » existe déjà à cet emplacement.`)
    if (entry.kind === 'container') domain.containers.push({ ...entry.obj, parentId: parent })
    else {
      // Utilisateurs, groupes et ordinateurs résident toujours dans un conteneur
      if (parent === null) raise('ParentDeleted', 'Indiquez le conteneur de destination (-TargetPath).')
      if (entry.kind === 'user') domain.users.push({ ...entry.obj, parentId: parent })
      else if (entry.kind === 'group') domain.groups.push({ ...entry.obj, parentId: parent })
      else domain.computers.push({ ...entry.obj, parentId: parent })
    }
    for (const g of domain.groups)
      if (entry.memberOf.includes(g.id) && !g.members.includes(entry.obj.id)) g.members.push(entry.obj.id)
    domain.deletedObjects.splice(index, 1)
    // Trace de la restauration sur le contrôleur de domaine (critère de lab adObjectRestored)
    const dcId = domain.controllers[0]
    if (dcId) {
      const sam = 'sam' in entry.obj ? entry.obj.sam : entry.obj.name
      logEvent(draft, dcId, {
        level: 'information',
        source: 'ActiveDirectory_DomainService',
        eventId: RESTORED_EVENT_ID,
        log: 'Service d’annuaire',
        account: `${domain.netbios}\\${sam}`,
        message: `L’objet « ${entry.obj.name} » a été restauré depuis la Corbeille Active Directory.`
      })
    }
    return undefined
  })
}

/**
 * Historique d'un compte (construction des labs) : création et dernière ouverture de session
 * datées d'il y a N jours (null : jamais ouvert de session).
 */
export function setAccountActivity(
  state: LabState,
  domainName: string,
  identity: string,
  activity: { createdDaysAgo?: number; lastLogonDaysAgo?: number | null; passwordAgeDays?: number }
): EngineResult {
  return transact(state, (draft) => {
    const domain = requireDomain(draft, domainName)
    const found = findPrincipal(domain as Domain, identity)
    if (!found || found.kind !== 'user') notFound(domain as Domain, identity)
    const user = domain.users.find((u) => u.id === found.obj.id)
    if (!user) return undefined
    const day = 86_400_000
    if (activity.createdDaysAgo !== undefined) user.whenCreated = draft.clock - activity.createdDaysAgo * day
    // Mot de passe inchangé depuis N jours (pwdLastSet)
    if (activity.passwordAgeDays !== undefined)
      user.passwordLastSet = draft.clock - activity.passwordAgeDays * day
    if (activity.lastLogonDaysAgo !== undefined)
      user.lastLogon =
        activity.lastLogonDaysAgo === null ? null : draft.clock - activity.lastLogonDaysAgo * day
    return undefined
  })
}

/** Définit les noms de principal de service d'un compte (Set-ADUser -ServicePrincipalNames). */
export function setServicePrincipalNames(
  state: LabState,
  domainName: string,
  identity: string,
  spns: string[]
): EngineResult {
  return transact(state, (draft) => {
    const domain = requireDomain(draft, domainName)
    const found = findPrincipal(domain as Domain, identity)
    if (!found || found.kind !== 'user') notFound(domain as Domain, identity)
    const clean = spns.map((s) => s.trim()).filter((s) => s !== '')
    if (clean.some((s) => !s.includes('/')))
      raise('InvalidSpn', 'Un SPN s’écrit « classe/hôte » (exemple : MSSQLSvc/srv1.lab.local:1433).')
    const user = domain.users.find((u) => u.id === found.obj.id)
    if (user) user.spns = [...new Set(clean)]
    return undefined
  })
}

/** Déverrouille un compte (Unlock-ADAccount, « Déverrouiller le compte » de la console AD). */
export function unlockAccount(state: LabState, domainName: string, identity: string): EngineResult {
  return transact(state, (draft) => {
    const domain = requireDomain(draft, domainName)
    const found = findPrincipal(domain as Domain, identity)
    if (!found || found.kind !== 'user') notFound(domain as Domain, identity)
    const user = domain.users.find((u) => u.id === found.obj.id)
    if (user) {
      user.lockoutTime = null
      user.badPwdCount = 0
      user.lastBadPassword = null
    }
    return undefined
  })
}

export interface GroupPatch {
  description?: string
  scope?: AdGroup['scope']
  category?: AdGroup['category']
  sam?: string
}

/**
 * Modifie un groupe (Set-ADGroup). Conversions d'étendue d'après Microsoft Learn
 * (« Understand security groups », Group scope) : Global → Universelle si le groupe n'est membre
 * d'aucun autre groupe global ; Domaine local → Universelle s'il ne contient aucun groupe de
 * domaine local ; Universelle → Globale s'il ne contient aucun groupe universel ; Universelle →
 * Domaine local s'il n'est membre d'aucun groupe universel. Global ↔ Domaine local : impossible.
 */
export function setGroupProperties(
  state: LabState,
  domainName: string,
  identity: string,
  patch: GroupPatch
): EngineResult {
  return transact(state, (draft) => {
    const domain = requireDomain(draft, domainName)
    const found = findPrincipal(domain as Domain, identity)
    if (!found || found.kind !== 'group') notFound(domain as Domain, identity)
    const group = domain.groups.find((g) => g.id === found.obj.id) as Draft<AdGroup>
    if (patch.scope && patch.scope !== group.scope) {
      const from = group.scope
      const to = patch.scope
      const parents = domain.groups.filter((g) => g.members.includes(group.id))
      const children = domain.groups.filter((g) => group.members.includes(g.id))
      const refuse = (why: string) =>
        raise('InvalidGroupScope', `Impossible de changer l’étendue du groupe « ${group.name} » : ${why}`)
      if ((from === 'Global' && to === 'DomainLocal') || (from === 'DomainLocal' && to === 'Global'))
        refuse('convertissez-le d’abord en groupe universel.')
      if (from === 'Global' && parents.some((g) => g.scope === 'Global'))
        refuse('il est membre d’un autre groupe global.')
      if (from === 'DomainLocal' && children.some((g) => g.scope === 'DomainLocal'))
        refuse('il contient un groupe de domaine local.')
      if (from === 'Universal' && to === 'Global' && children.some((g) => g.scope === 'Universal'))
        refuse('il contient un groupe universel.')
      if (from === 'Universal' && to === 'DomainLocal' && parents.some((g) => g.scope === 'Universal'))
        refuse('il est membre d’un groupe universel.')
      group.scope = to
    }
    if (patch.description !== undefined) group.description = patch.description
    if (patch.category) group.category = patch.category
    if (patch.sam !== undefined && patch.sam.trim() !== group.sam) {
      assertSamAvailable(domain, patch.sam.trim())
      group.sam = patch.sam.trim()
    }
    return undefined
  })
}

export interface ComputerInput {
  name: string
  path?: string
  enabled?: boolean
}

/**
 * Crée un compte d'ordinateur (New-ADComputer) sans joindre d'ordinateur au domaine (Learn) :
 * compte pré-créé, repris par la jonction d'un ordinateur du même nom. Conteneur par défaut :
 * CN=Computers.
 */
export function addComputer(state: LabState, domainName: string, input: ComputerInput): EngineResult<string> {
  return transact(state, (draft) => {
    const domain = requireDomain(draft, domainName)
    const name = input.name.trim()
    if (!name) raise('InvalidName', 'Le nom de l’ordinateur est obligatoire.')
    if (domain.computers.some((c) => c.name.toLowerCase() === name.toLowerCase()))
      raise('AlreadyExists', 'Le compte spécifié existe déjà.')
    const parentId = targetContainer(domain, input.path, 'Computers')
    if (parentId === null)
      raise('InvalidPath', 'Un ordinateur doit être créé dans un conteneur ou une unité d’organisation.')
    assertSamAvailable(domain, `${name}$`)
    assertNameAvailable(domain, parentId, name)
    const id = newAdId(draft)
    domain.computers.push({
      id,
      name,
      parentId,
      deviceId: null,
      enabled: input.enabled ?? true,
      dnsHostName: ''
    })
    domain.groups.find((g) => g.name === 'Ordinateurs du domaine')?.members.push(id)
    return id
  })
}

/**
 * Canal sécurisé d'un membre du domaine (Test-ComputerSecureChannel) : un contrôleur allumé et le
 * compte d'ordinateur du même nom, activé et lié à cet ordinateur. Un compte recréé (New-ADComputer
 * après suppression) n'est plus lié à l'ordinateur : le canal est rompu.
 */
export function secureChannelStatus(
  state: LabState,
  deviceId: string
): 'ok' | 'notDomainMember' | 'noDc' | 'broken' {
  const d = state.devices[deviceId]
  if (!d || (d.kind !== 'server' && d.kind !== 'client') || !d.host.domain) return 'notDomainMember'
  const domain = state.domains[d.host.domain]
  if (!domain) return 'notDomainMember'
  if (domain.controllers.includes(deviceId)) return 'ok'
  if (!domain.controllers.some((id) => state.devices[id]?.powered)) return 'noDc'
  const account = domain.computers.find((c) => c.name.toLowerCase() === d.name.toLowerCase())
  return account && account.enabled && account.deviceId === deviceId ? 'ok' : 'broken'
}

/**
 * Réparation du canal (Test-ComputerSecureChannel -Repair) : le compte d'ordinateur du même nom
 * est de nouveau lié à l'ordinateur. Sans compte, la réparation échoue (il faut rejoindre le domaine).
 */
export function repairSecureChannel(state: LabState, deviceId: string): EngineResult {
  return transact(state, (draft) => {
    const d = draft.devices[deviceId]
    if (!d || (d.kind !== 'server' && d.kind !== 'client') || !d.host.domain)
      raise('NotDomainMember', 'Cet ordinateur n’est pas membre d’un domaine.')
    const domain = requireDomain(draft, d.host.domain)
    const account = domain.computers.find((c) => c.name.toLowerCase() === d.name.toLowerCase())
    if (!account)
      raise(
        'ComputerAccountNotFound',
        `Le compte d’ordinateur ${d.name} est introuvable dans le domaine ${domain.name} : joignez de nouveau l’ordinateur au domaine.`
      )
    if (!account.enabled) raise('ComputerAccountDisabled', `Le compte d’ordinateur ${d.name} est désactivé.`)
    account.deviceId = deviceId
    return undefined
  })
}
