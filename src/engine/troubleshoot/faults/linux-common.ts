/**
 * Socle des pannes Linux (v2.9, #241) : une panne casse et répare avec des lignes de la console bash
 * (`sudo sed -i`, `sudo chmod`, `sudo systemctl`, `fail2ban-client`…), rendues en commandes nommées
 * `shell.exec`. L'élève répare donc avec les mêmes outils, et la réparation officielle est exactement
 * ce qu'il peut saisir. Aucune sortie nouvelle : tout symptôme est lu dans l'état par les fonctions
 * des services (systemctl, ss, configtest, bind, dhcpd…).
 */
import { command } from '../../commands/catalog'
import type { AnyCommand } from '../../commands/define'
import { isLinuxHost } from '../../model/host'
import type { HostDevice, LabState } from '../../model/schema'
import { effectiveIpv4 } from '../../net/addressing'
import { createShellSession } from '../../shell/exec'
import { findUnit } from '../../services/linuxcatalog'
import { isInstalled } from '../../services/linuxpackages'
import { unitStatus } from '../../services/linuxsystem'
import { hostFiles, type LinuxFiles } from '../../services/linuxtree'
import type { FaultDef, FaultTargetParams } from '../types'
import { firstViable } from './viable'

/**
 * Lignes saisies à la console bash d'un ordinateur Linux, rendues en commandes nommées `shell.exec`.
 * Les lignes d'une panne ne changent ni le dossier courant ni les variables : une même session sert à toutes.
 */
export function bashCommands(state: LabState, deviceId: string, lines: string[]): AnyCommand[] {
  const session = createShellSession(state, deviceId, 'cmd')
  return lines.map((line) => command('shell.exec', session, line, []))
}

/** Serveurs Linux allumés. */
export const linuxServers = (state: LabState): HostDevice[] =>
  Object.values(state.devices).filter(
    (d): d is HostDevice => isLinuxHost(d) && d.kind === 'server' && d.powered
  )

/** Fichiers vus par la console du serveur. */
export const filesOf = (host: HostDevice): LinuxFiles => hostFiles(host)

/** Hôte Linux d'un identifiant (undefined si ce n'en est pas un). */
export function linuxHostOf(state: LabState, id: unknown): HostDevice | undefined {
  const d = state.devices[String(id)]
  return isLinuxHost(d) ? d : undefined
}

/** L'unité systemd est-elle installée et active ? */
export function unitActive(host: HostDevice | undefined, name: string): boolean {
  const unit = findUnit(name)
  return !!host && !!unit && isInstalled(host, unit.pkg) && unitStatus(host, unit).active
}

/** L'unité est-elle activée au démarrage (`systemctl enable`) ? */
export function unitEnabled(host: HostDevice | undefined, name: string): boolean {
  const unit = findUnit(name)
  return !!host && !!unit && isInstalled(host, unit.pkg) && unitStatus(host, unit).enabled
}

/** Première adresse IPv4 d'un ordinateur. */
export function ipOf(host: HostDevice): string | null {
  for (const i of host.interfaces) {
    const eff = effectiveIpv4(i)
    if (eff) return eff.address
  }
  return null
}

/** Poste qui observe la panne : un autre ordinateur allumé et adressé (poste de préférence). */
export function clientFor(state: LabState, server: HostDevice): HostDevice | undefined {
  const others = Object.values(state.devices).filter(
    (d): d is HostDevice =>
      (d.kind === 'client' || d.kind === 'server') && d.id !== server.id && d.powered && ipOf(d) !== null
  )
  return others.find((d) => d.kind === 'client') ?? others[0]
}

/** Nom d'un équipement dans un message (texte de repli si l'équipement a disparu). */
export const nameOf = (state: LabState, id: unknown, fallback = 'le serveur'): string =>
  state.devices[String(id)]?.name ?? fallback

/** Nom du poste qui observe (« PC1 »), ou « un poste ». */
export const clientName = (state: LabState, p: FaultTargetParams): string =>
  p['client'] === undefined ? 'un poste' : nameOf(state, p['client'], 'un poste')

const SED_DELIMITERS = ['/', ',', '|', '!', '@', '%']
const BRE_SPECIAL = /[.[\]*^$\\]/g

/**
 * Ligne `sudo sed -i 's/ancien/nouveau/' fichier` (premier `ancien` de chaque ligne). Le texte est
 * échappé pour l'expression régulière de base de sed ; `null` si le texte contient une apostrophe
 * ou tous les séparateurs possibles (la cible n'est alors pas modifiable proprement).
 */
export function sedLine(
  file: string,
  from: string,
  to: string,
  /** `whole` : le texte doit occuper toute la ligne (ancres `^` et `$`). */
  opts: { whole?: boolean } = {}
): string | null {
  if (from.includes("'") || to.includes("'") || from === '') return null
  const delim = SED_DELIMITERS.find((d) => !from.includes(d) && !to.includes(d))
  if (!delim) return null
  const pattern = from.replace(BRE_SPECIAL, '\\$&')
  const replacement = to.replace(/[\\&]/g, '\\$&')
  const anchored = opts.whole ? `^${pattern}$` : pattern
  return `sudo sed -i 's${delim}${anchored}${delim}${replacement}${delim}' ${file}`
}

/** Idem `sedLine`, pour une ligne dont on est sûr qu'elle est modifiable (lève sinon). */
export function sedOrThrow(file: string, from: string, to: string, opts: { whole?: boolean } = {}): string {
  const line = sedLine(file, from, to, opts)
  if (line === null) throw new Error(`Texte non modifiable avec sed : ${from}`)
  return line
}

/** Échappe un texte pour une expression régulière JavaScript. */
export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export interface LinuxFaultSpec {
  id: string
  title: string
  difficulty: 1 | 2 | 3
  /** Cibles candidates (paramètres complets) dans l'état sain ; `device` et `service` toujours présents. */
  candidates(state: LabState): FaultTargetParams[]
  /** Lignes de la console du serveur qui cassent / réparent. */
  breakLines(state: LabState, p: FaultTargetParams): string[]
  fixLines(state: LabState, p: FaultTargetParams): string[]
  /** État conforme au fonctionnement d'origine, lu sur l'état courant. */
  healed(state: LabState, p: FaultTargetParams): boolean
  /** Symptôme observable, si plus précis que « pas guéri » (par défaut : `!healed`). */
  symptom?(state: LabState, p: FaultTargetParams): boolean
  ticket(state: LabState, p: FaultTargetParams): string
  hints(state: LabState, p: FaultTargetParams): [string, string, string]
  cause(state: LabState, p: FaultTargetParams): string
}

/**
 * Panne Linux : la cible est tirée parmi les candidats sains dont l'injection produit un symptôme ;
 * le symptôme est l'écart avec l'état d'origine (`!healed`) et la guérison se constate sur l'état.
 */
export function linuxFault(spec: LinuxFaultSpec): FaultDef {
  const fault: FaultDef = {
    id: spec.id,
    domain: 'linux',
    difficulty: spec.difficulty,
    title: spec.title,
    pick(state, rand) {
      const healthy = spec.candidates(state).filter((p) => spec.healed(state, p))
      return firstViable(state, rand, healthy, fault)
    },
    inject: (state, p) => bashCommands(state, String(p['device']), spec.breakLines(state, p)),
    symptomVisible: (state, p) => (spec.symptom ? spec.symptom(state, p) : !spec.healed(state, p)),
    ticket: spec.ticket,
    hints: spec.hints,
    cause: spec.cause,
    repair: (state, p) => bashCommands(state, String(p['device']), spec.fixLines(state, p)),
    healed: spec.healed
  }
  return fault
}
