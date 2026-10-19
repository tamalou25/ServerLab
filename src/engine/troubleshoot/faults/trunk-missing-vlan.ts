/**
 * Panne `net.trunk-missing-vlan` : un VLAN est retiré de la liste autorisée d'un trunk
 * (`net.setSwitchport`, équivalent de `switchport trunk allowed vlan`). Les postes de ce VLAN ne
 * franchissent plus la liaison : le ping n'aboutit plus (la liste se lit avec
 * `show interfaces trunk`). Aucune sortie de console nouvelle.
 */
import { command } from '../../commands/catalog'
import type { LabState, NetInterface } from '../../model/schema'
import { effectiveIpv4 } from '../../net/addressing'
import { switchportOf, trunkAllows } from '../../net/switchport'
import type { FaultDef, FaultTargetParams } from '../types'
import { firstVisible, nameOf, pingOk, poweredHosts } from './net-common'

const ID = 'net.trunk-missing-vlan'

function port(state: LabState, p: FaultTargetParams): { name: string; iface: NetInterface } | null {
  const device = state.devices[String(p['switch'])]
  const iface = device?.interfaces.find((i) => i.id === p['iface'])
  return device && iface ? { name: device.name, iface } : null
}

const peerAnswers = (state: LabState, p: FaultTargetParams): boolean =>
  pingOk(state, String(p['host']), String(p['peer']))

/** Liste autorisée mémorisée dans les cibles : « all » (tous les VLAN) ou « 10,20 ». */
function parseAllowed(text: string): number[] | null {
  return text === 'all' ? null : text.split(',').map(Number)
}

/** Trunk reconfiguré avec la liste donnée (mode, VLAN natif inchangés). */
function setAllowed(
  state: LabState,
  p: FaultTargetParams,
  allowed: number[] | null
): ReturnType<FaultDef['inject']> {
  const t = port(state, p)
  if (!t) return []
  const sp = switchportOf(t.iface)
  return [
    command('net.setSwitchport', String(p['switch']), String(p['iface']), {
      mode: 'trunk',
      accessVlan: sp.accessVlan,
      nativeVlan: sp.nativeVlan,
      allowedVlans: allowed
    })
  ]
}

export const trunkMissingVlan: FaultDef = {
  id: ID,
  domain: 'reseau',
  difficulty: 2,
  title: 'VLAN retiré de la liste autorisée d’un trunk',

  pick(state, rand) {
    const hosts = poweredHosts(state)
    const candidates: FaultTargetParams[] = []
    for (const sw of Object.values(state.devices)) {
      if (sw.kind !== 'switch' || !sw.powered) continue
      for (const iface of sw.interfaces) {
        const sp = switchportOf(iface)
        if (sp.mode !== 'trunk') continue
        for (const vlan of sw.vlans) {
          if (vlan.id === sp.nativeVlan || !trunkAllows(sp, vlan.id)) continue
          const rest = (sp.allowedVlans ?? sw.vlans.map((v) => v.id)).filter((v) => v !== vlan.id)
          if (rest.length === 0) continue
          for (const host of hosts)
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
                  vlan: vlan.id,
                  original: sp.allowedVlans ? sp.allowedVlans.join(',') : 'all',
                  restricted: rest.join(',')
                })
              }
            }
        }
      }
    }
    return firstVisible(trunkMissingVlan, state, candidates, rand)
  },

  inject: (state, p) => setAllowed(state, p, parseAllowed(String(p['restricted']))),

  symptomVisible: (state, p) => !peerAnswers(state, p),

  ticket: (state, p) =>
    `Depuis un changement sur le réseau, ${nameOf(state, p['host'], 'un poste')} ne joint plus ${String(p['peerName'])}, alors que les autres postes communiquent normalement.`,

  hints: (state, p) => [
    `Le ping de ${nameOf(state, p['host'], 'le poste')} vers ${String(p['peerName'])} échoue, alors que les ports d’accès des deux postes sont corrects.`,
    `Les deux postes ne se rejoignent que par une liaison entre équipements (trunk) : examinez les trunks de ${nameOf(state, p['switch'], 'du réseau')}.`,
    `Affichez les trunks (show interfaces trunk) : tous les VLAN utilisés par les postes figurent-ils dans la liste des VLAN autorisés ?`
  ],

  cause: (state, p) =>
    `Le VLAN ${String(p['vlan'])} avait été retiré de la liste des VLAN autorisés du trunk ${port(state, p)?.iface.name ?? ''} de ${nameOf(state, p['switch'], 'le switch')}.`,

  repair: (state, p) => setAllowed(state, p, parseAllowed(String(p['original']))),

  healed(state, p) {
    const t = port(state, p)
    return !!t && trunkAllows(switchportOf(t.iface), Number(p['vlan'])) && peerAnswers(state, p)
  }
}
