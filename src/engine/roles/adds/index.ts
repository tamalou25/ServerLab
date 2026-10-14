/**
 * Module du rôle Services AD DS : annuaire, promotion en contrôleur, jonction et sessions.
 * Les données de l'annuaire sont propres à la forêt (`state.domains`), pas à un serveur.
 */
import { defineRole } from '../types'
import { addsAuditRules } from './audit'
import { recycleBinCmdlets } from './recycle'
import { adCmdlets } from './cmdlets'
import { addsCommands } from './commands'
import { addsCriteria } from './criteria'
import { controlledDomain } from './directory'
import { replicateDirectory } from './replication'
import { siteCmdlets } from './site-cmdlets'
import { netdomTool, nltestTool, repadminTool } from './site-tools'
import { dsTools } from './ds-tools'
import { addsBashTools } from './realm'

export const addsRole = defineRole({
  id: 'adds',
  displayName: 'AD DS',
  feature: 'AD-Domain-Services',
  // Un contrôleur de domaine héberge la zone DNS du domaine
  dependencies: ['dns'],
  uses: ['files', 'gpo'],
  features: [
    {
      name: 'AD-Domain-Services',
      displayName: 'Services AD DS',
      role: true,
      requires: ['GPMC', 'RSAT-AD-PowerShell'],
      managementTools: ['RSAT-AD-Tools', 'RSAT-ADDS']
    },
    { name: 'RSAT-AD-Tools', displayName: 'Outils AD DS et AD LDS', role: false },
    {
      name: 'RSAT-AD-PowerShell',
      displayName: 'Module Active Directory pour PowerShell',
      role: false,
      parent: 'RSAT-AD-Tools'
    },
    { name: 'RSAT-ADDS', displayName: 'Outils AD DS', role: false, parent: 'RSAT-AD-Tools' }
  ],
  commands: addsCommands,
  cmdlets: [...adCmdlets, ...recycleBinCmdlets, ...siteCmdlets],
  tools: [repadminTool, netdomTool, nltestTool, ...dsTools],
  bashTools: addsBashTools,
  views: [
    {
      app: 'aduc',
      label: 'Utilisateurs et ordinateurs Active Directory',
      run: ['dsa.msc'],
      tool: true,
      requires: { feature: 'RSAT-ADDS', domain: true }
    },
    {
      app: 'dsac',
      label: 'Centre d’administration Active Directory',
      run: ['dsac.exe', 'dsac'],
      tool: true,
      requires: { feature: 'RSAT-ADDS', domain: true }
    },
    {
      app: 'dssite',
      label: 'Sites et services Active Directory',
      run: ['dssite.msc'],
      tool: true,
      requires: { feature: 'RSAT-ADDS', domain: true }
    },
    {
      app: 'adpromote',
      label: 'Assistant Configuration des services de domaine Active Directory',
      requires: { server: true }
    }
  ],
  criteria: addsCriteria,
  auditRules: addsAuditRules,
  backgroundTasks: [
    {
      id: 'adds.replication',
      label: 'Réplication Active Directory',
      // Annuaire, câblage et équipements (chemin réseau entre contrôleurs) : pas de passage sans changement
      deps: (state) => [
        state.domains,
        state.links,
        ...Object.values(state.devices).flatMap((d) => [
          d.powered,
          d.interfaces,
          d.kind === 'server' ? d.roles['dns'] : null,
          d.kind === 'server' || d.kind === 'client' ? d.host.firewall : null
        ])
      ],
      run: replicateDirectory
    }
  ],
  events: { sources: ['ActiveDirectory_DomainService', 'Security-Auditing', 'NTDS KCC'] },
  services: [
    { display: 'Services de domaine Active Directory', name: 'NTDS', when: 'domainController' },
    { display: 'Centre de distribution de clés Kerberos', name: 'Kdc', when: 'domainController' },
    { display: 'Ouverture de session réseau', name: 'Netlogon', when: 'domainController' },
    { display: 'Réplication DFS', name: 'DFSR', when: 'domainController' }
  ],
  uninstallBlocked: (state, deviceId, feature) =>
    feature === 'AD-Domain-Services' && controlledDomain(state, deviceId)
      ? {
          code: 'DcRoleRemoval',
          message:
            'Le rôle Services AD DS ne peut pas être supprimé tant que le serveur est contrôleur de domaine. Rétrogradez-le d’abord.'
        }
      : null
})
