/**
 * Cmdlets du module RemoteDesktop (collections, RemoteApp, sessions). Le groupe local Utilisateurs
 * du Bureau à distance est géré par les cmdlets LocalAccounts (shell/ps/cmdlets/localaccounts.ts).
 */
import { psError } from '../../shell/ps/errors'
import type { CmdContext } from '../../shell/ps/interpreter'
import type { CmdletDef, ParamDef } from '../../shell/ps/registry'
import { flatten, psObject, psToString, type PsValue } from '../../shell/ps/values'
import { hasFeature } from '../../shell/ps/cmdlets/helpers'
import {
  addRemoteApp,
  addSessionCollection,
  removeRemoteApp,
  removeSessionCollection,
  setCollectionUserGroups
} from './server'
import { rdsServerOf } from './state'

const MODULE = 'RemoteDesktop'
const available = (ctx: CmdContext) => hasFeature(ctx, 'RDS-RD-Server')
const str = (v: PsValue | undefined): string => psToString(v)
const list = (v: PsValue | undefined): string[] =>
  v === undefined ? [] : flatten([v]).map((x) => psToString(x))

const collectionNames = (ctx: CmdContext) => rdsServerOf(ctx.device)?.collections.map((c) => c.name) ?? []
const collectionParam: ParamDef = {
  name: 'CollectionName',
  type: 'string',
  mandatory: true,
  position: 0,
  complete: collectionNames
}
const brokerParams: ParamDef[] = [
  { name: 'ConnectionBroker', type: 'string' },
  { name: 'Force', type: 'switch' }
]

export const rdsCmdlets: CmdletDef[] = [
  {
    name: 'New-RDSessionCollection',
    module: MODULE,
    synopsis: 'Crée une collection de sessions.',
    available,
    params: [
      collectionParam,
      { name: 'SessionHost', type: 'string[]' },
      { name: 'CollectionDescription', type: 'string' },
      ...brokerParams
    ],
    run(ctx, args) {
      const hosts = list(args['SessionHost']).map((h) => h.split('.')[0]!.toLowerCase())
      if (hosts.some((h) => h !== ctx.device.name.toLowerCase()))
        throw psError(
          'Déploiement à serveur unique : l’hôte de session doit être ce serveur.',
          'InvalidArgument',
          'SessionHost'
        )
      ctx.apply(
        addSessionCollection(ctx.state, ctx.deviceId, {
          name: str(args['CollectionName']),
          description: args['CollectionDescription'] ? str(args['CollectionDescription']) : '',
          userGroups: []
        })
      )
    }
  },
  {
    name: 'Get-RDSessionCollection',
    module: MODULE,
    synopsis: 'Liste les collections de sessions.',
    available,
    params: [{ ...collectionParam, mandatory: false }, ...brokerParams],
    run(ctx, args) {
      const name = args['CollectionName'] ? str(args['CollectionName']).toLowerCase() : null
      return (rdsServerOf(ctx.device)?.collections ?? [])
        .filter((c) => !name || c.name.toLowerCase() === name)
        .map((c) =>
          psObject(
            'Microsoft.RemoteDesktopServices.Management.RDSessionCollection',
            {
              CollectionName: c.name,
              Size: 1,
              ResourceType: c.remoteApps.length > 0 ? 'Programmes RemoteApp' : 'Bureau à distance',
              CollectionDescription: c.description,
              UserGroup: c.userGroups
            },
            { kind: 'table', props: ['CollectionName', 'Size', 'ResourceType', 'CollectionDescription'] }
          )
        )
    }
  },
  {
    name: 'Set-RDSessionCollectionConfiguration',
    module: MODULE,
    synopsis: 'Modifie la configuration d’une collection (groupes d’utilisateurs).',
    available,
    params: [collectionParam, { name: 'UserGroup', type: 'string[]' }, ...brokerParams],
    run(ctx, args) {
      if (args['UserGroup'] !== undefined)
        ctx.apply(
          setCollectionUserGroups(
            ctx.state,
            ctx.deviceId,
            str(args['CollectionName']),
            list(args['UserGroup'])
          )
        )
    }
  },
  {
    name: 'Remove-RDSessionCollection',
    module: MODULE,
    synopsis: 'Supprime une collection de sessions.',
    available,
    params: [collectionParam, ...brokerParams],
    run(ctx, args) {
      const name = str(args['CollectionName'])
      if (!ctx.confirm(name)) return
      ctx.apply(removeSessionCollection(ctx.state, ctx.deviceId, name))
    }
  },
  {
    name: 'New-RDRemoteApp',
    module: MODULE,
    synopsis: 'Publie un programme RemoteApp.',
    available,
    params: [
      collectionParam,
      { name: 'DisplayName', type: 'string', mandatory: true },
      { name: 'FilePath', type: 'string', mandatory: true },
      { name: 'Alias', type: 'string' },
      ...brokerParams
    ],
    run(ctx, args) {
      ctx.apply(
        addRemoteApp(ctx.state, ctx.deviceId, str(args['CollectionName']), {
          displayName: str(args['DisplayName']),
          filePath: str(args['FilePath']),
          ...(args['Alias'] ? { alias: str(args['Alias']) } : {})
        })
      )
    }
  },
  {
    name: 'Get-RDRemoteApp',
    module: MODULE,
    synopsis: 'Liste les programmes RemoteApp publiés.',
    available,
    params: [{ ...collectionParam, mandatory: false }, ...brokerParams],
    run(ctx, args) {
      const name = args['CollectionName'] ? str(args['CollectionName']).toLowerCase() : null
      return (rdsServerOf(ctx.device)?.collections ?? [])
        .filter((c) => !name || c.name.toLowerCase() === name)
        .flatMap((c) =>
          c.remoteApps.map((a) =>
            psObject(
              'Microsoft.RemoteDesktopServices.Management.RemoteApp',
              {
                CollectionName: c.name,
                Alias: a.alias,
                DisplayName: a.displayName,
                FolderName: '',
                FilePath: a.filePath
              },
              { kind: 'table', props: ['CollectionName', 'Alias', 'DisplayName', 'FilePath'] }
            )
          )
        )
    }
  },
  {
    name: 'Remove-RDRemoteApp',
    module: MODULE,
    synopsis: 'Retire un programme RemoteApp.',
    available,
    params: [collectionParam, { name: 'Alias', type: 'string', mandatory: true }, ...brokerParams],
    run(ctx, args) {
      ctx.apply(removeRemoteApp(ctx.state, ctx.deviceId, str(args['CollectionName']), str(args['Alias'])))
    }
  },
  {
    name: 'Get-RDUserSession',
    module: MODULE,
    synopsis: 'Liste les sessions Bureau à distance ouvertes.',
    available,
    params: brokerParams,
    run(ctx) {
      const d = ctx.device
      const sessions = d.kind === 'server' ? d.host.remoteSessions : []
      return sessions.map((s) =>
        psObject(
          'Microsoft.RemoteDesktopServices.Management.RDUserSession',
          {
            UserName: s.account.split('\\')[1] ?? s.account,
            DomainName: s.account.split('\\')[0] ?? '',
            SessionId: s.id,
            HostServer: d.name,
            ClientName: s.from,
            SessionState: 'STATE_ACTIVE',
            ApplicationType: s.app ?? 'Bureau'
          },
          {
            kind: 'table',
            props: ['UserName', 'DomainName', 'SessionId', 'ClientName', 'SessionState', 'ApplicationType']
          }
        )
      )
    }
  }
]
