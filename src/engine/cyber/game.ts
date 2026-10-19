/**
 * Mode Red/Blue : partie solo contre l'IA, autour des scénarios et contre-mesures existants.
 *
 * Garde-fou : ce module n'ajoute AUCUNE attaque. Il orchestre des scénarios déjà définis
 * (`scenarios/`) et des contre-mesures déjà définies (`countermeasures.ts`), tient le décompte des
 * tours et calcule le score. Il ne contient aucune logique offensive.
 *
 * Déroulement : phase de préparation (le camp Blue durcit, le camp Red choisit l'ordre de ses
 * scénarios), puis des tours. Un tour = un coup de Red (un scénario), puis un coup de Blue
 * (durcir, analyser les journaux ou passer). L'IA joue le camp que le joueur n'a pas choisi, de façon
 * déterministe selon la graine (PRNG local : ni `Math.random` ni `Date.now`).
 *
 * Les coups sont des commandes nommées (`cyber.playStep`, `cyber.applyCountermeasure`) : l'interface
 * les exécute par son store (annuler/rétablir, canvas), les tests par `dispatch`. `settle` tient la
 * comptabilité de la partie dans les deux cas.
 */
import { command, type Command } from '../commands/catalog'
import { dispatch } from '../commands/dispatch'
import { mulberry32 as prng, shuffle } from '../core/prng'
import type { LabState } from '../model/schema'
import { availableCountermeasures, getCountermeasure } from './countermeasures'
import { getScenario, scenariosOf } from './registry'
import type { StepRecord } from './scenario'

export type Side = 'red' | 'blue'
export type GamePhase = 'prep' | 'running' | 'over'
export type EndReason = 'completed' | 'turns' | 'timeout'

/** Coup d'un camp. */
export type Move =
  { kind: 'scenario'; id: string } | { kind: 'harden'; id: string } | { kind: 'analyse' } | { kind: 'pass' }

/** Événement inscrit dans un journal pendant un scénario (journal Sécurité, Système ou syslog IOS). */
export interface LoggedEvent {
  deviceName: string
  eventId: number | null
  text: string
}

/** Scénario lancé par Red. */
export interface Launch {
  scenarioId: string
  name: string
  startTurn: number
  success: boolean
  events: LoggedEvent[]
  /** Tour où Blue a repéré l'événement dans les journaux ; null : pas (encore) repéré. */
  detectedTurn: number | null
}

export interface TimelineEntry {
  turn: number
  side: Side | 'system'
  kind: 'scenario' | 'harden' | 'analyse' | 'detection' | 'end'
  label: string
  /** Identifiant du scénario ou de la contre-mesure concernés (traduction côté interface). */
  ref?: string
  success?: boolean
  events?: LoggedEvent[]
}

export interface GameState {
  side: Side
  seed: number
  maxTurns: number
  blueBudget: number
  phase: GamePhase
  /** Tour en cours (0 pendant la préparation). */
  turn: number
  /** Scénarios de Red, dans l'ordre, et prochain à jouer. */
  redPlan: string[]
  redCursor: number
  /** Contre-mesures que l'IA Blue appliquera en préparation (vide si le joueur est Blue). */
  blueQueue: string[]
  /** L'IA Blue analyse les journaux tous les N tours. */
  aiAnalyseEvery: number
  hardened: string[]
  launches: Launch[]
  timeline: TimelineEntry[]
  endReason: EndReason | null
}

// --- Création et préparation ---------------------------------------------------------------------

