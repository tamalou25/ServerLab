/**
 * Cmdlets Active Directory (module ActiveDirectory, ADDSDeployment) et jonction au domaine.
 */
import { formatShortDate } from '../../core/clock'
import { guidFromSeed } from '../../core/guid'
import type { AdComputer, AdContainer, AdGroup, AdUser, Domain } from '../../model/schema'
import {
  allObjects,
  containerDn,
  domainDn,
  findPrincipal,
  groupsOf,
  isDomainAdmin,
  objectDn,
  resolveContainerDn,
  type AdObject
} from './directory'
import { installForest } from './forest'
import { joinDomain, leaveDomain } from './join'
import {
  addComputer,
  addGroup,
  addGroupMembers,
  addOrganizationalUnit,
  addUser,
  moveObject,
  removeGroupMembers,
  removeObject,
  resetPassword,
  setAccountEnabled,
  setGroupProperties,
  setOuProtection,
  unlockAccount,
  setUserProperties
} from './objects'
import { fsmoHolder } from './fsmo'
import { domainLockoutPolicy, domainPasswordPolicy } from '../gpo/scope'
import { updateGpoSettings, type GpoSettingsPatch } from '../gpo/objects'
import { DEFAULT_DOMAIN_POLICY_ID } from '../gpo/defaults'
import { CommandFailure } from '../../shell/context'
import { unsimulatedParameterMessage } from '../../shell/unsimulated'
import { restartComputer } from '../../services/system'
import { isLockedOut } from './lockout'
import { psError } from '../../shell/ps/errors'
import { evaluateExpression } from '../../shell/ps/expression'
import type { ExecContext } from '../../shell/context'
import type { CmdContext } from '../../shell/ps/interpreter'
import type { BoundArgs, CmdletDef, ParamDef } from '../../shell/ps/registry'
import {
  flatten,
  getProp,
  isCredential,
  isScript,
  isSecure,
  psObject,
  psToBool,
  psToString,
  type PsObject,
  type PsValue
} from '../../shell/ps/values'
import { hasFeature } from '../../shell/ps/cmdlets/helpers'

export const adAvailable = (ctx: CmdContext) => hasFeature(ctx, 'RSAT-AD-PowerShell')
const str = (v: PsValue | undefined): string => psToString(v)

/** GUID déterministe dérivé de l'identifiant interne. */
const guidOf = (id: string): string => guidFromSeed(id)

function sidOf(domain: Domain, id: string): string {
  const rid = 1000 + Number(id.replace(/\D/g, '') || 0)
  const base = [...domain.name].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7)
  return `S-1-5-21-${base}-${(base * 7) >>> 0}-${(base * 13) >>> 0}-${rid}`
}

function userObject(domain: Domain, u: AdUser, clock: number): PsObject {
  return psObject(
    'ADUser',
    {
      DistinguishedName: objectDn(domain, { kind: 'user', obj: u }),
      Enabled: u.enabled,
      GivenName: u.givenName || null,
      Name: u.name,
      ObjectClass: 'user',
      ObjectGUID: guidOf(u.id),
      SamAccountName: u.sam,
      SID: sidOf(domain, u.id),
      Surname: u.surname || null,
      UserPrincipalName: u.upn || null,
      Description: u.description || null,
      PasswordNeverExpires: u.passwordNeverExpires,
      LastLogonDate: u.lastLogon === null ? null : formatShortDate(u.lastLogon),
      LockedOut: isLockedOut(domain, u, clock),
      BadLogonCount: u.badPwdCount,
      AccountLockoutTime: u.lockoutTime === null ? null : formatShortDate(u.lockoutTime),
      whenCreated: formatShortDate(u.whenCreated),
      // Appartenance directe aux groupes (attribut memberOf), visible via -Properties MemberOf
      MemberOf: domain.groups
        .filter((g) => g.members.includes(u.id))
        .map((g) => objectDn(domain, { kind: 'group', obj: g }))
    },
    {
      kind: 'list',
      props: [
        'DistinguishedName',
        'Enabled',
        'GivenName',
        'Name',
        'ObjectClass',
        'ObjectGUID',
        'SamAccountName',
        'SID',
        'Surname',
        'UserPrincipalName'
      ]
    }
  )
}

/**
 * -Properties : propriétés ajoutées au jeu affiché par défaut (« * » : toutes celles de l'objet).
 * Une propriété que l'objet ne porte pas est ignorée, comme un attribut non défini.
 */
function withProperties(obj: PsObject, requested: PsValue | undefined): PsObject {
  if (requested === undefined || !obj.view) return obj
  const names = flatten([requested]).map(psToString)
  const all = Object.keys(obj.props)
  const extra = names.includes('*')
    ? all
    : names.flatMap((n) => all.filter((k) => k.toLowerCase() === n.trim().toLowerCase()))
  const props = [...obj.view.props, ...extra.filter((k) => !obj.view?.props.includes(k))]
  return { ...obj, view: { ...obj.view, props } }
}

function groupObject(domain: Domain, g: AdGroup): PsObject {
  return psObject(
    'ADGroup',
    {
      DistinguishedName: objectDn(domain, { kind: 'group', obj: g }),
      GroupCategory: g.category,
      GroupScope: g.scope,
      Name: g.name,
      ObjectClass: 'group',
      ObjectGUID: guidOf(g.id),
      SamAccountName: g.sam,
      SID: sidOf(domain, g.id)
    },
    {
      kind: 'list',
      props: [
        'DistinguishedName',
        'GroupCategory',
        'GroupScope',
        'Name',
        'ObjectClass',
        'ObjectGUID',
        'SamAccountName',
        'SID'
      ]
    }
  )
}

function ouObject(domain: Domain, c: AdContainer): PsObject {
  return psObject(
    'ADOrganizationalUnit',
    {
      City: null,
      Country: null,
      DistinguishedName: containerDn(domain, c.id),
      LinkedGroupPolicyObjects: `{${c.gpLinks
        .map((l) => `cn=${l.gpoId},cn=policies,cn=system,${domainDn(domain)}`)
        .join(', ')}}`,
      ManagedBy: null,
      Name: c.name,
      ObjectClass: 'organizationalUnit',
      ObjectGUID: guidOf(c.id),
      PostalCode: null,
      ProtectedFromAccidentalDeletion: c.protected,
      State: null,
      StreetAddress: null
    },
    {
      kind: 'list',
      props: [
        'City',
        'Country',
        'DistinguishedName',
        'LinkedGroupPolicyObjects',
        'ManagedBy',
        'Name',
        'ObjectClass',
        'ObjectGUID',
        'PostalCode',
        'State',
        'StreetAddress'
      ]
    }
  )
}

