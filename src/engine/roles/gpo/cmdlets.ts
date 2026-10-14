/**
 * Cmdlets du module GroupPolicy (installé avec la Gestion des stratégies de groupe) :
 * objets GPO, liaisons, héritage, filtrage de sécurité et actualisation.
 */
import { formatShortDate } from '../../core/clock'
import type { Domain, Gpo, GpRegistryValue } from '../../model/schema'
import { AUTHENTICATED_USERS_SID } from '../../model/schema'
import { containerDn, isDomainAdmin, objectById, resolveContainerDn } from '../adds/directory'
import {
  createGpo,
  deleteGpo,
  linkGpo,
  renameGpo,
  resolveFilterPrincipal,
  setGpoSecurityFilter,
  setInheritanceBlocked,
  unlinkGpo,
  updateGpoLink
} from './objects'
import { processGroupPolicy, GP_NO_DC_MESSAGE } from './processing'
import { containerPath, findGpo, gpoPrecedence, linksAt, partEnabled } from './scope'
import { findGpRegistryValues, gpoRegistryValues, setGpRegistryValue, type GpHive } from './registry'
import { describeSettings } from './settings'
import { writeTextFile } from '../files/content'
import { CommandFailure } from '../../shell/context'
import { unsimulatedParameterMessage } from '../../shell/unsimulated'
import { psError } from '../../shell/ps/errors'
import type { CmdContext } from '../../shell/ps/interpreter'
import type { BoundArgs, CmdletDef, ParamDef } from '../../shell/ps/registry'
import { flatten, psObject, psToString, type PsObject, type PsValue } from '../../shell/ps/values'
import { hasFeature } from '../../shell/ps/cmdlets/helpers'

const gpAvailable = (ctx: CmdContext) => hasFeature(ctx, 'GPMC')
const str = (v: PsValue | undefined): string => psToString(v)

/** Domaine de l'ordinateur ; `write` exige un administrateur du domaine. */
function gpDomain(ctx: CmdContext, write = false): Domain {
  const name = ctx.host.host.domain
  const domain = name ? ctx.state.domains[name] : undefined
  const dcUp = domain?.controllers.some((id) => ctx.state.devices[id]?.powered)
  if (!domain || !dcUp)
    throw psError(
      'Le domaine spécifié n’existe pas ou n’a pas pu être contacté.',
      'InvalidOperation',
      'System.ArgumentException,Microsoft.GroupPolicy.Commands',
      '',
      'ArgumentException'
    )
  if (write && (!ctx.user.domain || !isDomainAdmin(domain, ctx.user.name)))
    throw psError(
      'Accès refusé.',
      'PermissionDenied',
      'UnauthorizedAccessException',
      '',
      'UnauthorizedAccessException'
    )
  return domain
}

/** GPO désignée par -Name ou -Guid (erreur réaliste si introuvable). */
function gpoArg(domain: Domain, args: BoundArgs): Gpo {
  const value = args['Guid'] !== undefined ? str(args['Guid']) : str(args['Name'])
  const gpo = findGpo(domain, value)
  if (!gpo)
    throw psError(
      `L’objet de stratégie de groupe « ${value} » est introuvable dans le domaine ${domain.name}.`,
      'ObjectNotFound',
      'GpoWithNameNotFound',
      value,
      'ArgumentException'
    )
  return gpo
}

/** Cible d'une liaison (-Target « OU=Compta,DC=lab,DC=local ») : null = racine du domaine. */
function targetArg(domain: Domain, value: string): string | null {
  const id = resolveContainerDn(domain, value)
  if (id === undefined)
    throw psError(
      `La cible « ${value} » est introuvable : indiquez le nom unique (DN) du domaine ou d’une unité d’organisation.`,
      'ObjectNotFound',
      'TargetNotFound',
      value,
      'ArgumentException'
    )
  return id
}

const yesNo = (v: boolean) => (v ? 'Yes' : 'No')

function bareGuid(gpo: Gpo): string {
  return gpo.id.slice(1, -1).toLowerCase()
}

