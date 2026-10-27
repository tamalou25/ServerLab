/**
 * Comparaison rapide de deux états du lab du point de vue du réseau. Grâce au partage
 * structurel d'immer, déplacer ou renommer un équipement ne change ni `links` ni les tableaux
 * `interfaces` : les calculs coûteux (segments de niveau 2, conflits d'adresses, voyants) peuvent
 * alors être réutilisés tels quels, au lieu d'être refaits à chaque mouvement de souris.
 */
import { isDraft } from 'immer'
import type { Device, LabState } from '../model/schema'

/** Comparaison supplémentaire d'un équipement modifié (champs hors réseau utiles au calcul). */
export type DeviceSame = (before: Device, after: Device) => boolean

/**
 * Vrai si seuls des champs hors réseau ont changé (position, nom, journaux…) : mêmes câbles,
 * mêmes équipements, mêmes cartes (par référence), même alimentation.
 */
export function sameNetwork(a: LabState, b: LabState, extra?: DeviceSame): boolean {
  if (a === b) return true
  if (a.links !== b.links) return false
  if (a.devices === b.devices) return true
  const ids = Object.keys(a.devices)
  if (ids.length !== Object.keys(b.devices).length) return false
  for (const id of ids) {
    const before = a.devices[id]
    const after = b.devices[id]
    if (!before || !after) return false
    if (before === after) continue
    if (
      before.kind !== after.kind ||
      before.powered !== after.powered ||
      before.interfaces !== after.interfaces ||
      (before.kind === 'switch' && after.kind === 'switch' && before.vlans !== after.vlans)
    )
      return false
    if (extra && !extra(before, after)) return false
  }
  return true
}

/**
 * Mémoïse un calcul qui ne dépend que du réseau : le dernier résultat est réutilisé tant que
 * `sameNetwork` (complété par `extra`) est vrai entre l'état précédent et le nouveau.
 */
export function memoByNetwork<T>(
  compute: (state: LabState) => T,
  extra?: DeviceSame
): (state: LabState) => T {
  let last: { state: LabState; value: T } | null = null
  return (state) => {
    // Brouillon immer (calcul pendant une action) : jamais mémorisé, il sera révoqué
    if (isDraft(state)) return compute(state)
    if (last && sameNetwork(last.state, state, extra)) {
      last = { state, value: last.value }
      return last.value
    }
    const value = compute(state)
    last = { state, value }
    return value
  }
}

/**
 * Dépendances réseau d'un équipement, communes aux tâches de fond : identité, alimentation,
 * cartes, routes et VLAN (références inchangées quand l'équipement est seulement déplacé ou renommé).
 */
export function networkDeps(device: Device): unknown[] {
  return [
    device.id,
    device.powered,
    device.interfaces,
    device.kind === 'router'
      ? device.routes
      : device.kind === 'switch'
        ? device.vlans
        : device.kind === 'firewall'
          ? device.pf
          : null,
    // Équipement IOS : routage dynamique, ip routing…
    device.kind === 'router' || device.kind === 'switch' ? device.ios : null
  ]
}