function computerObject(domain: Domain, c: AdComputer): PsObject {
  return psObject(
    'ADComputer',
    {
      DistinguishedName: objectDn(domain, { kind: 'computer', obj: c }),
      DNSHostName: c.dnsHostName,
      Enabled: c.enabled,
      Name: c.name,
      ObjectClass: 'computer',
      ObjectGUID: guidOf(c.id),
      SamAccountName: `${c.name}$`,
      SID: sidOf(domain, c.id),
      UserPrincipalName: null
    },
    {
      kind: 'list',
      props: [
        'DistinguishedName',
        'DNSHostName',
        'Enabled',
        'Name',
        'ObjectClass',
        'ObjectGUID',
        'SamAccountName',
        'SID',
        'UserPrincipalName'
      ]
    }
  )
}

function toPs(domain: Domain, o: AdObject, clock: number): PsObject {
  switch (o.kind) {
    case 'user':
      return userObject(domain, o.obj, clock)
    case 'group':
      return groupObject(domain, o.obj)
    case 'computer':
      return computerObject(domain, o.obj)
    case 'container':
      return ouObject(domain, o.obj)
  }
}

/** Domaine de l'ordinateur ; `write` exige un administrateur du domaine. */
export function adDomain(ctx: CmdContext, write = false): Domain {
  const name = ctx.host.host.domain
  const domain = name ? ctx.state.domains[name] : undefined
  const dcUp = domain?.controllers.some((id) => ctx.state.devices[id]?.powered)
  if (!domain || !dcUp)
    throw psError(
      'Impossible de trouver un serveur par défaut sur lequel les services Web Active Directory s’exécutent.',
      'ResourceUnavailable',
      'ActiveDirectoryServer:0',
      '',
      'ADServerDownException'
    )
  if (write) {
    const user = ctx.user
    if (!user.domain || !isDomainAdmin(domain, user.name))
      throw psError(
        'Accès refusé',
        'PermissionDenied',
        'ActiveDirectoryCmdlet:System.UnauthorizedAccessException',
        '',
        'UnauthorizedAccessException'
      )
  }
  return domain
}

function identityNotFound(domain: Domain, identity: string) {
  return psError(
    `Impossible de trouver un objet avec l’identité « ${identity} » sous « ${domainDn(domain)} ».`,
    'ObjectNotFound',
    'ActiveDirectoryCmdlet:ActiveDirectory.Management.ADIdentityNotFoundException',
    identity,
    'ADIdentityNotFoundException'
  )
}

/** Objets correspondant à -Identity ou -Filter. */
function select(
  ctx: CmdContext,
  domain: Domain,
  args: BoundArgs,
  kind: AdObject['kind'],
  ouOnly = false
): AdObject[] {
  const all = allObjects(domain).filter(
    (o) => o.kind === kind && (!ouOnly || (o.kind === 'container' && o.obj.kind === 'ou'))
  )
  if (args['Identity'] !== undefined) {
    const identity = str(args['Identity'])
    const found =
      kind === 'container'
        ? all.find(
            (o) =>
              objectDn(domain, o).toLowerCase() === identity.toLowerCase() ||
              o.obj.name.toLowerCase() === identity.toLowerCase()
          )
        : findPrincipal(domain, identity)
    if (!found || found.kind !== kind) throw identityNotFound(domain, identity)
    return [found]
  }
  const filterValue = args['Filter'] ?? args['LDAPFilter']
  if (filterValue === undefined)
    throw psError(
      'Le paramètre -Identity ou -Filter est obligatoire.',
      'InvalidArgument',
      'ParameterSetRequired'
    )
  const filter = isScript(filterValue) ? filterValue.source : str(filterValue)
  let items = all
  if (args['SearchBase'] !== undefined) {
    const base = resolveContainerDn(domain, str(args['SearchBase']))
    if (base === undefined)
      throw psError(
        `Objet de répertoire non trouvé : « ${str(args['SearchBase'])} ».`,
        'ObjectNotFound',
        'ActiveDirectoryCmdlet:DirectoryObjectNotFound'
      )
    items = items.filter((o) => {
      let cursor: string | null = o.kind === 'container' ? o.obj.parentId : o.obj.parentId
      if (o.kind === 'container' && o.obj.id === base) return true
      while (cursor) {
        if (cursor === base) return true
        cursor = domain.containers.find((c) => c.id === cursor)?.parentId ?? null
      }
      return base === null
    })
  }
  if (filter.trim() === '*') return items
  return items.filter((o) => {
    const obj = toPs(domain, o, ctx.state.clock)
    return psToBool(
      evaluateExpression(filter, { variable: (n) => ctx.variable(n), bare: (w) => getProp(obj, w) })
    )
  })
}

const identityParam: ParamDef = { name: 'Identity', type: 'string', position: 0 }
const filterParams: ParamDef[] = [
  { name: 'Filter', type: 'any' },
  { name: 'LDAPFilter', type: 'string' },
  { name: 'SearchBase', type: 'string' },
  { name: 'Properties', type: 'string[]' },
  { name: 'Server', type: 'string' }
]

export function secureText(v: PsValue | undefined): string | undefined {
  if (v === undefined) return undefined
  return isSecure(v) ? v.value : str(v)
}

