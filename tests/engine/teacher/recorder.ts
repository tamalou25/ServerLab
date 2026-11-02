/**
 * Enregistreur de solutions (issue #405) : les solutions officielles des labs appellent directement
 * les actions du moteur. En test, `@engine/index` est remplacé par une version instrumentée
 * (`vi.mock('@engine/index', instrumentEngine)`) : chaque action qui correspond à une commande
 * nommée du catalogue et qui modifie l'état est enregistrée sous forme de commande. Le journal
 * obtenu est ensuite rejoué par la correction du mode enseignant : il doit valider 100 % des
 * critères, comme l'élève qui ferait exactement ces opérations dans l'interface.
 *
 * Hors enregistrement, les fonctions instrumentées se comportent exactement comme l'original.
 */
import type * as Engine from '../../../src/engine/index'

type EngineModule = typeof Engine
type Fn = (...args: unknown[]) => unknown

/**
 * Actions exportées dont la commande passe par un adaptateur (résultat converti en
 * `EngineResult`) : même signature, correspondance par nom.
 */
const ADAPTERS: Record<string, string> = {
  executeLine: 'shell.exec',
  joinDomain: 'adds.joinDomain',
  leaveDomain: 'adds.leaveDomain',
  logon: 'adds.logon',
  changePasswordAndLogon: 'adds.changePasswordAndLogon',
  installDomainController: 'adds.installDomainController',
  mapDrive: 'files.mapDrive',
  unmapDrive: 'files.unmapDrive',
  dhcpRenew: 'net.dhcpRenew',
  dhcpRelease: 'net.dhcpRelease'
}

/** Fonctions qui modifient l'état sans être des commandes, mais que le rejeu reproduit seul. */
const IMPLICIT = new Set(['autoConfigureDhcp', 'runBackgroundTasks'])

interface Recording {
  commands: { type: string; args: unknown[] }[]
  /** Fonctions qui ont modifié l'état sans commande correspondante (solution non rejouable). */
  unmapped: Set<string>
}

let current: Recording | null = null
/** Mémo des tâches de fond pendant l'enregistrement (comme le store de l'interface). */
let memo: Engine.BackgroundMemo = {}

/** Tâches de fond après chaque opération, comme l'interface en Temps réel et le rejeu. */
function settle(state: Engine.LabState): Engine.LabState {
  const run = original!.runBackgroundTasks(state, memo)
  memo = run.memo
  return run.state
}

/** Résultat dont l'état est remplacé par l'état après tâches de fond. */
function withState(result: unknown, state: Engine.LabState): unknown {
  return { ...(result as object), state }
}
/** Profondeur d'appel : seules les opérations de premier niveau de la solution sont enregistrées. */
let depth = 0
let original: EngineModule | null = null
/** Enregistrement automatique (démarré par buildLabStart / buildLabState) : départ du lab suivi. */
let auto: { start: unknown; state?: unknown } | null = null
/** États de départ construits (plusieurs labs peuvent être chargés avant leurs tests). */
const starts = new Map<unknown, unknown>()
/**
 * Enregistrement explicite (startRecording) : l'état de la solution passe par les tâches de fond après
 * chaque opération, comme dans l'interface. En automatique, les états des tests restent inchangés.
 */
let settleMainLine = false
/** Labs dont la solution a été validée par rejeu dans ce fichier de test. */
export const replayed = new Set<string>()

function stateOf(result: unknown): unknown {
  if (typeof result !== 'object' || result === null) return undefined
  const r = result as { ok?: boolean; state?: unknown }
  if (r.ok === false) return undefined
  return r.state
}

const isLabState = (v: unknown): boolean =>
  typeof v === 'object' && v !== null && 'devices' in v && 'links' in v && 'clock' in v