export function gpoObject(domain: Domain, gpo: Gpo): PsObject {
  return psObject(
    'Gpo',
    {
      DisplayName: gpo.name,
      DomainName: domain.name,
      Owner: `${domain.netbios}\\Admins du domaine`,
      Id: bareGuid(gpo),
      GpoStatus: gpo.status,
      Description: gpo.comment,
      CreationTime: formatShortDate(gpo.createdAt),
      ModificationTime: formatShortDate(gpo.modifiedAt),
      UserVersion: `AD Version: ${gpo.userVersion}, SysVol Version: ${gpo.userVersion}`,
      ComputerVersion: `AD Version: ${gpo.computerVersion}, SysVol Version: ${gpo.computerVersion}`,
      WmiFilter: null
    },
    {
      kind: 'list',
      props: [
        'DisplayName',
        'DomainName',
        'Owner',
        'Id',
        'GpoStatus',
        'Description',
        'CreationTime',
        'ModificationTime',
        'UserVersion',
        'ComputerVersion',
        'WmiFilter'
      ]
    }
  )
}

function linkObject(domain: Domain, gpo: Gpo, targetId: string | null): PsObject {
  const links = linksAt(domain, targetId)
  const index = links.findIndex((l) => l.gpoId === gpo.id)
  const link = links[index]
  return psObject(
    'GpoLink',
    {
      GpoId: bareGuid(gpo),
      DisplayName: gpo.name,
      Enabled: link?.enabled ?? false,
      Enforced: link?.enforced ?? false,
      Target: containerDn(domain, targetId),
      Order: index + 1
    },
    { kind: 'list', props: ['GpoId', 'DisplayName', 'Enabled', 'Enforced', 'Target', 'Order'] }
  )
}

function inheritanceObject(domain: Domain, targetId: string | null): PsObject {
  const container = targetId === null ? undefined : domain.containers.find((c) => c.id === targetId)
  const own = linksAt(domain, targetId)
    .map((l) => domain.gpos.find((g) => g.id === l.gpoId)?.name)
    .filter((n): n is string => !!n)
  const inherited = gpoPrecedence(domain, targetId).map((e) => e.gpo.name)
  return psObject(
    'Som',
    {
      Name: (container?.name ?? domain.name).toLowerCase(),
      ContainerType: container ? 'OU' : 'Domain',
      Path: containerDn(domain, targetId).toLowerCase(),
      GpoInheritanceBlocked: yesNo(container?.blockInheritance ?? false),
      GpoLinks: `{${own.join(', ')}}`,
      InheritedGpoLinks: `{${inherited.join(', ')}}`
    },
    {
      kind: 'list',
      props: ['Name', 'ContainerType', 'Path', 'GpoInheritanceBlocked', 'GpoLinks', 'InheritedGpoLinks']
    }
  )
}

/** Nom affiché d'un élément du filtrage de sécurité. */
function trusteeName(domain: Domain, principal: string): { name: string; type: string } {
  if (principal === AUTHENTICATED_USERS_SID)
    return { name: 'Utilisateurs authentifiés', type: 'WellKnownGroup' }
  const o = objectById(domain, principal)
  if (!o || o.kind === 'container') return { name: principal, type: 'Unknown' }
  const type = o.kind === 'user' ? 'User' : o.kind === 'group' ? 'Group' : 'Computer'
  return { name: o.obj.name, type }
}

function permissionObject(domain: Domain, name: string, type: string, permission: string): PsObject {
  return psObject(
    'GPPermission',
    { Trustee: name, TrusteeType: type, Permission: permission, Inherited: false, Domain: domain.netbios },
    { kind: 'list', props: ['Trustee', 'TrusteeType', 'Permission', 'Inherited'] }
  )
}

const nameParam: ParamDef = { name: 'Name', type: 'string', position: 0, aliases: ['DisplayName'] }
const guidParam: ParamDef = { name: 'Guid', type: 'string', aliases: ['Id'] }
const yesNoSet = ['Yes', 'No', 'Unspecified']

/** Valeur -LinkEnabled / -Enforced (Yes, No) : undefined si non précisée. */
function yesNoArg(v: PsValue | undefined): boolean | undefined {
  if (v === undefined) return undefined
  const s = str(v).toLowerCase()
  if (s === 'unspecified') return undefined
  return s === 'yes' || s === 'true'
}

