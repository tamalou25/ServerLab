/**
 * Catalogue des pannes du mode panne. Ajouter une panne : voir `docs/depannage.md`.
 * Cohérence (ids uniques, 3 indices, difficulté) vérifiée par `tests/engine/troubleshoot/registry.test.ts`.
 */
import { aclBlocking } from './faults/acl-blocking'
import { cableUnplugged } from './faults/cable-unplugged'
import { duplicateIp } from './faults/duplicate-ip'
import { etherchannelDown } from './faults/etherchannel-down'
import { missingRoute } from './faults/missing-route'
import { portErrDisabled } from './faults/port-err-disabled'
import { serviceStopped } from './faults/service-stopped'
import { LINUX_FAULTS } from './faults/linux'
import { PF_FAULTS } from './faults/pf'
import { WINDOWS_FAULTS } from './faults/windows'
import { trunkMissingVlan } from './faults/trunk-missing-vlan'
import { wrongGateway } from './faults/wrong-gateway'
import { wrongMask } from './faults/wrong-mask'
import { wrongNat } from './faults/wrong-nat'
import { wrongStpRoot } from './faults/wrong-stp-root'
import { wrongVlan } from './faults/wrong-vlan'
import type { FaultDef } from './types'

export const FAULTS: readonly FaultDef[] = [
  serviceStopped,
  wrongMask,
  wrongGateway,
  duplicateIp,
  cableUnplugged,
  wrongVlan,
  trunkMissingVlan,
  portErrDisabled,
  aclBlocking,
  wrongNat,
  missingRoute,
  wrongStpRoot,
  etherchannelDown,
  ...WINDOWS_FAULTS,
  ...LINUX_FAULTS,
  ...PF_FAULTS
]

/** Panne du catalogue par identifiant (undefined : identifiant inconnu, p. ex. fichier d'une version future). */
export function getFault(id: string): FaultDef | undefined {
  return FAULTS.find((f) => f.id === id)
}