/** Copie sérialisable (le rendu est un fichier JSON). */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** Fabrique de `vi.mock('@engine/index', …)` : module original instrumenté. */
export async function instrumentEngine(importOriginal: () => Promise<EngineModule>): Promise<EngineModule> {
  const engine = await importOriginal()
  original = engine
  const defs = engine.commandDefinitions() as Record<string, { run: unknown }>
  const byRun = new Map<unknown, string>()
  for (const [type, def] of Object.entries(defs)) byRun.set(def.run, type)
  const out: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(engine)) {
    if (typeof value !== 'function' || /^[A-Z]/.test(name)) {
      out[name] = value
      continue
    }
    const fn = value as Fn
    if (name === 'buildLabStart' || name === 'buildLabState') {
      // Départ d'un lab : l'enregistrement automatique commence (état après tâches de fond)
      out[name] = (...args: unknown[]) => {
        const state = fn(...args) as Engine.LabState
        if (current && !auto) return state
        const start = name === 'buildLabStart' ? args[0] : (args[0] as Engine.LabDefinition).start
        current = { commands: [], unmapped: new Set() }
        starts.set(state, start)
        auto = { start, state }
        settleMainLine = false
        memo = {}
        // État rendu tel quel : les tests du départ restent inchangés (les tâches de fond passent à la première opération)
        return state
      }
      continue
    }
    if (name === 'runIosScript') {
      // Script IOS = lignes saisies dans la console de l'équipement : une commande shell.exec par ligne
      out[name] = (state: Engine.LabState, deviceId: string, lines: readonly string[]) => {
        if (!current || depth > 0) return fn(state, deviceId, lines)
        if (starts.has(state) && (auto || current.commands.length === 0)) {
          current.commands = []
          current.unmapped.clear()
          auto = { start: starts.get(state), state }
        }
        let s = state
        let session: Engine.ShellSession = { deviceId, stack: ['ios'], cwd: '', variables: {} }
        for (const line of lines) {
          const r = engine.executeLine(s, session, line, [])
          if (r.state !== s) {
            current.commands.push(plain({ type: 'shell.exec', args: [session, line, []] }))
            s = settleMainLine ? settle(r.state) : r.state
          } else if (r.session !== session) {
            // Changement de mode sans effet sur l'état : la ligne reste nécessaire au rejeu
            current.commands.push(plain({ type: 'shell.exec', args: [session, line, []] }))
          }
          session = r.session
        }
        return s
      }
      continue
    }
    if (name === 'checkLab') {
      // Lab validé à 100 % pendant un enregistrement automatique : la solution doit l'être aussi par rejeu
      out[name] = (...args: unknown[]) => {
        const progress = fn(...args) as Engine.LabProgress
        const lab = args[1] as Engine.LabDefinition
        if (
          current &&
          auto &&
          auto.start === lab.start &&
          progress.total > 0 &&
          progress.passed === progress.total
        ) {
          const rec = current
          if (rec.unmapped.size > 0)
            throw new Error(
              `Solution non rejouable (${lab.id}) : ${[...rec.unmapped].join(', ')} sans commande nommée.`
            )
          const correction = replayAsSubmission(lab, rec)
          const failing = correction.criteria.filter((c) => !c.ok).map((c) => c.id)
          if (failing.length > 0 || correction.flags.length > 0)
            throw new Error(
              `Rejeu de la solution ${lab.id} : critères non validés [${failing.join(', ')}], signalements [${correction.flags.map((f) => f.code).join(', ')}].`
            )
          replayed.add(lab.id)
          if (process.env['SL_REPLAY_LOG']) console.log(`REJEU-OK ${lab.id}`)
        }
        return progress
      }
      continue
    }
    const type = byRun.get(fn) ?? ADAPTERS[name]
    out[name] = function (this: unknown, ...args: unknown[]) {
      depth++
      let result: unknown
      try {
        result = fn.apply(this, args)
      } finally {
        depth--
      }
      if (!current || depth > 0 || !isLabState(args[0])) return result
      // Nouvelle solution jouée depuis le départ (autre test du même fichier) : journal remis à zéro
      if (current && starts.has(args[0]) && (auto || current.commands.length === 0)) {
        current.commands = []
        current.unmapped.clear()
        auto = { start: starts.get(args[0]), state: args[0] }
      }
      if (name === 'dispatch') {
        // Commande déjà nommée : enregistrée telle quelle si elle a modifié l'état
        const cmd = args[1] as { type: string; args: unknown[] }
        const after = stateOf(result)
        if (after === undefined || after === args[0]) return result
        current.commands.push(plain({ type: cmd.type, args: cmd.args }))
        return settleMainLine ? withState(result, settle(after as Engine.LabState)) : result
      }
      const next = stateOf(result)
      if (next === undefined || next === args[0] || !isLabState(next)) return result
      if (type) {
        current.commands.push(plain({ type, args: args.slice(1) }))
        return settleMainLine ? withState(result, settle(next as Engine.LabState)) : result
      }
      if (!IMPLICIT.has(name)) current.unmapped.add(name)
      return result
    }
  }
  return out as EngineModule
}

/** Démarre l'enregistrement ; `stop` renvoie les commandes et les fonctions non rejouables. */
export function startRecording(): {
  /** État de départ tel que l'interface le charge (tâches de fond passées). */
  begin: (start: Engine.LabState) => Engine.LabState
  stop: () => Recording
} {
  current = { commands: [], unmapped: new Set() }
  auto = null
  settleMainLine = true
  memo = {}
  const rec = current
  return {
    begin: (start) => settle(start),
    stop: () => {
      current = null
      auto = null
      return rec
    }
  }
}

/**
 * Rejoue la solution enregistrée comme le rendu d'un élève (sujet créé depuis le lab, barème par
 * défaut) et renvoie la correction.
 */
export function replayAsSubmission(lab: Engine.LabDefinition, recording: Recording) {
  const e = original
  if (!e) throw new Error('instrumentEngine non installé (vi.mock manquant)')
  const subject = e.createSubject(lab, { appVersion: 'test' })
  const t0 = 1_793_000_000_000
  const submission = e.finishAttempt(
    {
      ...e.startAttempt(subject, 'Solution', 'self', t0),
      journal: recording.commands.map((command, i) => ({ kind: 'command' as const, at: t0 + i, command }))
    },
    { now: t0 + recording.commands.length, ending: 'finish', appVersion: 'test' }
  )
  const parsed = e.parseSubmission(e.serializeSubmission(submission))
  if (!parsed.ok) throw new Error(`Rendu invalide : ${parsed.message}`)
  return e.correctSubmission(subject, parsed.doc, { appVersion: 'test', correctedAt: 'test' })
}
