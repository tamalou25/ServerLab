/**
 * Ports en écoute d'un ordinateur (v2.7, Lot 2c) : netstat -a, Get-NetTCPConnection,
 * Test-NetConnection -Port.
 *
 * Un port écoute quand le rôle qui l'ouvre est installé (règle de pare-feu prédéfinie du rôle,
 * services/firewall.ts) ET que le service correspondant est démarré (Lot 2a). Le pare-feu ne
 * ferme pas un port en écoute : il filtre le trafic entrant (vérifié par l'acheminement des
 * paquets, sim/forward.ts), comme les listes d'accès IOS sur le chemin.
 */
import type { HostDevice } from '../model/schema'
import { predefinedRules } from './firewall'
import { serviceRunning } from './servicestate'

export interface ListeningPort {
  protocol: 'TCP' | 'UDP'
  port: number
  /** Service qui écoute (nom court), null : système. */
  service: string | null
}

/** Service propriétaire de chaque règle prédéfinie (null : aucun service ne conditionne l'écoute). */
const RULE_SERVICE: Record<string, string | null> = {
  'FPS-SMB-In-TCP': 'LanmanServer',
  // Services Bureau à distance : arrêtés, le port 3389 n'écoute plus (v2.8, #222)
  'RemoteDesktop-UserMode-In-TCP': 'TermService',
  'DNSSrv-TCP-In': 'DNS',
  'DNSSrv-UDP-In': 'DNS',
  'ADDS-LDAP-TCP-In': 'NTDS',
  'ADDS-LDAP-UDP-In': 'NTDS',
  'KDC-TCP-In': 'Kdc',
  'Microsoft-Windows-DHCP-ClientSvc-DHCPv4-In': 'DHCPServer',
  'IIS-WebServerRole-HTTP-In-TCP': 'W3SVC',
  'IIS-WebServerRole-HTTPS-In-TCP': 'W3SVC',
  'WSUS-HTTP-In-TCP': 'W3SVC',
  'RemoteAccess-SSTP-In-TCP': 'RemoteAccess',
  'NPS-NPSSvc-In-UDP-1812-1645': 'IAS',
  'DFSR-DFSRSvc-In-TCP': 'DFSR'
}

/** Ports en écoute, triés (TCP puis UDP, par numéro), sans doublon. */
export function listeningPorts(host: HostDevice): ListeningPort[] {
  if (!host.powered) return []
  return predefinedRules(host)
    .filter((r) => r.protocol === 'TCP' || r.protocol === 'UDP')
    .filter((r) => r.id !== 'RemoteDesktop-UserMode-In-TCP' || host.host.remoteDesktop.enabled)
    .filter((r) => {
      const service = RULE_SERVICE[r.id]
      return !service || serviceRunning(host, service)
    })
    .flatMap((r) =>
      r.localPorts.map((port) => ({
        protocol: r.protocol as 'TCP' | 'UDP',
        port,
        service: RULE_SERVICE[r.id] ?? null
      }))
    )
    .filter((e, i, all) => all.findIndex((o) => o.protocol === e.protocol && o.port === e.port) === i)
    .sort((a, b) => (a.protocol === b.protocol ? a.port - b.port : a.protocol === 'TCP' ? -1 : 1))
}

/** Le port TCP écoute-t-il sur cet ordinateur ? */
export function tcpListening(host: HostDevice, port: number): boolean {
  return listeningPorts(host).some((p) => p.protocol === 'TCP' && p.port === port)
}