export const gpoCmdlets: CmdletDef[] = [
  {
    name: 'New-GPO',
    module: 'GroupPolicy',
    synopsis: 'Crée un objet de stratégie de groupe (GPO).',
    available: gpAvailable,
    params: [
      { ...nameParam, mandatory: true },
      { name: 'Comment', type: 'string' },
      { name: 'Domain', type: 'string' }
    ],
    run(ctx, args) {
      const domain = gpDomain(ctx, true)
      const id = ctx.apply(
        createGpo(ctx.state, domain.name, { name: str(args['Name']), comment: str(args['Comment']) })
      )
      const d = ctx.state.domains[domain.name] as Domain
      const gpo = d.gpos.find((g) => g.id === id)
      return gpo ? [gpoObject(d, gpo)] : []
    }
  },
  {
    name: 'Get-GPO',
    module: 'GroupPolicy',
    synopsis: 'Obtient un ou tous les objets de stratégie de groupe du domaine.',
    available: gpAvailable,
    params: [nameParam, guidParam, { name: 'All', type: 'switch' }, { name: 'Domain', type: 'string' }],
    run(ctx, args) {
      const domain = gpDomain(ctx)
      if (args['All'] === true) return domain.gpos.map((g) => gpoObject(domain, g))
      if (args['Name'] === undefined && args['Guid'] === undefined)
        throw psError(
          'Spécifiez -Name, -Guid ou -All.',
          'InvalidArgument',
          'AmbiguousParameterSet',
          '',
          'ParameterBindingException'
        )
      return [gpoObject(domain, gpoArg(domain, args))]
    }
  },
  {
    name: 'Remove-GPO',
    module: 'GroupPolicy',
    synopsis: 'Supprime un objet de stratégie de groupe et ses liaisons.',
    available: gpAvailable,
    params: [nameParam, guidParam],
    run(ctx, args) {
      const domain = gpDomain(ctx, true)
      const gpo = gpoArg(domain, args)
      if (!ctx.confirm(gpo.name, 'Remove-GPO')) return []
      ctx.apply(deleteGpo(ctx.state, domain.name, gpo.id))
      return []
    }
  },
  {
    name: 'Rename-GPO',
    module: 'GroupPolicy',
    synopsis: 'Renomme un objet de stratégie de groupe.',
    available: gpAvailable,
    params: [nameParam, guidParam, { name: 'TargetName', type: 'string', mandatory: true, position: 1 }],
    run(ctx, args) {
      const domain = gpDomain(ctx, true)
      const gpo = gpoArg(domain, args)
      ctx.apply(renameGpo(ctx.state, domain.name, gpo.id, str(args['TargetName'])))
      const d = ctx.state.domains[domain.name] as Domain
      const renamed = d.gpos.find((g) => g.id === gpo.id)
      return renamed ? [gpoObject(d, renamed)] : []
    }
  },
  {
    name: 'New-GPLink',
    module: 'GroupPolicy',
    synopsis: 'Lie une GPO à un domaine ou à une unité d’organisation.',
    available: gpAvailable,
    params: [
      nameParam,
      guidParam,
      { name: 'Target', type: 'string', mandatory: true, position: 1 },
      { name: 'LinkEnabled', type: 'string', validateSet: yesNoSet },
      { name: 'Enforced', type: 'string', validateSet: yesNoSet },
      { name: 'Order', type: 'int' }
    ],
    run(ctx, args) {
      const domain = gpDomain(ctx, true)
      const gpo = gpoArg(domain, args)
      const targetId = targetArg(domain, str(args['Target']))
      const enabled = yesNoArg(args['LinkEnabled'])
      const enforced = yesNoArg(args['Enforced'])
      ctx.apply(
        linkGpo(ctx.state, domain.name, gpo.id, targetId, {
          ...(enabled !== undefined ? { enabled } : {}),
          ...(enforced !== undefined ? { enforced } : {}),
          ...(args['Order'] !== undefined ? { order: Number(args['Order']) } : {})
        })
      )
      return [linkObject(ctx.state.domains[domain.name] as Domain, gpo, targetId)]
    }
  },
  {
    name: 'Set-GPLink',
    module: 'GroupPolicy',
    synopsis: 'Modifie une liaison : activation, application forcée, ordre.',
    available: gpAvailable,
    params: [
      nameParam,
      guidParam,
      { name: 'Target', type: 'string', mandatory: true, position: 1 },
      { name: 'LinkEnabled', type: 'string', validateSet: yesNoSet },
      { name: 'Enforced', type: 'string', validateSet: yesNoSet },
      { name: 'Order', type: 'int' }
    ],
    run(ctx, args) {
      const domain = gpDomain(ctx, true)
      const gpo = gpoArg(domain, args)
      const targetId = targetArg(domain, str(args['Target']))
      const enabled = yesNoArg(args['LinkEnabled'])
      const enforced = yesNoArg(args['Enforced'])
      ctx.apply(
        updateGpoLink(ctx.state, domain.name, gpo.id, targetId, {
          ...(enabled !== undefined ? { enabled } : {}),
          ...(enforced !== undefined ? { enforced } : {}),
          ...(args['Order'] !== undefined ? { order: Number(args['Order']) } : {})
        })
      )
      return [linkObject(ctx.state.domains[domain.name] as Domain, gpo, targetId)]
    }
  },
  {
    name: 'Remove-GPLink',
    module: 'GroupPolicy',
    synopsis: 'Supprime la liaison d’une GPO (la GPO est conservée).',
    available: gpAvailable,
    params: [nameParam, guidParam, { name: 'Target', type: 'string', mandatory: true, position: 1 }],
    run(ctx, args) {
      const domain = gpDomain(ctx, true)
      const gpo = gpoArg(domain, args)
      ctx.apply(unlinkGpo(ctx.state, domain.name, gpo.id, targetArg(domain, str(args['Target']))))
      return []
    }
  },
  {
    name: 'Get-GPInheritance',
    module: 'GroupPolicy',
    synopsis: 'Affiche les GPO liées et héritées d’un domaine ou d’une OU.',
    available: gpAvailable,
    params: [{ name: 'Target', type: 'string', mandatory: true, position: 0 }],
    run(ctx, args) {
      const domain = gpDomain(ctx)
      return [inheritanceObject(domain, targetArg(domain, str(args['Target'])))]
    }
  },
  {
    name: 'Set-GPInheritance',
    module: 'GroupPolicy',
    synopsis: 'Bloque ou rétablit l’héritage des GPO sur une unité d’organisation.',
    available: gpAvailable,
    params: [
      { name: 'Target', type: 'string', mandatory: true, position: 0 },
      { name: 'IsBlocked', type: 'string', mandatory: true, position: 1, validateSet: ['Yes', 'No'] }
    ],
    run(ctx, args) {
      const domain = gpDomain(ctx, true)
      const targetId = targetArg(domain, str(args['Target']))
      if (targetId === null)
        throw psError(
          'Le blocage de l’héritage ne s’applique qu’à une unité d’organisation.',
          'InvalidArgument',
          'InvalidTarget',
          str(args['Target'])
        )
      ctx.apply(setInheritanceBlocked(ctx.state, domain.name, targetId, yesNoArg(args['IsBlocked']) === true))
      return [inheritanceObject(ctx.state.domains[domain.name] as Domain, targetId)]
    }
  },
  {
    name: 'Get-GPPermission',
    aliases: ['Get-GPPermissions'],
    module: 'GroupPolicy',
    synopsis: 'Affiche les autorisations (dont le filtrage de sécurité) d’une GPO.',
    available: gpAvailable,
    params: [
      nameParam,
      guidParam,
      { name: 'All', type: 'switch' },
      { name: 'TargetName', type: 'string' },
      { name: 'TargetType', type: 'string', validateSet: ['User', 'Group', 'Computer'] }
    ],
    run(ctx, args) {
      const domain = gpDomain(ctx)
      const gpo = gpoArg(domain, args)
      const entries = [
        ...gpo.securityFilter.map((p) => ({ ...trusteeName(domain, p), permission: 'GpoApply' })),
        { name: 'Admins du domaine', type: 'Group', permission: 'GpoEditDeleteModifySecurity' },
        { name: 'Administrateurs de l’entreprise', type: 'Group', permission: 'GpoEditDeleteModifySecurity' },
        { name: 'SYSTEM', type: 'WellKnownGroup', permission: 'GpoEditDeleteModifySecurity' },
        { name: 'CONTRÔLEURS DE DOMAINE D’ENTREPRISE', type: 'WellKnownGroup', permission: 'GpoRead' }
      ]
      const wanted = args['TargetName'] !== undefined ? str(args['TargetName']).toLowerCase() : null
      return entries
        .filter((e) => wanted === null || e.name.toLowerCase() === wanted)
        .map((e) => permissionObject(domain, e.name, e.type, e.permission))
    }
  },
  {
    name: 'Set-GPPermission',
    aliases: ['Set-GPPermissions'],
    module: 'GroupPolicy',
    synopsis: 'Accorde ou retire une autorisation (GpoApply = filtrage de sécurité).',
    available: gpAvailable,
    params: [
      nameParam,
      guidParam,
      { name: 'TargetName', type: 'string', mandatory: true },
      { name: 'TargetType', type: 'string', mandatory: true, validateSet: ['User', 'Group', 'Computer'] },
      {
        name: 'PermissionLevel',
        type: 'string',
        mandatory: true,
        validateSet: ['GpoRead', 'GpoApply', 'GpoEdit', 'GpoEditDeleteModifySecurity', 'None']
      },
      { name: 'Replace', type: 'switch' }
    ],
    run(ctx, args) {
      const domain = gpDomain(ctx, true)
      const gpo = gpoArg(domain, args)
      const target = str(args['TargetName'])
      const level = str(args['PermissionLevel']).toLowerCase()
      if (!resolveFilterPrincipal(domain, target))
        throw psError(
          `Le compte « ${target} » est introuvable dans le domaine ${domain.name}.`,
          'ObjectNotFound',
          'TrusteeNotFound',
          target,
          'ArgumentException'
        )
      const applies = gpo.securityFilter.includes(resolveFilterPrincipal(domain, target) ?? '')
      if (level === 'gpoapply') ctx.apply(setGpoSecurityFilter(ctx.state, domain.name, gpo.id, target, true))
      else if (applies) {
        // Niveau inférieur à GpoApply : le droit d'appliquer est retiré, avec -Replace uniquement
        if (args['Replace'] !== true)
          throw psError(
            `Le compte « ${target} » possède déjà une autorisation plus élevée : utilisez -Replace pour la réduire.`,
            'InvalidOperation',
            'PermissionLevelLower',
            target,
            'InvalidOperationException'
          )
        ctx.apply(setGpoSecurityFilter(ctx.state, domain.name, gpo.id, target, false))
      }
      const d = ctx.state.domains[domain.name] as Domain
      const trustee = trusteeName(d, resolveFilterPrincipal(d, target) ?? target)
      return level === 'none'
        ? []
        : [permissionObject(d, trustee.name, trustee.type, str(args['PermissionLevel']))]
    }
  },
  {
    name: 'Invoke-GPUpdate',
    module: 'GroupPolicy',
    synopsis: 'Actualise les stratégies de groupe de l’ordinateur local.',
    available: gpAvailable,
    params: [
      { name: 'Computer', type: 'string' },
      { name: 'Target', type: 'string', validateSet: ['Computer', 'User'] },
      { name: 'Force', type: 'switch' },
      { name: 'RandomDelayInMinutes', type: 'int' }
    ],
    run(ctx, args) {
      if (
        args['Computer'] !== undefined &&
        str(args['Computer']).toLowerCase() !== ctx.host.name.toLowerCase()
      )
        throw psError(
          'L’actualisation à distance n’est pas simulée : exécutez gpupdate sur l’ordinateur concerné.',
          'NotImplemented',
          'RemoteGpUpdateNotSupported',
          str(args['Computer'])
        )
      const target = args['Target'] !== undefined ? str(args['Target']).toLowerCase() : null
      const op = processGroupPolicy(ctx.state, ctx.deviceId, {
        computer: target !== 'user',
        user: target !== 'computer'
      })
      ctx.state = op.state
      ctx.addTrace(op.trace)
      if (op.computer === 'failed' || op.user === 'failed')
        throw psError(op.error ?? GP_NO_DC_MESSAGE, 'OperationStopped', 'GpUpdateFailed', ctx.host.name)
      return []
    }
  }
]

