/**
 * Pannes Linux du catalogue (v2.9, #241) : services, SSH et fail2ban, Apache2, Samba, Bind9 et DHCP.
 * Une seule ligne dans `registry.ts` (`...LINUX_FAULTS`) pour limiter les conflits de fusion.
 */
import type { FaultDef } from '../types'
import { LINUX_NET_FAULTS } from './linux-net'
import { LINUX_SERVICE_FAULTS } from './linux-services'
import { LINUX_SHARE_FAULTS } from './linux-share'
import { LINUX_WEB_FAULTS } from './linux-web'

export const LINUX_FAULTS: readonly FaultDef[] = [
  ...LINUX_SERVICE_FAULTS,
  ...LINUX_WEB_FAULTS,
  ...LINUX_SHARE_FAULTS,
  ...LINUX_NET_FAULTS
]
