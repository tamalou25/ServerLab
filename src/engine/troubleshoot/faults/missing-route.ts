/**
 * Panne `net.missing-route` : une route statique manque sur un routeur (`net.removeStaticRoute`). Les
 * paquets vers ce réseau sont rejetés ou perdus : `ping` répond « Impossible de joindre le réseau de
 * destination » ou n'aboutit pas, `tracert` s'arrête au routeur, `show ip route` ne liste plus la route.
 * Réparation : la route est rajoutée (`net.addStaticRoute`). Aucune sortie de console nouvelle.
 */
import { command } from '../../commands/catalog'
import type { LabState } from '../../model/schema'
import { effectiveIpv4 } from '../../net/addressing'
import { prefixToMask } from '../../net/ipv4'
import type { FaultDef, FaultTargetParams } from '../types'
import { firstVisible, nameOf, pingOk, poweredHosts } from './net-common'

const ID = 'net.missing-route'

const peerAnswers = (state: LabState, p: FaultTargetParams): boolean =>
  pingOk(state, String(p['host']), String(p['peer']))

/** Rang de la route ciblée dans la table du routeur (-1 : absente). */
function routeIndex(state: LabState, p: FaultTargetParams): number {
  const router = state.devices[String(p['router'])]
  if (router?.kind !== 'router') return -1
  return router.routes.findIndex(
    (r) => r.network === p['network'] && r.prefixLength === p['prefix'] && r.nextHop === p['nextHop']
  )
}

const label = (p: FaultTargetParams): string => `${String(p['network'])}/${String(p['prefix'])}`

export const missingRoute: FaultDef = {
  id: ID,
  domain: 'reseau',
  difficulty: 2,
  title: 'Route statique manquante',

  pick(state, rand) {
    const hosts = poweredHosts(state)
    const candidates: FaultTargetParams[] = []
    for (const router of Object.values(state.devices)) {
      if (router.kind !== 'router' || !router.powered) continue
      for (const route of router.routes)
        for (const host of hosts)
          for (const other of hosts) {
            if (other.id === host.id) continue
            for (const o of other.interfaces) {
              const oe = effectiveIpv4(o)
              if (!oe) continue
              candidates.push({
                router: router.id,
                network: route.network,
                prefix: route.prefixLength,
                nextHop: route.nextHop,
                host: host.id,
                peer: oe.address,
                peerName: other.name
              })
            }
          }
    }
    return firstVisible(missingRoute, state, candidates, rand)
  },

  inject(state, p) {
    const index = routeIndex(state, p)
    return index < 0 ? [] : [command('net.removeStaticRoute', String(p['router']), index)]
  },

  symptomVisible: (state, p) => routeIndex(state, p) < 0 && !peerAnswers(state, p),

  ticket: (state, p) =>
    `${nameOf(state, p['host'], 'Un poste')} ne joint plus ${String(p['peerName'])}, qui se trouve dans un réseau distant. Les ressources du réseau local restent accessibles.`,

  hints: (state, p) => [
    `Lancez un tracert depuis ${nameOf(state, p['host'], 'le poste')} vers ${String(p['peerName'])} : jusqu’à quel équipement le chemin va-t-il ?`,
    `Le paquet s’arrête sur ${nameOf(state, p['router'], 'un routeur')} : examinez sa table de routage (show ip route).`,
    `Le routeur sait-il joindre le réseau de ${String(p['peerName'])} ? Comparez sa table avec les réseaux qu’il doit desservir.`
  ],

  cause: (state, p) =>
    `La route statique vers ${label(p)} via ${String(p['nextHop'])} avait été supprimée de ${nameOf(state, p['router'], 'le routeur')}.`,

  repair: (_state, p) => [
    command('net.addStaticRoute', String(p['router']), {
      network: String(p['network']),
      mask: prefixToMask(Number(p['prefix'])),
      nextHop: String(p['nextHop'])
    })
  ],

  healed: (state, p) => routeIndex(state, p) >= 0 && peerAnswers(state, p)
}
