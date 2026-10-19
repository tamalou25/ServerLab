/**
 * Sondes des pannes de service (`windows.service-stopped`, `win.service-disabled`,
 * `win.service-failed`, `win.dependency-stopped`) : une sonde = un service avec son effet
 * OBSERVABLE sur le lab, lu par une fonction du moteur déjà utilisée par une console sourcée.
 * Aucune sortie nouvelle : le symptôme est celui, existant, de la commande de l'élève.
 *
 * - DNS : un nom de la zone ne se résout plus (`nslookup`).
 * - DHCPServer : un client n'obtient plus de bail (`ipconfig /renew`).
 * - LanmanServer : le partage n'est plus joint, erreur 53 (`net use`, `dir \\serveur\partage`).
 * - W3SVC : le site ne répond plus (`Invoke-WebRequest`).
 * - Netlogon : plus de contrôleur de domaine joignable (ouverture de session, `nltest /dsgetdc`).
 * Ajouter un service = ajouter une entrée à `PROBES`.
 */
import { command } from '../../commands/catalog'
import type { AnyCommand } from '../../commands/define'
import type { HostDevice, LabState } from '../../model/schema'
import { effectiveIpv4 } from '../../net/addressing'
import { dhcpAcquire } from '../../roles/dhcp/client'
import { dhcpServerOf } from '../../roles/dhcp/state'
import { dnsServerOf } from '../../roles/dns/state'
import { dnsServersOf, resolveName } from '../../roles/dns/resolver'
import { locateDc } from '../../roles/adds/locator'
import { sessionToken } from '../../roles/files/acl'
import { openUnc } from '../../roles/files/smb'
import { httpGet } from '../../roles/iis/http'
import { iisServerOf } from '../../roles/iis/state'
import { serviceRunning } from '../../services/servicestate'
import type { FaultTargetParams } from '../types'

export interface Probe {
  /** Nom court du service. */
  service: string
  /** Cibles possibles sur l'état sain (serveur, et ce qui sert à observer le symptôme). */
  candidates(state: LabState): FaultTargetParams[]
  /** L'effet du service est-il observable (service qui répond) ? */
  works(state: LabState, p: FaultTargetParams): boolean
  /** Commandes jouées AVANT la panne pour que l'état soit cohérent (p. ex. le bail libéré). */
  before?(state: LabState, p: FaultTargetParams): AnyCommand[]
  /** Commandes de réparation jouées APRÈS le démarrage du service (p. ex. renouveler le bail). */
  after?(state: LabState, p: FaultTargetParams): AnyCommand[]
  ticket(state: LabState, p: FaultTargetParams): string
  hints(state: LabState, p: FaultTargetParams): [string, string, string]
  cause: string
}

export const nameOf = (state: LabState, id: unknown): string => state.devices[String(id)]?.name ?? 'le poste'

const hostsOf = (state: LabState): HostDevice[] =>
  Object.values(state.devices).filter(
    (d): d is HostDevice => (d.kind === 'client' || d.kind === 'server') && d.powered
  )

const DNS_PROBE: Probe = {
  service: 'DNS',
  candidates(state) {
    const out: FaultTargetParams[] = []
    for (const server of hostsOf(state)) {
      if (server.kind !== 'server' || !server.host.features.includes('DNS')) continue
      const dns = dnsServerOf(server)
      const ips = server.interfaces.map((i) => effectiveIpv4(i)?.address).filter((a): a is string => !!a)
      for (const zone of dns?.zones ?? []) {
        if (zone.reverse) continue
        const record = zone.records.find((r) => r.type === 'A' || r.type === 'CNAME')
        if (!record) continue
        const name = record.name === '@' ? zone.name : `${record.name}.${zone.name}`
        for (const client of hostsOf(state)) {
          if (client.id === server.id || !dnsServersOf(client).some((s) => ips.includes(s))) continue
          out.push({ device: server.id, service: 'DNS', client: client.id, name })
        }
      }
    }
    return out
  },
  works: (state, p) => resolveName(state, String(p['client']), String(p['name'])).result.kind === 'answer',
  ticket: (state, p) =>
    `Depuis ce matin, ${nameOf(state, p['client'])} n’arrive plus à ouvrir les ressources de l’entreprise par leur nom (« ${String(p['name'])} » ne répond pas). Le serveur est pourtant allumé.`,
  hints: (state, p) => [
    `Depuis ${nameOf(state, p['client'])}, « ${String(p['name'])} » ne se résout plus. Une résolution directe par adresse IP fonctionne-t-elle encore ?`,
    `Regardez du côté du serveur ${nameOf(state, p['device'])}, celui que ${nameOf(state, p['client'])} interroge pour résoudre les noms.`,
    `Le rôle est installé et configuré : vérifiez que son service tourne bien sur ${nameOf(state, p['device'])}.`
  ],
  cause: 'Le service DNS du serveur ne répondait plus : plus aucune requête de nom n’obtenait de réponse.'
}

