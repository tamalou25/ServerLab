/**
 * Module du rôle Serveur DHCP (et du client DHCP des ordinateurs).
 */
import { networkDeps } from '../../net/network-key'
import { defineRole } from '../types'
import { dhcpCmdlets } from './cmdlets'
import { dhcpCommands } from './commands'
import { autoConfigureDhcp } from './client'
import { dhcpCriteria } from './criteria'
import { DHCP_STATE } from './state'

export const dhcpRole = defineRole({
  id: 'dhcp',
  displayName: 'DHCP',
  feature: 'DHCP',
  dependencies: [],
  uses: ['adds'],
  features: [
    { name: 'DHCP', displayName: 'Serveur DHCP', role: true, managementTools: ['RSAT-DHCP'] },
    { name: 'RSAT-DHCP', displayName: 'Outils du serveur DHCP', role: false }
  ],
  state: DHCP_STATE,
  commands: dhcpCommands,
  cmdlets: dhcpCmdlets,
  tools: [],
  views: [
    { app: 'dhcp', label: 'DHCP', run: ['dhcpmgmt.msc'], tool: true, requires: { feature: 'RSAT-DHCP' } },
    {
      app: 'dhcppost',
      label: 'Assistant Configuration post-installation DHCP',
      requires: { server: true }
    }
  ],
  criteria: dhcpCriteria,
  backgroundTasks: [
    // Le client DHCP des cartes configurées en automatique demande un bail
    {
      id: 'dhcp.client',
      label: 'Client DHCP',
      // Réseau, domaines (autorisation) et serveurs DHCP : pas de nouvel essai sans changement
      deps: (state) => [
        state.links,
        state.domains,
        ...Object.values(state.devices).flatMap((d) => [
          ...networkDeps(d),
          ...(d.kind === 'server' ? [d.roles, d.host.features, d.host.domain] : [])
        ])
      ],
      run: autoConfigureDhcp
    }
  ],
  events: { sources: ['DhcpServer'] },
  services: [{ display: 'Serveur DHCP', name: 'DHCPServer', when: 'installed' }]
})
