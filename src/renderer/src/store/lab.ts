/**
 * Store du document courant : état simulé (LabState du moteur), journal des commandes, fichier.
 * Toute modification passe par `dispatch` (commande nommée du moteur) ; l'annuler/rétablir
 * applique les patches du journal, sans aucun inverse écrit à la main.
 *
 * Mode Temps réel : après chaque changement d'état, le moteur exécute les tâches de fond
 * déclarées par les modules de rôles (bail DHCP, application des stratégies de groupe), hors
 * historique : annuler une action ne défait pas un bail obtenu entre-temps.
 */
import { create } from 'zustand'
import {
  createLab,
  dispatch as dispatchCommand,
  emptyHistory,
  journalEntry,
  recordEntry,
  runBackgroundTasks,
  redoStep,
  undoStep,
  type AnyCommand,
  type BackgroundMemo,
  type Command,
  type CommandType,
  type CommandValue,
  type DispatchResult,
  type History,
  type HistoryStep,
  type LabState,
  type Viewport
} from '@engine/index'

export const UNTITLED = 'Sans titre'

export type LabelledCommand = AnyCommand & { label?: string }

/** Commande déjà exécutée sur un état de base, validée plus tard (fin de lecture en Simulation). */
export interface PreparedCommand<T = unknown> {
  command: LabelledCommand
  base: LabState
  result: DispatchResult<T>
}

/** Résultat d'un annuler / rétablir : libellé de la commande, ou message d'erreur. */
export type HistoryOutcome = { ok: true; label: string } | { ok: false; code: string; message: string }

export interface DispatchOptions {
  /** false : appliquée sans entrer dans l'historique (tâches de fond). */
  record?: boolean
}

interface LabStore {
  lab: LabState
  filePath: string | null
  fileName: string
  dirty: boolean
  /** Historique annuler / rétablir (logique dans le moteur : commands/history.ts). */
  history: History
  /** État au début d'une transaction (glisser) : les commandes intermédiaires ne sont pas journalisées. */
  transactionBase: LabState | null
  /** Incrémenté à chaque chargement de document (permet au canvas de recadrer la vue). */
  revision: number
  /** État au chargement du document (départ du lab) : référence du rapport d'audit. */
  loadedLab: LabState
  /** Vue à restaurer après chargement (null → ajuster à la fenêtre). */
  viewport: Viewport | null
  /** Mode Temps réel : tâches de fond des rôles exécutées après chaque changement. */
  realtime: boolean

  /** Exécute une commande du moteur ; en cas de succès l'état est remplacé (et journalisé). */
  dispatch<K extends CommandType>(
    command: Command<K>,
    options?: DispatchOptions
  ): DispatchResult<CommandValue<K>>
  dispatch(command: LabelledCommand, options?: DispatchOptions): DispatchResult<unknown>
  /** Exécute une commande sans l'appliquer (opération réseau rejouée avant validation). */
  prepare<K extends CommandType>(command: Command<K>): PreparedCommand<CommandValue<K>>
  /** Valide une commande préparée ; si le lab a changé entre-temps, elle est exécutée à nouveau. */
  commit(prepared: PreparedCommand): void
  /** Ouvre une transaction : la suite de modifications forme une seule entrée du journal. */
  beginTransaction(): void
  /** Ferme la transaction et la journalise sous la commande qui la résume (ex. déplacement). */
  commitTransaction(command: LabelledCommand): void
  undo(): HistoryOutcome
  redo(): HistoryOutcome
  /** Remplace le document (nouveau, ouverture, récupération). */
  load(
    lab: LabState,
    file: { path: string | null; name: string },
    viewport?: Viewport | null,
    dirty?: boolean
  ): void
  markSaved(path: string, name: string): void
  /** Active ou suspend les tâches de fond (mode Temps réel / Simulation). */
  setRealtime(on: boolean): void
}

/**
 * Enregistreur de la passation (mode enseignant) : reçoit chaque commande exécutée par
 * l'interface, refusée ou non, ainsi que les annulations, rétablissements et transactions.
 * null hors passation.
 */
export type JournalRecorder = (
  step:
    | { kind: 'command'; command: LabelledCommand }
    | { kind: 'undo' | 'redo' }
    | { kind: 'transaction'; label: string; commands: LabelledCommand[] }
) => void

