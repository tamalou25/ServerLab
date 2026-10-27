/**
 * Actions pures sur les règles, alias et blocages automatiques d'un pare-feu pfSense (v2.10, #243) :
 * Firewall > Rules, Firewall > Aliases, Interfaces > WAN (Block private / bogon networks).
 * Appelées par les commandes nommées `pf.*` (commands/catalog.ts) ; l'annulation vient des patches immer.
 */
import { raise, transact, type EngineResult } from '../core/result'
import { nextSeq } from '../model/factory'
import {
  PF_IFACE_KEYS,
  PfAliasSchema,
  PfRuleSchema,
  type PfAlias,
  type PfEndpoint,
  type PfIfaceKey,
  type PfRule,
  type PfState
} from '../model/firewall'
import type { LabState } from '../model/schema'
import { isIpv4 } from './ipv4'
import type { Draft } from 'immer'

/** Règle à créer ou à modifier : tout sauf l'identifiant (valeurs par défaut de pfSense pour le reste). */
export type PfRuleInput = Partial<Omit<PfRule, 'id' | 'iface'>> & { iface: PfIfaceKey }
export type PfRulePatch = Partial<Omit<PfRule, 'id'>>

/** Pare-feu de l'état, ou erreur métier si l'équipement n'en est pas un. */
function requirePf(draft: Draft<LabState>, deviceId: string): PfState {
  const device = draft.devices[deviceId]
  if (!device) raise('DeviceNotFound', 'Équipement introuvable.')
  if (device.kind !== 'firewall') raise('NotAFirewall', `${device.name} n’est pas un pare-feu pfSense.`)
  return device.pf as PfState
}

const PORT_PROTOCOLS = ['tcp', 'udp', 'tcp/udp']

function validateEndpoint(pf: PfState, endpoint: PfEndpoint, role: 'source' | 'destination'): void {
  const where = role === 'source' ? 'source' : 'destination'
  if (endpoint.type === 'address' && !isIpv4(endpoint.address))
    raise('InvalidAddress', `L’adresse ${where} « ${endpoint.address} » n’est pas une adresse IPv4 valide.`)
  if (endpoint.type === 'network' && !isIpv4(endpoint.address))
    raise('InvalidAddress', `Le réseau ${where} « ${endpoint.address} » n’est pas une adresse IPv4 valide.`)
  if (endpoint.type === 'alias') {
    const alias = pf.aliases.find((a) => a.name === endpoint.name)
    if (!alias) raise('AliasNotFound', `L’alias « ${endpoint.name} » n’existe pas.`)
    if (alias.type === 'port')
      raise(
        'InvalidAlias',
        `L’alias « ${endpoint.name} » est un alias de ports : il ne peut pas servir de ${where}.`
      )
  }
}

/** Contrôles d'une règle complète avant enregistrement. */
function validateRule(pf: PfState, rule: PfRule): void {
  if (!pf.assignments.some((a) => a.key === rule.iface))
    raise('InterfaceNotFound', `L’interface « ${rule.iface} » n’existe pas sur ce pare-feu.`)
  validateEndpoint(pf, rule.source, 'source')
  validateEndpoint(pf, rule.destination, 'destination')
  for (const [label, range] of [
    ['source', rule.sourcePort],
    ['de destination', rule.destinationPort]
  ] as const) {
    if (!range) continue
    if (!PORT_PROTOCOLS.includes(rule.protocol))
      raise('InvalidRule', `Un port ${label} n’a de sens qu’avec le protocole TCP, UDP ou TCP/UDP.`)
    if (range.from > range.to)
      raise(
        'InvalidPort',
        `La plage de ports ${label} est invalide : ${range.from} est supérieur à ${range.to}.`
      )
  }
}

function parseRule(input: unknown, id: string): PfRule {
  const parsed = PfRuleSchema.safeParse({ action: 'pass', ...(input as object), id })
  if (!parsed.success)
    raise(
      'InvalidRule',
      `Règle de pare-feu invalide : ${parsed.error.issues[0]?.message ?? 'paramètres incorrects'}.`
    )
  return parsed.data
}