const DHCP_PROBE: Probe = {
  service: 'DHCPServer',
  candidates(state) {
    const out: FaultTargetParams[] = []
    for (const server of hostsOf(state)) {
      if (server.kind !== 'server' || !server.host.features.includes('DHCP')) continue
      if (!dhcpServerOf(server)?.scopes.some((s) => s.state === 'Active')) continue
      for (const client of hostsOf(state))
        for (const iface of client.interfaces)
          if (iface.addressing === 'dhcp' && iface.dhcpLease?.serverDeviceId === server.id)
            out.push({ device: server.id, service: 'DHCPServer', client: client.id, iface: iface.id })
    }
    return out
  },
  works(state, p) {
    const r = dhcpAcquire(state, String(p['client']), String(p['iface']))
    return r.outcome === 'bound' || r.outcome === 'renewed'
  },
  before: (_s, p) => [command('net.dhcpRelease', String(p['client']), String(p['iface']))],
  after: (_s, p) => [command('net.dhcpRenew', String(p['client']), String(p['iface']))],
  ticket: (state, p) =>
    `${nameOf(state, p['client'])} n’a plus d’adresse IP valide depuis son redémarrage : il ne joint plus rien sur le réseau. Les câbles et les voyants sont normaux.`,
  hints: (state, p) => [
    `Sur ${nameOf(state, p['client'])}, une demande de bail (ipconfig /renew) n’aboutit pas : l’adresse reste en 169.254.x.x ou absente.`,
    `Le client est configuré pour obtenir son adresse automatiquement : regardez du côté du serveur ${nameOf(state, p['device'])} qui distribue les baux.`,
    `Le rôle est installé et l’étendue configurée : vérifiez que le service tourne bien sur ${nameOf(state, p['device'])}.`
  ],
  cause: 'Le service Serveur DHCP ne tournait pas : aucune demande de bail n’obtenait de réponse.'
}

const SMB_PROBE: Probe = {
  service: 'LanmanServer',
  candidates(state) {
    const out: FaultTargetParams[] = []
    for (const server of hostsOf(state)) {
      if (server.kind !== 'server') continue
      const share = server.storage.shares.find((s) => !s.name.endsWith('$'))
      if (!share) continue
      for (const client of hostsOf(state))
        if (client.id !== server.id && sessionToken(state, client.id))
          out.push({
            device: server.id,
            service: 'LanmanServer',
            client: client.id,
            unc: `\\\\${server.name}\\${share.name}`
          })
    }
    return out
  },
  works(state, p) {
    const token = sessionToken(state, String(p['client']))
    return openUnc(state, String(p['client']), String(p['unc']), token).ok
  },
  ticket: (state, p) =>
    `${nameOf(state, p['client'])} n’arrive plus à ouvrir le dossier partagé ${String(p['unc'])} : « Le chemin réseau n’a pas été trouvé ». Le serveur répond pourtant au ping.`,
  hints: (state, p) => [
    `Depuis ${nameOf(state, p['client'])}, le ping vers ${nameOf(state, p['device'])} répond mais l’accès à ${String(p['unc'])} échoue (erreur 53).`,
    `Le problème est du côté du serveur ${nameOf(state, p['device'])} : le partage existe-t-il et est-il publié ?`,
    `Un service du serveur est nécessaire pour publier les partages : vérifiez qu’il tourne sur ${nameOf(state, p['device'])}.`
  ],
  cause: 'Le service Serveur (LanmanServer) était arrêté : plus aucun partage n’était accessible.'
}