/** Nouvelle partie sur le lab `lab` : le joueur choisit son camp, l'IA joue l'autre. */
export function createGame(lab: LabState, options: { side: Side; seed: number }): GameState {
  // Le lab peut imposer le camp de l'IA : le joueur prend l'autre
  const aiSide = lab.cyber.game.aiSide
  const side: Side = aiSide === options.side ? (aiSide === 'red' ? 'blue' : 'red') : options.side
  options = { ...options, side }
  const rand = prng(options.seed)
  const { maxTurns, blueBudget } = lab.cyber.game
  const ai: Pick<GameState, 'redPlan' | 'blueQueue'> = { redPlan: [], blueQueue: [] }
  if (options.side === 'blue') {
    // IA Red : tous les scénarios, dans un ordre tiré selon la graine
    ai.redPlan = shuffle(
      scenariosOf(lab).map((s) => s.id),
      rand
    )
  } else {
    // IA Blue : sous-ensemble aléatoire (selon la graine) des contre-mesures disponibles
    const available = shuffle(
      availableCountermeasures(lab).map((c) => c.id),
      rand
    )
    const count = Math.min(blueBudget, available.length, Math.floor(rand() * (available.length + 1)))
    ai.blueQueue = available.slice(0, count)
  }
  return {
    side: options.side,
    seed: options.seed,
    maxTurns,
    blueBudget,
    phase: 'prep',
    turn: 0,
    ...ai,
    redCursor: 0,
    aiAnalyseEvery: 1 + Math.floor(rand() * 3),
    hardened: [],
    launches: [],
    timeline: [],
    endReason: null
  }
}

/** Joueur Red : choisit les scénarios à lancer et leur ordre (préparation seulement). */
export function setRedPlan(game: GameState, ids: string[], lab?: LabState): GameState {
  if (game.side !== 'red' || game.phase !== 'prep') return game
  const enabled = lab ? new Set(scenariosOf(lab).map((s) => s.id)) : null
  const valid = (id: string, i: number) =>
    !!getScenario(id) && ids.indexOf(id) === i && (enabled === null || enabled.has(id))
  return { ...game, redPlan: ids.filter(valid) }
}

/** Coups de préparation de l'IA Blue (durcissements tirés selon la graine). */
export function aiPrepMoves(game: GameState): Move[] {
  return game.phase === 'prep' ? game.blueQueue.map((id) => ({ kind: 'harden', id })) : []
}

/** Fin de la préparation : le premier tour commence. */
export function startGame(game: GameState): GameState {
  return game.phase === 'prep' ? { ...game, phase: 'running', turn: 1 } : game
}

/** Contre-mesures encore permises à Blue (budget et utilité dans le lab). */
export function blueOptions(game: GameState, lab: LabState) {
  if (game.hardened.length >= game.blueBudget) return []
  return availableCountermeasures(lab)
}

// --- Coups ---------------------------------------------------------------------------------------

/** Prochain coup de Red : le prochain scénario du plan, ou null si le plan est épuisé. */
export function redMove(game: GameState): Move | null {
  const id = game.redPlan[game.redCursor]
  return game.phase === 'running' && id ? { kind: 'scenario', id } : null
}

/** Coup de l'IA Blue : analyse des journaux au rythme tiré par la graine, sinon passe. */
export function aiBlueMove(game: GameState): Move {
  return game.turn % game.aiAnalyseEvery === 0 ? { kind: 'analyse' } : { kind: 'pass' }
}

/** Commandes nommées qui réalisent un coup (vide pour analyser ou passer). */
export function commandsFor(move: Move): Command[] {
  if (move.kind === 'harden') return [command('cyber.applyCountermeasure', move.id)]
  if (move.kind === 'scenario')
    return (getScenario(move.id)?.steps ?? []).map((_, i) => command('cyber.playStep', move.id, i))
  return []
}

// --- Comptabilité --------------------------------------------------------------------------------

/** Événements apparus entre deux états : journaux des hôtes (identifiants croissants) et syslog IOS. */
export function newEvents(before: LabState, after: LabState): LoggedEvent[] {
  const out: LoggedEvent[] = []
  for (const device of Object.values(after.devices)) {
    if (device.kind === 'server' || device.kind === 'client')
      for (const e of device.host.eventLog)
        if (e.id > before.seq) out.push({ deviceName: device.name, eventId: e.eventId, text: e.message })
    if (device.kind === 'switch' || device.kind === 'router') {
      const was = (before.devices[device.id] as typeof device | undefined)?.ios?.syslog.length ?? 0
      const lines = device.ios?.syslog ?? []
      for (const text of lines.slice(Math.min(was, lines.length)))
        out.push({ deviceName: device.name, eventId: null, text })
    }
  }
  return out
}

