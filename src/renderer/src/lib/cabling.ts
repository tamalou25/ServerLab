/**
 * Câblage port à port : premier port choisi, puis second port → câble créé dans le moteur.
 * Utilisé par le menu de ports et par le panneau de ports affiché au survol des nœuds.
 */
import { command } from '@engine/index'
import { useUiStore } from '../store/ui'
import { runCommand } from './run'

/** Choisit un port pendant le câblage (outil Câble). */
export function pickCablePort(deviceId: string, ifaceId: string): void {
  const ui = useUiStore.getState()
  const end = { deviceId, ifaceId }
  const start = ui.cableStart
  if (!start) {
    ui.setCableStart(end)
    return
  }
  // Second clic sur le même équipement : on change simplement de port de départ
  if (start.deviceId === deviceId) {
    ui.setCableStart(end)
    return
  }
  ui.setCableStart(null)
  const linkId = runCommand(command('topology.connect', start, end))
  if (linkId) ui.select({ link: linkId, devices: [] })
}

/**
 * Débit négocié d'un câble, déduit des noms de ports (affichage seulement) : un port FastEthernet
 * (Fa…) limite le lien à 100 Mbit/s, les autres ports (Gigabit, cartes des serveurs et postes) à 1 Gbit/s.
 */
export function linkSpeedMbps(portA: string, portB: string): number {
  const speed = (port: string) => (/^fa/i.test(port) ? 100 : 1000)
  return Math.min(speed(portA), speed(portB))
}
