/**
 * Panne du serveur DHCP du pare-feu pfSense (v2.10, #248, domaine `pare-feu`) : serveur désactivé, ou passerelle
 * ou serveur DNS distribués erronés. Injection et réparation : `pf.setDhcp`. Symptôme : un client en DHCP ne
 * reçoit plus de bail, ou un bail dont la passerelle / le DNS n'est pas celui du pare-feu (`ipconfig /renew`,
 * `ipconfig /all`).
 */
import { command } from '../../commands/catalog'
import type { PfIfaceKey } from '../../model/firewall'
import type { LabState } from '../../model/schema'
import { dhcpAcquire } from '../../roles/dhcp/client'
import type { FaultDef, FaultTargetParams } from '../types'
import { firstViable } from './viable'
import { firewalls, unusedNear } from './pf-common'
import { nameOf } from './net-common'

/** Bail obtenu auprès du pare-feu : passerelle et premier DNS distribués (null : pas de bail de ce serveur). */
function leaseOf(
  state: LabState,
  p: FaultTargetParams
): { gateway: string | null; dns: string | null } | null {
  const op = dhcpAcquire(state, String(p['client']), String(p['iface']))
  if (op.outcome !== 'bound') return null
  const lease = op.state.devices[String(p['client'])]?.interfaces.find((i) => i.id === p['iface'])?.dhcpLease
  if (!lease || lease.serverDeviceId !== p['device']) return null
  return { gateway: lease.gateway ?? null, dns: lease.dnsServers[0] ?? null }
}

/** Le client reçoit-il exactement les paramètres attendus ? */
function leaseOk(state: LabState, p: FaultTargetParams): boolean {
  const lease = leaseOf(state, p)
  return !!lease && lease.gateway === p['gw'] && lease.dns === p['dns']
}

const fwName = (state: LabState, p: FaultTargetParams): string => nameOf(state, p['device'], 'FW1')

export const pfDhcpOptions: FaultDef = {
  id: 'pf.dhcp-options',
  domain: 'pare-feu',
  difficulty: 2,
  title: 'Serveur DHCP du pare-feu désactivé ou mal configuré',
  pick(state, rand) {
    const candidates: FaultTargetParams[] = []
    for (const fw of firewalls(state))
      for (const key of ['lan', 'opt1'] as const) {
        const cfg = fw.pf.dhcp[key]
        if (!cfg?.enabled) continue
        for (const host of Object.values(state.devices)) {
          if (host.kind !== 'client' && host.kind !== 'server') continue
          for (const iface of host.interfaces) {
            if (iface.addressing !== 'dhcp') continue
            const op = dhcpAcquire(state, host.id, iface.id)
            const lease = op.state.devices[host.id]?.interfaces.find((i) => i.id === iface.id)?.dhcpLease
            if (op.outcome !== 'bound' || lease?.serverDeviceId !== fw.id || !lease.gateway) continue
            const base: FaultTargetParams = {
              device: fw.id,
              client: host.id,
              iface: iface.id,
              service: `dhcp:${key}`,
              key,
              clientName: host.name,
              gw: lease.gateway,
              dns: lease.dnsServers[0] ?? '',
              origGateway: cfg.gateway ?? '',
              origDns: cfg.dnsServers.join(',')
            }
            candidates.push({ ...base, variant: 'disabled' })
            const wrong = unusedNear(state, lease.gateway)
            if (wrong) {
              candidates.push({ ...base, variant: 'gateway', wrong })
              if (lease.dnsServers.length > 0) candidates.push({ ...base, variant: 'dns', wrong })
            }
          }
        }
      }
    return firstViable(state, rand, candidates, pfDhcpOptions)
  },
  inject(_s, p) {
    const key = p['key'] as PfIfaceKey
    const patch =
      p['variant'] === 'disabled'
        ? { enabled: false }
        : p['variant'] === 'gateway'
          ? { gateway: String(p['wrong']) }
          : { dnsServers: [String(p['wrong'])] }
    return [command('pf.setDhcp', String(p['device']), key, patch)]
  },
  symptomVisible: (state, p) => !leaseOk(state, p),
  ticket: (state, p) =>
    p['variant'] === 'disabled'
      ? `${String(p['clientName'])} n’obtient plus d’adresse (ipconfig /renew échoue) depuis que le réseau a redémarré ; ${fwName(state, p)} est allumé.`
      : `${String(p['clientName'])} obtient une adresse mais n’accède plus à Internet ni aux noms (ipconfig /renew a réussi).`,
  hints: (state, p) => [
    p['variant'] === 'disabled'
      ? `${String(p['clientName'])} n’a pas de bail : ipconfig /renew ne reçoit aucune offre.`
      : `${String(p['clientName'])} a bien une adresse du bon réseau, mais ses paramètres (ipconfig /all) ne sont pas ceux attendus.`,
    `Le serveur DHCP est celui du pare-feu : consultez Services > DHCP Server de ${fwName(state, p)}, onglet de l’interface concernée.`,
    p['variant'] === 'disabled'
      ? `Vérifiez que le serveur est activé sur l’interface et que la plage est renseignée.`
      : `Comparez la passerelle et le serveur DNS distribués avec l’adresse du pare-feu sur cette interface.`
  ],
  cause: (state, p) =>
    p['variant'] === 'disabled'
      ? `Le serveur DHCP de l’interface ${String(p['key']).toUpperCase()} de ${fwName(state, p)} était désactivé : aucun client ne recevait de bail.`
      : p['variant'] === 'gateway'
        ? `Le serveur DHCP de ${fwName(state, p)} distribuait la passerelle ${String(p['wrong'])} (aucune machine) au lieu de ${String(p['gw'])} : les clients ne pouvaient pas sortir de leur réseau.`
        : `Le serveur DHCP de ${fwName(state, p)} distribuait le serveur DNS ${String(p['wrong'])} (aucune machine) au lieu de ${String(p['dns'])} : les noms ne se résolvaient plus.`,
  repair(_s, p) {
    const key = p['key'] as PfIfaceKey
    const patch =
      p['variant'] === 'disabled'
        ? { enabled: true }
        : p['variant'] === 'gateway'
          ? { gateway: String(p['origGateway']) === '' ? null : String(p['origGateway']) }
          : { dnsServers: String(p['origDns']) === '' ? [] : String(p['origDns']).split(',') }
    return [command('pf.setDhcp', String(p['device']), key, patch)]
  },
  healed: (state, p) => leaseOk(state, p)
}
