/**
 * Module du rôle Services de stratégie et d'accès réseau (serveur NPS) : serveur RADIUS des
 * serveurs d'accès (VPN), stratégies réseau par groupe du domaine, journal des décisions.
 */
import { defineRole } from '../types'
import { npsCmdlets } from './cmdlets'
import { npsCommands } from './commands'
import { npsCriteria } from './criteria'
import { NPS_STATE } from './state'

export const npsRole = defineRole({
  id: 'nps',
  displayName: 'NPS',
  feature: 'NPAS',
  dependencies: ['adds'],
  uses: ['dns', 'files'],
  features: [
    {
      name: 'NPAS',
      displayName: 'Services de stratégie et d’accès réseau',
      role: true,
      managementTools: ['RSAT-NPAS']
    },
    { name: 'RSAT-NPAS', displayName: 'Outils des services de stratégie et d’accès réseau', role: false }
  ],
  state: NPS_STATE,
  commands: npsCommands,
  cmdlets: npsCmdlets,
  tools: [],
  views: [
    {
      app: 'nps',
      label: 'Serveur NPS (Network Policy Server)',
      run: ['nps.msc'],
      tool: true,
      requires: { feature: 'RSAT-NPAS' }
    }
  ],
  criteria: npsCriteria,
  backgroundTasks: [],
  events: { sources: ['NPS'] },
  services: [{ display: 'Serveur NPS (Network Policy Server)', name: 'IAS', when: 'installed' }]
})
