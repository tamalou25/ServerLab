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
import { apacheBashTools } from './bash/apache'
import { bindBashTools } from './bash/bind'
import { dhcpBashTools } from './bash/dhcp'
import { coreBashTools } from './bash/core'
import { loggingBashTools } from './bash/logging'
import { netBashTools } from './bash/net'
import { sambaBashTools } from './bash/samba'
import { sshBashTools, sshWindowsTool } from './bash/ssh'
import { systemBashTools } from './bash/system'

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
      sshWindowsTool,
      ...roles.flatMap((m) => m.tools)
    ],
    bashTools: [
      ...coreBashTools,
      ...systemBashTools,
      ...netBashTools,
      ...sshBashTools,
      ...loggingBashTools,
      ...apacheBashTools,
      ...sambaBashTools,
      ...bindBashTools,
      ...dhcpBashTools,
      ...roles.flatMap((m) => m.bashTools ?? [])
    ]
  }
  return catalog
}
