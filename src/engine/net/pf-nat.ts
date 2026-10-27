/**
 * NAT d'un pare-feu pfSense CE 2.7 (v2.10, #244) : Firewall > NAT > Outbound (mode et règles) et
 * Port Forward (redirections de port avec règle de filtrage associée). Actions pures appelées par les
 * commandes nommées `pf.*` ; la traduction des paquets est dans `pf-nat-transit.ts`.
 */
import type { Draft } from 'immer'
import { raise, transact, type EngineResult } from '../core/result'
import { nextSeq } from '../model/factory'
import {
  PF_NAT_MODES,
  PfOutboundNatSchema,
  PfPortForwardSchema,
  PfRuleSchema,
  type PfIfaceKey,
  type PfOutboundNat,
  type PfPortForward,
  type PfPortRange,
  type PfState
} from '../model/firewall'
import type { LabState } from '../model/schema'
import { isIpv4 } from './ipv4'
import { requirePf, validateEndpoint } from './pf-rules'

// --- Clés de la table de traduction de l'opération (ctx.nat) -----------------------------------
// Préfixe `pf` : distinct des clés du NAT de RRAS et d'IOS, qui ne doivent pas retraduire ces paquets.

/** NAT sortant : (équipement, adresse publique, hôte distant) → adresse source d'origine. */
export const natOutKey = (deviceId: string, pub: string, remote: string): string =>
  `pf|${deviceId}|${pub}|${remote}`
/** Redirection : (équipement, client, adresse interne) → adresse publique visée par le client. */
export const rdrKey = (deviceId: string, client: string, internal: string): string =>
  `pf-rdr|${deviceId}|${client}|${internal}`
/** Redirection : (équipement, client, adresse publique) → adresse interne. */
export const rdrBackKey = (deviceId: string, client: string, pub: string): string =>
  `pf-rdr-back|${deviceId}|${client}|${pub}`
/** Redirection : (équipement, client, adresse interne) → libellé de la traduction (table d'états). */
export const rdrTextKey = (deviceId: string, client: string, internal: string): string =>
  `pf-rdr-txt|${deviceId}|${client}|${internal}`

// --- NAT sortant --------------------------------------------------------------------------------

export type PfNatMode = (typeof PF_NAT_MODES)[number]

/** Règle de NAT sortant à créer (Firewall > NAT > Outbound > Add). */
export type PfOutboundNatInput = Partial<Omit<PfOutboundNat, 'id' | 'iface' | 'source'>> &
  Pick<PfOutboundNat, 'source'> & { iface?: PfIfaceKey }
export type PfOutboundNatPatch = Partial<Omit<PfOutboundNat, 'id'>>

/** Mode de NAT sortant (Automatic, Hybrid, Manual, Disable). */
export function setPfNatMode(state: LabState, deviceId: string, mode: PfNatMode): EngineResult<void> {
  return transact(state, (draft) => {
    const pf = requirePf(draft, deviceId)
    if (!PF_NAT_MODES.includes(mode))
      raise('InvalidNatMode', `Le mode de NAT sortant « ${mode} » n’existe pas.`)
    pf.nat.outboundMode = mode
  })
}

function validateOutbound(pf: PfState, rule: PfOutboundNat): void {
  if (!pf.assignments.some((a) => a.key === rule.iface))
    raise('InterfaceNotFound', `L’interface « ${rule.iface} » n’existe pas sur ce pare-feu.`)
  validateEndpoint(pf, rule.source, 'source')
  validateEndpoint(pf, rule.destination, 'destination')
  if (rule.translation !== null && !isIpv4(rule.translation))
    raise(
      'InvalidAddress',
      `L’adresse de traduction « ${rule.translation} » n’est pas une adresse IPv4 valide.`
    )
}

function parseOutbound(input: unknown, id: string): PfOutboundNat {
  const parsed = PfOutboundNatSchema.safeParse({ iface: 'wan', ...(input as object), id })
  if (!parsed.success)
    raise(
      'InvalidNat',
      `Règle de NAT sortant invalide : ${parsed.error.issues[0]?.message ?? 'paramètres incorrects'}.`
    )
  return parsed.data
}