/** Adresse d'un site web joignable depuis un client : http://nom-de-liaison ou http://ip:port. */
const webUrl = (server: HostDevice, binding: { host: string; port: number }): string => {
  const ip = server.interfaces.map((i) => effectiveIpv4(i)?.address).find((a) => !!a) ?? ''
  const host = binding.host || ip
  return `http://${host}${binding.port === 80 ? '' : `:${binding.port}`}/`
}

const WEB_PROBE: Probe = {
  service: 'W3SVC',
  candidates(state) {
    const out: FaultTargetParams[] = []
    for (const server of hostsOf(state)) {
      if (server.kind !== 'server' || !server.host.features.includes('Web-Server')) continue
      for (const site of iisServerOf(server)?.sites ?? []) {
        const binding = site.bindings.find((b) => b.protocol === 'http')
        if (site.state !== 'Started' || !binding) continue
        for (const client of hostsOf(state))
          if (client.id !== server.id)
            out.push({
              device: server.id,
              service: 'W3SVC',
              client: client.id,
              url: webUrl(server, binding),
              site: site.name
            })
      }
    }
    return out
  },
  works: (state, p) => {
    const r = httpGet(state, String(p['client']), String(p['url']))
    return r.kind === 'response' && r.status === 200
  },
  ticket: (state, p) =>
    `Le site ${String(p['url'])} ne s’ouvre plus depuis ${nameOf(state, p['client'])} : « Impossible de se connecter au serveur distant ». Le serveur est allumé.`,
  hints: (state, p) => [
    `Depuis ${nameOf(state, p['client'])}, la page ${String(p['url'])} ne répond pas, alors que le serveur répond au ping.`,
    `Regardez le serveur web ${nameOf(state, p['device'])} : le site est-il démarré, le port est-il à l’écoute ?`,
    `Le site est configuré et démarré dans IIS : vérifiez le service qui le publie sur ${nameOf(state, p['device'])}.`
  ],
  cause: 'Le service de publication World Wide Web (W3SVC) ne tournait pas : aucun site n’écoutait plus.'
}

const NETLOGON_PROBE: Probe = {
  service: 'Netlogon',
  candidates(state) {
    const out: FaultTargetParams[] = []
    for (const domain of Object.values(state.domains))
      for (const dc of domain.controllers) {
        if (!state.devices[dc]?.powered) continue
        for (const client of hostsOf(state))
          if (client.host.domain === domain.name && client.id !== dc)
            out.push({ device: dc, service: 'Netlogon', client: client.id, domain: domain.name })
      }
    return out
  },
  works: (state, p) => locateDc(state, String(p['client']), String(p['domain']), []) !== null,
  ticket: (state, p) =>
    `Plus personne ne peut ouvrir de session de domaine sur ${nameOf(state, p['client'])} : « Il n’y a actuellement aucun serveur d’ouverture de session disponible ». Le contrôleur de domaine est pourtant allumé.`,
  hints: (state, p) => [
    `Sur ${nameOf(state, p['client'])}, l’ouverture de session de domaine et nltest /dsgetdc échouent ; les comptes locaux fonctionnent.`,
    `Regardez le contrôleur de domaine ${nameOf(state, p['device'])} : répond-il aux clients ?`,
    `Un service du contrôleur localise le domaine pour les clients : vérifiez son état sur ${nameOf(state, p['device'])}.`
  ],
  cause:
    'Le service Netlogon du contrôleur de domaine était arrêté : le contrôleur ne répondait plus aux clients.'
}

export const PROBES: Probe[] = [DNS_PROBE, DHCP_PROBE, SMB_PROBE, WEB_PROBE, NETLOGON_PROBE]

export const probeOf = (p: FaultTargetParams): Probe | undefined =>
  PROBES.find((x) => x.service === p['service'])

/** Le service `name` (par défaut celui de la sonde) tourne-t-il sur l'ordinateur ciblé ? */
export function running(state: LabState, p: FaultTargetParams, name = String(p['service'])): boolean {
  const device = state.devices[String(p['device'])]
  return !!device && (device.kind === 'server' || device.kind === 'client') && serviceRunning(device, name)
}
