/**
 * Panne `net.wrong-gateway` : passerelle par défaut erronée sur une carte statique (une adresse du bon
 * réseau, mais qui n'est pas celle du routeur). L'ordinateur joint son réseau local, pas les autres :
 * le ping vers un hôte distant reste sans réponse. Aucune sortie de console nouvelle (`ping`, `ipconfig`).
 */
import { command } from '../../commands/catalog'
import type { LabState } from '../../model/schema'
import { effectiveIpv4 } from '../../net/addressing'
import { formatIpv4, hostAddressError, parseIpv4, sameSubnet } from '../../net/ipv4'
import type { FaultDef, FaultTargetParams } from '../types'
import { firstVisible, nameOf, pingOk, poweredHosts, staticIpv4Input } from './net-common'

const ID = 'net.wrong-gateway'

function target(state: LabState, p: FaultTargetParams) {
  const device = state.devices[String(p['device'])]
  const iface = device?.interfaces.find((i) => i.id === p['iface'])
  return device && iface ? { name: device.name, iface } : null
}

const peerAnswers = (state: LabState, p: FaultTargetParams): boolean =>
  pingOk(state, String(p['device']), String(p['peer']))

/** Passerelle forcée sur la carte (le reste de sa configuration est inchangé). */
function setGateway(state: LabState, p: FaultTargetParams, gateway: string): ReturnType<FaultDef['inject']> {
  const t = target(state, p)
  if (!t) return []
  return [
    command(
      'net.setInterfaceIpv4',
      String(p['device']),
      String(p['iface']),
      staticIpv4Input(t.iface, { gateway })
    )
  ]
}

/** Adresse libre du réseau, la plus haute possible, qui n'est portée par aucune carte du lab. */
function freeAddress(state: LabState, address: string, prefix: number): string | null {
  const used = new Set<string>()
  for (const d of Object.values(state.devices))
    for (const i of d.interfaces) {
      const eff = effectiveIpv4(i)
      if (eff) used.add(eff.address)
    }
  const base = parseIpv4(address)
  if (base === null) return null
  const hostBits = 32 - prefix
  if (hostBits < 3) return null
  const top = ((base >>> hostBits) << hostBits) >>> 0
  for (let host = 2 ** hostBits - 2; host >= 1; host--) {
    const candidate = formatIpv4((top + host) >>> 0)
    if (!used.has(candidate) && !hostAddressError(candidate, prefix)) return candidate
  }
  return null
}

export const wrongGateway: FaultDef = {
  id: ID,
  domain: 'reseau',
  difficulty: 1,
  title: 'Passerelle par défaut erronée',

  pick(state, rand) {
    const hosts = poweredHosts(state)
    const candidates: FaultTargetParams[] = []
    for (const device of hosts)
      for (const iface of device.interfaces) {
        const eff = effectiveIpv4(iface)
        if (!eff || eff.source !== 'static' || !eff.gateway) continue
        const wrong = freeAddress(state, eff.address, eff.prefixLength)
        if (!wrong) continue
        for (const other of hosts) {
          if (other.id === device.id) continue
          for (const o of other.interfaces) {
            const oe = effectiveIpv4(o)
            // Un hôte d'un AUTRE réseau : le trafic doit passer par la passerelle
            if (!oe || sameSubnet(eff.address, oe.address, eff.prefixLength)) continue
            candidates.push({
              device: device.id,
              iface: iface.id,
              peer: oe.address,
              peerName: other.name,
              original: eff.gateway,
              wrong
            })
          }
        }
      }
    return firstVisible(wrongGateway, state, candidates, rand)
  },

  inject: (state, p) => setGateway(state, p, String(p['wrong'])),

  symptomVisible: (state, p) => !peerAnswers(state, p),

  ticket: (state, p) =>
    `${nameOf(state, p['device'], 'Un poste')} fonctionne avec ses voisins du bureau mais n’atteint plus ${String(p['peerName'])}, situé dans un autre réseau.`,

  hints: (state, p) => [
    `Depuis ${nameOf(state, p['device'], 'le poste')}, testez un voisin du même réseau, puis ${String(p['peerName'])} : seul le second reste sans réponse.`,
    `Le trafic vers les autres réseaux passe par un routeur : examinez la configuration IP de la carte de ${nameOf(state, p['device'], 'le poste')}.`,
    `Comparez la passerelle par défaut de ${nameOf(state, p['device'], 'le poste')} avec l’adresse réellement portée par l’interface du routeur dans son réseau.`
  ],

  cause: (state, p) =>
    `La passerelle par défaut de ${nameOf(state, p['device'], 'la carte')} était ${String(p['wrong'])} (aucun routeur) au lieu de ${String(p['original'])}.`,

  repair: (state, p) => setGateway(state, p, String(p['original'])),

  healed(state, p) {
    const t = target(state, p)
    return !!t && t.iface.gateway === p['original'] && peerAnswers(state, p)
  }
}
