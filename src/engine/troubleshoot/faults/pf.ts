/**
 * Pannes du pare-feu pfSense du catalogue (v2.10, #248, domaine `pare-feu`) : filtrage, NAT et routage, DHCP.
 * Une seule ligne dans `registry.ts` (`...PF_FAULTS`) pour limiter les conflits de fusion.
 */
import type { FaultDef } from '../types'
import { pfDhcpOptions } from './pf-dhcp'
import { PF_NAT_FAULTS } from './pf-nat'
import { PF_RULE_FAULTS } from './pf-rules'

export const PF_FAULTS: readonly FaultDef[] = [...PF_RULE_FAULTS, ...PF_NAT_FAULTS, pfDhcpOptions]
