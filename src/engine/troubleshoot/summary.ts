/**
 * Interface du mode panne : accesseurs purs (ticket, indices révélés) et bilan d'un dépannage.
 * Le bilan compare la démarche de l'élève (commandes jouées depuis le départ) à la réparation
 * officielle de chaque panne. Durée et nombre de commandes sont fournis par l'appelant : le moteur
 * ne lit jamais l'horloge.
 */
import { commandLabel, dispatch } from '../commands/dispatch'
import type { LabState } from '../model/schema'
import { HINTS_PER_FAULT } from './hints'
import { getFault } from './registry'
import type { FaultDomain, FaultTargetParams } from './types'

/** Pénalité (points sur 100) par indice utilisé. */
export const HINT_PENALTY = 10

export interface FaultSummary {
  title: string
  domain: FaultDomain
  difficulty: 1 | 2 | 3
  /** Symptôme tel que l'utilisateur l'a signalé (le ticket). */
  symptom: string
  cause: string
  /** Libellés lisibles de la réparation officielle (une commande nommée par ligne). */
  repairSteps: string[]
}

/** Mesures de la session, fournies par l'interface. */
export interface TroubleshootStats {
  /** Commandes nommées jouées depuis le départ (hors demandes d'indice, annulations comprises). */
  commandsPlayed: number
  hintsUsed: number
  elapsedMs: number
  /** Toutes les pannes sont réparées à la fin. */
  repaired: boolean
  /** Dépannage abandonné (cause révélée sans réparation). */
  gaveUp: boolean
}

export interface TroubleshootSummary {
  faults: FaultSummary[]
  repaired: boolean
  gaveUp: boolean
  /** Commandes de la réparation officielle (toutes pannes). */
  officialCommands: number
  playedCommands: number
  /** Commandes jouées en plus du chemin le plus court (0 : chemin optimal). */
  extraCommands: number
  hintsUsed: number
  elapsedMs: number
  /** Score sur 100 : 0 sans réparation, sinon efficacité de la démarche moins la pénalité d'indices. */
  score: number
  verdict: string
}

/** Tickets des pannes actives (sans la cause), dans l'ordre d'injection. `start` : état cassé de départ. */
export function faultTickets(start: LabState): string[] {
  return (start.troubleshooting?.faults ?? []).flatMap((f) => {
    const def = getFault(f.id)
    return def ? [def.ticket(start, f.params)] : []
  })
}

/** Indice révélé (niveau 1 à 3) d'une panne. */
export interface RevealedHint {
  /** Rang de la panne (0 pour la première). */
  fault: number
  level: number
  text: string
}

/** Indices déjà demandés (état courant), avec leur texte tiré de l'état de départ. */
export function revealedHints(start: LabState, current: LabState): RevealedHint[] {
  const out: RevealedHint[] = []
  ;(start.troubleshooting?.faults ?? []).forEach((f, i) => {
    const used = current.troubleshooting?.faults.find((x) => x.id === f.id)?.hintsUsed ?? 0
    const texts = getFault(f.id)?.hints(start, f.params) ?? []
    for (let level = 1; level <= Math.min(used, texts.length); level++)
      out.push({ fault: i, level, text: texts[level - 1] ?? '' })
  })
  return out
}

/** Panne dont le prochain indice peut être demandé (la première non épuisée et non réparée), ou null. */
export function nextHintFaultId(current: LabState): string | null {
  const faults = current.troubleshooting?.faults ?? []
  const open = faults.find(
    (f) => f.hintsUsed < HINTS_PER_FAULT && !(getFault(f.id)?.healed(current, f.params) ?? false)
  )
  return open?.id ?? null
}

/** Total des indices demandés sur l'état donné. */
export function hintsUsedTotal(state: LabState): number {
  return (state.troubleshooting?.faults ?? []).reduce((n, f) => n + f.hintsUsed, 0)
}

/** Libellés de la réparation officielle d'une panne, évalués au fil des commandes. */
function repairSteps(start: LabState, id: string, params: FaultTargetParams): string[] {
  const def = getFault(id)
  if (!def) return []
  const steps: string[] = []
  let state = start
  for (const c of def.repair(start, params)) {
    steps.push(commandLabel(state, c))
    const r = dispatch(state, c)
    if (r.ok) state = r.state
  }
  return steps
}

/** Phrase lisible sur l'écart au chemin le plus court. */
function verdictOf(s: { repaired: boolean; gaveUp: boolean; extra: number; hints: number }): string {
  if (!s.repaired)
    return s.gaveUp ? 'Dépannage abandonné : la correction officielle est affichée.' : 'Panne non réparée.'
  const plural = s.hints > 1 ? 's' : ''
  const hints = s.hints > 0 ? ` (${s.hints} indice${plural} utilisé${plural})` : ''
  if (s.extra <= 0) return `Chemin le plus court : bravo${hints}.`
  return `${s.extra} commande${s.extra > 1 ? 's' : ''} de plus que le chemin le plus court${hints}.`
}

/** Bilan d'un dépannage. `start` : état cassé de départ (après injection). */
export function summarizeTroubleshooting(start: LabState, stats: TroubleshootStats): TroubleshootSummary {
  const faults: FaultSummary[] = []
  for (const f of start.troubleshooting?.faults ?? []) {
    const def = getFault(f.id)
    if (!def) continue
    faults.push({
      title: def.title,
      domain: def.domain,
      difficulty: def.difficulty,
      symptom: def.ticket(start, f.params),
      cause: def.cause(start, f.params),
      repairSteps: repairSteps(start, f.id, f.params)
    })
  }
  const official = faults.reduce((n, f) => n + f.repairSteps.length, 0)
  const played = Math.max(0, Math.floor(stats.commandsPlayed))
  const hints = Math.max(0, Math.floor(stats.hintsUsed))
  const extra = Math.max(0, played - official)
  const efficiency = Math.round((100 * official) / Math.max(played, official, 1))
  const repaired = stats.repaired && !stats.gaveUp
  const score = repaired ? Math.max(0, efficiency - HINT_PENALTY * hints) : 0
  return {
    faults,
    repaired,
    gaveUp: stats.gaveUp,
    officialCommands: official,
    playedCommands: played,
    extraCommands: extra,
    hintsUsed: hints,
    elapsedMs: Math.max(0, stats.elapsedMs),
    score,
    verdict: verdictOf({ repaired, gaveUp: stats.gaveUp, extra, hints })
  }
}
