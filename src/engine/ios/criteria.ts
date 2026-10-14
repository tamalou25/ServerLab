/**
 * Critères de lab propres aux équipements Cisco IOS : ils lisent l'état IOS (configuration
 * générée, interfaces, routes, voisinages, traductions…) avec les mêmes fonctions que la console.
 * Les critères du système de base (ping, adresse d'interface, VLAN, DHCP…) servent aussi aux labs IOS.
 */
import { z } from 'zod'
import type { LabState } from '../model/schema'
import { routingTable } from '../net/routing'
import { networkAddress } from '../net/ipv4'
import { byName } from '../labs/lookup'
import { defineCriterion, type CriterionType } from '../roles/types'
import { configModified, iosState } from './config'
import { isIos, type IosDevice } from './device'
import { configBody, showStartupConfig } from './running-config'
import { ospfDatabase } from './ospf'
import { ifaceStatus } from './status'

function iosDevice(state: LabState, name: string): IosDevice | null {
  const device = byName(state, name)
  return isIos(device) ? device : null
}

/** Lignes de la startup-config enregistrée (même mise en forme que show startup-config). */
function startupLines(state: LabState, device: IosDevice): string[] {
  return showStartupConfig(device, state).map((l) => l.trim().replace(/\s+/g, ' '))
}

const sameLine = (a: string, b: string): boolean =>
  a.trim().replace(/\s+/g, ' ') === b.trim().replace(/\s+/g, ' ')

/** Lignes de la configuration en cours de l'équipement (comparaison sans espaces superflus). */
function runningLines(state: LabState, device: IosDevice): string[] {
  return configBody(device, state).map((l) => l.trim().replace(/\s+/g, ' '))
}

/** Interface IOS désignée par son nom court (Gi0/0, Gi0/0.10, Vl10) ou long. */
function ifaceOf(device: IosDevice, name: string) {
  const short = name
    .replace(/^GigabitEthernet/i, 'Gi')
    .replace(/^FastEthernet/i, 'Fa')
    .replace(/^Vlan/i, 'Vl')
  return device.interfaces.find((i) => i.name.toLowerCase() === short.toLowerCase())
}

