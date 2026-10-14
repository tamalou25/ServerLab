/**
 * Module Stratégies de groupe : GPO du domaine (`state.domains`), application sur les membres.
 */
import { networkDeps } from '../../net/network-key'
import { defineRole } from '../types'
import { gpoAuditRules } from './audit'
import { gpoCmdlets, gpoRegistryCmdlets } from './cmdlets'
import { gpoCommands } from './commands'
import { gpoCriteria } from './criteria'
import { autoGroupPolicy, GP_SOURCE } from './processing'
import { gpresultTool, gpupdateTool } from './tools'

export const gpoRole = defineRole({
  id: 'gpo',
  displayName: 'Stratégies de groupe',
  feature: 'GPMC',
  dependencies: ['adds'],
  uses: ['files'],
  features: [{ name: 'GPMC', displayName: 'Gestion des stratégies de groupe', role: false }],
  commands: gpoCommands,
  cmdlets: [...gpoCmdlets, ...gpoRegistryCmdlets],
  tools: [gpupdateTool, gpresultTool],
  views: [
    {
      app: 'gpmc',
      label: 'Gestion des stratégies de groupe',
      run: ['gpmc.msc'],
      tool: true,
      requires: { feature: 'GPMC', domain: true }
    },
    {
      app: 'gpme',
      label: 'Éditeur de gestion des stratégies de groupe',
      requires: { feature: 'GPMC', domain: true }
    }
  ],
  criteria: gpoCriteria,
  auditRules: gpoAuditRules,
  backgroundTasks: [
    // Les membres du domaine appliquent leurs stratégies après un démarrage ou une ouverture de session
    {
      id: 'gpo.refresh',
      label: 'Application des stratégies de groupe',
      // Réseau, domaines (GPO, liaisons), DNS des contrôleurs, démarrages et sessions des membres
      deps: (state) => [
        state.links,
        state.domains,
        ...Object.values(state.devices).flatMap((d) => [
          ...networkDeps(d),
          ...(d.kind === 'server' ? [d.roles] : []),
          ...(d.kind === 'server' || d.kind === 'client'
            ? [d.host.domain, d.host.bootedAt, d.host.session, d.host.policy]
            : [])
        ])
      ],
      run: autoGroupPolicy
    }
  ],
  events: { sources: [GP_SOURCE] },
  services: []
})
