/**
 * Pannes de NAT et de routage du pare-feu pfSense (v2.10, #248, domaine `pare-feu`) : redirection de port vers
 * la mauvaise adresse ou le mauvais port, NAT sortant désactivé, passerelle par défaut absente.
 * Injection et réparation : commandes `pf.updatePortForward`, `pf.setNatMode`, `pf.removeGateway` / `pf.setGateway`.
 * Symptôme : la sonde (connexion depuis Internet vers l'adresse WAN, ping d'un poste interne vers l'extérieur)
 * n'aboutit plus ; la table d'états et la trace du paquet le montrent (Diagnostics > States).
 */
import { command } from '../../commands/catalog'
import type { PfIfaceKey } from '../../model/firewall'
import type { LabState } from '../../model/schema'
import { inNetwork } from '../../net/ipv4'
import { nicOf, type PfDevice } from '../../net/pf'
import { pfProbe } from '../../net/pf-probe'
import { effectiveIpv4 } from '../../net/addressing'
import type { FaultDef, FaultTargetParams } from '../types'
import { firstViable } from './viable'
import {
  describeFlow,
  describeProbe,
  firewalls,
  firstWorking,
  hostsWithIp,
  probeParams,
  probeWorks,
  unusedNear,
  wanAddress,
  zoneOf,
  type Probe
} from './pf-common'
import { nameOf } from './net-common'

const fwName = (state: LabState, p: FaultTargetParams): string => nameOf(state, p['device'], 'FW1')

const outsideTicket = (state: LabState, p: FaultTargetParams): string =>
  `Depuis ce matin, ${describeProbe(p)} n’aboutit plus depuis ${String(p['fromName'])}, alors que ça fonctionnait hier. Le pare-feu ${fwName(state, p)} est allumé.`

// --- Redirection de port vers la mauvaise cible --------------------------------------------------------

export const pfForwardTarget: FaultDef = {
  id: 'pf.forward-target',
  domain: 'pare-feu',
  difficulty: 2,
  title: 'Redirection de port vers la mauvaise adresse ou le mauvais port',
  pick(state, rand) {
    const candidates: FaultTargetParams[] = []
    for (const fw of firewalls(state)) {
      const wan = wanAddress(fw)
      if (!wan) continue
      for (const fwd of fw.pf.nat.portForwards) {
        if (fwd.disabled || fwd.iface !== 'wan' || !fwd.destinationPort || fwd.protocol === 'udp') continue
        const probe: Probe | null = firstWorking(
          state,
          hostsWithIp(state)
            .filter((h) => zoneOf(fw, h.ip) === 'wan')
            .map((h) => ({
              from: h.host.id,
              dst: wan,
              protocol: 'tcp' as const,
              port: fwd.destinationPort!.from
            }))
        )
        if (!probe) continue
        const target =
          hostsWithIp(state).find((h) => h.ip === fwd.targetAddress)?.host.name ?? fwd.targetAddress
        const base = {
          device: fw.id,
          service: `forward:${fwd.id}`,
          forward: fwd.id,
          target,
          origAddress: fwd.targetAddress,
          origPort: fwd.targetPort ?? 0,
          ...probeParams(state, probe, `l’adresse WAN ${wan}`)
        }
        const wrongAddress = unusedNear(state, fwd.targetAddress)
        if (wrongAddress) candidates.push({ ...base, variant: 'ip', wrongAddress })
        candidates.push({
          ...base,
          variant: 'port',
          wrongPort: (fwd.targetPort ?? fwd.destinationPort.from) === 8080 ? 8081 : 8080
        })
      }
    }
    return firstViable(state, rand, candidates, pfForwardTarget)
  },
  inject: (_s, p) => [
    command(
      'pf.updatePortForward',
      String(p['device']),
      String(p['forward']),
      p['variant'] === 'ip'
        ? { targetAddress: String(p['wrongAddress']) }
        : { targetPort: Number(p['wrongPort']) }
    )
  ],
  symptomVisible: (state, p) => !probeWorks(state, p),
  ticket: outsideTicket,
  hints: (_state, p) => [
    `Le site publié ne répond plus depuis l’extérieur (${describeFlow(p)}), alors que ${String(p['target'])} fonctionne depuis le LAN.`,
    `Le paquet atteint le pare-feu : regardez la traduction de la redirection (Firewall > NAT > Port Forward, Diagnostics > States) et où elle envoie le trafic.`,
    `Comparez l’adresse IP et le port cibles de la redirection avec ceux du serveur réellement joint.`
  ],
  cause: (state, p) =>
    p['variant'] === 'ip'
      ? `La redirection de port de ${fwName(state, p)} visait ${String(p['wrongAddress'])} au lieu de ${String(p['origAddress'])} (${String(p['target'])}) : aucune machine ne répondait à cette adresse.`
      : `La redirection de port de ${fwName(state, p)} visait le port ${String(p['wrongPort'])} de ${String(p['target'])} : aucun service n’y écoutait.`,
  repair: (_s, p) => [
    command(
      'pf.updatePortForward',
      String(p['device']),
      String(p['forward']),
      p['variant'] === 'ip'
        ? { targetAddress: String(p['origAddress']) }
        : { targetPort: Number(p['origPort']) > 0 ? Number(p['origPort']) : null }
    )
  ],
  healed: (state, p) => probeWorks(state, p)
}

// --- NAT sortant désactivé -----------------------------------------------------------------------------

