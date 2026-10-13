/**
 * Module du rôle WSUS (services de mise à jour) et de la page Windows Update des ordinateurs.
 */
import { defineRole } from '../types'
import { wsusCmdlets } from './cmdlets'
import { wsusCommands } from './commands'
import { wsusCriteria } from './criteria'
import { WSUS_STATE } from './state'

export const wsusRole = defineRole({
  id: 'wsus',
  displayName: 'WSUS',
  feature: 'UpdateServices',
  dependencies: ['gpo'],
  uses: ['adds', 'dns'],
  features: [
    {
      name: 'UpdateServices',
      displayName: 'Services WSUS (Windows Server Update Services)',
      role: true,
      requires: ['UpdateServices-WidDB', 'UpdateServices-Services'],
      managementTools: ['UpdateServices-RSAT', 'UpdateServices-API', 'UpdateServices-UI']
    },
    {
      name: 'UpdateServices-WidDB',
      displayName: 'Connectivité WID',
      role: true,
      parent: 'UpdateServices'
    },
    {
      name: 'UpdateServices-Services',
      displayName: 'Services WSUS',
      role: true,
      parent: 'UpdateServices'
    },
    { name: 'UpdateServices-RSAT', displayName: 'Outils des services WSUS', role: false },
    {
      name: 'UpdateServices-API',
      displayName: 'Outils API et PowerShell',
      role: false,
      parent: 'UpdateServices-RSAT'
    },
    {
      name: 'UpdateServices-UI',
      displayName: 'Composant logiciel enfichable Interface utilisateur',
      role: false,
      parent: 'UpdateServices-RSAT'
    }
  ],
  state: WSUS_STATE,
  commands: wsusCommands,
  cmdlets: wsusCmdlets,
  tools: [],
  views: [
    {
      app: 'wsus',
      label: 'Services WSUS',
      run: ['wsus.msc'],
      tool: true,
      requires: { feature: 'UpdateServices-UI' }
    },
    { app: 'wuclient', label: 'Windows Update', run: ['ms-settings:windowsupdate'], requires: {} }
  ],
  criteria: wsusCriteria,
  backgroundTasks: [],
  events: { sources: ['Windows Server Update Services'] },
  services: [{ display: 'Service WSUS', name: 'WsusService', when: 'installed' }]
})
