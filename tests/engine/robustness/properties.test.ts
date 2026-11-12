/**
 * Propriétés sur tous les labs (labs/*.json) avec des commandes nommées tirées au hasard
 * (graine fixe, catalogue de src/engine/commands) :
 *  - annuler puis rétablir redonne le même état ;
 *  - sérialiser en .slab puis rouvrir redonne le même lab ;
 *  - rejouer le journal depuis l'état initial redonne le même état.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import {
  applyStatePatches,
  commandDefinitions,
  dispatch,
  emptyHistory,
  LabStateSchema,
  parseSlab,
  recordEntry,
  redoStep,
  replay,
  serializeSlab,
  undoStep,
  type AnyCommand,
  type History,
  type JournalEntry,
  type LabState
} from '@engine/index'
import { loadAllLabs, prng, type Rng } from './prng'
import { COMMAND_TYPES, factoryCommand, makePool, warmupCommands } from './command-factories'

const TYPES = Object.keys(commandDefinitions()).filter((t) => t !== 'batch')
/** Au plus HISTORY_LIMIT (100) étapes : au-delà, l’historique d’annulation oublie les plus anciennes. */
const STEPS_PER_LAB = 100
const ATTEMPTS_PER_LAB = 1000
/** Nombre minimal de types de commandes distincts acceptés sur l'ensemble des labs (99 mesurés sur 239 ; graine fixe donc déterministe, marge pour de petites évolutions). */
const MIN_DISTINCT_TYPES = 90
const SLAB_OPTIONS = { savedAt: '2026-10-05T12:00:00.000Z', appVersion: 'test' }

/** Valeur d'argument plausible, tirée de l'état (identifiants, noms, adresses) ou du bruit. */
function randomArg(rng: Rng, state: LabState, depth = 0): unknown {
  const devices = Object.values(state.devices)
  const r = rng.int(14)
  if (r < 3 && devices.length) return rng.pick(devices).id
  if (r < 4 && devices.length) return rng.pick(devices).name
  if (r < 5) return rng.pick(Object.keys(state.links).concat(['inconnu']))
  if (r < 6) return rng.int(4096)
  if (r < 7) return rng.next() < 0.5
  if (r < 8) return `10.${rng.int(255)}.${rng.int(255)}.${rng.int(255)}`
  if (r < 9) return rng.pick(['srv', 'test.local', 'Utilisateur1', 'P@ssw0rd!', 'Eth0', 'D:\\Partage', ''])
  if (r < 10 && devices.length) return rng.pick(['server', 'client', 'switch', 'router']) // genre d'équipement
  if (r < 11) return rng.pick(['a', 'b', 'c']).repeat(rng.int(40))
  if (r < 12 && depth < 2) return Array.from({ length: rng.int(3) }, () => randomArg(rng, state, depth + 1))
  if (r < 13 && depth < 2) {
    const o: Record<string, unknown> = {}
    for (const k of ['kind', 'name', 'id', 'x', 'y', 'enabled', 'ip', 'mask'].slice(0, rng.int(8)))
      o[k] = randomArg(rng, state, depth + 1)
    return o
  }
  return null
}

function randomCommand(rng: Rng, state: LabState): AnyCommand {
  const type = rng.pick(TYPES)
  return { type, args: Array.from({ length: rng.int(5) }, () => randomArg(rng, state)) }
}

/** Égalité structurelle stricte (un `undefined` explicite diffère d'une valeur par défaut). */
function isDeepStrictEqualJson(a: unknown, b: unknown): boolean {
  try {
    expect(a).toEqual(b)
    return true
  } catch {
    return false
  }
}

interface Run {
  initial: LabState
  final: LabState
  history: History
  commands: AnyCommand[]
  /** Types de commandes acceptés pendant cette exécution. */
  accepted: Set<string>
}