/** Position d'une règle dans la liste, ou erreur. */
function indexOfRule(pf: PfState, ruleId: string): number {
  const index = pf.rules.findIndex((r) => r.id === ruleId)
  if (index < 0) raise('RuleNotFound', `La règle « ${ruleId} » n’existe pas.`)
  return index
}

/**
 * Ajoute une règle (Firewall > Rules > Add). Sans `beforeRuleId`, elle est placée en dernier ; sinon
 * juste avant la règle indiquée. Renvoie l'identifiant de la règle.
 */
export function addPfRule(
  state: LabState,
  deviceId: string,
  input: PfRuleInput,
  beforeRuleId: string | null = null
): EngineResult<string> {
  return transact(state, (draft) => {
    const pf = requirePf(draft, deviceId)
    const id = `pfr${nextSeq(draft)}`
    const rule = parseRule(input, id)
    validateRule(pf, rule)
    const at = beforeRuleId === null ? pf.rules.length : indexOfRule(pf, beforeRuleId)
    pf.rules.splice(at, 0, rule)
    return id
  })
}

/** Modifie une règle (action, protocole, adresses, ports, journalisation, désactivation…). */
export function updatePfRule(
  state: LabState,
  deviceId: string,
  ruleId: string,
  patch: PfRulePatch
): EngineResult<void> {
  return transact(state, (draft) => {
    const pf = requirePf(draft, deviceId)
    const index = indexOfRule(pf, ruleId)
    const { id: _ignored, ...current } = pf.rules[index] as PfRule
    void _ignored
    const rule = parseRule({ ...current, ...patch }, ruleId)
    validateRule(pf, rule)
    pf.rules[index] = rule
  })
}

/** Supprime une règle. */
export function removePfRule(state: LabState, deviceId: string, ruleId: string): EngineResult<void> {
  return transact(state, (draft) => {
    const pf = requirePf(draft, deviceId)
    pf.rules.splice(indexOfRule(pf, ruleId), 1)
  })
}

/**
 * Déplace une règle juste avant `beforeRuleId` (null : en dernier). L'ordre compte : la première
 * règle qui correspond s'applique.
 */
export function movePfRule(
  state: LabState,
  deviceId: string,
  ruleId: string,
  beforeRuleId: string | null
): EngineResult<void> {
  return transact(state, (draft) => {
    const pf = requirePf(draft, deviceId)
    if (beforeRuleId === ruleId) return
    const [rule] = pf.rules.splice(indexOfRule(pf, ruleId), 1)
    const at = beforeRuleId === null ? pf.rules.length : indexOfRule(pf, beforeRuleId)
    pf.rules.splice(at, 0, rule as PfRule)
  })
}

// --- Alias --------------------------------------------------------------------------------------

const ALIAS_NAME = /^[A-Za-z][A-Za-z0-9_]{0,30}$/

/** Valide une valeur d'alias : adresse, CIDR ou nom d'un autre alias (hôtes, réseaux) ; port ou plage (ports). */
function validateAliasValue(pf: PfState, alias: PfAlias, value: string): void {
  if (alias.type === 'port') {
    const m = /^(\d{1,5})(?::(\d{1,5}))?$/.exec(value)
    const [from, to] = [Number(m?.[1]), Number(m?.[2] ?? m?.[1])]
    if (!m || from < 1 || to > 65535 || from > to)
      raise('InvalidPort', `« ${value} » n’est pas un port ou une plage de ports valide (1 à 65535).`)
    return
  }
  const [address = '', prefix] = value.split('/')
  if (isIpv4(address)) {
    const length = Number(prefix)
    if (prefix !== undefined && (!Number.isInteger(length) || length < 0 || length > 32))
      raise('InvalidAddress', `Le masque de « ${value} » est invalide (0 à 32).`)
    if (alias.type === 'host' && prefix !== undefined && length !== 32)
      raise('InvalidAddress', `Un alias d’hôtes ne contient que des adresses : « ${value} » est un réseau.`)
    return
  }
  const nested = pf.aliases.find((a) => a.name === value)
  if (!nested || nested.type === 'port' || nested.name === alias.name)
    raise(
      'InvalidAddress',
      `« ${value} » n’est ni une adresse IPv4 ni un alias de ${alias.type === 'host' ? 'machines' : 'réseaux'} existant.`
    )
}

