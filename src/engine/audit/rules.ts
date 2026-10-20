/**
 * Règles d'audit du système de base (pare-feu) et liste complète : système de base puis
 * règles déclarées par les modules de rôles.
 */
import { isLinuxHost } from '../model/host'
import type { HostDevice, LabState } from '../model/schema'
import { FIREWALL_PROFILES } from '../model/schema'
import { IOS_AUDIT_RULES } from '../ios/audit'
import { roleModules } from '../roles/registry'
import { PROFILE_LABELS, profileEnabled } from '../services/firewall'
import type { AuditRule } from './types'

export * from './types'

/** Ordinateurs Windows (le pare-feu Windows ne concerne pas les postes Linux). */
const hosts = (state: LabState): HostDevice[] =>
  Object.values(state.devices).filter(
    (d): d is HostDevice => (d.kind === 'server' || d.kind === 'client') && !isLinuxHost(d)
  )

/** Règles du système de base. */
export const CORE_AUDIT_RULES: AuditRule[] = [
  {
    id: 'firewallDisabled',
    title: 'Pare-feu désactivé',
    severity: 'élevée',
    fix: 'Réactivez le pare-feu sur tous les profils (Set-NetFirewallProfile -All -Enabled True) ou par stratégie de groupe.',
    refs: ['anssi-17', 'cis-4.4', 'cis-4.5'],
    check: (state) =>
      hosts(state).flatMap((h) =>
        FIREWALL_PROFILES.filter((p) => !profileEnabled(h, p)).map((p) => ({
          object: `${h.name} (profil ${PROFILE_LABELS[p]})`,
          detail: `Le pare-feu est désactivé pour le profil ${PROFILE_LABELS[p]}.`
        }))
      )
  }
]

/** Toutes les règles : système de base, rôles (dans l'ordre du registre), puis équipements IOS. */
export function auditRules(): AuditRule[] {
  return [...CORE_AUDIT_RULES, ...roleModules().flatMap((m) => m.auditRules ?? []), ...IOS_AUDIT_RULES]
}
