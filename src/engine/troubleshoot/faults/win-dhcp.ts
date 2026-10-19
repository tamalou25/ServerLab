/**
 * Pannes d'étendue DHCP (chantier D, #230), symptôme commun : un client DHCP n'obtient plus de
 * bail (`ipconfig /renew`), alors que le service Serveur DHCP tourne :
 * - `win.dhcp-scope-disabled` : l'étendue est désactivée (`dhcp.setScopeState`) ;
 * - `win.dhcp-scope-exhausted` : plus aucune adresse libre, ici parce qu'une plage d'exclusion
 *   couvre toute l'étendue (`dhcp.addExclusion`).
 * Avant la panne, le client libère son bail (`net.dhcpRelease`) ; la réparation renouvelle le bail.
 * Le symptôme n'existe que si le service tourne : un service arrêté le masque (pannes composées).
 */
import { command } from '../../commands/catalog'
import type { LabState } from '../../model/schema'
import { dhcpAcquire } from '../../roles/dhcp/client'
import { dhcpServerOf } from '../../roles/dhcp/state'
import { inScopeRange } from '../../roles/dhcp/server'
import { serviceRunning } from '../../services/servicestate'
import type { FaultDef, FaultTargetParams } from '../types'
import { nameOf } from './service-probes'
import { firstViable } from './viable'

const gets = (state: LabState, p: FaultTargetParams): boolean => {
  const r = dhcpAcquire(state, String(p['client']), String(p['iface']))
  return r.outcome === 'bound' || r.outcome === 'renewed'
}

/** Étendue ciblée sur le serveur, undefined si elle a disparu. */
function scopeOf(state: LabState, p: FaultTargetParams) {
  const server = state.devices[String(p['device'])]
  return server ? dhcpServerOf(server)?.scopes.find((s) => s.scopeId === p['scopeId']) : undefined
}

const serviceUp = (state: LabState, p: FaultTargetParams): boolean => {
  const server = state.devices[String(p['device'])]
  return !!server && server.kind === 'server' && serviceRunning(server, 'DHCPServer')
}

/** Cibles : un client dont le bail vient d'une étendue active d'un serveur DHCP autorisé. */
function candidates(state: LabState): FaultTargetParams[] {
  const out: FaultTargetParams[] = []
  for (const server of Object.values(state.devices)) {
    if (server.kind !== 'server' || !server.powered || !server.host.features.includes('DHCP')) continue
    if (!serviceRunning(server, 'DHCPServer')) continue
    for (const scope of dhcpServerOf(server)?.scopes ?? []) {
      if (scope.state !== 'Active') continue
      for (const client of Object.values(state.devices)) {
        if ((client.kind !== 'client' && client.kind !== 'server') || !client.powered) continue
        for (const iface of client.interfaces) {
          const lease = iface.dhcpLease
          if (iface.addressing !== 'dhcp' || lease?.serverDeviceId !== server.id) continue
          if (!inScopeRange(scope, lease.address)) continue
          out.push({
            device: server.id,
            scopeId: scope.scopeId,
            scopeName: scope.name,
            start: scope.start,
            end: scope.end,
            index: scope.exclusions.length,
            client: client.id,
            iface: iface.id
          })
        }
      }
    }
  }
  return out.filter((p) => gets(state, p))
}

const ticket = (state: LabState, p: FaultTargetParams): string =>
  `${nameOf(state, p['client'])} n’obtient plus d’adresse IP : après un redémarrage il reste en 169.254.x.x et ne joint plus le réseau. Les câbles sont branchés et le serveur DHCP est allumé.`

const release = (p: FaultTargetParams) => command('net.dhcpRelease', String(p['client']), String(p['iface']))
const renew = (p: FaultTargetParams) => command('net.dhcpRenew', String(p['client']), String(p['iface']))

export const dhcpScopeDisabled: FaultDef = {
  id: 'win.dhcp-scope-disabled',
  domain: 'windows',
  difficulty: 2,
  title: 'Étendue DHCP désactivée',
  pick: (state, rand) => firstViable(state, rand, candidates(state), dhcpScopeDisabled),
  inject: (_s, p) => [
    release(p),
    command('dhcp.setScopeState', String(p['device']), String(p['scopeId']), false)
  ],
  symptomVisible: (state, p) =>
    serviceUp(state, p) && scopeOf(state, p)?.state === 'Inactive' && !gets(state, p),
  ticket,
  hints: (state, p) => [
    `Sur ${nameOf(state, p['client'])}, ipconfig /renew n’aboutit pas : le client est bien configuré pour obtenir une adresse automatiquement.`,
    `Le service DHCP du serveur ${nameOf(state, p['device'])} tourne : regardez la configuration de ses étendues.`,
    `Comparez l’état de l’étendue « ${String(p['scopeName'])} » dans la console DHCP (ou avec Get-DhcpServerv4Scope) à celui attendu.`
  ],
  cause: (state, p) =>
    `L’étendue « ${String(p['scopeName'])} » (${String(p['scopeId'])}) de ${nameOf(state, p['device'])} était désactivée : le serveur ne distribuait plus aucune adresse.`,
  repair: (_s, p) => [
    command('dhcp.setScopeState', String(p['device']), String(p['scopeId']), true),
    renew(p)
  ],
  healed: (state, p) => scopeOf(state, p)?.state === 'Active' && gets(state, p)
}

export const dhcpScopeExhausted: FaultDef = {
  id: 'win.dhcp-scope-exhausted',
  domain: 'windows',
  difficulty: 2,
  title: 'Étendue DHCP épuisée',
  pick: (state, rand) => firstViable(state, rand, candidates(state), dhcpScopeExhausted),
  inject: (_s, p) => [
    release(p),
    command(
      'dhcp.addExclusion',
      String(p['device']),
      String(p['scopeId']),
      String(p['start']),
      String(p['end'])
    )
  ],
  symptomVisible: (state, p) => {
    const scope = scopeOf(state, p)
    const covered = !!scope?.exclusions.some((e) => e.start === p['start'] && e.end === p['end'])
    return serviceUp(state, p) && covered && !gets(state, p)
  },
  ticket,
  hints: (state, p) => [
    `Sur ${nameOf(state, p['client'])}, ipconfig /renew n’aboutit pas alors que l’étendue est active sur le serveur.`,
    `Le service DHCP de ${nameOf(state, p['device'])} répond : regardez le nombre d’adresses disponibles dans l’étendue « ${String(p['scopeName'])} ».`,
    `Examinez les plages d’exclusion et les baux de l’étendue : y a-t-il encore une adresse libre à distribuer ?`
  ],
  cause: (state, p) =>
    `Une plage d’exclusion ${String(p['start'])} - ${String(p['end'])} couvrait toute l’étendue « ${String(p['scopeName'])} » de ${nameOf(state, p['device'])} : plus aucune adresse libre à distribuer (étendue épuisée).`,
  repair: (_s, p) => [
    command('dhcp.removeExclusion', String(p['device']), String(p['scopeId']), Number(p['index'])),
    renew(p)
  ],
  healed: (state, p) => {
    const scope = scopeOf(state, p)
    return (
      !!scope && !scope.exclusions.some((e) => e.start === p['start'] && e.end === p['end']) && gets(state, p)
    )
  }
}