/** Ajoute une règle de NAT sortant (prise en compte en mode Hybrid ou Manual). Renvoie son identifiant. */
export function addPfOutboundNat(
  state: LabState,
  deviceId: string,
  input: PfOutboundNatInput
): EngineResult<string> {
  return transact(state, (draft) => {
    const pf = requirePf(draft, deviceId)
    const id = `pfo${nextSeq(draft)}`
    const rule = parseOutbound(input, id)
    validateOutbound(pf, rule)
    pf.nat.outbound.push(rule)
    return id
  })
}

function outboundIndex(pf: PfState, id: string): number {
  const index = pf.nat.outbound.findIndex((r) => r.id === id)
  if (index < 0) raise('NatRuleNotFound', `La règle de NAT sortant « ${id} » n’existe pas.`)
  return index
}

export function updatePfOutboundNat(
  state: LabState,
  deviceId: string,
  id: string,
  patch: PfOutboundNatPatch
): EngineResult<void> {
  return transact(state, (draft) => {
    const pf = requirePf(draft, deviceId)
    const index = outboundIndex(pf, id)
    const { id: _ignored, ...current } = pf.nat.outbound[index] as PfOutboundNat
    void _ignored
    const rule = parseOutbound({ ...current, ...patch }, id)
    validateOutbound(pf, rule)
    pf.nat.outbound[index] = rule
  })
}

export function removePfOutboundNat(state: LabState, deviceId: string, id: string): EngineResult<void> {
  return transact(state, (draft) => {
    const pf = requirePf(draft, deviceId)
    pf.nat.outbound.splice(outboundIndex(pf, id), 1)
  })
}

// --- Redirections de port -----------------------------------------------------------------------

/** Redirection à créer (Firewall > NAT > Port Forward > Add) : la règle associée est créée par défaut. */
export type PfPortForwardInput = Partial<Omit<PfPortForward, 'id' | 'ruleId' | 'iface' | 'protocol'>> &
  Pick<PfPortForward, 'protocol' | 'targetAddress'> & {
    iface?: PfIfaceKey
    destinationPort: NonNullable<PfPortRange>
  }
export type PfPortForwardPatch = Partial<Omit<PfPortForward, 'id' | 'ruleId'>>

function parseForward(input: unknown, id: string, ruleId: string | null | undefined): PfPortForward {
  const parsed = PfPortForwardSchema.safeParse({
    iface: 'wan',
    ...(input as object),
    id,
    ruleId: ruleId ?? null
  })
  if (!parsed.success)
    raise(
      'InvalidNat',
      `Redirection de port invalide : ${parsed.error.issues[0]?.message ?? 'paramètres incorrects'}.`
    )
  return parsed.data
}

const portText = (range: { from: number; to: number }): string =>
  range.from === range.to ? String(range.from) : `${range.from}-${range.to}`

const protocolsOverlap = (a: string, b: string): boolean => a === b || a === 'tcp/udp' || b === 'tcp/udp'

function validateForward(pf: PfState, fwd: PfPortForward): void {
  if (!pf.assignments.some((a) => a.key === fwd.iface))
    raise('InterfaceNotFound', `L’interface « ${fwd.iface} » n’existe pas sur ce pare-feu.`)
  validateEndpoint(pf, fwd.destination, 'destination')
  const range = fwd.destinationPort
  if (!range) raise('InvalidPort', 'Le port de destination est obligatoire pour une redirection de port.')
  if (range.from > range.to)
    raise(
      'InvalidPort',
      `La plage de ports de destination est invalide : ${range.from} est supérieur à ${range.to}.`
    )
  if (!isIpv4(fwd.targetAddress))
    raise('InvalidAddress', `L’adresse IP cible « ${fwd.targetAddress} » n’est pas une adresse IPv4 valide.`)
  const target = fwd.targetPort ?? range.from
  const last = target + (range.to - range.from)
  if (last > 65535) raise('InvalidPort', `La plage de ports cible dépasse 65535 (${target} à ${last}).`)
  // Deux redirections ne peuvent pas viser le même port de la même adresse sur la même interface
  const clash = pf.nat.portForwards.find(
    (o) =>
      o.id !== fwd.id &&
      !o.disabled &&
      !fwd.disabled &&
      o.iface === fwd.iface &&
      JSON.stringify(o.destination) === JSON.stringify(fwd.destination) &&
      o.destinationPort !== null &&
      protocolsOverlap(o.protocol, fwd.protocol) &&
      o.destinationPort.from <= range.to &&
      range.from <= o.destinationPort.to
  )
  if (clash)
    raise(
      'PortForwardConflict',
      `Le port ${portText(range)} est déjà redirigé par la règle « ${clash.id} » sur cette interface.`
    )
}