/**
 * Enregistre un coup déjà exécuté. `before` / `after` : état du lab autour du coup ; `records` :
 * résultats des étapes (scénario). Un coup refusé (`ok: false`) n'est pas compté.
 */
export function settle(
  game: GameState,
  side: Side,
  move: Move,
  outcome: { ok: boolean; before: LabState; after: LabState; records?: StepRecord[] }
): GameState {
  if (!outcome.ok || game.phase === 'over') return game
  const turn = game.turn
  if (move.kind === 'scenario') {
    const scenario = getScenario(move.id)
    const records = outcome.records ?? []
    const success = records.length > 0 && records.every((r) => r.success)
    const events = newEvents(outcome.before, outcome.after)
    const launch: Launch = {
      scenarioId: move.id,
      name: scenario?.name ?? move.id,
      startTurn: turn,
      success,
      events,
      detectedTurn: null
    }
    return {
      ...game,
      redCursor: game.redCursor + 1,
      launches: [...game.launches, launch],
      timeline: [
        ...game.timeline,
        { turn, side, kind: 'scenario', label: launch.name, ref: move.id, success, events }
      ]
    }
  }
  if (move.kind === 'harden') {
    return {
      ...game,
      hardened: [...game.hardened, move.id],
      timeline: [
        ...game.timeline,
        {
          turn,
          side,
          kind: 'harden',
          label: getCountermeasure(move.id)?.label ?? move.id,
          ref: move.id,
          success: true
        }
      ]
    }
  }
  if (move.kind === 'analyse') {
    // Blue lit les journaux : tout lancement dont l'événement est inscrit et pas encore repéré l'est maintenant
    const found: TimelineEntry[] = []
    const launches = game.launches.map((l) => {
      if (l.detectedTurn !== null || l.events.length === 0) return l
      found.push({
        turn,
        side: 'blue',
        kind: 'detection',
        label: l.name,
        ref: l.scenarioId,
        events: l.events
      })
      return { ...l, detectedTurn: turn }
    })
    return {
      ...game,
      launches,
      timeline: [
        ...game.timeline,
        { turn, side, kind: 'analyse', label: '', success: found.length > 0 },
        ...found
      ]
    }
  }
  return game
}

/** Clôt le tour : tour suivant, ou fin de partie (plan de Red épuisé, nombre de tours atteint). */
export function endTurn(game: GameState): GameState {
  if (game.phase !== 'running') return game
  const exhausted = game.redCursor >= game.redPlan.length
  if (exhausted || game.turn >= game.maxTurns) return endGame(game, exhausted ? 'completed' : 'turns')
  return { ...game, turn: game.turn + 1 }
}

/** Termine la partie (minuteur écoulé, abandon, fin normale). */
export function endGame(game: GameState, reason: EndReason): GameState {
  if (game.phase === 'over') return game
  return {
    ...game,
    phase: 'over',
    endReason: reason,
    timeline: [...game.timeline, { turn: game.turn, side: 'system', kind: 'end', label: reason }]
  }
}

// --- Score ---------------------------------------------------------------------------------------

export interface Score {
  red: {
    attempted: number
    succeeded: number
    compromisedAccounts: string[]
    controlledMachines: string[]
    interceptedFlows: number
    hoppedHosts: number
  }
  blue: {
    blocked: number
    detected: number
    undetected: number
    /** Délais de détection, en tours, un par attaque repérée. */
    detectionTurns: number[]
    averageDetectionTurns: number | null
    countermeasures: number
  }
  /** Gagnant : Red si plus de scénarios réussis que bloqués, Blue dans le cas inverse. */
  outcome: Side | 'draw'
}

