/**
 * Module Accès à distance (Routage et accès distant) : routage LAN, NAT et serveur VPN ; client
 * VPN des ordinateurs (connexions, rasdial).
 */
import { defineRole } from '../types'
import { rasdialTool, rrasCmdlets } from './cmdlets'
import { rrasCommands } from './commands'
import { rrasCriteria } from './criteria'
import { RRAS_STATE } from './state'
import { rrasTransit } from './transit'

export const rrasRole = defineRole({
  id: 'rras',
  displayName: 'Accès à distance',
  feature: 'RemoteAccess',
  dependencies: [],
  uses: ['adds', 'dns', 'nps'],
  features: [
    {
      name: 'RemoteAccess',
      displayName: 'Accès à distance',
      role: true,
      managementTools: ['RSAT-RemoteAccess']
    },
    {
      name: 'DirectAccess-VPN',
      displayName: 'DirectAccess et VPN (accès à distance)',
      role: true,
      parent: 'RemoteAccess'
    },
    { name: 'Routing', displayName: 'Routage', role: true, parent: 'RemoteAccess' },
    { name: 'RSAT-RemoteAccess', displayName: 'Outils de gestion de l’accès à distance', role: false }
  ],
  state: RRAS_STATE,
  commands: rrasCommands,
  cmdlets: rrasCmdlets,
  tools: [rasdialTool],
  views: [
    {
      app: 'rrasmgmt',
      label: 'Routage et accès distant',
      run: ['rrasmgmt.msc'],
      tool: true,
      requires: { feature: 'RSAT-RemoteAccess' }
    },
    { app: 'vpnclient', label: 'VPN', run: ['ms-settings:network-vpn'], requires: {} }
  ],
  criteria: rrasCriteria,
  backgroundTasks: [],
  events: { sources: ['RemoteAccess'] },
  services: [{ display: 'Routage et accès distant', name: 'RemoteAccess', when: 'installed' }],
  transit: rrasTransit
})