/** Couples (ordinateur d'une zone interne, ordinateur au-delà du WAN) dont un ping aboutit dans l'état sain. */
function insideToOutside(state: LabState, fw: PfDevice): Probe[] {
  const hosts = hostsWithIp(state)
  const outside = hosts.filter((h) => zoneOf(fw, h.ip) === 'wan')
  return hosts
    .filter((h) => zoneOf(fw, h.ip) !== 'wan')
    .flatMap((inside) => outside.map((o) => ({ from: inside.host.id, dst: o.ip, protocol: 'icmp' as const })))
    .filter((c) => pfProbe(state, c.from, c.dst, c.protocol))
}

const hostNamed = (state: LabState, ip: string): string =>
  hostsWithIp(state).find((h) => h.ip === ip)?.host.name ?? ip

export const pfNatDisabled: FaultDef = {
  id: 'pf.nat-disabled',
  domain: 'pare-feu',
  difficulty: 2,
  title: 'NAT sortant désactivé',
  pick(state, rand) {
    const candidates: FaultTargetParams[] = []
    for (const fw of firewalls(state)) {
      const mode = fw.pf.nat.outboundMode
      if (mode === 'disabled') continue
      for (const probe of insideToOutside(state, fw)) {
        const base = {
          device: fw.id,
          service: 'nat',
          orig: mode,
          ...probeParams(state, probe, hostNamed(state, probe.dst))
        }
        candidates.push({ ...base, mode: 'disabled' })
        if (mode !== 'manual') candidates.push({ ...base, mode: 'manual' })
      }
    }
    return firstViable(state, rand, candidates, pfNatDisabled)
  },
  inject: (_s, p) => [command('pf.setNatMode', String(p['device']), p['mode'] as 'disabled' | 'manual')],
  symptomVisible: (state, p) => !probeWorks(state, p),
  ticket: outsideTicket,
  hints: (state, p) => [
    `${describeFlow(p)} n’aboutit pas, alors que la liaison avec le fournisseur est active et que les règles du pare-feu laissent sortir ce trafic.`,
    `Le destinataire reçoit-il le paquet avec une adresse publique ? Observez la source du paquet à la sortie du WAN (trace du ping, Diagnostics > States).`,
    `Les réseaux privés doivent être traduits en l’adresse du WAN avant de sortir : examinez le mode de NAT sortant (Firewall > NAT > Outbound) de ${fwName(state, p)}.`
  ],
  cause: (state, p) =>
    p['mode'] === 'disabled'
      ? `Le NAT sortant de ${fwName(state, p)} était désactivé : les paquets sortaient avec une adresse privée en source et le destinataire ne savait pas répondre.`
      : `Le NAT sortant de ${fwName(state, p)} était en mode manuel sans règle : aucun réseau privé n’était traduit en sortie.`,
  repair: (_s, p) => [
    command('pf.setNatMode', String(p['device']), String(p['orig']) as 'automatic' | 'hybrid' | 'manual')
  ],
  healed: (state, p) => probeWorks(state, p)
}

// --- Passerelle par défaut absente ---------------------------------------------------------------------

export const pfNoDefaultGateway: FaultDef = {
  id: 'pf.no-default-gateway',
  domain: 'pare-feu',
  difficulty: 2,
  title: 'Passerelle par défaut du pare-feu absente',
  pick(state, rand) {
    const candidates: FaultTargetParams[] = []
    for (const fw of firewalls(state)) {
      const gateway = fw.pf.gateways.find((g) => g.isDefault)
      if (!gateway) continue
      const wan = nicOf(fw, 'wan')
      const wanEff = wan ? effectiveIpv4(wan) : null
      for (const probe of insideToOutside(state, fw)) {
        // Seules les destinations au-delà de la passerelle (hors réseau du WAN) dépendent de la route par défaut
        if (wanEff && inNetwork(probe.dst, wanEff.address, wanEff.prefixLength)) continue
        candidates.push({
          device: fw.id,
          service: 'gateway',
          gateway: gateway.name,
          gatewayIface: gateway.iface satisfies PfIfaceKey,
          gatewayAddress: gateway.address,
          ...probeParams(state, probe, hostNamed(state, probe.dst))
        })
      }
    }
    return firstViable(state, rand, candidates, pfNoDefaultGateway)
  },
  inject: (_s, p) => [command('pf.removeGateway', String(p['device']), String(p['gateway']))],
  symptomVisible: (state, p) => !probeWorks(state, p),
  ticket: outsideTicket,
  hints: (state, p) => [
    `${describeFlow(p)} n’aboutit pas ; le réseau du fournisseur directement connecté au WAN répond encore.`,
    `Le pare-feu sait-il vers où envoyer les paquets destinés à un réseau qu’il ne connaît pas ? Consultez System > Routing et Diagnostics > Routes.`,
    `Sans route par défaut, tout ce qui n’est pas directement connecté est abandonné : vérifiez les passerelles de ${fwName(state, p)}.`
  ],
  cause: (state, p) =>
    `La passerelle ${String(p['gateway'])} (${String(p['gatewayAddress'])}), passerelle par défaut de ${fwName(state, p)}, avait été supprimée : sans route par défaut, ${describeFlow(p)} n’avait aucun chemin.`,
  repair: (_s, p) => [
    command('pf.setGateway', String(p['device']), {
      name: String(p['gateway']),
      iface: p['gatewayIface'] as PfIfaceKey,
      address: String(p['gatewayAddress']),
      isDefault: true
    })
  ],
  healed: (state, p) => probeWorks(state, p)
}

export const PF_NAT_FAULTS: readonly FaultDef[] = [pfForwardTarget, pfNatDisabled, pfNoDefaultGateway]
