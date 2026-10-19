/**
 * Pannes de droits sur un dossier partagé (chantier D, #230) : un utilisateur qui écrivait dans le
 * partage n'y écrit plus (« Accès refusé », sortie existante de `New-Item`, `copy`, `net use`).
 * - `win.ntfs-rights` : l'entrée NTFS du groupe de l'utilisateur a disparu du dossier
 *   (`files.setNtfsEntry` vide) ;
 * - `win.share-acl` : les autorisations du partage sont rabaissées à Lecture (`files.setShareAcl`) :
 *   le droit effectif est l'intersection partage ∩ NTFS.
 * Symptôme lu par `openUnc` (accès au chemin UNC, droits effectifs) ; le service Serveur arrêté le
 * masque (erreur 53 avant tout contrôle de droits : pannes composées).
 */
import { command } from '../../commands/catalog'
import {
  WELL_KNOWN_SIDS,
  type LabState,
  type NtfsRight,
  type ServerDevice,
  type ShareAce
} from '../../model/schema'
import { domainToken, localToken, sessionToken, type AccessToken } from '../../roles/files/acl'
import { nodePath } from '../../roles/files/paths'
import { openUnc } from '../../roles/files/smb'
import type { FaultDef, FaultTargetParams } from '../types'
import { nameOf } from './service-probes'
import { firstViable } from './viable'

const WELL_KNOWN = new Set<string>(Object.values(WELL_KNOWN_SIDS))

/** Jeton administrateur du serveur (domaine s'il en est membre, sinon compte local). */
function adminToken(state: LabState, serverId: string): AccessToken {
  const server = state.devices[serverId]
  const domain =
    server && (server.kind === 'server' || server.kind === 'client') && server.host.domain
      ? state.domains[server.host.domain]
      : undefined
  return (domain && domainToken(domain, 'Administrateur')) || localToken(server?.name ?? '', 'Administrateur')
}

/** Accès du client au partage : 'write' (écriture possible), 'denied' (accès refusé), 'other'. */
function access(state: LabState, p: FaultTargetParams): 'write' | 'denied' | 'other' {
  const token = sessionToken(state, String(p['client']))
  const r = openUnc(state, String(p['client']), String(p['unc']), token)
  if (r.ok) return r.target.perms.has('write') ? 'write' : 'denied'
  return r.code === 5 ? 'denied' : 'other'
}

/** Partage non masqué d'un serveur, avec un client dont la session accède en écriture. */
function targets(state: LabState): FaultTargetParams[] {
  const out: FaultTargetParams[] = []
  for (const server of Object.values(state.devices)) {
    if (server.kind !== 'server' || !server.powered) continue
    for (const share of server.storage.shares) {
      if (share.name.endsWith('$')) continue
      const node = server.storage.nodes.find((n) => n.id === share.folderId)
      if (!node) continue
      for (const client of Object.values(state.devices)) {
        if ((client.kind !== 'client' && client.kind !== 'server') || client.id === server.id) continue
        if (!client.powered) continue
        const token = sessionToken(state, client.id)
        if (!token) continue
        out.push({
          device: server.id,
          share: share.name,
          path: nodePath(server.storage, node.id),
          unc: `\\\\${server.name}\\${share.name}`,
          client: client.id,
          sam: token.account
        })
      }
    }
  }
  return out.filter((p) => access(state, p) === 'write')
}

const clientName = (state: LabState, p: FaultTargetParams): string => nameOf(state, p['client'])

const ticket = (state: LabState, p: FaultTargetParams): string =>
  `${String(p['sam'])} n’arrive plus à enregistrer ni modifier de fichier dans ${String(p['unc'])} depuis ${clientName(state, p)} : « Accès refusé ». Le dossier s’ouvre toujours.`

