/**
 * Critères de validation des labs : chaque type déclare son schéma (zod) et son évaluateur,
 * qui lit l'état du lab sans le modifier. Les évaluateurs utilisent les mêmes fonctions que
 * les consoles et l'interface (ping, résolution DNS, accès effectif…).
 *
 * Types du système de base ici ; les types propres à un rôle sont déclarés par son module
 * (`roles/<rôle>/criteria.ts`) et rassemblés par le registre.
 */
import { z } from 'zod'
import type { LabState } from '../model/schema'
import { effectiveIpv4 } from '../net/addressing'
import { ping } from '../net/diagnostics'
import { switchportOf } from '../net/switchport'
import { findComputerService } from '../services/hostservices'
import { clockOffset } from '../services/hostclock'
import { findLocalGroup, findLocalUser } from '../services/localaccounts'
import { effectiveRules, profileEnabled } from '../services/firewall'
import { allRepaired } from '../troubleshoot/session'
import { auditLab } from '../audit/audit'
import { CYBER_CRITERIA } from '../cyber/criteria'
import { IOS_CRITERIA } from '../ios/criteria'
import { roleCriteria } from '../roles/registry'
import { defineCriterion, type CriterionType } from '../roles/types'
import { byName, hostByName, sameName, targetIp } from './lookup'

/** Critères du système de base (adressage, connectivité, rôles installés). */
const CORE_CRITERIA: CriterionType[] = [
  defineCriterion(
    z.object({ type: z.literal('auditScore'), min: z.number().int().min(0).max(100) }),
    (state, check) => auditLab(state).score >= check.min,
    'Score d’audit minimal'
  ),
  defineCriterion(
    z.object({ type: z.literal('auditRule'), rule: z.string(), passed: z.boolean().default(true) }),
    (state, check) => auditLab(state).passed.includes(check.rule) === check.passed,
    'Règle d’audit respectée ou non'
  ),
  defineCriterion(
    z.object({
      type: z.literal('interfaceIp'),
      device: z.string(),
      /** Nom de la carte (Gi0/0, Ethernet0) ; par défaut la première carte de niveau 3. */
      interface: z.string().optional(),
      address: z.string(),
      prefixLength: z.number().int().optional(),
      gateway: z.string().optional()
    }),
    (state, check) => {
      const device = byName(state, check.device)
      const iface = check.interface
        ? device?.interfaces.find((i) => sameName(i.name, check.interface ?? ''))
        : device?.interfaces.find((i) => i.l3)
      const eff = iface ? effectiveIpv4(iface) : null
      return (
        !!eff &&
        eff.address === check.address &&
        (check.prefixLength === undefined || eff.prefixLength === check.prefixLength) &&
        (check.gateway === undefined || eff.gateway === check.gateway)
      )
    },
    'Adresse IP d’une carte réseau'
  ),
  defineCriterion(
    z.object({
      type: z.literal('ping'),
      from: z.string(),
      to: z.string(),
      /** false : le ping doit échouer (isolement d'un réseau, filtrage). */
      success: z.boolean().default(true)
    }),
    (state, check) => {
      const from = byName(state, check.from)
      const ip = targetIp(state, check.to)
      if (!from || !ip) return false
      const r = ping(state, from.id, ip, { count: 1 })
      return r.ok && r.value.success === (check.success !== false)
    },
    'Ping d’un équipement vers un autre'
  ),
  defineCriterion(
    z.object({
      type: z.literal('switchport'),
      device: z.string(),
      port: z.string(),
      mode: z.enum(['access', 'trunk']).optional(),
      /** VLAN d'accès (port d'accès) ou VLAN qui doit circuler sur le trunk. */
      vlan: z.number().int().optional()
    }),
    (state, check) => {
      const device = byName(state, check.device)
      const port =
        device?.kind === 'switch' ? device.interfaces.find((i) => sameName(i.name, check.port)) : undefined
      if (!device || device.kind !== 'switch' || !port) return false
      const config = switchportOf(port)
      if (check.mode !== undefined && config.mode !== check.mode) return false
      if (check.vlan === undefined) return true
      if (!device.vlans.some((v) => v.id === check.vlan)) return false
      return config.mode === 'access'
        ? config.accessVlan === check.vlan
        : config.allowedVlans === null || config.allowedVlans.includes(check.vlan)
    },
    'Port de switch (accès ou trunk)'
  ),
  defineCriterion(
    z.object({
      type: z.literal('firewallProfile'),
      device: z.string(),
      profile: z.enum(['Domain', 'Private', 'Public']),
      enabled: z.boolean().default(true)
    }),
    (state, check) => {
      const host = hostByName(state, check.device)
      return !!host && profileEnabled(host, check.profile) === (check.enabled !== false)
    },
    'Profil du pare-feu activé ou non'
  ),
  defineCriterion(
    z.object({
      type: z.literal('firewallRule'),
      device: z.string(),
      /** Nom affiché de la règle (sinon : toute règle correspondant aux autres paramètres). */
      displayName: z.string().optional(),
      direction: z.enum(['Inbound', 'Outbound']).default('Inbound'),
      action: z.enum(['Allow', 'Block']).optional(),
      protocol: z.enum(['Any', 'TCP', 'UDP', 'ICMPv4']).optional(),
      port: z.number().int().optional(),
      /** La règle doit être activée (false : désactivée ou absente). */
      enabled: z.boolean().default(true)
    }),
    (state, check) => {
      const host = hostByName(state, check.device)
      if (!host) return false
      const found = effectiveRules(host).some(
        (r) =>
          r.enabled &&
          r.direction === (check.direction ?? 'Inbound') &&
          (check.displayName === undefined || sameName(r.displayName, check.displayName)) &&
          (check.action === undefined || r.action === check.action) &&
          (check.protocol === undefined || r.protocol === check.protocol) &&
          (check.port === undefined || r.localPorts.includes(check.port))
      )
      return found === (check.enabled !== false)
    },
    'Règle du pare-feu'
  ),
  defineCriterion(
    z.object({ type: z.literal('featureInstalled'), device: z.string(), feature: z.string() }),
    (state, check) => !!hostByName(state, check.device)?.host.features.includes(check.feature),
    'Rôle ou fonctionnalité installé'
  ),
  defineCriterion(
    z.object({
      type: z.literal('serviceState'),
      device: z.string(),
      name: z.string(),
      running: z.boolean().optional(),
      startType: z.enum(['Automatic', 'Manual', 'Disabled']).optional()
    }),
    (state, check) => {
      const id = hostByName(state, check.device)?.id
      const s = id ? findComputerService(state, id, check.name) : undefined
      return (
        !!s &&
        (check.running === undefined || (s.status === 'Running') === check.running) &&
        (check.startType === undefined || s.startType === check.startType)
      )
    },
    'État d’un service système'
  ),
  defineCriterion(
    z.object({
      type: z.literal('localAccount'),
      device: z.string(),
      name: z.string(),
      enabled: z.boolean().optional(),
      memberOf: z.string().optional()
    }),
    (state, check) => {
      const id = hostByName(state, check.device)?.id
      const user = id ? findLocalUser(state, id, check.name) : undefined
      if (!id || !user) return false
      if (check.enabled !== undefined && user.enabled !== check.enabled) return false
      if (check.memberOf === undefined) return true
      return !!findLocalGroup(state, id, check.memberOf)?.members.some(
        (m) => m.toLowerCase() === user.name.toLowerCase()
      )
    },
    'Compte local (existence, état, groupe local)'
  ),
  defineCriterion(
    z.object({ type: z.literal('clockOffset'), device: z.string(), maxSeconds: z.number().int().min(0) }),
    (state, check) => {
      const id = hostByName(state, check.device)?.id
      return !!id && Math.abs(clockOffset(state, id)) <= check.maxSeconds
    },
    'Écart d’horloge d’un ordinateur'
  ),
  defineCriterion(
    z.object({ type: z.literal('faultRepaired'), faultId: z.string().optional() }),
    // Dépannage (mode panne) : toutes les pannes actives, ou celle d'identifiant `faultId`, sont guéries
    (state, check) => allRepaired(state, check.faultId),
    'Panne du mode dépannage réparée'
  )
]