/** Exécute des commandes aléatoires ; les exceptions dues à des arguments absurdes sont ignorées. */
function randomRun(initial: LabState, seed: number): Run {
  const rng = prng(seed)
  let state = initial
  let history = emptyHistory()
  const commands: AnyCommand[] = []
  const accepted = new Set<string>()
  // Fabriques d'arguments par type : on parcourt d'abord tout le catalogue (décalé selon la graine),
  // puis on tire au hasard ; 20 % des tentatives reste du bruit pur (arguments absurdes)
  let pool = makePool(state)
  const offset = rng.int(COMMAND_TYPES.length)
  // Préparation : rôles installés et forêt créée, pour que les commandes des rôles aient prise
  const warmup = warmupCommands(initial)
  for (let i = 0; i < ATTEMPTS_PER_LAB && commands.length < STEPS_PER_LAB; i++) {
    const noise = i >= warmup.length && rng.next() < 0.2
    const command =
      i < warmup.length
        ? (warmup[i] as AnyCommand)
        : noise
          ? randomCommand(rng, state)
          : factoryCommand(
              i < warmup.length + COMMAND_TYPES.length * 2
                ? (COMMAND_TYPES[(offset + i) % COMMAND_TYPES.length] as string)
                : rng.pick(COMMAND_TYPES),
              rng,
              state,
              pool
            )
    let result: ReturnType<typeof dispatch>
    try {
      result = dispatch(state, command)
    } catch {
      continue // arguments mal typés : jamais produits par l'interface
    }
    if (!result.ok || !result.entry) continue
    // Arguments absurdes (types faux) acceptés sans validation : jamais produits par l'interface typée,
    // on écarte les résultats qui sortent du schéma pour ne tester que des états atteignables
    // (ni explicitement `undefined` là où le schéma impose une valeur par défaut)
    const normalised = LabStateSchema.safeParse(result.state)
    if (!normalised.success || !isDeepStrictEqualJson(normalised.data, result.state)) continue
    // Le bruit peut écrire des valeurs hors schéma dans l'état des rôles (non validé par LabStateSchema) :
    // on ne garde que ce que l'application pourrait réenregistrer puis rouvrir
    if (noise && !parseSlab(serializeSlab(result.state, SLAB_OPTIONS)).ok) continue
    state = result.state
    history = recordEntry(history, result.entry)
    commands.push(command)
    accepted.add(command.type)
    pool = makePool(state)
  }
  return { initial, final: state, history, commands, accepted }
}

const labs = loadAllLabs()
const runs = new Map<string, Run>()
function runOf(file: string, state: LabState, index: number): Run {
  let r = runs.get(file)
  if (!r) {
    r = randomRun(state, 1000 + index)
    runs.set(file, r)
  }
  return r
}

describe('propriétés sur les labs avec commandes aléatoires', () => {
  // Les exécutions aléatoires (59 labs) sont calculées une fois, hors du délai d'un test unitaire
  beforeAll(() => {
    for (const [i, l] of labs.entries()) runOf(l.file, l.state, i)
  }, 120_000)

  it('au moins quelques commandes aléatoires aboutissent (le test n’est pas vide)', () => {
    const total = labs.reduce((n, l, i) => n + runOf(l.file, l.state, i).commands.length, 0)
    expect(total).toBeGreaterThan(labs.length)
  })

  it('couvre un large éventail de types de commandes acceptés', () => {
    const distinct = new Set<string>()
    for (const [i, l] of labs.entries()) for (const t of runOf(l.file, l.state, i).accepted) distinct.add(t)
    expect(
      distinct.size,
      `${distinct.size} / ${COMMAND_TYPES.length} types acceptés (minimum ${MIN_DISTINCT_TYPES})`
    ).toBeGreaterThanOrEqual(MIN_DISTINCT_TYPES)
  })

  describe.each(labs.map((l, i) => [l.file, l, i] as const))('%s', (file, lab, index) => {
    it('annuler puis rétablir : même état', () => {
      const run = runOf(file, lab.state, index)
      let state = run.final
      let history = run.history
      const steps = history.past.length
      for (let i = 0; i < steps; i++) {
        const u = undoStep(state, history)
        expect(u.ok).toBe(true)
        if (!u.ok) return
        state = u.state
        history = u.history
      }
      expect(state).toEqual(run.initial)
      for (let i = 0; i < steps; i++) {
        const r = redoStep(state, history)
        expect(r.ok).toBe(true)
        if (!r.ok) return
        state = r.state
        history = r.history
      }
      expect(state).toEqual(run.final)
      expect(LabStateSchema.safeParse(state).success).toBe(true)
    })

    it('.slab : sérialiser puis rouvrir donne le même lab', () => {
      const run = runOf(file, lab.state, index)
      const options = SLAB_OPTIONS
      const text = serializeSlab(run.final, options)
      const parsed = parseSlab(text)
      expect(parsed.ok, parsed.ok ? '' : parsed.message).toBe(true)
      if (!parsed.ok) return
      expect(parsed.doc.lab).toEqual(run.final)
      // Idempotence : un second aller-retour ne change plus rien
      const again = parseSlab(serializeSlab(parsed.doc.lab, options))
      expect(again.ok && again.doc.lab).toEqual(parsed.doc.lab)
    })

    it('rejouer le journal depuis l’état initial : même état', () => {
      const run = runOf(file, lab.state, index)
      const replayed = replay(run.initial, run.commands)
      expect(replayed.ok).toBe(true)
      if (!replayed.ok) return
      expect(replayed.state).toEqual(run.final)
      // Les patches du journal reconstruisent aussi l'état final
      const entries: JournalEntry[] = run.history.past
      let state = run.initial
      for (const e of entries) state = applyStatePatches(state, e.patches)
      expect(state).toEqual(run.final)
    })
  })
})