// ---------------------------------------------------------------------------------------------
// Valeurs de registre et rapports (v2.7, Lot 2b)

const HIVE_LABEL: Record<GpHive, { full: string; name: string }> = {
  HKLM: { full: 'HKEY_LOCAL_MACHINE', name: 'LocalMachine' },
  HKCU: { full: 'HKEY_CURRENT_USER', name: 'CurrentUser' }
}

/** Objet PolicyRegistrySetting (Learn, Get-GPRegistryValue, exemple 1). */
function registryObject(v: GpRegistryValue): PsObject {
  const hive = HIVE_LABEL[v.hive]
  return psObject(
    'Microsoft.GroupPolicy.PolicyRegistrySetting',
    {
      KeyPath: v.key,
      FullKeyPath: `${hive.full}\\${v.key}`,
      Hive: hive.name,
      PolicyState: v.state,
      Value: v.state === 'Delete' ? '' : Array.isArray(v.value) ? v.value.join(', ') : v.value,
      Type: v.type,
      ValueName: v.valueName,
      HasValue: true
    },
    {
      kind: 'list',
      props: ['KeyPath', 'FullKeyPath', 'Hive', 'PolicyState', 'Value', 'Type', 'ValueName', 'HasValue']
    }
  )
}

/** Erreur du moteur → erreur PowerShell (GroupPolicy). */
function gpRun(fn: () => void, target: string): void {
  try {
    fn()
  } catch (e) {
    if (e instanceof CommandFailure)
      throw psError(e.message, 'InvalidArgument', e.code, target, 'ArgumentException')
    throw e
  }
}

