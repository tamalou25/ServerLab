/**
 * Cmdlets système : rôles et fonctionnalités, redémarrage, renommage.
 */
import { isDomainAdmin } from '../../../roles/adds/directory'
import { allFeatures, featureInfo, installFeatures, uninstallFeatures } from '../../../roles/features'
import { newSelfSignedCertificate } from '../../../services/certificates'
import { renameComputer, restartComputer } from '../../../services/system'
import { setPower } from '../../../topology/actions'
import { psError } from '../errors'
import type { CmdContext } from '../interpreter'
import type { CmdletDef } from '../registry'
import { flatten, psObject, type PsObject, psToString, wildcardToRegExp } from '../values'
import { onServer } from './helpers'

const featureNames = () => allFeatures().map((f) => f.name)

function featureResult(success: boolean, names: string[], restart = false) {
  return psObject(
    'FeatureOperationResult',
    {
      Success: success,
      'Restart Needed': restart ? 'Yes' : 'No',
      'Exit Code': names.length === 0 ? 'NoChangeNeeded' : 'Success',
      'Feature Result': `{${names.join(', ')}}`
    },
    { kind: 'table', props: ['Success', 'Restart Needed', 'Exit Code', 'Feature Result'] }
  )
}

function restartNow(ctx: CmdContext): void {
  ctx.apply(restartComputer(ctx.state, ctx.deviceId))
  ctx.write('Redémarrage de l’ordinateur…')
  ctx.exit = true
}

/** Affichage tableau de Get-WindowsFeature : « [X] Nom affiché », Name, Install State. */
function renderFeatures(objects: PsObject[]): string[] {
  const label = (o: PsObject) => {
    const indent = o.props['Depth'] === 1 ? '    ' : ''
    return `${indent}${o.props['Installed'] === true ? '[X]' : '[ ]'} ${psToString(o.props['DisplayName'] ?? '')}`
  }
  const width = Math.max(...objects.map((o) => label(o).length - 4)) + 6
  const lines = [
    '',
    `${'Display Name'.padEnd(width)}${'Name'.padEnd(28)}Install State`,
    `${'------------'.padEnd(width)}${'----'.padEnd(28)}-------------`
  ]
  for (const o of objects)
    lines.push(
      `${label(o).padEnd(width)}${psToString(o.props['Name'] ?? '').padEnd(28)}${psToString(o.props['InstallState'] ?? '')}`
    )
  lines.push('')
  return lines
}

