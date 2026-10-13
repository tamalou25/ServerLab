/**
 * Module du rôle Services Bureau à distance (hôte de session, collections, RemoteApp) et de la
 * Connexion Bureau à distance des ordinateurs.
 */
import { defineRole } from '../types'
import { rdsCmdlets } from './cmdlets'
import { rdsCommands } from './commands'
import { rdsCriteria } from './criteria'
import { RDS_STATE } from './state'

export const rdsRole = defineRole({
  id: 'rds',
  displayName: 'Services Bureau à distance',
  feature: 'RDS-RD-Server',
  dependencies: ['adds'],
  uses: ['dns', 'files', 'gpo'],
  features: [
    {
      name: 'Remote-Desktop-Services',
      displayName: 'Services Bureau à distance',
      role: true
    },
    {
      name: 'RDS-RD-Server',
      displayName: 'Hôte de session Bureau à distance',
      role: true,
      parent: 'Remote-Desktop-Services',
      requires: ['RDS-Connection-Broker', 'RDS-Web-Access'],
      managementTools: ['RSAT-RDS-Tools']
    },
    {
      name: 'RDS-Connection-Broker',
      displayName: 'Service Broker pour les connexions Bureau à distance',
      role: true,
      parent: 'Remote-Desktop-Services'
    },
    {
      name: 'RDS-Web-Access',
      displayName: 'Accès Bureau à distance par le Web',
      role: true,
      parent: 'Remote-Desktop-Services'
    },
    { name: 'RSAT-RDS-Tools', displayName: 'Outils des services Bureau à distance', role: false }
  ],
  state: RDS_STATE,
  commands: rdsCommands,
  cmdlets: rdsCmdlets,
  tools: [],
  views: [
    {
      app: 'rdsmgr',
      label: 'Services Bureau à distance',
      tool: true,
      requires: { feature: 'RSAT-RDS-Tools' }
    },
    {
      app: 'mstsc',
      label: 'Connexion Bureau à distance',
      run: ['mstsc', 'mstsc.exe'],
      dialog: true,
      requires: {}
    }
  ],
  criteria: rdsCriteria,
  backgroundTasks: [],
  events: { sources: ['TerminalServices-RemoteConnectionManager'] },
  services: [
    { display: 'Services Bureau à distance', name: 'TermService', when: 'always' },
    { display: 'Service Broker pour les connexions Bureau à distance', name: 'Tssdis', when: 'installed' }
  ],
  // Un hôte de session accepte les connexions Bureau à distance
  onInstall(_draft, device) {
    device.host.remoteDesktop.enabled = true
  }
})