const xml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Emplacements où la GPO est liée (racine du domaine puis OU). */
function gpoLinks(
  domain: Domain,
  gpo: Gpo
): { som: string; path: string; enabled: boolean; enforced: boolean }[] {
  const out: { som: string; path: string; enabled: boolean; enforced: boolean }[] = []
  for (const l of domain.gpLinks)
    if (l.gpoId === gpo.id)
      out.push({ som: domain.netbios, path: domain.name, enabled: l.enabled, enforced: l.enforced })
  for (const c of domain.containers)
    for (const l of c.gpLinks)
      if (l.gpoId === gpo.id)
        out.push({ som: c.name, path: containerPath(domain, c.id), enabled: l.enabled, enforced: l.enforced })
  return out
}

/**
 * Rapport d'une GPO (Get-GPOReport, Learn : « details, links, security filtering, WMI filtering,
 * delegation, and computer and user configurations »). Sous-ensemble ServerLab : détails, liaisons,
 * filtrage de sécurité, paramètres simulés et valeurs de registre (pas de filtre WMI ni de délégation).
 */
export function gpoReport(domain: Domain, gpo: Gpo, type: 'Html' | 'Xml'): string {
  const links = gpoLinks(domain, gpo)
  const filter = gpo.securityFilter.map((p) => trusteeName(domain, p).name)
  const parts = (['computer', 'user'] as const).map((part) => ({
    part,
    title: part === 'computer' ? 'Configuration ordinateur' : 'Configuration utilisateur',
    version: part === 'computer' ? gpo.computerVersion : gpo.userVersion,
    enabled: partEnabled(gpo, part),
    settings: describeSettings(part, gpo.computer, gpo.user),
    registry: gpoRegistryValues(gpo).filter((v) => (v.hive === 'HKLM') === (part === 'computer'))
  }))
  if (type === 'Xml')
    return [
      '<?xml version="1.0" encoding="utf-16"?>',
      '<GPO xmlns="http://www.microsoft.com/GroupPolicy/Settings">',
      '  <Identifier>',
      `    <Identifier>${gpo.id}</Identifier>`,
      `    <Domain>${xml(domain.name)}</Domain>`,
      '  </Identifier>',
      `  <Name>${xml(gpo.name)}</Name>`,
      `  <CreatedTime>${formatShortDate(gpo.createdAt)}</CreatedTime>`,
      `  <ModifiedTime>${formatShortDate(gpo.modifiedAt)}</ModifiedTime>`,
      `  <SecurityFiltering>${filter.map((f) => `<Trustee>${xml(f)}</Trustee>`).join('')}</SecurityFiltering>`,
      ...parts.flatMap((p) => [
        `  <${p.part === 'computer' ? 'Computer' : 'User'}>`,
        `    <VersionDirectory>${p.version}</VersionDirectory>`,
        `    <VersionSysvol>${p.version}</VersionSysvol>`,
        `    <Enabled>${p.enabled}</Enabled>`,
        ...p.settings.map(
          (s) => `    <Setting Category="${xml(s.category)}" Name="${xml(s.label)}">${xml(s.value)}</Setting>`
        ),
        ...p.registry.map(
          (r) =>
            `    <RegistrySetting Key="${xml(`${HIVE_LABEL[r.hive].full}\\${r.key}`)}" ValueName="${xml(r.valueName)}" Type="${r.type}" State="${r.state}">${xml(String(r.value))}</RegistrySetting>`
        ),
        `  </${p.part === 'computer' ? 'Computer' : 'User'}>`
      ]),
      ...links.map(
        (l) =>
          `  <LinksTo><SOMName>${xml(l.som)}</SOMName><SOMPath>${xml(l.path)}</SOMPath><Enabled>${l.enabled}</Enabled><NoOverride>${l.enforced}</NoOverride></LinksTo>`
      ),
      '</GPO>'
    ].join('\n')
  const rows = (cells: string[][]) =>
    cells.map((c) => `<tr>${c.map((x) => `<td>${xml(x)}</td>`).join('')}</tr>`).join('')
  return [
    '<html>',
    `<head><title>${xml(gpo.name)}</title></head>`,
    '<body>',
    `<h1>${xml(gpo.name)}</h1>`,
    '<h2>Détails</h2>',
    `<table>${rows([
      ['Domaine', domain.name],
      ['Propriétaire', `${domain.netbios}\\Admins du domaine`],
      ['Créé le', formatShortDate(gpo.createdAt)],
      ['Modifié le', formatShortDate(gpo.modifiedAt)],
      ['Révisions utilisateur', `${gpo.userVersion} (AD), ${gpo.userVersion} (SYSVOL)`],
      ['Révisions ordinateur', `${gpo.computerVersion} (AD), ${gpo.computerVersion} (SYSVOL)`],
      ['ID unique', gpo.id],
      ['État de l’objet GPO', gpo.status]
    ])}</table>`,
    '<h2>Liaisons</h2>',
    `<table>${rows([['Emplacement', 'Appliqué', 'État de la liaison'], ...links.map((l) => [l.path, l.enforced ? 'Oui' : 'Non', l.enabled ? 'Activé' : 'Désactivé'])])}</table>`,
    '<h2>Filtrage de sécurité</h2>',
    `<table>${rows(filter.map((f) => [f]))}</table>`,
    ...parts.flatMap((p) => [
      `<h2>${p.title} (${p.enabled ? 'Activée' : 'Désactivée'})</h2>`,
      p.settings.length + p.registry.length === 0
        ? '<p>Aucun paramètre défini.</p>'
        : `<table>${rows([
            ...p.settings.map((s) => [s.category, s.label, s.value]),
            ...p.registry.map((r) => [
              'Paramètres du Registre',
              `${HIVE_LABEL[r.hive].full}\\${r.key}\\${r.valueName}`,
              r.state === 'Delete' ? 'Supprimée' : `${r.type} : ${String(r.value)}`
            ])
          ])}</table>`
    ]),
    '</body>',
    '</html>'
  ].join('\n')
}