export function scoreOf(game: GameState, lab: LabState): Score {
  const succeeded = game.launches.filter((l) => l.success).length
  const blocked = game.launches.length - succeeded
  const detectionTurns = game.launches
    .filter((l) => l.detectedTurn !== null)
    .map((l) => (l.detectedTurn as number) - l.startTurn)
  const hosts = Object.values(lab.devices)
  return {
    red: {
      attempted: game.launches.length,
      succeeded,
      compromisedAccounts: Object.values(lab.domains).flatMap((d) =>
        d.users.filter((u) => u.compromised).map((u) => `${d.netbios}\\${u.sam}`)
      ),
      controlledMachines: hosts
        .filter((d) => (d.kind === 'server' || d.kind === 'client') && d.host.controlled)
        .map((d) => d.name),
      interceptedFlows: lab.cyber.intercepts.length,
      hoppedHosts: hosts
        .flatMap((d) => (d.kind === 'switch' ? d.interfaces : []))
        .filter((p) => p.switchport?.hoppedVlan != null).length
    },
    blue: {
      blocked,
      detected: detectionTurns.length,
      undetected: game.launches.filter((l) => l.detectedTurn === null).length,
      detectionTurns,
      averageDetectionTurns: detectionTurns.length
        ? detectionTurns.reduce((a, b) => a + b, 0) / detectionTurns.length
        : null,
      countermeasures: game.hardened.length
    },
    outcome: succeeded > blocked ? 'red' : succeeded < blocked ? 'blue' : 'draw'
  }
}

// --- Exécution sans interface (tests, IA) ------------------------------------------------------

/** Exécute un coup par `dispatch` et le comptabilise ; renvoie le nouvel état du lab et de la partie. */
export function runMove(
  lab: LabState,
  game: GameState,
  side: Side,
  move: Move
): { lab: LabState; game: GameState } {
  // Budget de contre-mesures épuisé : le coup est refusé sans toucher au lab
  if (move.kind === 'harden' && game.hardened.length >= game.blueBudget) return { lab, game }
  let current = lab
  const records: StepRecord[] = []
  let ok = true
  for (const cmd of commandsFor(move)) {
    const r = dispatch(current, cmd)
    if (!r.ok) {
      ok = false
      break
    }
    current = r.state
    if (cmd.type === 'cyber.playStep') records.push(r.value as StepRecord)
  }
  return { lab: current, game: settle(game, side, move, { ok, before: lab, after: current, records }) }
}

/** Joue un tour complet : coup de Red (plan), puis coup de Blue (`blue` pour le joueur, sinon l'IA). */
export function runTurn(lab: LabState, game: GameState, blue?: Move): { lab: LabState; game: GameState } {
  let state = { lab, game }
  const red = redMove(state.game)
  if (red) state = runMove(state.lab, state.game, 'red', red)
  state = runMove(state.lab, state.game, 'blue', blue ?? aiBlueMove(state.game))
  return { lab: state.lab, game: endTurn(state.game) }
}

/**
 * Partie complète sans interface. Le joueur Red fournit son plan, le joueur Blue ses coups
 * (préparation, puis un coup par tour) ; l'IA joue l'autre camp.
 */
export function playGame(
  lab: LabState,
  options: { side: Side; seed: number; redPlan?: string[]; bluePrep?: string[]; blueTurns?: Move[] }
): { lab: LabState; game: GameState; score: Score } {
  let game = createGame(lab, options)
  if (options.redPlan) game = setRedPlan(game, options.redPlan)
  let state = { lab, game }
  const prep: Move[] =
    options.side === 'blue'
      ? (options.bluePrep ?? []).map((id) => ({ kind: 'harden', id }))
      : aiPrepMoves(state.game)
  for (const move of prep) state = runMove(state.lab, state.game, 'blue', move)
  state.game = startGame(state.game)
  while (state.game.phase === 'running') {
    // Joueur Blue : le coup prévu pour ce tour, sinon il passe (l'IA ne joue que le camp Blue adverse)
    const planned: Move | undefined =
      options.side === 'blue' ? (options.blueTurns?.[state.game.turn - 1] ?? { kind: 'pass' }) : undefined
    state = runTurn(state.lab, state.game, planned)
  }
  return { ...state, score: scoreOf(state.game, state.lab) }
}