let recorder: JournalRecorder | null = null
/** Commandes intermédiaires d'une transaction en cours (enregistrées en un seul pas). */
let transactionCommands: LabelledCommand[] = []

export function setJournalRecorder(next: JournalRecorder | null): void {
  recorder = next
  transactionCommands = []
}

export const useLabStore = create<LabStore>()((set, get) => {
  /** Dépendances des tâches de fond à leur dernier passage (tâches incrémentales du moteur). */
  let backgroundMemo: BackgroundMemo = {}

  /** État après les tâches de fond des rôles (mode Temps réel uniquement). */
  const settle = (lab: LabState): LabState => {
    if (!get().realtime) return lab
    const result = runBackgroundTasks(lab, backgroundMemo)
    backgroundMemo = result.memo
    return result.state
  }

  /** Applique un pas d'historique (annuler ou rétablir) calculé par le moteur. */
  const applyStep = (step: HistoryStep): HistoryOutcome => {
    if (!step.ok) {
      set({ history: step.history })
      return { ok: false, code: step.error.code, message: step.error.message }
    }
    set({ lab: settle(step.state), history: step.history, dirty: true })
    return { ok: true, label: step.entry.label }
  }

  const initial = createLab()
  return {
    lab: initial,
    loadedLab: initial,
    filePath: null,
    fileName: UNTITLED,
    dirty: false,
    history: emptyHistory(),
    transactionBase: null,
    revision: 0,
    viewport: null,
    realtime: true,

    dispatch: ((command: LabelledCommand, options?: DispatchOptions) => {
      const before = get().lab
      if (recorder) {
        if (get().transactionBase !== null) transactionCommands.push(command)
        else recorder({ kind: 'command', command })
      }
      const result = dispatchCommand(before, command)
      if (result.ok && result.state !== before) {
        const record = (options?.record ?? true) && get().transactionBase === null
        set((s) => ({
          lab: settle(result.state),
          dirty: true,
          ...(record && result.entry ? { history: recordEntry(s.history, result.entry) } : {})
        }))
      }
      return result
    }) as LabStore['dispatch'],

    prepare: ((command: LabelledCommand) => {
      const base = get().lab
      return { command, base, result: dispatchCommand(base, command) }
    }) as LabStore['prepare'],

    commit(prepared) {
      const { result, base, command } = prepared
      if (get().lab !== base) {
        // Le lab a changé pendant la lecture : la commande est rejouée sur l'état courant
        if (result.ok) get().dispatch(command)
        return
      }
      recorder?.({ kind: 'command', command })
      if (!result.ok) return
      if (result.state === base) return
      const entry = journalEntry(base, result.state, command)
      set((s) => ({
        lab: settle(result.state),
        dirty: true,
        ...(entry ? { history: recordEntry(s.history, entry) } : {})
      }))
    },

    beginTransaction() {
      if (get().transactionBase === null) set({ transactionBase: get().lab })
    },

    commitTransaction(command) {
      const base = get().transactionBase
      if (base === null) return
      recorder?.({ kind: 'transaction', label: command.label ?? command.type, commands: transactionCommands })
      transactionCommands = []
      const entry = journalEntry(base, get().lab, command)
      set((s) => ({ transactionBase: null, ...(entry ? { history: recordEntry(s.history, entry) } : {}) }))
    },

    undo() {
      recorder?.({ kind: 'undo' })
      return applyStep(undoStep(get().lab, get().history))
    },

    redo() {
      recorder?.({ kind: 'redo' })
      return applyStep(redoStep(get().lab, get().history))
    },

    load(lab, file, viewport = null, dirty = false) {
      // Nouveau document : toutes les tâches de fond repassent
      backgroundMemo = {}
      const settled = settle(lab)
      set((s) => ({
        lab: settled,
        filePath: file.path,
        fileName: file.name,
        // Un bail obtenu à l'ouverture modifie le document
        dirty: dirty || settled !== lab,
        history: emptyHistory(),
        transactionBase: null,
        viewport,
        revision: s.revision + 1,
        loadedLab: settled
      }))
    },

    markSaved(path, name) {
      set({ filePath: path, fileName: name, dirty: false })
    },

    setRealtime(on) {
      if (get().realtime === on) return
      set({ realtime: on })
      const { lab } = get()
      const settled = settle(lab)
      if (settled !== lab) set({ lab: settled, dirty: true })
    }
  }
})
