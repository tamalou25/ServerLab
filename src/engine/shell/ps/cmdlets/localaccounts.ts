/**
 * Cmdlets du module Microsoft.PowerShell.LocalAccounts (v2.7, Lot 2b) : Get/New/Set/Remove-LocalUser,
 * Get/New-LocalGroup, Add/Remove/Get-LocalGroupMember. Base de comptes : services/localaccounts.ts.
 *
 * Sourcé Microsoft Learn (PowerShell 5.1, microsoft.powershell.localaccounts) :
 * - Get-LocalUser : affichage « Name Enabled Description » (exemples 1 à 3), -Name (caractères
 *   génériques), -SID ; exemple 3 : SID se terminant par -500 = compte Administrateur intégré.
 * - New-LocalUser : -Name, -Password (SecureString) ou -NoPassword, -FullName, -Description,
 *   -Disabled, -PasswordNeverExpires, -UserMayNotChangePassword ; exemple 1 (-NoPassword) affiche
 *   l'utilisateur créé ; alias nlu ; règles de nom (20 caractères, caractères interdits).
 * - Set-LocalUser : -Description, -FullName, -Password, -PasswordNeverExpires <Boolean>,
 *   -UserMayChangePassword <Boolean> ; exemple 2 « $UserAccount | Set-LocalUser -Password $Password ».
 * - Remove-LocalUser -Name ; New-LocalGroup -Name [-Description] ; Get-LocalGroup [[-Name]] ;
 *   Add-LocalGroupMember -Group -Member (exemple 1 : comptes locaux et DOMAINE\groupe).
 * - PrincipalSource : Local ou ActiveDirectory.
 * Libellés français et colonnes de Get-LocalGroup : docs/fidelite.md, « À vérifier (Lot 2) ».
 */
import {
  addLocalGroupMembers,
  findLocalGroup,
  findLocalUser,
  localGroups,
  localUsers,
  newLocalGroup,
  newLocalUser,
  removeLocalGroupMembers,
  removeLocalUser,
  setLocalUser,
  type LocalUserPatch,
  type LocalUserView
} from '../../../services/localaccounts'
import { CommandFailure } from '../../context'
import { unsimulatedParameterMessage } from '../../unsimulated'
import { psError } from '../errors'
import type { CmdContext } from '../interpreter'
import type { BoundArgs, CmdletDef } from '../registry'
import {
  flatten,
  isPsObject,
  isSecure,
  psObject,
  psToBool,
  psToString,
  wildcardToRegExp,
  type PsObject,
  type PsValue
} from '../values'

const MODULE = 'Microsoft.PowerShell.LocalAccounts'
const str = (v: PsValue | undefined) => psToString(v)
const list = (v: PsValue | undefined) => (v === undefined ? [] : flatten([v]).map(psToString))

/** SID d'ordinateur déterministe (S-1-5-21-a-b-c), dérivé de l'identifiant de l'équipement. */
function machineSid(deviceId: string): string {
  const base = [...deviceId].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 11)
  return `S-1-5-21-${base}-${(base * 5) >>> 0}-${(base * 17) >>> 0}`
}

function userObject(ctx: CmdContext, u: LocalUserView): PsObject {
  return psObject(
    'Microsoft.PowerShell.Commands.LocalUser',
    {
      Name: u.name,
      Enabled: u.enabled,
      Description: u.description,
      FullName: u.fullName,
      UserMayChangePassword: u.userMayChangePassword,
      PasswordRequired: u.password !== '',
      SID: `${machineSid(ctx.deviceId)}-${u.rid}`,
      PrincipalSource: 'Local',
      ObjectClass: 'Utilisateur'
    },
    { kind: 'table', props: ['Name', 'Enabled', 'Description'] }
  )
}

function groupObject(ctx: CmdContext, g: { name: string; description: string; sid: string }): PsObject {
  return psObject(
    'Microsoft.PowerShell.Commands.LocalGroup',
    {
      Name: g.name,
      Description: g.description,
      SID: g.sid.startsWith('rid:') ? `${machineSid(ctx.deviceId)}-${g.sid.slice(4)}` : g.sid,
      PrincipalSource: 'Local',
      ObjectClass: 'Groupe'
    },
    { kind: 'table', props: ['Name', 'Description'] }
  )
}