/** Crée ou remplace un alias (Firewall > Aliases). */
export function setPfAlias(state: LabState, deviceId: string, input: PfAlias): EngineResult<void> {
  return transact(state, (draft) => {
    const pf = requirePf(draft, deviceId)
    const parsed = PfAliasSchema.safeParse(input)
    if (!parsed.success) raise('InvalidAlias', 'Alias invalide : type ou valeurs incorrects.')
    const alias = parsed.data
    if (!ALIAS_NAME.test(alias.name))
      raise(
        'InvalidAlias',
        'Le nom d’un alias commence par une lettre et ne contient que des lettres, des chiffres et des tirets bas (31 caractères au plus).'
      )
    for (const value of alias.values) validateAliasValue(pf, alias, value)
    const index = pf.aliases.findIndex((a) => a.name === alias.name)
    if (index >= 0) pf.aliases[index] = alias
    else pf.aliases.push(alias)
  })
}

/** Supprime un alias, sauf s'il est utilisé par une règle ou par un autre alias. */
export function removePfAlias(state: LabState, deviceId: string, name: string): EngineResult<void> {
  return transact(state, (draft) => {
    const pf = requirePf(draft, deviceId)
    const index = pf.aliases.findIndex((a) => a.name === name)
    if (index < 0) raise('AliasNotFound', `L’alias « ${name} » n’existe pas.`)
    const used = (e: PfEndpoint) => e.type === 'alias' && e.name === name
    if (pf.rules.some((r) => used(r.source) || used(r.destination)))
      raise(
        'AliasInUse',
        `L’alias « ${name} » est utilisé par une règle : supprimez-la ou modifiez-la d’abord.`
      )
    if (pf.aliases.some((a) => a.values.includes(name)))
      raise('AliasInUse', `L’alias « ${name} » est utilisé par un autre alias.`)
    pf.aliases.splice(index, 1)
  })
}

// --- Blocages automatiques et journal -------------------------------------------------------------

/** Cases « Block private networks and loopback addresses » et « Block bogon networks » d'une interface. */
export function setPfBlockNetworks(
  state: LabState,
  deviceId: string,
  key: PfIfaceKey,
  options: { blockPrivate?: boolean; blockBogons?: boolean }
): EngineResult<void> {
  return transact(state, (draft) => {
    const pf = requirePf(draft, deviceId)
    if (!PF_IFACE_KEYS.includes(key)) raise('InterfaceNotFound', `L’interface « ${key} » n’existe pas.`)
    const assignment = pf.assignments.find((a) => a.key === key)
    if (!assignment) raise('InterfaceNotFound', `L’interface « ${key} » n’existe pas sur ce pare-feu.`)
    if (options.blockPrivate !== undefined) assignment.blockPrivate = options.blockPrivate
    if (options.blockBogons !== undefined) assignment.blockBogons = options.blockBogons
  })
}

/** Vide le journal du pare-feu (Status > System Logs > Settings > Clear log). */
export function clearPfLog(state: LabState, deviceId: string): EngineResult<void> {
  return transact(state, (draft) => {
    requirePf(draft, deviceId).log = []
  })
}

/** Vide la table d'états (Diagnostics > States > Reset States). */
export function resetPfStates(state: LabState, deviceId: string): EngineResult<void> {
  return transact(state, (draft) => {
    requirePf(draft, deviceId).states = []
  })
}