export const adCmdlets: CmdletDef[] = [
  {
    name: 'Install-ADDSForest',
    module: 'ADDSDeployment',
    synopsis: 'Promeut le serveur en contrôleur de domaine d’une nouvelle forêt.',
    available: (ctx) => hasFeature(ctx, 'AD-Domain-Services'),
    params: [
      { name: 'DomainName', type: 'string', mandatory: true },
      { name: 'DomainNetbiosName', type: 'string' },
      { name: 'SafeModeAdministratorPassword', type: 'secure', mandatory: true, confirm: true },
      { name: 'InstallDns', type: 'switch' },
      { name: 'CreateDnsDelegation', type: 'bool' },
      { name: 'Force', type: 'switch' },
      { name: 'NoRebootOnCompletion', type: 'switch' },
      { name: 'DomainMode', type: 'string' },
      { name: 'ForestMode', type: 'string' },
      { name: 'DatabasePath', type: 'string' },
      { name: 'LogPath', type: 'string' },
      { name: 'SysvolPath', type: 'string' }
    ],
    run(ctx, args) {
      if (args['Force'] !== true) {
        ctx.writeLines([
          'Le serveur cible sera configuré en tant que contrôleur de domaine et redémarré une fois cette opération terminée.'
        ])
        const answer = ctx
          .ask(
            'Voulez-vous continuer cette opération ?\n[O] Oui  [T] Oui pour tout  [N] Non  [U] Non pour tout  [?] Aide (la valeur par défaut est « O ») : '
          )
          .trim()
          .toLowerCase()
        if (answer !== '' && answer !== 'o' && answer !== 't') return []
      }
      const result = ctx.apply(
        installForest(ctx.state, ctx.deviceId, {
          domainName: str(args['DomainName']),
          ...(args['DomainNetbiosName'] ? { netbios: str(args['DomainNetbiosName']) } : {}),
          safeModePassword: secureText(args['SafeModeAdministratorPassword']) ?? '',
          installDns: true
        })
      )
      for (const w of result.warnings) ctx.warn(w)
      ctx.writeLines([
        '',
        'Message                                  Context           RebootRequired  Status',
        '-------                                  -------           --------------  ------',
        `L’opération a réussi.                    DCPromo.General.1          False Success`,
        '',
        'Vous allez être déconnecté : l’ordinateur redémarre pour terminer la promotion…'
      ])
      ctx.exit = true
      return []
    }
  },
  {
    name: 'Add-Computer',
    module: 'Management',
    synopsis: 'Joint l’ordinateur à un domaine.',
    params: [
      { name: 'DomainName', type: 'string', mandatory: true, position: 0 },
      { name: 'Credential', type: 'credential', mandatory: true },
      { name: 'OUPath', type: 'string' },
      { name: 'Restart', type: 'switch' },
      { name: 'Force', type: 'switch' }
    ],
    run(ctx, args) {
      const cred = args['Credential']
      if (!isCredential(cred ?? null))
        throw psError('Informations d’identification invalides.', 'InvalidArgument', 'InvalidCredential')
      const credential = cred as { user: string; password: string }
      const op = joinDomain(ctx.state, ctx.deviceId, {
        domain: str(args['DomainName']),
        user: credential.user,
        password: credential.password,
        ...(args['OUPath'] ? { ouPath: str(args['OUPath']) } : {})
      })
      ctx.addTrace(op.trace)
      if (!op.ok)
        throw psError(op.message, 'OperationStopped', 'FailToJoinDomainFromWorkgroup', ctx.host.name)
      ctx.state = op.state
      if (args['Restart'] === true) {
        ctx.apply(restartComputer(ctx.state, ctx.deviceId))
        ctx.write('Redémarrage de l’ordinateur…')
        ctx.exit = true
      } else {
        ctx.warn(
          `Les modifications seront prises en compte après le redémarrage de l’ordinateur ${ctx.host.name}.`
        )
      }
      return []
    }
  },
  {
    name: 'Remove-Computer',
    module: 'Management',
    synopsis: 'Retire l’ordinateur du domaine (groupe de travail).',
    params: [
      { name: 'UnjoinDomainCredential', type: 'credential' },
      { name: 'WorkgroupName', type: 'string' },
      { name: 'Restart', type: 'switch' },
      { name: 'Force', type: 'switch' }
    ],
    run(ctx, args) {
      if (!ctx.confirm(ctx.host.name, 'Remove-Computer')) return []
      const op = leaveDomain(ctx.state, ctx.deviceId)
      if (!op.ok) throw psError(op.message, 'InvalidOperation', 'NotDomainMember')
      ctx.state = op.state
      if (args['Restart'] === true) {
        ctx.apply(restartComputer(ctx.state, ctx.deviceId))
        ctx.exit = true
      } else
        ctx.warn(
          `Les modifications seront prises en compte après le redémarrage de l’ordinateur ${ctx.host.name}.`
        )
      return []
    }
  },
  {
    name: 'Get-ADDomain',
    module: 'ActiveDirectory',
    synopsis: 'Informations sur le domaine.',
    available: adAvailable,
    params: [],
    run(ctx) {
      const domain = adDomain(ctx)
      const dc = ctx.state.devices[domain.controllers[0] ?? '']
      return [
        psObject(
          'ADDomain',
          {
            DistinguishedName: domainDn(domain),
            DNSRoot: domain.name,
            Forest: domain.name,
            Name: domain.netbios.toLowerCase(),
            NetBIOSName: domain.netbios,
            PDCEmulator: dc ? `${dc.name}.${domain.name}` : '',
            UsersContainer: `CN=Users,${domainDn(domain)}`,
            ComputersContainer: `CN=Computers,${domainDn(domain)}`
          },
          {
            kind: 'list',
            props: [
              'DistinguishedName',
              'DNSRoot',
              'Forest',
              'Name',
              'NetBIOSName',
              'PDCEmulator',
              'UsersContainer',
              'ComputersContainer'
            ]
          }
        )
      ]
    }
  },
  {
    name: 'New-ADOrganizationalUnit',
    module: 'ActiveDirectory',
    synopsis: 'Crée une unité d’organisation.',
    available: adAvailable,
    params: [
      { name: 'Name', type: 'string', mandatory: true, position: 0 },
      { name: 'Path', type: 'string' },
      { name: 'Description', type: 'string' },
      { name: 'ProtectedFromAccidentalDeletion', type: 'bool' }
    ],
    run(ctx, args) {
      const domain = adDomain(ctx, true)
      ctx.apply(
        addOrganizationalUnit(ctx.state, domain.name, {
          name: str(args['Name']),
          ...(args['Path'] ? { path: str(args['Path']) } : {}),
          description: str(args['Description']),
          protectedFromDeletion:
            args['ProtectedFromAccidentalDeletion'] === undefined
              ? true
              : args['ProtectedFromAccidentalDeletion'] === true
        })
      )
      return []
    }
  },
  {
    name: 'Get-ADOrganizationalUnit',
    module: 'ActiveDirectory',
    synopsis: 'Recherche des unités d’organisation.',
    available: adAvailable,
    params: [identityParam, ...filterParams],
    run(ctx, args) {
      const domain = adDomain(ctx)
      return select(ctx, domain, args, 'container', true).map((o) => toPs(domain, o, ctx.state.clock))
    }
  },
  {
    name: 'Set-ADOrganizationalUnit',
    module: 'ActiveDirectory',
    synopsis: 'Modifie une unité d’organisation.',
    available: adAvailable,
    params: [
      { ...identityParam, mandatory: true, pipeline: true },
      { name: 'ProtectedFromAccidentalDeletion', type: 'bool' },
      { name: 'Description', type: 'string' }
    ],
    run(ctx, args) {
      const domain = adDomain(ctx, true)
      const [ou] = select(ctx, domain, args, 'container', true)
      if (ou && args['ProtectedFromAccidentalDeletion'] !== undefined)
        ctx.apply(
          setOuProtection(ctx.state, domain.name, ou.obj.id, args['ProtectedFromAccidentalDeletion'] === true)
        )
      return []
    }
  },
  {
    name: 'Remove-ADOrganizationalUnit',
    module: 'ActiveDirectory',
    synopsis: 'Supprime une unité d’organisation.',
    available: adAvailable,
    params: [
      { ...identityParam, mandatory: true, pipeline: true },
      { name: 'Recursive', type: 'switch' }
    ],
    run(ctx, args) {
      const domain = adDomain(ctx, true)
      const [ou] = select(ctx, domain, args, 'container', true)
      if (!ou || !ctx.confirm(objectDn(domain, ou), 'Remove')) return []
      ctx.apply(removeObject(ctx.state, domain.name, ou.obj.id, args['Recursive'] === true))
      return []
    }
  },
  {
    name: 'New-ADUser',
    module: 'ActiveDirectory',
    synopsis: 'Crée un compte d’utilisateur.',
    available: adAvailable,
    params: [
      { name: 'Name', type: 'string', mandatory: true, position: 0 },
      { name: 'SamAccountName', type: 'string' },
      { name: 'GivenName', type: 'string' },
      { name: 'Surname', type: 'string' },
      { name: 'DisplayName', type: 'string' },
      { name: 'UserPrincipalName', type: 'string' },
      { name: 'Path', type: 'string' },
      { name: 'AccountPassword', type: 'secure' },
      { name: 'Enabled', type: 'bool' },
      { name: 'ChangePasswordAtLogon', type: 'bool' },
      { name: 'PasswordNeverExpires', type: 'bool' },
      { name: 'Description', type: 'string' },
      { name: 'PassThru', type: 'switch' }
    ],
    run(ctx, args) {
      const domain = adDomain(ctx, true)
      const result = ctx.apply(
        addUser(
          ctx.state,
          domain.name,
          {
            name: str(args['Name']),
            ...(args['SamAccountName'] ? { sam: str(args['SamAccountName']) } : {}),
            givenName: str(args['GivenName']),
            surname: str(args['Surname']),
            upn: str(args['UserPrincipalName']),
            ...(args['Path'] ? { path: str(args['Path']) } : {}),
            ...(args['AccountPassword'] !== undefined
              ? { password: secureText(args['AccountPassword']) ?? '' }
              : {}),
            enabled: args['Enabled'] === true,
            mustChangePassword: args['ChangePasswordAtLogon'] === true,
            passwordNeverExpires: args['PasswordNeverExpires'] === true,
            description: str(args['Description'])
          },
          `${ctx.user.domain}\\${ctx.user.name}`
        )
      )
      if (result.passwordError)
        throw psError(
          result.passwordError,
          'InvalidData',
          'ActiveDirectoryServer:1325,NewADUser',
          str(args['Name']),
          'ADPasswordComplexityException'
        )
      if (args['PassThru'] === true) {
        const d = ctx.state.domains[domain.name]
        const u = d?.users.find((x) => x.id === result.id)
        return d && u ? [userObject(d, u, ctx.state.clock)] : []
      }
      return []
    }
  },
  {
    name: 'Get-ADUser',
    module: 'ActiveDirectory',
    synopsis: 'Recherche des comptes d’utilisateurs.',
    available: adAvailable,
    params: [identityParam, ...filterParams],
    run(ctx, args) {
      const domain = adDomain(ctx)
      return select(ctx, domain, args, 'user').map((o) =>
        withProperties(toPs(domain, o, ctx.state.clock), args['Properties'])
      )
    }
  },
  {
    name: 'Set-ADUser',
    module: 'ActiveDirectory',
    synopsis: 'Modifie un compte d’utilisateur.',
    available: adAvailable,
    params: [
      { ...identityParam, mandatory: true, pipeline: true },
      { name: 'Description', type: 'string' },
      { name: 'GivenName', type: 'string' },
      { name: 'Surname', type: 'string' },
      { name: 'UserPrincipalName', type: 'string' },
      { name: 'ChangePasswordAtLogon', type: 'bool' },
      { name: 'PasswordNeverExpires', type: 'bool' },
      { name: 'Enabled', type: 'bool' }
    ],
    run(ctx, args) {
      const domain = adDomain(ctx, true)
      const identity = str(args['Identity'])
      ctx.apply(
        setUserProperties(ctx.state, domain.name, identity, {
          ...(args['Description'] !== undefined ? { description: str(args['Description']) } : {}),
          ...(args['GivenName'] !== undefined ? { givenName: str(args['GivenName']) } : {}),
          ...(args['Surname'] !== undefined ? { surname: str(args['Surname']) } : {}),
          ...(args['UserPrincipalName'] !== undefined ? { upn: str(args['UserPrincipalName']) } : {}),
          ...(args['ChangePasswordAtLogon'] !== undefined
            ? { mustChangePassword: args['ChangePasswordAtLogon'] === true }
            : {}),
          ...(args['PasswordNeverExpires'] !== undefined
            ? { passwordNeverExpires: args['PasswordNeverExpires'] === true }
            : {})
        })
      )
      if (args['Enabled'] !== undefined)
        ctx.apply(setAccountEnabled(ctx.state, domain.name, identity, args['Enabled'] === true))
      return []
    }
  },
  {
    name: 'Unlock-ADAccount',
    module: 'ActiveDirectory',
    synopsis: 'Déverrouille un compte verrouillé.',
    available: adAvailable,
    params: [{ ...identityParam, mandatory: true, pipeline: true }],
    run(ctx, args) {
      const domain = adDomain(ctx, true)
      ctx.apply(unlockAccount(ctx.state, domain.name, str(args['Identity'])))
      return []
    }
  },
  {
    name: 'Search-ADAccount',
    module: 'ActiveDirectory',
    synopsis: 'Recherche des comptes (verrouillés, désactivés).',
    available: adAvailable,
    params: [
      { name: 'LockedOut', type: 'switch' },
      { name: 'AccountDisabled', type: 'switch' },
      { name: 'UsersOnly', type: 'switch' }
    ],
    run(ctx, args) {
      const domain = adDomain(ctx)
      if (args['LockedOut'] !== true && args['AccountDisabled'] !== true)
        throw psError(
          'Le jeu de paramètres ne peut pas être résolu à l’aide des paramètres nommés spécifiés.',
          'InvalidArgument',
          'AmbiguousParameterSet'
        )
      return domain.users
        .filter(
          (u) =>
            (args['LockedOut'] !== true || isLockedOut(domain, u, ctx.state.clock)) &&
            (args['AccountDisabled'] !== true || !u.enabled)
        )
        .map((u) => userObject(domain, u, ctx.state.clock))
    }
  },
  ...(['Enable', 'Disable'] as const).map((verb): CmdletDef => ({
    name: `${verb}-ADAccount`,
    module: 'ActiveDirectory',
    synopsis: verb === 'Enable' ? 'Active un compte.' : 'Désactive un compte.',
    available: adAvailable,
    params: [{ ...identityParam, mandatory: true, pipeline: true }],
    run(ctx, args) {
      const domain = adDomain(ctx, true)
      ctx.apply(setAccountEnabled(ctx.state, domain.name, str(args['Identity']), verb === 'Enable'))
      return []
    }
  })),
  {
    name: 'Set-ADAccountPassword',
    module: 'ActiveDirectory',
    synopsis: 'Réinitialise le mot de passe d’un compte.',
    available: adAvailable,
    params: [
      { ...identityParam, mandatory: true, pipeline: true },
      { name: 'NewPassword', type: 'secure', mandatory: true },
      { name: 'Reset', type: 'switch' },
      { name: 'OldPassword', type: 'secure' }
    ],
    run(ctx, args) {
      const domain = adDomain(ctx, true)
      ctx.apply(
        resetPassword(ctx.state, domain.name, str(args['Identity']), secureText(args['NewPassword']) ?? '')
      )
      return []
    }
  },
  {
    name: 'Remove-ADUser',
    module: 'ActiveDirectory',
    synopsis: 'Supprime un compte d’utilisateur.',
    available: adAvailable,
    params: [{ ...identityParam, mandatory: true, pipeline: true }],
    run(ctx, args) {
      const domain = adDomain(ctx, true)
      const [u] = select(ctx, domain, args, 'user')
      if (u && ctx.confirm(objectDn(domain, u), 'Remove'))
        ctx.apply(removeObject(ctx.state, domain.name, u.obj.id))
      return []
    }
  },
  {
    name: 'New-ADGroup',
    module: 'ActiveDirectory',
    synopsis: 'Crée un groupe.',
    available: adAvailable,
    params: [
      { name: 'Name', type: 'string', mandatory: true, position: 0 },
      {
        name: 'GroupScope',
        type: 'string',
        mandatory: true,
        position: 1,
        validateSet: ['DomainLocal', 'Global', 'Universal']
      },
      { name: 'GroupCategory', type: 'string', validateSet: ['Security', 'Distribution'] },
      { name: 'SamAccountName', type: 'string' },
      { name: 'Path', type: 'string' },
      { name: 'Description', type: 'string' }
    ],
    run(ctx, args) {
      const domain = adDomain(ctx, true)
      ctx.apply(
        addGroup(ctx.state, domain.name, {
          name: str(args['Name']),
          scope: str(args['GroupScope']) as AdGroup['scope'],
          category: (args['GroupCategory'] ? str(args['GroupCategory']) : 'Security') as AdGroup['category'],
          ...(args['SamAccountName'] ? { sam: str(args['SamAccountName']) } : {}),
          ...(args['Path'] ? { path: str(args['Path']) } : {}),
          description: str(args['Description'])
        })
      )
      return []
    }
  },
  {
    name: 'Get-ADGroup',
    module: 'ActiveDirectory',
    synopsis: 'Recherche des groupes.',
    available: adAvailable,
    params: [identityParam, ...filterParams],
    run(ctx, args) {
      const domain = adDomain(ctx)
      return select(ctx, domain, args, 'group').map((o) => toPs(domain, o, ctx.state.clock))
    }
  },
  {
    name: 'Remove-ADGroup',
    module: 'ActiveDirectory',
    synopsis: 'Supprime un groupe.',
    available: adAvailable,
    params: [{ ...identityParam, mandatory: true, pipeline: true }],
    run(ctx, args) {
      const domain = adDomain(ctx, true)
      const [g] = select(ctx, domain, args, 'group')
      if (g && ctx.confirm(objectDn(domain, g), 'Remove'))
        ctx.apply(removeObject(ctx.state, domain.name, g.obj.id))
      return []
    }
  },
  {
    name: 'Add-ADGroupMember',
    module: 'ActiveDirectory',
    synopsis: 'Ajoute des membres à un groupe.',
    available: adAvailable,
    params: [
      { ...identityParam, mandatory: true, pipeline: true },
      { name: 'Members', type: 'string[]', mandatory: true, position: 1, aliases: ['Member'] }
    ],
    run(ctx, args) {
      const domain = adDomain(ctx, true)
      ctx.apply(
        addGroupMembers(
          ctx.state,
          domain.name,
          str(args['Identity']),
          flatten([args['Members'] ?? []]).map(psToString)
        )
      )
      return []
    }
  },
  {
    name: 'Remove-ADGroupMember',
    module: 'ActiveDirectory',
    synopsis: 'Retire des membres d’un groupe.',
    available: adAvailable,
    params: [
      { ...identityParam, mandatory: true, pipeline: true },
      { name: 'Members', type: 'string[]', mandatory: true, position: 1, aliases: ['Member'] }
    ],
    run(ctx, args) {
      const domain = adDomain(ctx, true)
      if (!ctx.confirm(str(args['Identity']), 'Remove-ADGroupMember')) return []
      ctx.apply(
        removeGroupMembers(
          ctx.state,
          domain.name,
          str(args['Identity']),
          flatten([args['Members'] ?? []]).map(psToString)
        )
      )
      return []
    }
  },
  {
    name: 'Get-ADGroupMember',
    module: 'ActiveDirectory',
    synopsis: 'Liste les membres d’un groupe.',
    available: adAvailable,
    params: [
      { ...identityParam, mandatory: true },
      { name: 'Recursive', type: 'switch' }
    ],
    run(ctx, args) {
      const domain = adDomain(ctx)
      const [g] = select(ctx, domain, args, 'group')
      if (!g || g.kind !== 'group') return []
      const ids = new Set<string>()
      const queue = [...g.obj.members]
      while (queue.length > 0) {
        const id = queue.shift() as string
        const o = allObjects(domain).find((x) => x.obj.id === id)
        if (!o) continue
        if (o.kind === 'group' && args['Recursive'] === true) queue.push(...o.obj.members)
        else ids.add(id)
      }
      return [...ids]
        .map((id) => allObjects(domain).find((x) => x.obj.id === id))
        .filter((o): o is AdObject => !!o)
        .map((o) =>
          psObject(
            'ADPrincipal',
            {
              distinguishedName: objectDn(domain, o),
              name: o.obj.name,
              objectClass: o.kind === 'container' ? 'organizationalUnit' : o.kind,
              objectGUID: guidOf(o.obj.id),
              SamAccountName:
                o.kind === 'computer' ? `${o.obj.name}$` : o.kind === 'container' ? '' : o.obj.sam,
              SID: sidOf(domain, o.obj.id)
            },
            {
              kind: 'list',
              props: ['distinguishedName', 'name', 'objectClass', 'objectGUID', 'SamAccountName', 'SID']
            }
          )
        )
    }
  },
  {
    name: 'Get-ADPrincipalGroupMembership',
    module: 'ActiveDirectory',
    synopsis: 'Groupes dont un compte est membre.',
    available: adAvailable,
    params: [{ ...identityParam, mandatory: true }],
    run(ctx, args) {
      const domain = adDomain(ctx)
      const o = findPrincipal(domain, str(args['Identity']))
      if (!o) throw identityNotFound(domain, str(args['Identity']))
      return domain.groups.filter((g) => g.members.includes(o.obj.id)).map((g) => groupObject(domain, g))
    }
  },
  {
    name: 'Get-ADComputer',
    module: 'ActiveDirectory',
    synopsis: 'Recherche des comptes d’ordinateurs.',
    available: adAvailable,
    params: [identityParam, ...filterParams],
    run(ctx, args) {
      const domain = adDomain(ctx)
      return select(ctx, domain, args, 'computer').map((o) => toPs(domain, o, ctx.state.clock))
    }
  },
  {
    name: 'Move-ADObject',
    module: 'ActiveDirectory',
    synopsis: 'Déplace un objet vers une autre unité d’organisation.',
    available: adAvailable,
    params: [
      { ...identityParam, mandatory: true, pipeline: true },
      { name: 'TargetPath', type: 'string', mandatory: true, position: 1 }
    ],
    run(ctx, args) {
      const domain = adDomain(ctx, true)
      const identity = str(args['Identity'])
      const found =
        findPrincipal(domain, identity) ??
        allObjects(domain).find(
          (o) => o.kind === 'container' && objectDn(domain, o).toLowerCase() === identity.toLowerCase()
        )
      if (!found) throw identityNotFound(domain, identity)
      ctx.apply(moveObject(ctx.state, domain.name, found.obj.id, str(args['TargetPath'])))
      return []
    }
  }
]