export const ntfsRights: FaultDef = {
  id: 'win.ntfs-rights',
  domain: 'windows',
  difficulty: 2,
  title: 'Droits NTFS incohérents',

  pick(state, rand) {
    const list: FaultTargetParams[] = []
    for (const p of targets(state)) {
      const server = state.devices[String(p['device'])] as ServerDevice
      const token = sessionToken(state, String(p['client']))
      const node = server.storage.nodes.find((n) => nodePath(server.storage, n.id) === p['path'])
      if (!node || !token) continue
      // Entrées explicites « Autoriser » d'un groupe ou d'un compte du jeton (pas les identités intégrées)
      const mine = node.acl.filter(
        (a) => a.type === 'Allow' && !WELL_KNOWN.has(a.principal) && token.sids.includes(a.principal)
      )
      const principals = [...new Set(mine.map((a) => a.principal))]
      for (const principal of principals)
        if (node.acl.every((a) => a.principal !== principal || a.type === 'Allow'))
          list.push({
            ...p,
            principal,
            rights: node.acl
              .filter((a) => a.principal === principal)
              .map((a) => a.rights)
              .join(',')
          })
    }
    return firstViable(state, rand, list, ntfsRights)
  },

  inject: (state, p) => [
    command(
      'files.setNtfsEntry',
      String(p['device']),
      String(p['path']),
      String(p['principal']),
      { allow: [], deny: [] },
      adminToken(state, String(p['device']))
    )
  ],

  symptomVisible: (state, p) => access(state, p) === 'denied',
  ticket,

  hints: (state, p) => [
    `Depuis ${clientName(state, p)}, le dossier ${String(p['unc'])} s’ouvre mais l’écriture est refusée : le réseau, le partage et le service fonctionnent.`,
    `Regardez les autorisations du dossier ${String(p['path'])} sur ${nameOf(state, p['device'])} (onglet Sécurité, Accès effectif de ${String(p['sam'])}).`,
    `Le groupe qui donnait le droit de modification à ${String(p['sam'])} figure-t-il encore dans la liste des autorisations NTFS du dossier ?`
  ],

  cause: (state, p) =>
    `L’entrée NTFS du groupe de ${String(p['sam'])} (${String(p['rights'])}) avait disparu de ${String(p['path'])} sur ${nameOf(state, p['device'])} : le droit d’écriture n’était plus accordé.`,

  repair: (state, p) => [
    command(
      'files.setNtfsEntry',
      String(p['device']),
      String(p['path']),
      String(p['principal']),
      { allow: String(p['rights']).split(',') as NtfsRight[], deny: [] },
      adminToken(state, String(p['device']))
    )
  ],

  healed: (state, p) => access(state, p) === 'write'
}

export const shareAcl: FaultDef = {
  id: 'win.share-acl',
  domain: 'windows',
  difficulty: 2,
  title: 'Autorisations de partage incohérentes',

  pick(state, rand) {
    const list = targets(state).flatMap((p) => {
      const server = state.devices[String(p['device'])] as ServerDevice
      const share = server.storage.shares.find((s) => s.name === p['share'])
      // Il faut un droit au-dessus de Lecture à rabaisser
      return share?.acl.some((a) => a.type === 'Allow' && a.rights !== 'Read')
        ? [{ ...p, acl: JSON.stringify(share.acl) }]
        : []
    })
    return firstViable(state, rand, list, shareAcl)
  },

  inject(state, p) {
    const original = JSON.parse(String(p['acl'])) as ShareAce[]
    const reduced = original.map((a) => (a.type === 'Allow' ? { ...a, rights: 'Read' as const } : a))
    return [
      command(
        'files.setShareAcl',
        String(p['device']),
        String(p['share']),
        reduced,
        adminToken(state, String(p['device']))
      )
    ]
  },

  symptomVisible: (state, p) => access(state, p) === 'denied',
  ticket,

  hints: (state, p) => [
    `Depuis ${clientName(state, p)}, ${String(p['unc'])} s’ouvre en lecture mais toute écriture est refusée, alors que les droits NTFS du dossier n’ont pas changé.`,
    `Le droit effectif est le plus restrictif de deux listes : comparez les autorisations du partage « ${String(p['share'])} » et celles du dossier.`,
    `Regardez les autorisations de partage de « ${String(p['share'])} » (onglet Partage, Autorisations) : le niveau accordé suffit-il pour écrire ?`
  ],

  cause: (state, p) =>
    `Les autorisations du partage « ${String(p['share'])} » de ${nameOf(state, p['device'])} avaient été rabaissées à Lecture : l’écriture était refusée malgré les droits NTFS.`,

  repair: (state, p) => [
    command(
      'files.setShareAcl',
      String(p['device']),
      String(p['share']),
      JSON.parse(String(p['acl'])) as ShareAce[],
      adminToken(state, String(p['device']))
    )
  ],

  healed: (state, p) => access(state, p) === 'write'
}