export const gpoRegistryCmdlets: CmdletDef[] = [
  {
    name: 'Set-GPRegistryValue',
    module: 'GroupPolicy',
    synopsis: 'Configure une valeur de registre dans une GPO (Configuration ordinateur ou utilisateur).',
    available: gpAvailable,
    params: [
      nameParam,
      guidParam,
      { name: 'Key', type: 'string', mandatory: true },
      { name: 'ValueName', type: 'string[]' },
      { name: 'Value', type: 'any' },
      { name: 'Type', type: 'string' },
      { name: 'Domain', type: 'string' },
      { name: 'Server', type: 'string' },
      { name: 'Disable', type: 'switch' },
      { name: 'Additive', type: 'switch' },
      { name: 'ValuePrefix', type: 'string' }
    ],
    run(ctx, args) {
      for (const p of ['Additive', 'ValuePrefix'])
        if (args[p] !== undefined)
          throw psError(
            unsimulatedParameterMessage('Set-GPRegistryValue', p),
            'NotImplemented',
            'UnsimulatedParameter'
          )
      const domain = gpDomain(ctx, true)
      const gpo = gpoArg(domain, args)
      const values = args['Value'] === undefined ? [] : flatten([args['Value']])
      gpRun(
        () =>
          ctx.apply(
            setGpRegistryValue(ctx.state, domain.name, gpo.id, {
              key: str(args['Key']),
              valueNames: args['ValueName'] === undefined ? [] : flatten([args['ValueName']]).map(psToString),
              values: values.map((v) => (typeof v === 'number' ? v : psToString(v))),
              ...(args['Type'] !== undefined ? { type: str(args['Type']) } : {}),
              disable: args['Disable'] === true
            })
          ),
        gpo.name
      )
      // Learn, exemple 1 : la GPO modifiée est renvoyée
      const updated = ctx.state.domains[domain.name]?.gpos.find((g) => g.id === gpo.id)
      return updated ? [gpoObject(domain, updated)] : []
    }
  },
  {
    name: 'Get-GPRegistryValue',
    module: 'GroupPolicy',
    synopsis: 'Affiche les valeurs de registre configurées par une GPO.',
    available: gpAvailable,
    params: [
      nameParam,
      guidParam,
      { name: 'Key', type: 'string', mandatory: true },
      { name: 'ValueName', type: 'string' },
      { name: 'Domain', type: 'string' },
      { name: 'Server', type: 'string' }
    ],
    run(ctx, args) {
      const domain = gpDomain(ctx)
      const gpo = gpoArg(domain, args)
      const key = str(args['Key'])
      let found: GpRegistryValue[] = []
      gpRun(() => {
        found = findGpRegistryValues(
          gpo,
          key,
          args['ValueName'] === undefined ? undefined : str(args['ValueName'])
        )
      }, gpo.name)
      if (found.length === 0)
        throw psError(
          `La clé de registre « ${key}${args['ValueName'] !== undefined ? `\\${str(args['ValueName'])}` : ''} » n’est pas configurée dans l’objet de stratégie de groupe ${gpo.name}.`,
          'ObjectNotFound',
          'UnableToRetrievePolicyRegistryItem',
          key,
          'ArgumentException'
        )
      return found.map(registryObject)
    }
  },
  {
    name: 'Get-GPOReport',
    module: 'GroupPolicy',
    synopsis: 'Génère le rapport HTML ou XML d’une GPO (affiché ou écrit dans un fichier).',
    available: gpAvailable,
    params: [
      nameParam,
      guidParam,
      { name: 'ReportType', type: 'string', mandatory: true, position: 1, validateSet: ['Html', 'Xml'] },
      { name: 'Path', type: 'string', position: 2 },
      { name: 'All', type: 'switch' },
      { name: 'Domain', type: 'string' },
      { name: 'Server', type: 'string' }
    ],
    run(ctx, args) {
      const domain = gpDomain(ctx)
      const type = str(args['ReportType']).toLowerCase() === 'xml' ? 'Xml' : 'Html'
      const gpos = args['All'] === true ? domain.gpos : [gpoArg(domain, args)]
      const text = gpos.map((g) => gpoReport(domain, g, type)).join('\n')
      if (args['Path'] !== undefined) {
        writeTextFile(ctx, str(args['Path']), text)
        return []
      }
      return [text]
    }
  }
]
