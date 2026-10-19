/**
 * Outils communs aux pannes réseau (`net.*`) : tirage par essai d'injection, ping, scripts IOS.
 * Aucune sortie de console nouvelle : les symptômes sont ceux des commandes existantes.
 */
import { command } from '../../commands/catalog'
import { dispatch } from '../../commands/dispatch'
import type { AnyCommand } from '../../commands/define'
import type { Device, LabState, NetInterface } from '../../model/schema'
import { effectiveIpv4 } from '../../net/addressing'
import { ping } from '../../net/diagnostics'
import { createShellSession, executeLine } from '../../shell/exec'
import type { FaultDef, FaultTargetParams } from '../types'

/** Poste ou serveur allumé (les hôtes qui lancent et reçoivent les tests). */
export function poweredHosts(state: LabState): Device[] {
  return Object.values(state.devices).filter((d) => (d.kind === 'client' || d.kind === 'server') && d.powered)
}

/** Première adresse IPv4 effective d'un équipement (null : aucune). */
export function firstAddress(device: Device): string | null {
  for (const i of device.interfaces) {
    const eff = effectiveIpv4(i)
    if (eff) return eff.address
  }
  return null
}

/** Carte portant l'adresse effective donnée. */
export function ifaceWithAddress(device: Device, address: string): NetInterface | undefined {
  return device.interfaces.find((i) => effectiveIpv4(i)?.address === address)
}

/** Le ping de `from` vers `address` reçoit-il une réponse d'écho ? */
export function pingOk(state: LabState, from: string, address: string): boolean {
  const r = ping(state, from, address, { count: 1 })
  return r.ok && r.value.success
}

/** Applique des commandes dans l'ordre ; null si l'une est refusée. */
export function applyCommands(state: LabState, commands: AnyCommand[]): LabState | null {
  let current = state
  for (const c of commands) {
    const r = dispatch(current, c)
    if (!r.ok) return null
    current = r.state
  }
  return current
}

/**
 * Tirage d'une panne : parcourt les candidats à partir d'un rang tiré de la graine et garde le premier
 * dont l'injection est RÉELLEMENT visible (symptôme absent de l'état sain, présent une fois cassé).
 */
export function firstVisible(
  fault: FaultDef,
  state: LabState,
  candidates: FaultTargetParams[],
  rand: () => number
): FaultTargetParams | null {
  if (candidates.length === 0) return null
  const start = Math.floor(rand() * candidates.length)
  for (let k = 0; k < candidates.length; k++) {
    const p = candidates[(start + k) % candidates.length]!
    // L'état sain doit être guéri (le test observé répond) et sans symptôme
    if (!fault.healed(state, p) || fault.symptomVisible(state, p)) continue
    const broken = applyCommands(state, fault.inject(state, p))
    if (broken && broken !== state && fault.symptomVisible(broken, p)) return p
  }
  return null
}

/**
 * Lignes saisies à la console IOS d'un équipement, rendues en commandes nommées `shell.exec`
 * (la session de console est rejouée sur une copie de l'état pour porter le mode courant).
 */
export function iosCommands(state: LabState, deviceId: string, lines: string[]): AnyCommand[] {
  const commands: AnyCommand[] = []
  let current = state
  let session = createShellSession(state, deviceId, 'ios')
  for (const line of lines) {
    commands.push(command('shell.exec', session, line, []))
    const r = executeLine(current, session, line)
    current = r.state
    session = r.session
  }
  return commands
}

/** Nom d'un équipement (texte de repli si l'équipement a disparu). */
export const nameOf = (state: LabState, id: unknown, fallback = 'l’équipement'): string =>
  state.devices[String(id)]?.name ?? fallback

/** Coordonnées IPv4 de la carte pour `net.setInterfaceIpv4` (adressage statique), avec ses modifications. */
export function staticIpv4Input(
  iface: NetInterface,
  patch: { address?: string; mask?: string; gateway?: string | null }
): {
  addressing: 'static'
  address: string
  mask: string
  gateway: string | null
  dnsMode: NetInterface['dnsMode']
  dnsServers: string[]
} {
  return {
    addressing: 'static',
    address: patch.address ?? iface.address ?? '',
    mask: patch.mask ?? String(iface.prefixLength ?? 24),
    gateway: patch.gateway === undefined ? iface.gateway : patch.gateway,
    dnsMode: iface.dnsMode,
    dnsServers: iface.dnsServers
  }
}
