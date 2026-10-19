/**
 * Catalogue des commandes des consoles simulées : commandes du système de base, puis cmdlets
 * et outils déclarés par chaque module de rôle (`roles/<rôle>/index.ts`).
 */
import { roleModules } from '../roles/registry'
import type { CommandCatalog } from './ps/interpreter'
import { coreCmdlets } from './ps/cmdlets/core'
import { firewallCmdlets } from './ps/cmdlets/firewall'
import { eventCmdlets } from './ps/cmdlets/events'
import { netCmdlets } from './ps/cmdlets/net'
import { serviceCmdlets } from './ps/cmdlets/services'
import { localAccountCmdlets } from './ps/cmdlets/localaccounts'
import { netSysCmdlets } from './ps/cmdlets/netsys'
import { systemCmdlets } from './ps/cmdlets/system'
import { hostnameTool, ipconfigTool, pingTool, tracertTool, whoamiTool } from './tools/net'
import { netshTool } from './tools/netsh'
import { diagTools } from './tools/diag'
import { w32tmTool } from './tools/time'
import { coreBashTools } from './bash/core'

let catalog: CommandCatalog | null = null

/** Catalogue complet (construit à la première utilisation, registre des rôles chargé). */
export function shellCatalog(): CommandCatalog {
  if (catalog) return catalog
  const roles = roleModules()
  catalog = {
    cmdlets: [
      ...coreCmdlets,
      ...netCmdlets,
      ...firewallCmdlets,
      ...eventCmdlets,
      ...systemCmdlets,
      ...serviceCmdlets,
      ...localAccountCmdlets,
      ...netSysCmdlets,
      ...roles.flatMap((m) => m.cmdlets)
    ],
    tools: [
      ipconfigTool,
      pingTool,
      tracertTool,
      hostnameTool,
      whoamiTool,
      netshTool,
      ...diagTools,
      w32tmTool,
      ...roles.flatMap((m) => m.tools)
    ],
    bashTools: [...coreBashTools, ...roles.flatMap((m) => m.bashTools ?? [])]
  }
  return catalog
}