/** Erreurs du moteur → erreurs PowerShell (identifiants du module LocalAccounts). */
function run<T>(fn: () => T, target: string): T {
  try {
    return fn()
  } catch (e) {
    if (!(e instanceof CommandFailure)) throw e
    const category: Record<string, string> = {
      UserNotFound: 'ObjectNotFound',
      GroupNotFound: 'ObjectNotFound',
      PrincipalNotFound: 'ObjectNotFound',
      MemberNotFound: 'ObjectNotFound',
      UserExists: 'ResourceExists',
      GroupExists: 'ResourceExists',
      NameInUse: 'ResourceExists',
      MemberExists: 'ResourceExists',
      InvalidName: 'InvalidArgument',
      InvalidPassword: 'InvalidArgument'
    }
    throw psError(e.message, category[e.code] ?? 'InvalidOperation', e.code, target)
  }
}

/** Nom d'un compte désigné par -Name, -InputObject ou le pipeline. */
function names(args: BoundArgs, input: PsValue[], param = 'Name'): string[] {
  const out = list(args[param])
  for (const v of [
    ...flatten(input),
    ...flatten(args['InputObject'] === undefined ? [] : [args['InputObject']])
  ])
    out.push(isPsObject(v) ? str(v.props['Name']) : str(v))
  return out
}

const boolArg = (v: PsValue | undefined) => (v === undefined ? undefined : psToBool(v))
const secret = (v: PsValue | undefined) => (v === undefined ? undefined : isSecure(v) ? v.value : str(v))

function unsimulated(command: string, args: BoundArgs, params: string[]): void {
  for (const p of params)
    if (args[p] !== undefined)
      throw psError(unsimulatedParameterMessage(command, p), 'NotImplemented', 'UnsimulatedParameter')
}

const userNames = (ctx: CmdContext) => localUsers(ctx.state, ctx.deviceId).map((u) => u.name)
const groupNames = (ctx: CmdContext) => localGroups(ctx.state, ctx.deviceId).map((g) => g.name)

