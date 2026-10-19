/**
 * Panne `net.cable-unplugged` : le câble d'un poste est débranché (`topology.disconnect`). Le lien est
 * tombé : `ipconfig` indique « Média déconnecté » et le ping n'aboutit plus. Réparation : rebrancher le
 * câble aux mêmes ports (`topology.connect`). Aucune sortie de console nouvelle.
 */
import { command } from '../../commands/catalog'
import type { LabState, Link } from '../../model/schema'
import { effectiveIpv4 } from '../../net/addressing'
import type { FaultDef, FaultTargetParams } from '../types'
import { firstVisible, nameOf, pingOk, poweredHosts } from './net-common'

const ID = 'net.cable-unplugged'

/** Câble qui relie encore les deux ports d'origine (dans un sens ou dans l'autre). */
function linkOf(state: LabState, p: FaultTargetParams): Link | undefined {
  const a = [String(p['aDevice']), String(p['aIface'])]
  const b = [String(p['bDevice']), String(p['bIface'])]
  const same = (e: { deviceId: string; ifaceId: string }, x: string[]) =>
    e.deviceId === x[0] && e.ifaceId === x[1]
  return Object.values(state.links).find(
    (l) => (same(l.a, a) && same(l.b, b)) || (same(l.a, b) && same(l.b, a))
  )
}

const peerAnswers = (state: LabState, p: FaultTargetParams): boolean =>
  pingOk(state, String(p['device']), String(p['peer']))

export const cableUnplugged: FaultDef = {
  id: ID,
  domain: 'reseau',
  difficulty: 1,
  title: 'Câble réseau débranché',

  pick(state, rand) {
    const hosts = poweredHosts(state)
    const candidates: FaultTargetParams[] = []
    for (const link of Object.values(state.links)) {
      if (link.virtual) continue
      for (const end of [link.a, link.b]) {
        const host = hosts.find((h) => h.id === end.deviceId)
        if (!host) continue
        const iface = host.interfaces.find((i) => i.id === end.ifaceId)
        if (!iface) continue
        for (const other of hosts) {
          if (other.id === host.id) continue
          for (const o of other.interfaces) {
            const oe = effectiveIpv4(o)
            if (!oe) continue
            candidates.push({
              device: host.id,
              aDevice: link.a.deviceId,
              aIface: link.a.ifaceId,
              bDevice: link.b.deviceId,
              bIface: link.b.ifaceId,
              port: iface.name,
              peer: oe.address,
              peerName: other.name
            })
          }
        }
      }
    }
    return firstVisible(cableUnplugged, state, candidates, rand)
  },

  inject(state, p) {
    const link = linkOf(state, p)
    return link ? [command('topology.disconnect', link.id)] : []
  },

  symptomVisible: (state, p) => !linkOf(state, p) && !peerAnswers(state, p),

  ticket: (state, p) =>
    `${nameOf(state, p['device'], 'Un poste')} n’a plus aucun accès au réseau : plus de partage, plus de ${String(p['peerName'])}. L’ordinateur, lui, est bien allumé.`,

  hints: (state, p) => [
    `Sur ${nameOf(state, p['device'], 'le poste')}, lisez l’état de la carte réseau (ipconfig) : que dit-elle du média ?`,
    `Le problème est avant tout physique : observez la topologie autour de ${nameOf(state, p['device'], 'le poste')}.`,
    `Une liaison manque entre ${nameOf(state, p['device'], 'le poste')} et le reste du réseau : cherchez le port qui n’est plus relié.`
  ],

  cause: (state, p) =>
    `Le câble de ${nameOf(state, p['device'], 'le poste')} (${String(p['port'])}) était débranché : le lien était tombé.`,

  repair: (_state, p) => [
    command(
      'topology.connect',
      { deviceId: String(p['aDevice']), ifaceId: String(p['aIface']) },
      { deviceId: String(p['bDevice']), ifaceId: String(p['bIface']) }
    )
  ],

  healed: (state, p) => !!linkOf(state, p) && peerAnswers(state, p)
}
