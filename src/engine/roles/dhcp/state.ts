/**
 * Données du rôle DHCP sur un serveur : définition (registre, validation) et accesseur typé.
 */
import { roleState } from '../state'
import type { RoleStateDef } from '../types'
import type { Device } from '../../model/schema'
import { DhcpServerSchema, type DhcpServer } from './schema'
import { serviceRunning } from '../../services/servicestate'

/** Serveur DHCP tel qu'après l'installation du rôle. */
export function createDhcpServer(): DhcpServer {
  return {
    authorized: false,
    configured: false,
    scopes: [],
    serverOptions: { router: [], dnsServers: [], dnsDomain: null }
  }
}

export const DHCP_STATE: RoleStateDef<DhcpServer> = {
  key: 'dhcp',
  feature: 'DHCP',
  schema: DhcpServerSchema,
  create: createDhcpServer
}

/** Données DHCP d'un équipement (null si ce n'est pas un serveur DHCP). */
export const dhcpServerOf = (device: Parameters<typeof roleState>[0]): DhcpServer | null =>
  roleState(device, DHCP_STATE)

/**
 * Service DHCP d'un équipement : rôle Serveur DHCP d'un serveur Windows, ou serveur DHCP IOS
 * (ip dhcp pool) d'un routeur ou d'un switch Cisco. Fonctionne aussi sur un brouillon immer.
 * Service « DHCPServer » arrêté (Stop-Service, net stop) : le serveur ne distribue plus de baux.
 */
/** Rôle DHCP installé mais service « DHCPServer » arrêté (note des traces). */
export function dhcpServiceStopped(device: Device | undefined): boolean {
  return (
    !!device &&
    device.kind === 'server' &&
    device.host.features.includes('DHCP') &&
    !serviceRunning(device, 'DHCPServer')
  )
}

export function dhcpServiceOf(device: Device | undefined): DhcpServer | null {
  if (!device) return null
  if (device.kind === 'server')
    return device.host.features.includes('DHCP') && serviceRunning(device, 'DHCPServer')
      ? dhcpServerOf(device)
      : null
  if ((device.kind === 'router' || device.kind === 'switch') && device.model)
    return (device.ios?.dhcpServer as DhcpServer | null | undefined) ?? null
  return null
}
