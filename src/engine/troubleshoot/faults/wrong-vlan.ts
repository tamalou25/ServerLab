/**
 * Panne `net.wrong-vlan` : un port d'accès de switch est affecté au mauvais VLAN (`net.setSwitchport`).
 * Le poste branché se retrouve isolé de son réseau : le ping vers ses voisins et sa passerelle
 * n'aboutit plus (symptôme de `ping` ; la configuration se lit avec `show vlan`). Aucune sortie nouvelle.
 */
import { command } from '../../commands/catalog'
import type { LabState, NetInterface } from '../../model/schema'
import { effectiveIpv4 } from '../../net/addressing'
import { switchportOf } from '../../net/switchport'
import { linkOnInterface, otherEnd } from '../../topology/queries'
import type { FaultDef, FaultTargetParams } from '../types'
import { firstVisible, nameOf, pingOk, poweredHosts } from './net-common'

const ID = 'net.wrong-vlan'

function port(state: LabState, p: FaultTargetParams): { name: string; iface: NetInterface } | null {
  const device = state.devices[String(p['switch'])]
  const iface = device?.interfaces.find((i) => i.id === p['iface'])
  return device && iface ? { name: device.name, iface } : null
}

const peerAnswers = (state: LabState, p: FaultTargetParams): boolean =>
  pingOk(state, String(p['host']), String(p['peer']))

/** Port d'accès remis dans le VLAN donné (reste de sa configuration inchangé). */
function setVlan(state: LabState, p: FaultTargetParams, vlan: number): ReturnType<FaultDef['inject']> {
  const t = port(state, p)
  if (!t) return []
  const sp = switchportOf(t.iface)
  return [
    command('net.setSwitchport', String(p['switch']), String(p['iface']), {
      mode: 'access',
      accessVlan: vlan,
      nativeVlan: sp.nativeVlan,
      allowedVlans: sp.allowedVlans
    })
  ]
}

export const wrongVlan: FaultDef = {
  id: ID,
  domain: 'reseau',
  difficulty: 2,
  title: 'Port d’accès dans le mauvais VLAN',

  pick(state, rand) {
    const hosts = poweredHosts(state)
    const candidates: FaultTargetParams[] = []
    for (const sw of Object.values(state.devices)) {
      if (sw.kind !== 'switch' || !sw.powered) continue
      for (const iface of sw.interfaces) {
        const sp = switchportOf(iface)
        if (sp.mode !== 'access') continue
        const link = linkOnInterface(state, sw.id, iface.id)
        if (!link) continue
        const end = otherEnd(link, sw.id, iface.id)
        const host = hosts.find((h) => h.id === end.deviceId)
        if (!host) continue
        for (const vlan of sw.vlans) {
          if (vlan.id === sp.accessVlan) continue
          for (const other of hosts) {
            if (other.id === host.id) continue
            for (const o of other.interfaces) {
              const oe = effectiveIpv4(o)
              if (!oe) continue
              candidates.push({
                switch: sw.id,
                iface: iface.id,
                host: host.id,
                peer: oe.address,
                peerName: other.name,
                original: sp.accessVlan,
                wrong: vlan.id
              })
            }
          }
        }
      }
    }
    return firstVisible(wrongVlan, state, candidates, rand)
  },

  inject: (state, p) => setVlan(state, p, Number(p['wrong'])),

  symptomVisible: (state, p) => !peerAnswers(state, p),

  ticket: (state, p) =>
    `${nameOf(state, p['host'], 'Un poste')} est branché comme d’habitude mais ne joint plus ${String(p['peerName'])} : il semble seul sur le réseau.`,

  hints: (state, p) => [
    `Depuis ${nameOf(state, p['host'], 'le poste')}, ni ${String(p['peerName'])} ni sa passerelle ne répondent au ping, alors que sa configuration IP est cohérente.`,
    `Le problème n’est pas sur le poste : regardez le switch ${nameOf(state, p['switch'], 'du réseau')}, au port où il est branché.`,
    `Affichez les VLAN du switch (show vlan) : à quel VLAN appartient le port du poste, comparé à celui de ses voisins ?`
  ],

  cause: (state, p) =>
    `Le port ${port(state, p)?.iface.name ?? ''} de ${nameOf(state, p['switch'], 'le switch')} était dans le VLAN ${String(p['wrong'])} au lieu du VLAN ${String(p['original'])}.`,

  repair: (state, p) => setVlan(state, p, Number(p['original'])),

  healed(state, p) {
    const t = port(state, p)
    return !!t && switchportOf(t.iface).accessVlan === p['original'] && peerAnswers(state, p)
  }
}
