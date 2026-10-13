/**
 * Détection des conflits d'adresses IP dans un même domaine de diffusion.
 */
import type { LabState } from '../model/schema'
import { effectiveIpv4 } from './addressing'
import { isApipa } from './ipv4'
import { memoByNetwork } from './network-key'
import { l2Segment, type PortRef } from './segment'

/**
 * Ensemble des ports (« équipement/port ») dont l'adresse est en conflit avec un autre hôte.
 * Recalculé seulement quand le réseau change (pas quand un équipement est déplacé).
 */
export const ipConflicts: (state: LabState) => Set<string> = memoByNetwork(computeConflicts)

function computeConflicts(state: LabState): Set<string> {
  const conflicts = new Set<string>()
  // Seule une adresse portée par au moins deux cartes peut être en conflit : le parcours du domaine
  // de diffusion (coûteux) n'est fait que pour elles, et non pour chaque carte (audit P-01)
  const holders = new Map<string, number>()
  for (const device of Object.values(state.devices))
    for (const iface of device.interfaces) {
      const address = effectiveIpv4(iface)?.address
      if (address) holders.set(address, (holders.get(address) ?? 0) + 1)
    }
  for (const device of Object.values(state.devices)) {
    if (!device.powered) continue
    for (const iface of device.interfaces) {
      const eff = effectiveIpv4(iface)
      if (!eff || isApipa(eff.address) || (holders.get(eff.address) ?? 0) < 2) continue
      const origin: PortRef = { deviceId: device.id, ifaceId: iface.id }
      for (const member of l2Segment(state, origin)) {
        if (member.port.deviceId === device.id && member.port.ifaceId === iface.id) continue
        const other = state.devices[member.port.deviceId]?.interfaces.find(
          (i) => i.id === member.port.ifaceId
        )
        const otherEff = other ? effectiveIpv4(other) : null
        if (otherEff?.address === eff.address) conflicts.add(`${device.id}/${iface.id}`)
      }
    }
  }
  return conflicts
}

/** Hôte en conflit avec l'adresse donnée sur le segment de ce port (pour le journal). */
export function conflictingPeer(
  state: LabState,
  origin: PortRef,
  address: string
): { name: string; mac: string } | null {
  for (const member of l2Segment(state, origin)) {
    if (member.port.deviceId === origin.deviceId && member.port.ifaceId === origin.ifaceId) continue
    const device = state.devices[member.port.deviceId]
    const iface = device?.interfaces.find((i) => i.id === member.port.ifaceId)
    if (device && iface && effectiveIpv4(iface)?.address === address)
      return { name: device.name, mac: iface.mac }
  }
  return null
}
