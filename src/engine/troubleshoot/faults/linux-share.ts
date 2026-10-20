/**
 * Pannes Linux de Samba (v2.9, #241) :
 * - `linux.smb-wrong-path` : le `path` d'un partage désigne un dossier inexistant (smb.conf relu au redémarrage) ;
 * - `linux.smb-share-perms` : droits Unix du dossier partagé retirés (connexion refusée, NT_STATUS_ACCESS_DENIED).
 * Le symptôme est lu dans la configuration en vigueur de smbd et les droits du dossier.
 */
import type { HostDevice, LabState } from '../../model/schema'
import { fileText, runningConfigText, SMB_CONF } from '../../services/linuxconfig'
import { findShare, hostSambaVersion, loadSmbConf, paramValue } from '../../services/linuxsamba'
import type { FaultDef, FaultTargetParams } from '../types'
import {
  clientFor,
  clientName,
  filesOf,
  linuxFault,
  linuxHostOf,
  linuxServers,
  nameOf,
  sedLine,
  sedOrThrow,
  unitActive
} from './linux-common'

const SPECIAL = ['global', 'homes', 'printers', 'print$']

/** Partages déclarés dans smb.conf, avec la ligne `path` telle qu'écrite et le dossier. */
function shares(host: HostDevice): { share: string; line: string; path: string }[] {
  const out: { share: string; line: string; path: string }[] = []
  let section = ''
  for (const raw of (fileText(filesOf(host), SMB_CONF) ?? '').split('\n')) {
    const line = raw.trim()
    const head = /^\[(.+)\]$/.exec(line)
    if (head) {
      section = head[1] as string
      continue
    }
    const m = /^path\s*=\s*(\/\S*)$/i.exec(line)
    if (m && section !== '' && !SPECIAL.includes(section.toLowerCase()))
      out.push({ share: section, line: raw.trimEnd(), path: m[1] as string })
  }
  return out
}

function candidates(state: LabState, withDir: boolean): FaultTargetParams[] {
  return linuxServers(state).flatMap((server) => {
    if (!unitActive(server, 'smbd')) return []
    const client = clientFor(state, server)
    const first = shares(server).find((s) => {
      const node = filesOf(server)[s.path]
      return !withDir || (!!node && node.type === 'dir' && (node.mode & 0o777) !== 0)
    })
    if (!first) return []
    const node = filesOf(server)[first.path]
    return [
      {
        device: server.id,
        service: 'smbd',
        share: first.share,
        line: first.line,
        path: first.path,
        mode: ((node?.mode ?? 0o755) & 0o777).toString(8),
        ...(client ? { client: client.id } : {})
      }
    ]
  })
}

const runningPath = (host: HostDevice, share: string): string => {
  const conf = loadSmbConf(runningConfigText(host.host.linux, 'smbd')).conf
  const section = findShare(conf, share)
  return section
    ? paramValue(conf, { hostname: host.name, version: hostSambaVersion(host) }, section, 'path')
    : ''
}

export const smbWrongPath = linuxFault({
  id: 'linux.smb-wrong-path',
  title: 'Partage Samba : chemin erroné',
  difficulty: 2,
  candidates: (state) =>
    candidates(state, false).filter(
      (p) => sedLine(SMB_CONF, String(p['line']), `${String(p['line'])}-old`, { whole: true }) !== null
    ),
  breakLines: (_s, p) => [
    sedOrThrow(SMB_CONF, String(p['line']), `${String(p['line'])}-old`, { whole: true }),
    'sudo systemctl restart smbd'
  ],
  fixLines: (_s, p) => [
    sedOrThrow(SMB_CONF, `${String(p['line'])}-old`, String(p['line']), { whole: true }),
    'sudo systemctl restart smbd'
  ],
  healed: (state, p) => {
    const host = linuxHostOf(state, p['device'])
    return !!host && unitActive(host, 'smbd') && runningPath(host, String(p['share'])) === String(p['path'])
  },
  ticket: (s, p) =>
    `Depuis ${clientName(s, p)}, le partage « ${String(p['share'])} » de ${nameOf(s, p['device'])} est introuvable (nom réseau incorrect), alors que le service Samba tourne et que le dossier existe.`,
  hints: (s, p) => [
    `Le partage « ${String(p['share'])} » n’est plus accessible depuis ${clientName(s, p)} ; le service Samba de ${nameOf(s, p['device'])} est actif.`,
    `Samba sait où se trouve chaque partage grâce à sa configuration : contrôlez-la avec testparm sur ${nameOf(s, p['device'])}.`,
    `Comparez la ligne path du partage avec le dossier réellement présent sur le disque ; smbd ne relit sa configuration qu’au redémarrage.`
  ],
  cause: (s, p) =>
    `Dans smb.conf de ${nameOf(s, p['device'])}, le path du partage ${String(p['share'])} valait ${String(p['path'])}-old (dossier inexistant) au lieu de ${String(p['path'])}.`
})

const modeOf = (host: HostDevice | undefined, path: string): number | null => {
  const node = host ? filesOf(host)[path] : undefined
  return node ? node.mode & 0o777 : null
}

export const smbSharePerms = linuxFault({
  id: 'linux.smb-share-perms',
  title: 'Partage Samba : droits Unix du dossier',
  difficulty: 2,
  candidates: (state) => candidates(state, true),
  breakLines: (_s, p) => [`sudo chmod 000 ${String(p['path'])}`],
  fixLines: (_s, p) => [`sudo chmod ${String(p['mode'])} ${String(p['path'])}`],
  healed: (state, p) =>
    modeOf(linuxHostOf(state, p['device']), String(p['path'])) === parseInt(String(p['mode']), 8),
  ticket: (s, p) =>
    `Depuis ${clientName(s, p)}, l’ouverture du partage « ${String(p['share'])} » de ${nameOf(s, p['device'])} est refusée (accès refusé) avec un compte pourtant autorisé, alors que le mot de passe est correct.`,
  hints: (s, p) => [
    `Le partage « ${String(p['share'])} » refuse l’accès à des comptes autorisés ; le mot de passe est bon et Samba est actif.`,
    `Samba applique ensuite les droits Unix du dossier partagé sur ${nameOf(s, p['device'])} : examinez-les.`,
    `ls -ld sur le dossier du partage donne propriétaire, groupe et droits ; comparez-les aux comptes qui doivent y accéder.`
  ],
  cause: (s, p) =>
    `Le dossier ${String(p['path'])} de ${nameOf(s, p['device'])} avait les droits 000 au lieu de ${String(p['mode'])} : aucun compte Samba ne pouvait l’ouvrir.`
})

export const LINUX_SHARE_FAULTS: readonly FaultDef[] = [smbWrongPath, smbSharePerms]
