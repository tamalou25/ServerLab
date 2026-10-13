/**
 * Requêtes en lecture seule sur la topologie.
 */
import { isDraft } from 'immer'
import type { Device, HostDevice, LabState, Link, LinkEnd, NetInterface } from '../model/schema'
import { linkAt } from '../net/segment'

type ReadState = Pick<LabState, 'devices' | 'links'>

export function getDevice(state: ReadState, id: string): Device | undefined {
  return state.devices[id]
}

export function getInterface(device: Device, ifaceId: string): NetInterface | undefined {
  return device.interfaces.find((i) => i.id === ifaceId)
}

export function isHostDevice(device: Device): device is HostDevice {
  return device.kind === 'server' || device.kind === 'client'
}

/** Câble branché sur un port, s'il existe. */
export function linkOnInterface(state: ReadState, deviceId: string, ifaceId: string): Link | undefined {
  // État figé : index « équipement/port » mis en cache par version des câbles (audit P-01). Brouillon
  // immer : les câbles peuvent changer sous la même référence, l'index en cache serait périmé
  if (!isDraft(state.links)) return linkAt(state, { deviceId, ifaceId })
  return Object.values(state.links).find(
    (l) =>
      (l.a.deviceId === deviceId && l.a.ifaceId === ifaceId) ||
      (l.b.deviceId === deviceId && l.b.ifaceId === ifaceId)
  )
}

/** Extrémité opposée d'un câble. */
export function otherEnd(link: Link, deviceId: string, ifaceId: string): LinkEnd {
  return link.a.deviceId === deviceId && link.a.ifaceId === ifaceId ? link.b : link.a
}

/** Câbles reliés à un équipement. */
export function linksOfDevice(state: ReadState, deviceId: string): Link[] {
  return Object.values(state.links).filter((l) => l.a.deviceId === deviceId || l.b.deviceId === deviceId)
}

/** Ports d'un équipement raccordés par un câble (ex. « Ports utilisés 3 / 16 » d'un switch). */
export function usedInterfaces(state: ReadState, deviceId: string): NetInterface[] {
  const used = new Set<string>()
  for (const link of linksOfDevice(state, deviceId)) {
    if (link.a.deviceId === deviceId) used.add(link.a.ifaceId)
    if (link.b.deviceId === deviceId) used.add(link.b.ifaceId)
  }
  return state.devices[deviceId]?.interfaces.filter((i) => used.has(i.id)) ?? []
}

/** Recherche un équipement par nom (insensible à la casse). */
export function findDeviceByName(state: ReadState, name: string): Device | undefined {
  const upper = name.toUpperCase()
  return Object.values(state.devices).find((d) => d.name.toUpperCase() === upper)
}