export const localAccountCmdlets: CmdletDef[] = [
  {
    name: 'Get-LocalUser',
    aliases: ['glu'],
    module: MODULE,
    synopsis: 'Affiche les comptes d’utilisateurs locaux.',
    params: [
      { name: 'Name', type: 'string[]', position: 0, pipeline: true, complete: userNames },
      { name: 'SID', type: 'string[]' }
    ],
    run(ctx, args, input) {
      const all = localUsers(ctx.state, ctx.deviceId)
      const patterns = names(args, input)
      const sids = list(args['SID'])
      if (patterns.length === 0 && sids.length === 0) return all.map((u) => userObject(ctx, u))
      const out: PsObject[] = []
      for (const p of patterns) {
        const re = wildcardToRegExp(p)
        const found = all.filter((u) => re.test(u.name))
        if (found.length === 0 && !/[*?]/.test(p))
          throw psError(`L’utilisateur ${p} est introuvable.`, 'ObjectNotFound', 'UserNotFound', p)
        out.push(...found.map((u) => userObject(ctx, u)))
      }
      for (const sid of sids) {
        const found = all
          .map((u) => userObject(ctx, u))
          .find((o) => str(o.props['SID']).toLowerCase() === sid.toLowerCase())
        if (!found)
          throw psError(`L’utilisateur ${sid} est introuvable.`, 'ObjectNotFound', 'UserNotFound', sid)
        out.push(found)
      }
      return out
    }
  },
  {
    name: 'New-LocalUser',
    aliases: ['nlu'],
    module: MODULE,
    synopsis: 'Crée un compte d’utilisateur local.',
    params: [
      { name: 'Name', type: 'string', mandatory: true, position: 0 },
      { name: 'Password', type: 'secure' },
      { name: 'NoPassword', type: 'switch' },
      { name: 'FullName', type: 'string' },
      { name: 'Description', type: 'string' },
      { name: 'Disabled', type: 'switch' },
      { name: 'PasswordNeverExpires', type: 'switch' },
      { name: 'UserMayNotChangePassword', type: 'switch' },
      { name: 'AccountExpires', type: 'string' },
      { name: 'AccountNeverExpires', type: 'switch' }
    ],
    available: (ctx) => ctx.host.host.os === 'windows',
    run(ctx, args) {
      unsimulated('New-LocalUser', args, ['AccountExpires'])
      const name = str(args['Name'])
      const noPassword = args['NoPassword'] === true
      // Jeu de paramètres Password (défaut) : -Password obligatoire, demandé s'il manque
      const password = noPassword ? undefined : (secret(args['Password']) ?? ctx.ask('Password : ', true))
      run(
        () =>
          ctx.apply(
            newLocalUser(ctx.state, ctx.deviceId, {
              name,
              ...(password !== undefined ? { password } : {}),
              fullName: str(args['FullName']),
              description: str(args['Description']),
              disabled: args['Disabled'] === true,
              passwordNeverExpires: args['PasswordNeverExpires'] === true,
              userMayNotChangePassword: args['UserMayNotChangePassword'] === true
            })
          ),
        name
      )
      const created = findLocalUser(ctx.state, ctx.deviceId, name)
      return created ? [userObject(ctx, created)] : []
    }
  },
  {
    name: 'Set-LocalUser',
    module: MODULE,
    synopsis: 'Modifie un compte d’utilisateur local.',
    params: [
      { name: 'Name', type: 'string', position: 0, complete: userNames },
      { name: 'InputObject', type: 'any', pipeline: true },
      { name: 'Description', type: 'string' },
      { name: 'FullName', type: 'string' },
      { name: 'Password', type: 'secure' },
      { name: 'PasswordNeverExpires', type: 'any' },
      { name: 'UserMayChangePassword', type: 'any' },
      { name: 'AccountExpires', type: 'string' },
      { name: 'AccountNeverExpires', type: 'switch' }
    ],
    run(ctx, args, input) {
      unsimulated('Set-LocalUser', args, ['AccountExpires'])
      const patch: LocalUserPatch = {}
      if (args['Description'] !== undefined) patch.description = str(args['Description'])
      if (args['FullName'] !== undefined) patch.fullName = str(args['FullName'])
      const password = secret(args['Password'])
      if (password !== undefined) patch.password = password
      const never = boolArg(args['PasswordNeverExpires'])
      if (never !== undefined) patch.passwordNeverExpires = never
      const may = boolArg(args['UserMayChangePassword'])
      if (may !== undefined) patch.userMayChangePassword = may
      for (const name of names(args, input))
        run(() => ctx.apply(setLocalUser(ctx.state, ctx.deviceId, name, patch)), name)
    }
  },
  {
    name: 'Enable-LocalUser',
    module: MODULE,
    synopsis: 'Active un compte d’utilisateur local.',
    params: [
      { name: 'Name', type: 'string[]', position: 0, complete: userNames },
      { name: 'InputObject', type: 'any', pipeline: true }
    ],
    run(ctx, args, input) {
      for (const name of names(args, input))
        run(() => ctx.apply(setLocalUser(ctx.state, ctx.deviceId, name, { enabled: true })), name)
    }
  },
  {
    name: 'Disable-LocalUser',
    module: MODULE,
    synopsis: 'Désactive un compte d’utilisateur local.',
    params: [
      { name: 'Name', type: 'string[]', position: 0, complete: userNames },
      { name: 'InputObject', type: 'any', pipeline: true }
    ],
    run(ctx, args, input) {
      for (const name of names(args, input))
        run(() => ctx.apply(setLocalUser(ctx.state, ctx.deviceId, name, { enabled: false })), name)
    }
  },
  {
    name: 'Remove-LocalUser',
    module: MODULE,
    synopsis: 'Supprime un compte d’utilisateur local.',
    params: [
      { name: 'Name', type: 'string[]', position: 0, complete: userNames },
      { name: 'InputObject', type: 'any', pipeline: true }
    ],
    run(ctx, args, input) {
      for (const name of names(args, input))
        run(() => ctx.apply(removeLocalUser(ctx.state, ctx.deviceId, name)), name)
    }
  },
  {
    name: 'Get-LocalGroup',
    aliases: ['glg'],
    module: MODULE,
    synopsis: 'Affiche les groupes locaux.',
    params: [
      { name: 'Name', type: 'string[]', position: 0, pipeline: true, complete: groupNames },
      { name: 'SID', type: 'string[]' }
    ],
    run(ctx, args, input) {
      unsimulated('Get-LocalGroup', args, ['SID'])
      const all = localGroups(ctx.state, ctx.deviceId)
      const patterns = names(args, input)
      if (patterns.length === 0) return all.map((g) => groupObject(ctx, g))
      const out: PsObject[] = []
      for (const p of patterns) {
        if (!/[*?]/.test(p)) {
          const g = findLocalGroup(ctx.state, ctx.deviceId, p)
          if (!g) throw psError(`Le groupe ${p} est introuvable.`, 'ObjectNotFound', 'GroupNotFound', p)
          out.push(groupObject(ctx, g))
          continue
        }
        const re = wildcardToRegExp(p)
        out.push(...all.filter((g) => re.test(g.name)).map((g) => groupObject(ctx, g)))
      }
      return out
    }
  },
  {
    name: 'New-LocalGroup',
    aliases: ['nlg'],
    module: MODULE,
    synopsis: 'Crée un groupe local.',
    params: [
      { name: 'Name', type: 'string', mandatory: true, position: 0 },
      { name: 'Description', type: 'string' }
    ],
    available: (ctx) => ctx.host.host.os === 'windows',
    run(ctx, args) {
      const name = str(args['Name'])
      run(
        () =>
          ctx.apply(newLocalGroup(ctx.state, ctx.deviceId, { name, description: str(args['Description']) })),
        name
      )
      const g = findLocalGroup(ctx.state, ctx.deviceId, name)
      return g ? [groupObject(ctx, g)] : []
    }
  },
  {
    name: 'Add-LocalGroupMember',
    aliases: ['algm'],
    module: MODULE,
    synopsis: 'Ajoute des membres à un groupe local.',
    params: [
      {
        name: 'Group',
        type: 'string',
        mandatory: true,
        position: 0,
        aliases: ['Name'],
        complete: groupNames
      },
      { name: 'Member', type: 'string[]', mandatory: true, position: 1 }
    ],
    run(ctx, args) {
      const group = str(args['Group'])
      run(() => ctx.apply(addLocalGroupMembers(ctx.state, ctx.deviceId, group, list(args['Member']))), group)
    }
  },
  {
    name: 'Remove-LocalGroupMember',
    aliases: ['rlgm'],
    module: MODULE,
    synopsis: 'Retire des membres d’un groupe local.',
    params: [
      {
        name: 'Group',
        type: 'string',
        mandatory: true,
        position: 0,
        aliases: ['Name'],
        complete: groupNames
      },
      { name: 'Member', type: 'string[]', mandatory: true, position: 1 }
    ],
    run(ctx, args) {
      const group = str(args['Group'])
      run(
        () => ctx.apply(removeLocalGroupMembers(ctx.state, ctx.deviceId, group, list(args['Member']))),
        group
      )
    }
  },
  {
    name: 'Get-LocalGroupMember',
    aliases: ['glgm'],
    module: MODULE,
    synopsis: 'Liste les membres d’un groupe local.',
    params: [
      { name: 'Group', type: 'string', mandatory: true, position: 0, aliases: ['Name'], complete: groupNames }
    ],
    run(ctx, args) {
      const name = str(args['Group'])
      const g = findLocalGroup(ctx.state, ctx.deviceId, name)
      if (!g) throw psError(`Le groupe ${name} est introuvable.`, 'ObjectNotFound', 'GroupNotFound', name)
      const d = ctx.host
      const domain = d.host.domain ? ctx.state.domains[d.host.domain] : undefined
      return g.members.map((m) => {
        const [prefix, sam] = m.includes('\\') ? (m.split('\\') as [string, string]) : [d.name, m]
        const fromDomain = !!domain && prefix.toLowerCase() === domain.netbios.toLowerCase()
        const isGroup = fromDomain
          ? domain.groups.some(
              (x) => x.sam.toLowerCase() === sam.toLowerCase() || x.name.toLowerCase() === sam.toLowerCase()
            )
          : !!findLocalGroup(ctx.state, ctx.deviceId, sam)
        return psObject(
          'Microsoft.PowerShell.Commands.LocalPrincipal',
          {
            ObjectClass: isGroup ? 'Groupe' : 'Utilisateur',
            Name: `${prefix}\\${sam}`,
            PrincipalSource: fromDomain ? 'ActiveDirectory' : 'Local'
          },
          { kind: 'table', props: ['ObjectClass', 'Name', 'PrincipalSource'] }
        )
      })
    }
  }
]