export const IOS_CRITERIA: CriterionType[] = [
  defineCriterion(
    z.object({
      type: z.literal('iosRunning'),
      device: z.string(),
      /** Ligne de la running-config (indentation ignorée). */
      line: z.string(),
      /** false : la ligne ne doit pas figurer dans la configuration. */
      present: z.boolean().default(true),
      /** prefix : la ligne commence par le texte donné (mots de passe hachés, bannières…). */
      match: z.enum(['exact', 'prefix']).default('exact')
    }),
    (state, check) => {
      const device = iosDevice(state, check.device)
      if (!device) return false
      const wanted = check.line.trim().replace(/\s+/g, ' ')
      const found = runningLines(state, device).some((l) =>
        check.match === 'prefix' ? l.startsWith(wanted) : sameLine(l, check.line)
      )
      return found === (check.present !== false)
    },
    'Ligne de la running-config d’un équipement Cisco'
  ),
  defineCriterion(
    z.object({
      type: z.literal('iosStartup'),
      device: z.string(),
      /** Ligne que la startup-config doit contenir (sinon : une startup-config à jour suffit). */
      line: z.string().optional()
    }),
    (state, check) => {
      const device = iosDevice(state, check.device)
      const startup = device ? iosState(device).startup : null
      if (!device || !startup) return false
      if (check.line === undefined) return !configModified(device)
      return startupLines(state, device).some((l) => sameLine(l, check.line ?? ''))
    },
    'Configuration enregistrée (startup-config)'
  ),
  defineCriterion(
    z.object({
      type: z.literal('iosInterface'),
      device: z.string(),
      interface: z.string(),
      state: z.enum(['up', 'down', 'admin-down', 'err-disabled']).default('up')
    }),
    (state, check) => {
      const device = iosDevice(state, check.device)
      const iface = device ? ifaceOf(device, check.interface) : undefined
      if (!device || !iface) return false
      const s = ifaceStatus(state, device, iface)
      switch (check.state) {
        case 'up':
          return s.status === 'up' && s.protocol === 'up'
        case 'admin-down':
          return s.status === 'administratively down'
        case 'err-disabled':
          return !!s.errDisabled
        default:
          return s.status === 'down' && !s.errDisabled
      }
    },
    'État d’une interface Cisco (up/up, down, administrativement coupée, err-disabled)'
  ),
  defineCriterion(
    z.object({
      type: z.literal('iosRoute'),
      device: z.string(),
      network: z.string(),
      prefixLength: z.number().int().min(0).max(32),
      /** Origine de la route : connectée, statique, par défaut ou OSPF. */
      source: z.enum(['connected', 'static', 'default', 'ospf', 'rip']).optional(),
      /** Prochain saut attendu. */
      via: z.string().optional()
    }),
    (state, check) => {
      const device = iosDevice(state, check.device)
      if (!device) return false
      return routingTable(state, device).some(
        (r) =>
          networkAddress(r.network, r.prefixLength) === check.network &&
          r.prefixLength === check.prefixLength &&
          (check.source === undefined || r.source === check.source) &&
          (check.via === undefined || r.gateway === check.via)
      )
    },
    'Route présente dans la table de routage d’un équipement Cisco'
  ),
  defineCriterion(
    z.object({
      type: z.literal('iosOspfNeighbors'),
      device: z.string(),
      minNeighbors: z.number().int().min(1)
    }),
    (state, check) => {
      const device = iosDevice(state, check.device)
      return !!device && (ospfDatabase(state).neighbors.get(device.id)?.length ?? 0) >= check.minNeighbors
    },
    'Nombre de voisins OSPF'
  ),
  defineCriterion(
    z.object({
      type: z.literal('iosHsrp'),
      device: z.string(),
      interface: z.string(),
      group: z.number().int().min(0).max(255),
      state: z.enum(['Active', 'Standby'])
    }),
    (state, check) => {
      const device = iosDevice(state, check.device)
      const iface = device ? ifaceOf(device, check.interface) : undefined
      return (
        !!device && !!iface && iosState(device).hsrpStates[`${iface.name}|${check.group}`] === check.state
      )
    },
    'Rôle HSRP d’une interface (Active ou Standby)'
  ),
  defineCriterion(
    z.object({
      type: z.literal('iosNat'),
      device: z.string(),
      minTranslations: z.number().int().min(1).default(1)
    }),
    (state, check) => {
      const device = iosDevice(state, check.device)
      return !!device && iosState(device).natTranslations.length >= check.minTranslations
    },
    'Traductions NAT actives'
  ),
  defineCriterion(
    z.object({
      type: z.literal('iosDhcpBindings'),
      device: z.string(),
      minBindings: z.number().int().min(1).default(1)
    }),
    (state, check) => {
      const device = iosDevice(state, check.device)
      const scopes = device ? (iosState(device).dhcpServer?.scopes ?? []) : []
      return (
        scopes.reduce((n, s) => n + s.leases.filter((l) => l.state === 'Active').length, 0) >=
        check.minBindings
      )
    },
    'Baux du serveur DHCP d’un équipement Cisco'
  ),
  defineCriterion(
    z.object({
      type: z.literal('iosPortSecurity'),
      device: z.string(),
      interface: z.string(),
      /** Violation constatée (port err-disabled) ou non. */
      violated: z.boolean().default(true)
    }),
    (state, check) => {
      const device = iosDevice(state, check.device)
      const iface = device ? ifaceOf(device, check.interface) : undefined
      const entry = device && iface ? iosState(device).interfaces[iface.name] : undefined
      if (!entry?.portSecurity?.enabled) return false
      return entry.portSecurity.violations > 0 === (check.violated !== false)
    },
    'Violation de port-security sur un port'
  )
]
