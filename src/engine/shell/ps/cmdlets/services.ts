/**
 * Cmdlets des services (module Microsoft.PowerShell.Management) : Get-Service, Start-Service,
 * Stop-Service, Restart-Service, Set-Service (v2.7, Lot 2a).
 *
 * Sourcé Microsoft Learn (PowerShell 5.1, microsoft.powershell.management) :
 * - Get-Service : « The default display shows the status, service name, and display name of each
 *   service » ; mise en page de l'exemple « Status   Name               DisplayName » (colonnes de
 *   8, 18 et 38 caractères, « ... » au-delà) ; Name accepte les caractères génériques et le
 *   pipeline (exemple 11 « "WinRM" | Get-Service ») ; Status est une énumération (Stopped = 1,
 *   Running = 4) triée sur sa valeur entière.
 * - Start-Service / Stop-Service / Restart-Service : aucune sortie sans -PassThru.
 * - Set-Service : -StartupType (Automatic, Manual, Disabled ; alias StartMode, SM, ST), -Status
 *   (Running, Stopped, Paused) ; exemple « Set-Service -Name WinRM -Status Running -PassThru ».
 * - Start-Service, exemple 4 : un service désactivé ne démarre pas.
 * Messages d'erreur français : docs/fidelite.md, « À vérifier (Lot 2) ».
 */
import {
  computerServices,
  findComputerService,
  restartService,
  serviceLabel,
  setServiceStartType,
  startService,
  stopService,
  type ServiceInfo,
  type ServiceStartType
} from '../../../services/hostservices'
import { CommandFailure } from '../../context'
import { unsimulatedParameterMessage } from '../../unsimulated'
import { psError } from '../errors'
import type { CmdContext } from '../interpreter'
import type { BoundArgs, CmdletDef, ParamDef } from '../registry'
import {
  flatten,
  isPsObject,
  psEnum,
  psObject,
  psToString,
  wildcardToRegExp,
  type PsObject,
  type PsValue
} from '../values'

const MODULE = 'Microsoft.PowerShell.Management'
const TYPE = 'System.ServiceProcess.ServiceController'

/** Valeurs de System.ServiceProcess.ServiceControllerStatus (Learn : Stopped = 1, Running = 4). */
const STATUS_VALUE = { Stopped: 1, Running: 4 } as const
/** Valeurs de System.ServiceProcess.ServiceStartMode. */
const START_VALUE: Record<ServiceStartType, number> = { Automatic: 2, Manual: 3, Disabled: 4 }

const cut = (text: string, width: number) => (text.length > width ? `${text.slice(0, width - 3)}...` : text)

/** Affichage par défaut (Learn, Get-Service) : Status, Name, DisplayName. */
function renderServices(objects: PsObject[]): string[] {
  const row = (status: string, name: string, display: string) =>
    `${status.padEnd(8)} ${cut(name, 18).padEnd(18)} ${cut(display, 38)}`.trimEnd()
  return [
    '',
    row('Status', 'Name', 'DisplayName'),
    row('------', '----', '-----------'),
    ...objects.map((o) =>
      row(psToString(o.props['Status']), psToString(o.props['Name']), psToString(o.props['DisplayName']))
    ),
    ''
  ]
}

/** Objet ServiceController d'un service. */
export function serviceObject(s: ServiceInfo): PsObject {
  return psObject(
    TYPE,
    {
      Name: s.name,
      DisplayName: s.display,
      ServiceName: s.name,
      Status: psEnum('System.ServiceProcess.ServiceControllerStatus', s.status, STATUS_VALUE[s.status]),
      StartType: psEnum('System.ServiceProcess.ServiceStartMode', s.startType, START_VALUE[s.startType]),
      CanStop: s.status === 'Running' && s.canStop,
      CanPauseAndContinue: false,
      MachineName: '.'
    },
    { kind: 'table', props: ['Status', 'Name', 'DisplayName'], render: renderServices }
  )
}

const strings = (v: PsValue | undefined) => (v === undefined ? [] : flatten([v]).map(psToString))

function notFound(name: string, byDisplay = false) {
  return psError(
    byDisplay
      ? `Impossible de trouver un service assorti du nom d’affichage « ${name} ».`
      : `Impossible de trouver un service assorti du nom « ${name} ».`,
    'ObjectNotFound',
    'NoServiceFoundForGivenName',
    name,
    'ServiceCommandException'
  )
}

