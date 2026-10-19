/**
 * Panne `windows.service-stopped` : le service d'un rôle installé est arrêté (`service.stop`).
 * Le symptôme est l'effet réel sur le lab. Sondes prises en charge (une par service) :
 * - DNS : un nom de la zone ne se résout plus depuis un client qui utilise ce serveur ; la
 *   sortie de `nslookup` est celle, existante, d'un serveur qui ne répond pas.
 * Ajouter un service = ajouter une entrée à `PROBES`.
 */
import { command } from '../../commands/catalog'
import type { LabState } from '../../model/schema'
import { effectiveIpv4 } from '../../net/addressing'
import { dnsServerOf } from '../../roles/dns/state'
import { dnsServersOf, resolveName } from '../../roles/dns/resolver'
import { serviceRunning } from '../../services/servicestate'
import type { FaultDef, FaultTargetParams } from '../types'

const ID = 'windows.service-stopped'

interface Probe {
  /** Nom court du service. */
  service: string
  /** Cibles possibles sur l'état sain (serveur, et ce qui sert à observer le symptôme). */
  candidates(state: LabState): FaultTargetParams[]
  /** L'effet du service est-il observable (service qui répond) ? */
  works(state: LabState, p: FaultTargetParams): boolean
  ticket(state: LabState, p: FaultTargetParams): string
  hints(state: LabState, p: FaultTargetParams): [string, string, string]
  cause: string
}

const nameOf = (state: LabState, id: unknown): string => state.devices[String(id)]?.name ?? 'le poste'

const DNS_PROBE: Probe = {
  service: 'DNS',
  candidates(state) {
    const out: FaultTargetParams[] = []
    for (const server of Object.values(state.devices)) {
      if (server.kind !== 'server' || !server.powered || !server.host.features.includes('DNS')) continue
      const dns = dnsServerOf(server)
      const ips = server.interfaces.map((i) => effectiveIpv4(i)?.address).filter((a): a is string => !!a)
      for (const zone of dns?.zones ?? []) {
        if (zone.reverse) continue
        const record = zone.records.find((r) => r.type === 'A' || r.type === 'CNAME')
        if (!record) continue
        const name = record.name === '@' ? zone.name : `${record.name}.${zone.name}`
        for (const client of Object.values(state.devices)) {
          if (client.id === server.id || (client.kind !== 'client' && client.kind !== 'server')) continue
          if (!client.powered || !dnsServersOf(client).some((s) => ips.includes(s))) continue
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
  cause: 'Le service DNS du serveur était arrêté : plus aucune requête de nom n’obtenait de réponse.'
}

const PROBES: Probe[] = [DNS_PROBE]

const probeOf = (p: FaultTargetParams): Probe | undefined => PROBES.find((x) => x.service === p['service'])

/** Le service ciblé tourne-t-il sur le serveur ? */
function running(state: LabState, p: FaultTargetParams): boolean {
  const device = state.devices[String(p['device'])]
  return !!device && device.kind === 'server' && serviceRunning(device, String(p['service']))
}

export const serviceStopped: FaultDef = {
  id: ID,
  domain: 'windows',
  difficulty: 1,
  title: 'Service arrêté',

  pick(state, rand) {
    const candidates = PROBES.flatMap((probe) =>
      probe.candidates(state).filter((p) => running(state, p) && probe.works(state, p))
    )
    return candidates.length === 0 ? null : candidates[Math.floor(rand() * candidates.length)]!
  },

  inject: (_state, p) => [command('service.stop', String(p['device']), String(p['service']))],

  symptomVisible: (state, p) => !running(state, p) && !(probeOf(p)?.works(state, p) ?? true),

  ticket: (state, p) => probeOf(p)?.ticket(state, p) ?? 'Un service ne répond plus.',

  hints: (state, p) =>
    probeOf(p)?.hints(state, p) ?? [
      'Un service ne répond plus.',
      'Cherchez sur un serveur.',
      'Un service est arrêté.'
    ],

  cause: (state, p) =>
    `${probeOf(p)?.cause ?? 'Un service était arrêté.'} (serveur ${nameOf(state, p['device'])}, service ${String(p['service'])})`,

  repair: (_state, p) => [command('service.start', String(p['device']), String(p['service']))],

  healed: (state, p) => running(state, p) && (probeOf(p)?.works(state, p) ?? false)
}
