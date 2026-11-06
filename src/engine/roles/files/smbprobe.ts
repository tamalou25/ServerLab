/**
 * Sonde SMB d'un partage Samba vue depuis un poste (critères de lab, bilans) : reproduit, sans écrire
 * dans l'état, ce que fait `smbclient //serveur/partage -U compte%mdp -c ls` (ou `net use` depuis un
 * poste Windows) : joignabilité du port 445 à travers le réseau simulé, service smbd actif avec sa
 * configuration EN VIGUEUR (relue au redémarrage, pas le fichier), authentification sur la base Samba,
 * connexion au partage (valid users, hosts allow, read only…), puis droits Unix du compte effectif :
 * lecture du dossier et, à la demande, création d'un fichier (à blanc, l'état n'est pas modifié).
 *
 * Une seule règle d'accès pour toutes les vérifications : celle de `shell/bash/sambaaccess.ts`.
 */
import type { HostDevice, LabState, ServerDevice } from '../../model/schema'
import { effectiveIpv4 } from '../../net/addressing'
import {
  authenticate,
  connect,
  createInShare,
  listShareDir,
  sambaServer,
  type SambaServer
} from '../../shell/bash/sambaaccess'
import { joinPath } from '../../shell/bash/linuxfs'
import { sourceAddressFor } from '../../sim/forward'
import { serverExchange } from '../adds/locator'
import { isLinuxServer } from './linuxshare'

export type SmbProbeStatus =
  /** Aucun chemin réseau jusqu'au serveur (câble, adressage, routage, pare-feu). */
  | 'unreachable'
  /** Le serveur répond mais smbd est arrêté ou Samba absent (port 445 fermé). */
  | 'refused'
  /** Compte inconnu de la base Samba, mot de passe faux ou compte désactivé. */
  | 'logon-failure'
  /** Partage inconnu de la configuration en vigueur, ou dossier introuvable. */
  | 'bad-network-name'
  /** Partage connu mais refusé : valid users, hosts allow, invités, droits Unix du dossier. */
  | 'access-denied'
  /** Connecté, mais le contenu du dossier ne peut pas être listé. */
  | 'list-denied'
  /** Connecté en lecture, mais l'écriture demandée est refusée. */
  | 'write-denied'
  | 'ok'

export interface SmbProbeOptions {
  /** Compte Samba ; null ou absent : session anonyme (invité). */
  user?: string | null
  /**
   * Mot de passe ; absent avec un compte : le mot de passe enregistré dans la base Samba du serveur
   * est utilisé (l'utilisateur tape son propre mot de passe), ce qui vérifie que le compte Samba existe.
   */
  password?: string | null
  /** L'écriture (création d'un fichier à la racine du partage) doit réussir. */
  write?: boolean
}

export interface SmbProbeResult {
  ok: boolean
  status: SmbProbeStatus
  /** Compte Unix effectif de la connexion (force user compris), si connecté. */
  unixUser?: string
  /** Écriture permise sur le partage (après `read only`, `write list`, `read list`). */
  writable?: boolean
}

/** Serveur Linux désigné par son nom ou l'une de ses adresses IPv4. */
export function linuxServerByRef(state: LabState, ref: string): ServerDevice | undefined {
  const wanted = ref.toLowerCase()
  return Object.values(state.devices).find(
    (d): d is ServerDevice =>
      d.kind === 'server' &&
      isLinuxServer(d) &&
      (d.name.toLowerCase() === wanted || d.interfaces.some((i) => effectiveIpv4(i)?.address === ref))
  )
}

const firstIp = (device: { interfaces: HostDevice['interfaces'] }): string | null =>
  device.interfaces.map((i) => effectiveIpv4(i)?.address).find((a): a is string => !!a) ?? null

/** Mot de passe Samba enregistré pour un compte (null si le compte n'a pas de compte Samba). */
function storedPassword(srv: SambaServer, user: string): string | null {
  return srv.users.find((u) => u.name.toLowerCase() === user.toLowerCase())?.password ?? null
}

/**
 * Sonde un partage depuis le poste `clientId`. `serverRef` : nom ou adresse du serveur Samba (Linux).
 * Pur : aucun effet sur l'état (la trace réseau n'est pas conservée).
 */
export function smbProbe(
  state: LabState,
  clientId: string,
  serverRef: string,
  share: string,
  opts: SmbProbeOptions = {}
): SmbProbeResult {
  const client = state.devices[clientId]
  const server = linuxServerByRef(state, serverRef)
  if (!client || (client.kind !== 'client' && client.kind !== 'server') || !client.powered || !server)
    return { ok: false, status: 'unreachable' }
  const ip = firstIp(server)
  if (!ip) return { ok: false, status: 'unreachable' }
  const exchange = serverExchange(state, clientId, ip, {
    protocol: 'SMB',
    port: 445,
    request: 'SMB2 : négociation du dialecte',
    reply: 'SMB2 : réponse du serveur Samba',
    fields: [['Hôte', server.name]]
  })
  const srv = sambaServer(server)
  if (!exchange.ok) return { ok: false, status: server.powered && !srv ? 'refused' : 'unreachable' }
  if (!srv) return { ok: false, status: 'refused' }
  const user = opts.user ?? null
  const password = user === null ? null : (opts.password ?? storedPassword(srv, user))
  const auth = authenticate(srv, user, password)
  if (auth.kind === 'failed') return { ok: false, status: 'logon-failure' }
  const clientIp = sourceAddressFor(state, client, ip)
  const connected = connect(srv, share, auth, clientIp)
  if (!connected.ok)
    return {
      ok: false,
      status: connected.status === 'NT_STATUS_BAD_NETWORK_NAME' ? 'bad-network-name' : 'access-denied'
    }
  const conn = connected.conn
  const base = { unixUser: conn.user, writable: conn.writable }
  if (listShareDir(srv, conn, conn.path) === null) return { ok: false, status: 'list-denied', ...base }
  if (opts.write) {
    // Création à blanc d'un fichier qui n'existe pas encore : l'état n'est jamais modifié
    let name = 'sonde-serverlab.txt'
    for (let n = 1; srv.files[joinPath(conn.path, name)]; n++) name = `sonde-serverlab-${n}.txt`
    const made = createInShare(srv, conn, joinPath(conn.path, name), 'file', state.clock, '')
    if ('error' in made) return { ok: false, status: 'write-denied', ...base }
  }
  return { ok: true, status: 'ok', ...base }
}

/** Libellé français d'un statut de sonde (bilans, indices). */
export const SMB_PROBE_LABELS: Record<SmbProbeStatus, string> = {
  unreachable: 'serveur injoignable sur le réseau',
  refused: 'connexion refusée : smbd ne répond pas sur le port 445',
  'logon-failure': 'ouverture de session refusée (compte Samba absent, désactivé ou mot de passe faux)',
  'bad-network-name': 'partage introuvable (NT_STATUS_BAD_NETWORK_NAME)',
  'access-denied': 'accès au partage refusé (NT_STATUS_ACCESS_DENIED)',
  'list-denied': 'connexion acceptée mais lecture du dossier refusée',
  'write-denied': 'lecture possible mais écriture refusée',
  ok: 'accès réussi'
}
