/**
 * Types d'arguments de la CLI IOS (reconnaissance, aide, complétion).
 */
import { parseIpv4 } from '../../net/ipv4'
import type { ArgContext, ArgType } from './types'

const single = (test: (token: string) => boolean): ArgType['match'] => {
  return (tokens, index) => {
    const token = tokens[index]
    return token !== undefined && test(token) ? { consumed: 1, value: token } : null
  }
}

/** Mot quelconque (nom, mot de passe…). */
export const WORD: ArgType = { label: 'WORD', match: single(() => true) }

/** Texte libre jusqu'à la fin de la ligne (bannière, description). */
export const LINE: ArgType = {
  label: 'LINE',
  rest: true,
  match: (tokens, index) =>
    index < tokens.length ? { consumed: tokens.length - index, value: tokens.slice(index).join(' ') } : null
}

/** Entier borné : <1-4094>. */
export function number(min: number, max: number): ArgType {
  return {
    label: `<${min}-${max}>`,
    match: single((t) => /^\d+$/.test(t) && Number(t) >= min && Number(t) <= max)
  }
}

/** Adresse IPv4 (A.B.C.D). */
export const IPV4: ArgType = { label: 'A.B.C.D', match: single((t) => parseIpv4(t) !== null) }

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

interface IfaceTypeInfo {
  long: string
  short: string
  help: string
}

const IFACE_TYPES: IfaceTypeInfo[] = [
  { long: 'FastEthernet', short: 'Fa', help: 'FastEthernet IEEE 802.3' },
  { long: 'GigabitEthernet', short: 'Gi', help: 'GigabitEthernet IEEE 802.3z' },
  { long: 'Vlan', short: 'Vl', help: 'Catalyst Vlans' }
]

export interface IfaceArgOptions {
  /** Sous-interfaces acceptées (Gi0/0.10). */
  subinterfaces?: boolean
  /** Interfaces VLAN acceptées (interface vlan 10). */
  vlans?: boolean
}

/** Types d'interface présents sur l'équipement (Vlan : switchs). */
function deviceIfaceTypes(ctx: ArgContext, options: IfaceArgOptions): IfaceTypeInfo[] {
  const device = ctx.state.devices[ctx.deviceId]
  if (!device) return []
  const prefixes = new Set(device.interfaces.map((i) => i.name.replace(/[\d/.]+$/, '')))
  return IFACE_TYPES.filter(
    (t) => prefixes.has(t.short) || (t.short === 'Vl' && !!options.vlans && device.kind === 'switch')
  )
}

/** Type d'interface désigné par un préfixe (g, gi, Gigabit…), null si inconnu ou ambigu. */
function resolveIfaceType(prefix: string, ctx: ArgContext, options: IfaceArgOptions): IfaceTypeInfo | null {
  const lower = prefix.toLowerCase()
  const found = deviceIfaceTypes(ctx, options).filter((t) => t.long.toLowerCase().startsWith(lower))
  return found.length === 1 ? (found[0] ?? null) : null
}

/**
 * Interface désignée comme sur IOS : `g0/0`, `gi 0/0`, `GigabitEthernet0/0.10`, `vlan 10`.
 * Valeur : nom court du moteur (Gi0/0, Gi0/0.10, Vl10). Le port physique doit exister.
 */
export function iface(options: IfaceArgOptions = {}): ArgType {
  return {
    label: 'interface',
    match: (tokens, index, ctx) => {
      const first = tokens[index]
      if (first === undefined) return null
      const joined = /^([A-Za-z]+)(\d.*)$/.exec(first)
      let prefix: string
      let num: string
      let consumed: number
      if (joined) {
        prefix = joined[1] as string
        num = joined[2] as string
        consumed = 1
      } else {
        const next = tokens[index + 1]
        if (!/^[A-Za-z]+$/.test(first) || next === undefined || !/^\d/.test(next)) return null
        prefix = first
        num = next
        consumed = 2
      }
      const type = resolveIfaceType(prefix, ctx, options)
      if (!type) return null
      if (type.short === 'Vl') {
        if (!options.vlans || !/^\d+$/.test(num) || Number(num) < 1 || Number(num) > 4094) return null
        return { consumed, value: `Vl${Number(num)}` }
      }
      const m = /^(\d+(?:\/\d+)+)(?:\.(\d+))?$/.exec(num)
      if (!m) return null
      const physical = `${type.short}${m[1]}`
      const device = ctx.state.devices[ctx.deviceId]
      if (!device?.interfaces.some((i) => i.name === physical && !i.subinterface)) return null
      if (m[2] === undefined) return { consumed, value: physical }
      if (!options.subinterfaces || device.kind !== 'router' || Number(m[2]) < 1) return null
      return { consumed, value: `${physical}.${Number(m[2])}` }
    },
    helpEntries: (ctx) => deviceIfaceTypes(ctx, options).map((t) => ({ word: t.long, help: t.help })),
    complete: (partial, ctx) =>
      deviceIfaceTypes(ctx, options)
        .map((t) => t.long)
        .filter((w) => w.toLowerCase().startsWith(partial.toLowerCase()))
  }
}

/** Liste de VLAN « 10,20,30-35 » développée (null si invalide). */
export function parseVlanList(text: string): number[] | null {
  const ids = new Set<number>()
  for (const part of text.split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part)
    if (!m) return null
    const from = Number(m[1])
    const to = m[2] === undefined ? from : Number(m[2])
    if (from < 1 || to > 4094 || from > to) return null
    for (let id = from; id <= to; id++) ids.add(id)
  }
  return [...ids].sort((a, b) => a - b)
}