/** -ComputerName : seul l'ordinateur local est simulé. */
function localOnly(ctx: CmdContext, args: BoundArgs): void {
  for (const c of strings(args['ComputerName'])) {
    const lower = c.toLowerCase()
    if (lower !== '.' && lower !== 'localhost' && lower !== ctx.host.name.toLowerCase())
      throw psError(
        unsimulatedParameterMessage(ctx.commandName, 'ComputerName'),
        'NotImplemented',
        'UnsimulatedParameter'
      )
  }
}

/**
 * Services désignés par -Name (caractères génériques), -DisplayName, -InputObject ou le
 * pipeline (objets ServiceController ou noms). Sans sélecteur : `all` (Get-Service) ou erreur.
 */
function selectServices(ctx: CmdContext, args: BoundArgs, input: PsValue[], all: boolean): ServiceInfo[] {
  localOnly(ctx, args)
  const list = computerServices(ctx.state, ctx.deviceId)
  const names = strings(args['Name'])
  const displays = strings(args['DisplayName'])
  for (const v of [
    ...flatten(input),
    ...flatten(args['InputObject'] === undefined ? [] : [args['InputObject']])
  ])
    names.push(isPsObject(v) ? psToString(v.props['Name'] ?? v.props['ServiceName'] ?? '') : psToString(v))
  if (names.length === 0 && displays.length === 0) {
    if (all) return applyFilters(list, args)
    throw psError(
      'Indiquez le service avec -Name, -DisplayName ou -InputObject.',
      'InvalidArgument',
      'MissingServiceSelector'
    )
  }
  const out: ServiceInfo[] = []
  const pick = (patterns: string[], field: 'name' | 'display') => {
    for (const p of patterns) {
      const re = wildcardToRegExp(p)
      const found = list.filter((s) => re.test(s[field]))
      if (found.length === 0 && !/[*?[]/.test(p)) throw notFound(p, field === 'display')
      for (const s of found) if (!out.some((o) => o.name === s.name)) out.push(s)
    }
  }
  pick(names, 'name')
  pick(displays, 'display')
  return applyFilters(out, args)
}

/** -Include / -Exclude (noms de service, caractères génériques). */
function applyFilters(list: ServiceInfo[], args: BoundArgs): ServiceInfo[] {
  const include = strings(args['Include']).map((p) => wildcardToRegExp(p))
  const exclude = strings(args['Exclude']).map((p) => wildcardToRegExp(p))
  return list.filter(
    (s) =>
      (include.length === 0 || include.some((r) => r.test(s.name))) && !exclude.some((r) => r.test(s.name))
  )
}

/** Erreurs du moteur traduites en erreurs PowerShell. */
function apply(run: () => void, s: ServiceInfo): void {
  try {
    run()
  } catch (e) {
    if (!(e instanceof CommandFailure)) throw e
    if (e.code === 'ServiceDisabled' || e.code === 'ServiceCannotStop')
      throw psError(
        e.message,
        'OpenError',
        e.code === 'ServiceDisabled' ? 'CouldNotStartService' : 'CouldNotStopService',
        serviceLabel(s),
        'ServiceCommandException'
      )
    throw e
  }
}

/** Service relu après l'opération (sortie -PassThru). */
function reread(ctx: CmdContext, s: ServiceInfo): PsObject {
  return serviceObject(findComputerService(ctx.state, ctx.deviceId, s.name) ?? s)
}

const completeNames = (ctx: CmdContext) => computerServices(ctx.state, ctx.deviceId).map((s) => s.name)

const selectorParams: ParamDef[] = [
  {
    name: 'Name',
    type: 'string[]',
    position: 0,
    aliases: ['ServiceName'],
    pipeline: true,
    complete: completeNames
  },
  { name: 'DisplayName', type: 'string[]' },
  { name: 'InputObject', type: 'any' },
  { name: 'Include', type: 'string[]' },
  { name: 'Exclude', type: 'string[]' },
  { name: 'PassThru', type: 'switch' }
]

/** Démarre, arrête ou redémarre les services désignés. */
function control(op: 'start' | 'stop' | 'restart') {
  const action = { start: startService, stop: stopService, restart: restartService }[op]
  return (ctx: CmdContext, args: BoundArgs, input: PsValue[]): PsValue[] => {
    const out: PsValue[] = []
    for (const s of selectServices(ctx, args, input, false)) {
      apply(() => ctx.apply(action(ctx.state, ctx.deviceId, s.name)), s)
      if (args['PassThru'] === true) out.push(reread(ctx, s))
    }
    return out
  }
}

export const serviceCmdlets: CmdletDef[] = [
  {
    name: 'Get-Service',
    aliases: ['gsv'],
    module: MODULE,
    synopsis: 'Affiche les services de l’ordinateur (état, nom, nom complet).',
    params: [
      {
        name: 'Name',
        type: 'string[]',
        position: 0,
        aliases: ['ServiceName'],
        pipeline: true,
        complete: completeNames
      },
      { name: 'DisplayName', type: 'string[]' },
      { name: 'InputObject', type: 'any' },
      { name: 'Include', type: 'string[]' },
      { name: 'Exclude', type: 'string[]' },
      { name: 'ComputerName', type: 'string[]', aliases: ['Cn'] },
      { name: 'DependentServices', type: 'switch', aliases: ['DS'] },
      { name: 'RequiredServices', type: 'switch', aliases: ['SDO', 'ServicesDependedOn'] }
    ],
    run(ctx, args, input) {
      for (const p of ['DependentServices', 'RequiredServices'])
        if (args[p] === true)
          throw psError(
            unsimulatedParameterMessage('Get-Service', p),
            'NotImplemented',
            'UnsimulatedParameter'
          )
      return selectServices(ctx, args, input, true).map(serviceObject)
    }
  },
  {
    name: 'Start-Service',
    aliases: ['sasv'],
    module: MODULE,
    synopsis: 'Démarre un ou plusieurs services arrêtés.',
    params: selectorParams,
    run: control('start')
  },
  {
    name: 'Stop-Service',
    aliases: ['spsv'],
    module: MODULE,
    synopsis: 'Arrête un ou plusieurs services en cours d’exécution.',
    params: [...selectorParams, { name: 'Force', type: 'switch' }, { name: 'NoWait', type: 'switch' }],
    run: control('stop')
  },
  {
    name: 'Restart-Service',
    module: MODULE,
    synopsis: 'Arrête puis démarre un ou plusieurs services.',
    params: [...selectorParams, { name: 'Force', type: 'switch' }],
    run: control('restart')
  },
  {
    name: 'Set-Service',
    module: MODULE,
    synopsis: 'Change le type de démarrage ou l’état d’un service.',
    params: [
      {
        name: 'Name',
        type: 'string',
        position: 0,
        aliases: ['ServiceName', 'SN'],
        pipeline: true,
        complete: completeNames
      },
      { name: 'InputObject', type: 'any' },
      {
        name: 'StartupType',
        type: 'string',
        aliases: ['StartMode', 'SM', 'ST'],
        validateSet: ['Boot', 'System', 'Automatic', 'Manual', 'Disabled']
      },
      { name: 'Status', type: 'string', validateSet: ['Paused', 'Running', 'Stopped'] },
      { name: 'DisplayName', type: 'string', aliases: ['DN'] },
      { name: 'Description', type: 'string' },
      { name: 'ComputerName', type: 'string[]', aliases: ['cn'] },
      { name: 'PassThru', type: 'switch' }
    ],
    run(ctx, args, input) {
      for (const p of ['DisplayName', 'Description'])
        if (args[p] !== undefined)
          throw psError(
            unsimulatedParameterMessage('Set-Service', p),
            'NotImplemented',
            'UnsimulatedParameter'
          )
      const startup = args['StartupType'] === undefined ? null : psToString(args['StartupType'])
      if (startup === 'Boot' || startup === 'System')
        // Learn : « valid only for device drivers »
        throw psError(
          `Le type de démarrage « ${startup} » n’est valide que pour les pilotes de périphériques.`,
          'InvalidArgument',
          'InvalidStartupType'
        )
      const status = args['Status'] === undefined ? null : psToString(args['Status'])
      if (status === 'Paused')
        throw psError(
          'La mise en pause d’un service n’est pas simulée dans ServerLab (états démarré et arrêté seulement).',
          'NotImplemented',
          'UnsimulatedParameter'
        )
      const targets = selectServices(ctx, args, input, false)
      const out: PsValue[] = []
      for (const s of targets) {
        if (startup)
          ctx.apply(setServiceStartType(ctx.state, ctx.deviceId, s.name, startup as ServiceStartType))
        if (status === 'Running') apply(() => ctx.apply(startService(ctx.state, ctx.deviceId, s.name)), s)
        if (status === 'Stopped') apply(() => ctx.apply(stopService(ctx.state, ctx.deviceId, s.name)), s)
        if (args['PassThru'] === true) out.push(reread(ctx, s))
      }
      return out
    }
  }
]