/** Groupes de l'utilisateur courant (pour whoami /groups). */
export function currentUserGroups(ctx: ExecContext): string[] {
  const domain = ctx.host.host.domain ? ctx.state.domains[ctx.host.host.domain] : undefined
  const user = domain?.users.find((u) => u.sam.toLowerCase() === ctx.user.name.toLowerCase())
  return domain && user ? groupsOf(domain, user.id).map((g) => `${domain.netbios}\\${g.name}`) : []
}

// ---------------------------------------------------------------------------------------------
// Forêt, groupes, stratégie de mot de passe, comptes d'ordinateurs (v2.7, Lot 2b)

/** Durée en minutes au format TimeSpan (« 00:30:00 », « 1.00:00:00 »). */
export function formatTimeSpan(minutes: number): string {
  const days = Math.floor(minutes / 1440)
  const h = Math.floor((minutes % 1440) / 60)
  const m = minutes % 60
  const time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`
  return days > 0 ? `${days}.${time}` : time
}

/** TimeSpan saisi (« 00:40:00 », « 1.00:00:00 ») → minutes entières. */
function parseTimeSpan(value: PsValue, name: string): number {
  const text = str(value).trim()
  const m = /^(?:(\d+)\.)?(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text)
  if (!m || Number(m[4] ?? 0) !== 0)
    throw psError(
      `Impossible de lier le paramètre « ${name} ». Impossible de convertir la valeur « ${text} » en type « System.TimeSpan » (minutes entières attendues, ex. 00:30:00).`,
      'InvalidArgument',
      `CannotConvertArgumentNoMessage,${name}`
    )
  return Number(m[1] ?? 0) * 1440 + Number(m[2]) * 60 + Number(m[3])
}

/** Domaine désigné par -Identity (DNS, NetBIOS ou DN) : celui de l'ordinateur, seul domaine simulé. */
function domainIdentity(domain: Domain, args: BoundArgs, input: PsValue[] = []): Domain {
  const v = args['Identity'] ?? input[0]
  if (v === undefined) return domain
  const text = isPsObjectValue(v) ? str(getProp(v, 'DNSRoot') ?? getProp(v, 'Name')) : str(v)
  const lower = text.toLowerCase()
  if (
    lower === domain.name ||
    lower === domain.netbios.toLowerCase() ||
    lower === domainDn(domain).toLowerCase()
  )
    return domain
  throw psError(
    `Impossible de trouver un objet avec l’identité « ${text} » sous « ${domainDn(domain)} ».`,
    'ObjectNotFound',
    'ActiveDirectoryCmdlet:ActiveDirectory.Management.ADIdentityNotFoundException',
    text,
    'ADIdentityNotFoundException'
  )
}

const isPsObjectValue = (v: PsValue): boolean =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && v.kind === 'object'

/** Erreur du moteur → erreur AD (ADException). */
function adRun(fn: () => void, target: string): void {
  try {
    fn()
  } catch (e) {
    if (e instanceof CommandFailure)
      throw psError(e.message, 'InvalidOperation', `ActiveDirectoryCmdlet:${e.code}`, target, 'ADException')
    throw e
  }
}

function passwordPolicyObject(domain: Domain): PsObject {
  const pwd = domainPasswordPolicy(domain)
  const lockout = domainLockoutPolicy(domain)
  return psObject(
    'ADDefaultDomainPasswordPolicy',
    {
      ComplexityEnabled: pwd.complexity,
      DistinguishedName: domainDn(domain),
      LockoutDuration: formatTimeSpan(lockout.duration),
      LockoutObservationWindow: formatTimeSpan(lockout.reset),
      LockoutThreshold: lockout.threshold,
      MinPasswordLength: pwd.minLength,
      objectClass: '{domainDNS}'
    },
    {
      kind: 'list',
      props: [
        'ComplexityEnabled',
        'DistinguishedName',
        'LockoutDuration',
        'LockoutObservationWindow',
        'LockoutThreshold',
        'MinPasswordLength',
        'objectClass'
      ]
    }
  )
}

export const adLot2Cmdlets: CmdletDef[] = [
  {
    name: 'Get-ADForest',
    module: 'ActiveDirectory',
    synopsis: 'Informations sur la forêt (forêt à un seul domaine).',
    available: adAvailable,
    params: [
      { name: 'Identity', type: 'string', position: 0 },
      { name: 'Current', type: 'string', validateSet: ['LocalComputer', 'LoggedOnUser'] },
      { name: 'Server', type: 'string' }
    ],
    run(ctx, args) {
      const domain = domainIdentity(adDomain(ctx), args)
      const fqdn = (id: string | null) => {
        const d = id ? ctx.state.devices[id] : undefined
        return d ? `${d.name}.${domain.name}` : ''
      }
      const dn = domainDn(domain)
      const set = (items: string[]) => `{${items.join(', ')}}`
      return [
        psObject(
          'ADForest',
          {
            ApplicationPartitions: set([`DC=ForestDnsZones,${dn}`, `DC=DomainDnsZones,${dn}`]),
            CrossForestReferences: '{}',
            DomainNamingMaster: fqdn(fsmoHolder(domain, 'DomainNamingMaster')),
            Domains: set([domain.name]),
            GlobalCatalogs: set(domain.controllers.map((id) => fqdn(id)).filter(Boolean)),
            Name: domain.name,
            PartitionsContainer: `CN=Partitions,CN=Configuration,${dn}`,
            RootDomain: domain.name,
            SchemaMaster: fqdn(fsmoHolder(domain, 'SchemaMaster')),
            Sites: set(domain.sites.map((s) => s.name)),
            SPNSuffixes: '{}',
            UPNSuffixes: '{}'
          },
          {
            kind: 'list',
            props: [
              'ApplicationPartitions',
              'CrossForestReferences',
              'DomainNamingMaster',
              'Domains',
              'GlobalCatalogs',
              'Name',
              'PartitionsContainer',
              'RootDomain',
              'SchemaMaster',
              'Sites',
              'SPNSuffixes',
              'UPNSuffixes'
            ]
          }
        )
      ]
    }
  },
  {
    name: 'Set-ADGroup',
    module: 'ActiveDirectory',
    synopsis: 'Modifie un groupe (description, étendue, catégorie, nom SAM).',
    available: adAvailable,
    params: [
      { ...identityParam, mandatory: true, pipeline: true },
      { name: 'Description', type: 'string' },
      {
        name: 'GroupScope',
        type: 'string',
        validateSet: ['DomainLocal', 'Global', 'Universal', '0', '1', '2']
      },
      { name: 'GroupCategory', type: 'string', validateSet: ['Distribution', 'Security', '0', '1'] },
      { name: 'SamAccountName', type: 'string' },
      { name: 'PassThru', type: 'switch' },
      { name: 'Server', type: 'string' },
      { name: 'DisplayName', type: 'string' },
      { name: 'ManagedBy', type: 'string' },
      { name: 'Add', type: 'any' },
      { name: 'Remove', type: 'any' },
      { name: 'Replace', type: 'any' },
      { name: 'Clear', type: 'any' },
      { name: 'Instance', type: 'any' }
    ],
    run(ctx, args) {
      for (const p of ['DisplayName', 'ManagedBy', 'Add', 'Remove', 'Replace', 'Clear', 'Instance'])
        if (args[p] !== undefined)
          throw psError(
            unsimulatedParameterMessage('Set-ADGroup', p),
            'NotImplemented',
            'UnsimulatedParameter'
          )
      const domain = adDomain(ctx, true)
      const [g] = select(ctx, domain, args, 'group')
      if (!g) return []
      // Learn : DomainLocal ou 0, Global ou 1, Universal ou 2 ; Distribution ou 0, Security ou 1
      const scopes = ['DomainLocal', 'Global', 'Universal'] as const
      const scopeArg = args['GroupScope'] === undefined ? undefined : str(args['GroupScope'])
      const scope =
        scopeArg === undefined ? undefined : (scopes[Number(scopeArg)] ?? (scopeArg as AdGroup['scope']))
      const categoryArg = args['GroupCategory'] === undefined ? undefined : str(args['GroupCategory'])
      const category =
        categoryArg === undefined
          ? undefined
          : categoryArg === '0'
            ? 'Distribution'
            : categoryArg === '1'
              ? 'Security'
              : (categoryArg as AdGroup['category'])
      adRun(
        () =>
          ctx.apply(
            setGroupProperties(ctx.state, domain.name, g.kind === 'group' ? g.obj.sam : g.obj.name, {
              ...(args['Description'] !== undefined ? { description: str(args['Description']) } : {}),
              ...(scope ? { scope } : {}),
              ...(category ? { category } : {}),
              ...(args['SamAccountName'] !== undefined ? { sam: str(args['SamAccountName']) } : {})
            })
          ),
        g.obj.name
      )
      if (args['PassThru'] !== true) return []
      const updated = ctx.state.domains[domain.name]
      const group = updated?.groups.find((x) => x.id === g.obj.id)
      return updated && group ? [groupObject(updated, group)] : []
    }
  },
  {
    name: 'Get-ADDefaultDomainPasswordPolicy',
    module: 'ActiveDirectory',
    synopsis: 'Stratégie de mot de passe par défaut du domaine (GPO liées à la racine du domaine).',
    available: adAvailable,
    params: [
      { name: 'Identity', type: 'any', position: 0, pipeline: true },
      { name: 'Current', type: 'string', validateSet: ['LocalComputer', 'LoggedOnUser'] },
      { name: 'Server', type: 'string' }
    ],
    run(ctx, args, input) {
      const domain = domainIdentity(adDomain(ctx), args, input)
      return [passwordPolicyObject(domain)]
    }
  },
  {
    name: 'Set-ADDefaultDomainPasswordPolicy',
    module: 'ActiveDirectory',
    synopsis: 'Modifie la stratégie de mot de passe du domaine (écrite dans la Default Domain Policy).',
    available: adAvailable,
    params: [
      { name: 'Identity', type: 'any', position: 0, pipeline: true },
      { name: 'ComplexityEnabled', type: 'any' },
      { name: 'MinPasswordLength', type: 'int' },
      { name: 'LockoutThreshold', type: 'int' },
      { name: 'LockoutDuration', type: 'any' },
      { name: 'LockoutObservationWindow', type: 'any' },
      { name: 'MaxPasswordAge', type: 'any' },
      { name: 'MinPasswordAge', type: 'any' },
      { name: 'PasswordHistoryCount', type: 'int' },
      { name: 'ReversibleEncryptionEnabled', type: 'any' },
      { name: 'PassThru', type: 'switch' },
      { name: 'Server', type: 'string' }
    ],
    run(ctx, args, input) {
      for (const p of [
        'MaxPasswordAge',
        'MinPasswordAge',
        'PasswordHistoryCount',
        'ReversibleEncryptionEnabled'
      ])
        if (args[p] !== undefined)
          throw psError(
            unsimulatedParameterMessage('Set-ADDefaultDomainPasswordPolicy', p),
            'NotImplemented',
            'UnsimulatedParameter'
          )
      const domain = domainIdentity(adDomain(ctx, true), args, input)
      if (args['Identity'] === undefined && input.length === 0)
        throw psError(
          'Le paramètre -Identity est obligatoire (domaine, par exemple lab.local).',
          'InvalidArgument',
          'ParameterBindingException'
        )
      const ddp = domain.gpos.find((g) => g.id === DEFAULT_DOMAIN_POLICY_ID)
      if (!ddp)
        throw psError(
          'La stratégie Default Domain Policy est introuvable : la stratégie de mot de passe du domaine ne peut pas être modifiée.',
          'ObjectNotFound',
          'ActiveDirectoryCmdlet:GpoNotFound'
        )
      const computer: GpoSettingsPatch['computer'] = {}
      if (args['ComplexityEnabled'] !== undefined)
        computer.passwordComplexity = psToBool(args['ComplexityEnabled'])
      if (args['MinPasswordLength'] !== undefined)
        computer.minPasswordLength = Number(args['MinPasswordLength'])
      if (args['LockoutThreshold'] !== undefined) computer.lockoutThreshold = Number(args['LockoutThreshold'])
      if (args['LockoutDuration'] !== undefined)
        computer.lockoutDuration = parseTimeSpan(args['LockoutDuration'], 'LockoutDuration')
      if (args['LockoutObservationWindow'] !== undefined)
        computer.lockoutReset = parseTimeSpan(args['LockoutObservationWindow'], 'LockoutObservationWindow')
      adRun(() => ctx.apply(updateGpoSettings(ctx.state, domain.name, ddp.id, { computer })), domain.name)
      const updated = ctx.state.domains[domain.name]
      return args['PassThru'] === true && updated ? [passwordPolicyObject(updated)] : []
    }
  },
  {
    name: 'New-ADComputer',
    module: 'ActiveDirectory',
    synopsis: 'Crée un compte d’ordinateur (sans joindre l’ordinateur au domaine).',
    available: adAvailable,
    params: [
      { name: 'Name', type: 'string', mandatory: true, position: 0 },
      { name: 'SamAccountName', type: 'string' },
      { name: 'Path', type: 'string' },
      { name: 'Enabled', type: 'any' },
      { name: 'Description', type: 'string' },
      { name: 'Location', type: 'string' },
      { name: 'DNSHostName', type: 'string' },
      { name: 'Instance', type: 'any' },
      { name: 'OtherAttributes', type: 'any' },
      { name: 'PassThru', type: 'switch' },
      { name: 'Server', type: 'string' }
    ],
    run(ctx, args) {
      for (const p of ['Description', 'Location', 'DNSHostName', 'Instance', 'OtherAttributes'])
        if (args[p] !== undefined)
          throw psError(
            unsimulatedParameterMessage('New-ADComputer', p),
            'NotImplemented',
            'UnsimulatedParameter'
          )
      const domain = adDomain(ctx, true)
      const name = str(args['Name'])
      const sam =
        args['SamAccountName'] === undefined ? undefined : str(args['SamAccountName']).replace(/\$$/, '')
      if (sam !== undefined && sam.toLowerCase() !== name.toLowerCase())
        throw psError(
          'Un SamAccountName différent du nom de l’ordinateur n’est pas simulé dans ServerLab.',
          'NotImplemented',
          'UnsimulatedParameter'
        )
      adRun(
        () =>
          ctx.apply(
            addComputer(ctx.state, domain.name, {
              name,
              ...(args['Path'] !== undefined ? { path: str(args['Path']) } : {}),
              ...(args['Enabled'] !== undefined ? { enabled: psToBool(args['Enabled']) } : {})
            })
          ),
        name
      )
      if (args['PassThru'] !== true) return []
      const updated = ctx.state.domains[domain.name]
      const c = updated?.computers.find((x) => x.name.toLowerCase() === name.toLowerCase())
      return updated && c ? [computerObject(updated, c)] : []
    }
  }
]
