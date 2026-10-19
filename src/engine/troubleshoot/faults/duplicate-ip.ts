/**
 * Panne `net.duplicate-ip` : une carte statique reçoit l'adresse IP d'un autre poste du même réseau.
 * Le symptôme est celui de `ipconfig` / `Get-NetIPAddress` (adresse « Dupliquée »), déjà simulé et sourcé.
 */
import { command } from '../../commands/catalog'
import type { LabState } from '../../model/schema'
import { effectiveIpv4 } from '../../net/addressing'
import { ipConflicts } from '../../net/conflicts'
import { sameSubnet } from '../../net/ipv4'
import type { FaultDef, FaultTargetParams } from '../types'
import { firstVisible, nameOf, poweredHosts, staticIpv4Input } from './net-common'

const ID = 'net.duplicate-ip'

function target(state: LabState, p: FaultTargetParams) {
  const device = state.devices[String(p['device'])]
  const iface = device?.interfaces.find((i) => i.id === p['iface'])
  return device && iface ? { name: device.name, iface } : null
}

/** L'adresse de la carte est-elle signalée en double ? */
const conflicting = (state: LabState, p: FaultTargetParams): boolean =>
  ipConflicts(state).has(`${String(p['device'])}/${String(p['iface'])}`)

function setAddress(state: LabState, p: FaultTargetParams, address: string): ReturnType<FaultDef['inject']> {
  const t = target(state, p)
  if (!t) return []
  return [
    command(
      'net.setInterfaceIpv4',
      String(p['device']),
      String(p['iface']),
      staticIpv4Input(t.iface, { address })
    )
  ]
}

export const duplicateIp: FaultDef = {
  id: ID,
  domain: 'reseau',
  difficulty: 1,
  title: 'Adresse IP en doublon',

  pick(state, rand) {
    const hosts = poweredHosts(state)
    const candidates: FaultTargetParams[] = []
    for (const device of hosts)
      for (const iface of device.interfaces) {
        const eff = effectiveIpv4(iface)
        if (!eff || eff.source !== 'static') continue
        for (const other of hosts) {
          if (other.id === device.id) continue
          for (const o of other.interfaces) {
            const oe = effectiveIpv4(o)
            if (!oe || oe.address === eff.address || !sameSubnet(eff.address, oe.address, eff.prefixLength))
              continue
            candidates.push({
              device: device.id,
              iface: iface.id,
              otherName: other.name,
              original: eff.address,
              duplicate: oe.address
            })
          }
        }
      }
    return firstVisible(duplicateIp, state, candidates, rand)
  },

  inject: (state, p) => setAddress(state, p, String(p['duplicate'])),

  symptomVisible: (state, p) => conflicting(state, p),

  ticket: (state, p) =>
    `Windows affiche un avertissement réseau sur ${nameOf(state, p['device'], 'un poste')} et la connexion est instable depuis qu’un autre poste a été branché.`,

  hints: (state, p) => [
    `Sur ${nameOf(state, p['device'], 'le poste')}, lisez la configuration réseau détaillée (ipconfig) : l’adresse est-elle signalée comme valide ?`,
    `Un autre ordinateur du même réseau utilise-t-il la même adresse que ${nameOf(state, p['device'], 'le poste')} ? Comparez les adresses des postes du réseau.`,
    `Deux machines ne peuvent pas porter la même adresse : repérez laquelle des deux a été configurée à tort et rendez-lui une adresse libre du réseau.`
  ],

  cause: (state, p) =>
    `${nameOf(state, p['device'], 'Le poste')} avait reçu l’adresse ${String(p['duplicate'])}, déjà utilisée par ${String(p['otherName'])}, au lieu de ${String(p['original'])}.`,

  repair: (state, p) => setAddress(state, p, String(p['original'])),

  healed(state, p) {
    const t = target(state, p)
    return !!t && t.iface.address === p['original'] && !conflicting(state, p)
  }
}
