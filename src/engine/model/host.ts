/**
 * Prédicats sur le système d'un ordinateur : point unique pour reconnaître un hôte Linux
 * (poste Ubuntu ou serveur Debian/Ubuntu), quel que soit son `kind`.
 */
import type { Device, HostDevice } from './schema'

/** Vrai pour un poste client ou un serveur dont le système est Linux. */
export function isLinuxHost(device: Device | undefined): device is HostDevice {
  return (device?.kind === 'client' || device?.kind === 'server') && device.host.os === 'linux'
}
