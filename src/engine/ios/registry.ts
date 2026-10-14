/**
 * Registre des fonctionnalités IOS (navigation, configuration de base, VLAN, routage…) : les
 * arbres de commandes des modes en sont dérivés (cli/tree.ts).
 */
import type { CliCommand } from './cli/types'
import type { Device, LabState, NetInterface } from '../model/schema'
import { ifaceStatus } from './status'
import type { Route } from '../net/routing'
import { networkDeps } from '../net/network-key'
import type { Hop } from '../net/segment'
import { switchportOf } from '../net/switchport'
import type { BackgroundTask } from '../roles/types'
import type { TransitHooks } from '../sim/transit'
import { produce, type Draft } from 'immer'
import type { PacketTrace } from '../sim/trace'
import { isIos, type IosDevice } from './device'
import type { IosFeature, L2Frame } from './feature'
import { acl } from './features/acl'
import { base } from './features/base'
import { hsrp } from './features/hsrp'
import { l2sec } from './features/l2sec'
import { logging } from './features/logging'
import { navigation } from './features/navigation'
import { routing } from './features/routing'
import { security } from './features/security'
import { services } from './features/services'
import { learnMacs, switching } from './features/switching'
import { vlan } from './features/vlan'

/** Fonctionnalités, dans l'ordre d'enregistrement. */
export function iosFeatures(): readonly IosFeature[] {
  return [navigation, base, vlan, switching, routing, services, hsrp, acl, security, l2sec, logging]
}

/** Crochets d'acheminement des fonctionnalités (routage d'un switch, NAT, ACL…). */
export function iosTransitHooks(): TransitHooks[] {
  return iosFeatures().flatMap((f) => (f.transit ? [f.transit] : []))
}

/** Routes dynamiques d'un équipement IOS (aucune pour les autres équipements). */
export function iosDynamicRoutes(state: LabState, device: Device): Route[] {
  if (!isIos(device)) return []
  return iosFeatures().flatMap((f) => f.routes?.(state, device) ?? [])
}

/** Une interface d'équipement IOS ne porte une route connectée que si elle est up/up. */
export function iosInterfaceRoutes(state: LabState, device: Device, iface: NetInterface): boolean {
  return !isIos(device) || ifaceStatus(state, device, iface).protocol === 'up'
}

/**
 * Applique les effets durables d'un échange (traductions NAT, compteurs d'ACL) aux équipements IOS
 * concernés ; l'état est inchangé s'il n'y en a pas.
 */
export function applyTraceEffects(state: LabState, trace: PacketTrace | null): LabState {
  if (!trace) return state
  const effects = trace.effects ?? []
  return produce(state, (draft) => {
    // Table d'adresses MAC des switchs IOS traversés
    learnMacs(draft, trace)
    for (const effect of effects) {
      const device = draft.devices[effect.deviceId]
      if (!isIos(device as Device | undefined)) continue
      for (const f of iosFeatures()) f.onEffect?.(device as Draft<IosDevice>, effect)
    }
  })
}

/** Stabilise l'état des équipements IOS (élection HSRP…) après une modification. */
export function settleIos(state: LabState): LabState {
  return iosFeatures().reduce((s, f) => f.settle?.(s) ?? s, state)
}

/** Messages affichés sur la console d'un équipement à la suite de la stabilisation. */
export function settleMessages(before: LabState, after: LabState, deviceId: string): string[] {
  if (before === after) return []
  return iosFeatures().flatMap((f) => f.settleMessages?.(before, after, deviceId) ?? [])
}

/** Tâche de fond des équipements IOS (mode Temps réel) : stabilisation après chaque changement. */
export const IOS_BACKGROUND_TASK: BackgroundTask = {
  id: 'ios',
  label: 'Équipements IOS (HSRP)',
  // Réseau seulement : déplacer ou renommer un équipement ne relance pas la tâche
  deps: (state) => [state.links, ...Object.values(state.devices).flatMap(networkDeps)],
  run: (state) => ({ state: settleIos(state), traces: [] })
}

/** Le port d'un switch IOS accepte-t-il les trames de cette adresse MAC (port-security) ? */
export function iosPortAdmits(state: LabState, device: Device, iface: NetInterface, mac: string): boolean {
  if (!isIos(device)) return true
  return iosFeatures().every((f) => f.admits?.(state, device, iface, mac) ?? true)
}

/**
 * Sécurité de niveau 2 le long d'un chemin de trames : premier switch IOS qui refuse la trame
 * (port d'arrivée, VLAN de la trame), avec l'explication ; null si elle traverse tout le chemin.
 */
export function iosL2Inspect(
  state: LabState,
  path: readonly Hop[],
  frame: L2Frame
): { deviceId: string; hopIndex: number; reason: string } | null {
  for (const [index, hop] of path.entries()) {
    const device = state.devices[hop.to]
    if (!device || device.kind !== 'switch' || !isIos(device)) continue
    const port = device.interfaces.find((i) => i.id === hop.toIfaceId)
    if (!port) continue
    const sp = switchportOf(port)
    const vlan = hop.vlan ?? (sp.mode === 'access' ? (sp.hoppedVlan ?? sp.accessVlan) : sp.nativeVlan)
    for (const f of iosFeatures()) {
      const reason = f.inspect?.(state, device, port, vlan, frame)
      if (reason) return { deviceId: device.id, hopIndex: index, reason }
    }
  }
  return null
}

/** Toutes les commandes déclarées. */
export function iosCommands(): CliCommand[] {
  return iosFeatures().flatMap((f) => f.commands)
}