/** Liste de VLAN (vlan 10,20 ; switchport trunk allowed vlan 10,20,30-35). */
export function vlanList(label = 'WORD'): ArgType {
  return { label, match: single((t) => parseVlanList(t) !== null) }
}

/** Liste compacte « 1,10,20-25 » d'identifiants triés. */
export function formatVlanList(ids: readonly number[]): string {
  const parts: string[] = []
  let i = 0
  while (i < ids.length) {
    let j = i
    while (j + 1 < ids.length && (ids[j + 1] as number) === (ids[j] as number) + 1) j++
    parts.push(j > i ? `${ids[i]}-${ids[j]}` : String(ids[i]))
    i = j + 1
  }
  return parts.join(',')
}

// ---------------------------------------------------------------------------
// Plages d'interfaces (interface range)
// ---------------------------------------------------------------------------

/** Nombre maximal de plages d'une commande interface range (guide 2960, IOS 15.0(2)SE). */
export const MAX_IFACE_RANGES = 5

/** Résultat de l'analyse d'une plage : ports désignés, jeton fautif ou élément non simulé. */
export type IfaceRangeParse =
  | { kind: 'ok'; names: string[] }
  | { kind: 'invalid'; index: number }
  | { kind: 'unsimulated'; name: string }

/**
 * Analyse `fa0/1 - 5 , gi0/1 - 2` à partir de tokens[index] : jusqu'à cinq plages séparées par
 * une virgule, espace obligatoire avant le tiret (`fa0/1-5` est refusé), ports existants de
 * l'équipement. Plages de VLAN et de sous-interfaces : non simulées.
 */
export function parseIfaceRange(tokens: readonly string[], index: number, ctx: ArgContext): IfaceRangeParse {
  const device = ctx.state.devices[ctx.deviceId]
  const exists = (name: string): boolean =>
    !!device?.interfaces.some((i) => i.name === name && !i.subinterface && !i.svi)
  const names: string[] = []
  let i = index
  for (let group = 1; ; group++) {
    if (group > MAX_IFACE_RANGES) return { kind: 'invalid', index: i }
    const first = tokens[i]
    if (first === undefined) return { kind: 'invalid', index: i }
    // Type et numéro : « fa0/1 » ou « fa 0/1 »
    const joined = /^([A-Za-z]+)(\d.*)$/.exec(first)
    if (!joined && !/^[A-Za-z]+$/.test(first)) return { kind: 'invalid', index: i }
    const prefix = joined ? (joined[1] as string) : first
    const numIndex = joined ? i : i + 1
    const type = resolveIfaceType(prefix, ctx, { vlans: true })
    if (!type) return { kind: 'invalid', index: i }
    if (type.short === 'Vl') return { kind: 'unsimulated', name: 'interface range vlan' }
    let num = joined ? (joined[2] as string) : tokens[numIndex]
    if (num === undefined) return { kind: 'invalid', index: numIndex }
    // Virgule collée au numéro (« gi0/1 - 3, gi0/5 », exemple du guide 2960)
    let comma = num.endsWith(',')
    if (comma) num = num.slice(0, -1)
    if (/^\d+(?:\/\d+)+\.\d+$/.test(num)) return { kind: 'unsimulated', name: 'interface range (sous-interfaces)' }
    const m = /^((?:\d+\/)+)(\d+)$/.exec(num)
    if (!m || !exists(`${type.short}${num}`)) return { kind: 'invalid', index: numIndex }
    const base = `${type.short}${m[1]}`
    const from = Number(m[2])
    let to = from
    i = numIndex + 1
    if (!comma && tokens[i] === '-') {
      const last = tokens[i + 1]
      const lm = last === undefined ? null : /^(\d+)(,?)$/.exec(last)
      if (!lm) return { kind: 'invalid', index: i + 1 }
      to = Number(lm[1])
      if (to < from) return { kind: 'invalid', index: i + 1 }
      for (let p = from; p <= to; p++) if (!exists(`${base}${p}`)) return { kind: 'invalid', index: i + 1 }
      comma = lm[2] === ','
      i += 2
    }
    for (let p = from; p <= to; p++) if (!names.includes(`${base}${p}`)) names.push(`${base}${p}`)
    if (comma) continue
    if (tokens[i] === undefined) return { kind: 'ok', names }
    if (tokens[i] !== ',') return { kind: 'invalid', index: i }
    i++
  }
}

/**
 * Plage d'interfaces : consomme le reste de la ligne. Valeur : `ok:Fa0/1,Fa0/2` ou
 * `unsimulated:<nom>` (message honnête affiché par la commande).
 */
export function ifaceRange(): ArgType {
  const types = iface()
  return {
    label: 'interface',
    match: (tokens, index, ctx) => {
      const r = parseIfaceRange(tokens, index, ctx)
      if (r.kind === 'invalid') return null
      const value = r.kind === 'ok' ? `ok:${r.names.join(',')}` : `unsimulated:${r.name}`
      return { consumed: tokens.length - index, value }
    },
    failure: (tokens, index, ctx) => {
      const r = parseIfaceRange(tokens, index, ctx)
      return r.kind === 'invalid' ? r.index : index
    },
    helpEntries: (ctx) => types.helpEntries?.(ctx) ?? [],
    complete: (partial, ctx) => types.complete?.(partial, ctx) ?? []
  }
}