export const systemCmdlets: CmdletDef[] = [
  {
    name: 'Get-WindowsFeature',
    module: 'ServerManager',
    synopsis: 'Liste les rôles et fonctionnalités du serveur.',
    params: [{ name: 'Name', type: 'string[]', position: 0, complete: featureNames }],
    available: onServer,
    run(ctx, args) {
      const patterns = args['Name']
        ? flatten([args['Name']]).map((p) => wildcardToRegExp(psToString(p)))
        : null
      const installed = ctx.host.host.features
      const rows = allFeatures().filter((f) => !patterns || patterns.some((p) => p.test(f.name)))
      return rows.map((f) => {
        const isInstalled = installed.includes(f.name)
        return psObject(
          'Feature',
          {
            Name: f.name,
            DisplayName: f.displayName,
            Installed: isInstalled,
            InstallState: isInstalled ? 'Installed' : 'Available',
            Depth: f.parent ? 1 : 0
          },
          { kind: 'table', props: ['DisplayName', 'Name', 'InstallState'], render: renderFeatures }
        )
      })
    }
  },
  {
    name: 'Install-WindowsFeature',
    aliases: ['Add-WindowsFeature'],
    module: 'ServerManager',
    synopsis: 'Installe des rôles ou fonctionnalités.',
    params: [
      { name: 'Name', type: 'string[]', position: 0, mandatory: true, complete: featureNames },
      { name: 'IncludeManagementTools', type: 'switch' },
      { name: 'IncludeAllSubFeature', type: 'switch' },
      { name: 'Restart', type: 'switch' }
    ],
    available: onServer,
    run(ctx, args) {
      const names = flatten([args['Name'] ?? []]).map(psToString)
      for (const n of names)
        if (!featureInfo(n))
          throw psError(
            `ArgumentNotValid : la fonctionnalité de rôle, de service de rôle ou de fonctionnalité est introuvable : « ${n} ». Le nom est introuvable.`,
            'InvalidArgument',
            'NameDoesNotExist',
            n
          )
      ctx.write('Début de l’installation…')
      const result = ctx.apply(
        installFeatures(ctx.state, ctx.deviceId, names, {
          includeManagementTools: args['IncludeManagementTools'] === true
        })
      )
      if (result.installed.some((f) => f.name === 'AD-Domain-Services'))
        ctx.warn(
          'Pour terminer, promouvez ce serveur en contrôleur de domaine (Install-ADDSForest ou Gestionnaire de serveur).'
        )
      return [
        featureResult(
          true,
          result.installed.map((f) => f.displayName)
        )
      ]
    }
  },
  {
    name: 'Uninstall-WindowsFeature',
    aliases: ['Remove-WindowsFeature'],
    module: 'ServerManager',
    synopsis: 'Désinstalle des rôles ou fonctionnalités.',
    params: [
      { name: 'Name', type: 'string[]', position: 0, mandatory: true, complete: featureNames },
      { name: 'Restart', type: 'switch' }
    ],
    available: onServer,
    run(ctx, args) {
      const names = flatten([args['Name'] ?? []]).map(psToString)
      const result = ctx.apply(uninstallFeatures(ctx.state, ctx.deviceId, names))
      return [
        featureResult(
          true,
          result.installed.map((f) => f.displayName)
        )
      ]
    }
  },
  {
    name: 'Restart-Computer',
    module: 'Management',
    synopsis: 'Redémarre l’ordinateur local ou des ordinateurs du domaine (-ComputerName).',
    params: [
      {
        name: 'ComputerName',
        type: 'string[]',
        position: 0,
        aliases: ['CN', '__SERVER', 'Server', 'IPAddress']
      },
      { name: 'Force', type: 'switch' },
      { name: 'Wait', type: 'switch' }
    ],
    run(ctx, args) {
      const names = args['ComputerName'] === undefined ? [] : flatten([args['ComputerName']]).map(psToString)
      const local = (n: string) => ['.', 'localhost', ctx.host.name.toLowerCase()].includes(n.toLowerCase())
      // Ordinateurs distants (Learn, Restart-Computer -ComputerName) : membres du même domaine,
      // allumés, administrateur du domaine requis
      for (const name of names.filter((n) => !local(n))) {
        const target = Object.values(ctx.state.devices).find(
          (d) => (d.kind === 'server' || d.kind === 'client') && d.name.toLowerCase() === name.toLowerCase()
        )
        const domain = ctx.host.host.domain ? ctx.state.domains[ctx.host.host.domain] : undefined
        if (!target || !target.powered || target.kind === 'router')
          throw psError(
            `Impossible de redémarrer l’ordinateur ${name}. Le serveur RPC n’est pas disponible.`,
            'OperationStopped',
            'RestartcomputerFailed',
            name
          )
        if (
          !domain ||
          (target.kind !== 'server' && target.kind !== 'client') ||
          target.host.domain !== domain.name ||
          !ctx.user.domain ||
          !isDomainAdmin(domain, ctx.user.name)
        )
          throw psError(
            `Impossible de redémarrer l’ordinateur ${name}. Accès refusé.`,
            'OperationStopped',
            'RestartcomputerFailed',
            name
          )
        ctx.apply(restartComputer(ctx.state, target.id))
      }
      if (names.length === 0 || names.some(local)) restartNow(ctx)
    }
  },
  {
    name: 'Stop-Computer',
    module: 'Management',
    synopsis: 'Arrête l’ordinateur.',
    params: [{ name: 'Force', type: 'switch' }],
    run(ctx) {
      ctx.write('Arrêt de l’ordinateur… (rallumez-le depuis son onglet Config ou le panneau Propriétés)')
      ctx.apply(setPower(ctx.state, ctx.deviceId, false))
      ctx.exit = true
    }
  },
  {
    name: 'Rename-Computer',
    module: 'Management',
    synopsis: 'Renomme l’ordinateur (effectif après redémarrage).',
    params: [
      { name: 'NewName', type: 'string', position: 0, mandatory: true },
      { name: 'Restart', type: 'switch' },
      { name: 'Force', type: 'switch' },
      { name: 'DomainCredential', type: 'credential' }
    ],
    run(ctx, args) {
      const name = psToString(args['NewName'])
      ctx.apply(renameComputer(ctx.state, ctx.deviceId, name))
      if (args['Restart'] === true) restartNow(ctx)
      else
        ctx.warn(
          `Les modifications seront prises en compte après le redémarrage de l’ordinateur ${ctx.host.name}.`
        )
    }
  },
  {
    name: 'New-SelfSignedCertificate',
    module: 'PKI',
    synopsis: 'Crée un certificat auto-signé dans le magasin de l’ordinateur.',
    params: [
      { name: 'DnsName', type: 'string[]', position: 0 },
      { name: 'CertStoreLocation', type: 'string' },
      { name: 'Subject', type: 'string' }
    ],
    run(ctx, args) {
      const store = psToString(args['CertStoreLocation'] ?? '')
        .replace(/^cert:\\?/i, '')
        .replace(/\\$/, '')
      if (store.toLowerCase() !== 'localmachine\\my')
        throw psError(
          'Seul le magasin Cert:\\LocalMachine\\My est simulé : indiquez -CertStoreLocation Cert:\\LocalMachine\\My.',
          'InvalidArgument',
          'CertStoreLocation,Microsoft.CertificateServices.Commands.NewSelfSignedCertificateCommand'
        )
      const names = args['DnsName'] ? flatten([args['DnsName']]).map((n) => psToString(n)) : []
      const thumbprint = ctx.apply(newSelfSignedCertificate(ctx.state, ctx.deviceId, names))
      ctx.writeLines([
        '',
        '   PSParentPath: Microsoft.PowerShell.Security\\Certificate::LocalMachine\\My',
        ''
      ])
      return [
        psObject(
          'System.Security.Cryptography.X509Certificates.X509Certificate2',
          { Thumbprint: thumbprint, Subject: `CN=${names[0]?.toLowerCase() ?? ''}` },
          { kind: 'table', props: ['Thumbprint', 'Subject'] }
        )
      ]
    }
  }
]
