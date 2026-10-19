/**
 * Panne `net.acl-blocking` : une liste d'accès étendue appliquée en entrée d'une interface de routeur
 * Cisco bloque le ping d'un réseau vers un hôte. Le symptôme est celui de `ping` (sans réponse) ; la
 * cause se lit avec `show access-lists` (compteurs de correspondances) et `show ip interface`.
 * Injection et réparation sont des lignes saisies à la console IOS (`shell.exec`).
 */
import { iosState } from '../../ios/config'
import { isIos } from '../../ios/device'
import type { LabState } from '../../model/schema'
import { effectiveIpv4 } from '../../net/addressing'
import { networkAddress, prefixToMaskInt, formatIpv4, sameSubnet } from '../../net/ipv4'
import type { FaultDef, FaultTargetParams } from '../types'
import { firstVisible, iosCommands, nameOf, pingOk, poweredHosts } from './net-common'

const ID = 'net.acl-blocking'

/** Nom de la liste posée par la panne. */
const ACL_NAME = 'FILTRE-ENTRANT'

const peerAnswers = (state: LabState, p: FaultTargetParams): boolean =>
  pingOk(state, String(p['host']), String(p['peer']))

/** Liste d'accès appliquée en entrée de l'interface ciblée. */
function appliedAcl(state: LabState, p: FaultTargetParams): string | null {
  const device = state.devices[String(p['router'])]
  return isIos(device) ? (iosState(device).interfaces[String(p['portName'])]?.aclIn ?? null) : null
}

/** Masque générique (inverse du masque) d'un préfixe. */
const wildcardOf = (prefix: number): string => formatIpv4((~prefixToMaskInt(prefix) >>> 0) as number)

export const aclBlocking: FaultDef = {
  id: ID,
  domain: 'reseau',
  difficulty: 2,
  title: 'Liste d’accès bloquante sur une interface',

  pick(state, rand) {
    const hosts = poweredHosts(state)
    const candidates: FaultTargetParams[] = []
    for (const router of Object.values(state.devices)) {
      if (!isIos(router) || router.kind !== 'router' || !router.powered) continue
      const ios = iosState(router)
      if (ios.acls.some((a) => a.name === ACL_NAME)) continue
      for (const iface of router.interfaces) {
        const eff = effectiveIpv4(iface)
        if (!eff || ios.interfaces[iface.name]?.aclIn) continue
        for (const host of hosts) {
          const he = host.interfaces
            .map((i) => effectiveIpv4(i))
            .find((e) => e && sameSubnet(e.address, eff.address, eff.prefixLength))
          if (!he) continue
          for (const other of hosts) {
            if (other.id === host.id) continue
            for (const o of other.interfaces) {
              const oe = effectiveIpv4(o)
              if (!oe || sameSubnet(oe.address, eff.address, eff.prefixLength)) continue
              candidates.push({
                router: router.id,
                portName: iface.name,
                host: host.id,
                peer: oe.address,
                peerName: other.name,
                network: networkAddress(eff.address, eff.prefixLength),
                wildcard: wildcardOf(eff.prefixLength)
              })
            }
          }
        }
      }
    }
    return firstVisible(aclBlocking, state, candidates, rand)
  },

  inject: (state, p) =>
    iosCommands(state, String(p['router']), [
      'enable',
      'configure terminal',
      `ip access-list extended ${ACL_NAME}`,
      `deny icmp ${String(p['network'])} ${String(p['wildcard'])} host ${String(p['peer'])}`,
      'permit ip any any',
      'exit',
      `interface ${String(p['portName'])}`,
      `ip access-group ${ACL_NAME} in`,
      'end'
    ]),

  symptomVisible: (state, p) => appliedAcl(state, p) === ACL_NAME && !peerAnswers(state, p),

  ticket: (state, p) =>
    `${nameOf(state, p['host'], 'Un poste')} n’arrive plus à joindre ${String(p['peerName'])} (ping sans réponse), alors que les autres destinations répondent normalement.`,

  hints: (state, p) => [
    `Depuis ${nameOf(state, p['host'], 'le poste')}, ${String(p['peerName'])} ne répond pas mais d’autres hôtes si : suivez le chemin avec tracert.`,
    `Le chemin traverse ${nameOf(state, p['router'], 'un routeur')} : un filtrage y est-il appliqué ? Regardez les interfaces (show ip interface).`,
    `Affichez les listes d’accès (show access-lists) : quelle ligne a des correspondances, et sur quelle interface et dans quel sens la liste est-elle appliquée ?`
  ],

  cause: (state, p) =>
    `La liste d’accès ${ACL_NAME} (deny icmp ${String(p['network'])} → ${String(p['peer'])}) était appliquée en entrée de ${String(p['portName'])} sur ${nameOf(state, p['router'], 'le routeur')}.`,

  repair: (state, p) =>
    iosCommands(state, String(p['router']), [
      'enable',
      'configure terminal',
      `interface ${String(p['portName'])}`,
      `no ip access-group ${ACL_NAME} in`,
      'exit',
      `no ip access-list extended ${ACL_NAME}`,
      'end'
    ]),

  healed: (state, p) => appliedAcl(state, p) !== ACL_NAME && peerAnswers(state, p)
}
