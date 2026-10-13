/**
 * Module du rôle Serveur Web (IIS) et du client HTTP des ordinateurs (navigateur, Invoke-WebRequest).
 */
import { ensureLocalPath } from '../files/actions'
import { defineRole } from '../types'
import { iisCmdlets } from './cmdlets'
import { iisCommands } from './commands'
import { iisCriteria } from './criteria'
import { DEFAULT_ROOT, IIS_STATE } from './state'

export const iisRole = defineRole({
  id: 'iis',
  displayName: 'IIS',
  feature: 'Web-Server',
  dependencies: ['files'],
  uses: ['adcs', 'adds', 'dns'],
  features: [
    {
      name: 'Web-Server',
      displayName: 'Serveur Web (IIS)',
      role: true,
      requires: ['Web-WebServer'],
      managementTools: ['Web-Mgmt-Tools', 'Web-Mgmt-Console']
    },
    { name: 'Web-WebServer', displayName: 'Serveur Web', role: true, parent: 'Web-Server' },
    { name: 'Web-Mgmt-Tools', displayName: 'Outils de gestion', role: true, parent: 'Web-Server' },
    {
      name: 'Web-Mgmt-Console',
      displayName: 'Console de gestion IIS',
      role: true,
      parent: 'Web-Mgmt-Tools'
    }
  ],
  state: IIS_STATE,
  commands: iisCommands,
  cmdlets: iisCmdlets,
  tools: [],
  views: [
    {
      app: 'inetmgr',
      label: 'Gestionnaire des services Internet (IIS)',
      run: ['inetmgr', 'inetmgr.exe'],
      tool: true,
      requires: { feature: 'Web-Mgmt-Console' }
    },
    { app: 'browser', label: 'Navigateur Web', requires: {} }
  ],
  criteria: iisCriteria,
  backgroundTasks: [],
  events: { sources: ['IIS-W3SVC'] },
  services: [
    { display: 'Service de publication World Wide Web', name: 'W3SVC', when: 'installed' },
    { display: 'Service d’activation des processus Windows', name: 'WAS', when: 'installed' }
  ],
  // Dossier racine du site par défaut et sa page d'accueil
  onInstall(draft, device) {
    ensureLocalPath(draft, device, `${DEFAULT_ROOT}\\iisstart.htm`, 'file', 703)
  }
})
