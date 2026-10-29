/**
 * Pannes Windows du catalogue (chantier D, #230) : 9 familles + pannes composées.
 * Une seule ligne dans `registry.ts` (`...WINDOWS_FAULTS`) pour limiter les conflits de fusion.
 */
import type { FaultDef } from '../types'
import { accountDisabled, accountLocked } from './win-account'
import { clockSkew } from './win-clock'
import { WINDOWS_COMPOSITES } from './win-composites'
import { dhcpScopeDisabled, dhcpScopeExhausted } from './win-dhcp'
import { dnsWrongA } from './win-dns-record'
import { gpoFiltered, gpoUnlinked } from './win-gpo'
import { dependencyStopped, serviceDisabled, serviceFailed } from './win-services'
import { ntfsRights, shareAcl } from './win-share'
import { trustBroken } from './win-trust'

export const WINDOWS_FAULTS: readonly FaultDef[] = [
  serviceDisabled,
  serviceFailed,
  dependencyStopped,
  dnsWrongA,
  dhcpScopeDisabled,
  dhcpScopeExhausted,
  trustBroken,
  accountLocked,
  accountDisabled,
  gpoUnlinked,
  gpoFiltered,
  ntfsRights,
  shareAcl,
  clockSkew,
  ...WINDOWS_COMPOSITES
]