let types: Map<string, CriterionType> | null = null

/** Types de critères disponibles (système de base + modules de rôles), par nom. */
export function criterionTypes(): Map<string, CriterionType> {
  return (types ??= new Map(
    [...CORE_CRITERIA, ...roleCriteria(), ...IOS_CRITERIA, ...CYBER_CRITERIA].map((c) => [c.type, c])
  ))
}

/** Vérification d'un critère : `type` plus les paramètres propres à ce type. */
export type Check = { type: string } & Record<string, unknown>

/** Union discriminée de tous les types de vérification (construite à la première validation). */
export const CheckSchema: z.ZodType<Check> = z.lazy(
  () =>
    z.discriminatedUnion(
      'type',
      [...criterionTypes().values()].map((c) => c.schema) as [z.ZodObject, ...z.ZodObject[]]
    ) as unknown as z.ZodType<Check>
)

export const CriterionSchema = z.object({
  id: z.string(),
  /** Ce qui est attendu, formulé pour l'étudiant. */
  label: z.string(),
  /** Indice affiché en cas d'échec : oriente sans donner la solution. */
  hint: z.string(),
  /** Indices suivants, de plus en plus précis, révélés un à un (éditeur de labs). */
  hints: z.array(z.string()).default([]),
  check: CheckSchema
})

export type Criterion = z.infer<typeof CriterionSchema>

/** Évalue une vérification sur l'état du lab (type inconnu → non validé). */
export function evaluateCheck(state: LabState, check: Check): boolean {
  return criterionTypes().get(check.type)?.evaluate(state, check) ?? false
}

export interface CriterionResult {
  id: string
  ok: boolean
}

/** Évalue tous les critères d'un lab. */
export function evaluateCriteria(state: LabState, criteria: Criterion[]): CriterionResult[] {
  return criteria.map((c) => ({ id: c.id, ok: evaluateCheck(state, c.check) }))
}