/** Règle de filtrage associée à une redirection (Filter rule association : Add associated filter rule). */
function associatedRule(fwd: PfPortForward, ruleId: string) {
  const range = fwd.destinationPort as { from: number; to: number }
  const target = fwd.targetPort ?? range.from
  return PfRuleSchema.parse({
    id: ruleId,
    iface: fwd.iface,
    action: 'pass',
    disabled: fwd.disabled,
    protocol: fwd.protocol,
    source: { type: 'any' },
    destination: { type: 'address', address: fwd.targetAddress },
    destinationPort: { from: target, to: target + (range.to - range.from) },
    descr: `NAT ${fwd.descr}`.trim()
  })
}

/** Aligne la règle associée sur la redirection : création, mise à jour sur place ou suppression. */
function syncAssociatedRule(draft: Draft<LabState>, pf: PfState, fwd: PfPortForward): void {
  const index = fwd.ruleId ? pf.rules.findIndex((r) => r.id === fwd.ruleId) : -1
  if (!fwd.associatedRule) {
    if (index >= 0) pf.rules.splice(index, 1)
    fwd.ruleId = null
    return
  }
  const ruleId = fwd.ruleId && index >= 0 ? fwd.ruleId : `pfr${nextSeq(draft)}`
  const rule = associatedRule(fwd, ruleId)
  if (index >= 0) pf.rules[index] = rule
  else pf.rules.push(rule)
  fwd.ruleId = ruleId
}

function forwardIndex(pf: PfState, id: string): number {
  const index = pf.nat.portForwards.findIndex((r) => r.id === id)
  if (index < 0) raise('NatRuleNotFound', `La redirection de port « ${id} » n’existe pas.`)
  return index
}

/** Ajoute une redirection de port et, par défaut, sa règle de filtrage Pass. Renvoie l'identifiant. */
export function addPfPortForward(
  state: LabState,
  deviceId: string,
  input: PfPortForwardInput
): EngineResult<string> {
  return transact(state, (draft) => {
    const pf = requirePf(draft, deviceId)
    const id = `pfn${nextSeq(draft)}`
    const fwd = parseForward(input, id, null)
    validateForward(pf, fwd)
    syncAssociatedRule(draft, pf, fwd)
    pf.nat.portForwards.push(fwd)
    return id
  })
}

/** Modifie une redirection ; la règle associée suit (ou disparaît si l'association est retirée). */
export function updatePfPortForward(
  state: LabState,
  deviceId: string,
  id: string,
  patch: PfPortForwardPatch
): EngineResult<void> {
  return transact(state, (draft) => {
    const pf = requirePf(draft, deviceId)
    const index = forwardIndex(pf, id)
    const { id: _ignored, ruleId, ...current } = pf.nat.portForwards[index] as PfPortForward
    void _ignored
    const fwd = parseForward({ ...current, ...patch }, id, ruleId)
    validateForward(pf, fwd)
    syncAssociatedRule(draft, pf, fwd)
    pf.nat.portForwards[index] = fwd
  })
}

/** Supprime une redirection et sa règle de filtrage associée. */
export function removePfPortForward(state: LabState, deviceId: string, id: string): EngineResult<void> {
  return transact(state, (draft) => {
    const pf = requirePf(draft, deviceId)
    const index = forwardIndex(pf, id)
    const ruleId = pf.nat.portForwards[index]?.ruleId
    const ruleIndex = ruleId ? pf.rules.findIndex((r) => r.id === ruleId) : -1
    if (ruleIndex >= 0) pf.rules.splice(ruleIndex, 1)
    pf.nat.portForwards.splice(index, 1)
  })
}
