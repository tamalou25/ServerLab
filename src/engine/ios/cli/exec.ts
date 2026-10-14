/**
 * Exécution d'une ligne saisie dans la console IOS : analyse dans l'arbre du mode courant
 * (repli sur la configuration globale depuis un sous-mode, comme IOS), messages d'erreur IOS,
 * saisies interactives (mot de passe) et Ctrl+Z.
 */
import type { LabState } from '../../model/schema'
import type { PacketTrace } from '../../sim/trace'
import { NeedInput, type OutputLine, type ShellResult, type ShellSession } from '../../shell/types'
import { parseLine, tokenize, type ParseOutcome, type Token } from './parser'
import { applyFilter, parseFilter, type FilterParse } from './filter'
import { unsimulatedIosMessage } from '../../shell/unsimulated'
import { iosPrompt, iosSessionOf } from './session'
import { modeTree } from './tree'
import { applyTraceEffects, settleIos, settleMessages } from '../registry'
import { iosState } from '../config'
import { isIos } from '../device'
import { CONFIG_SUBMODES, isConfigMode, type IosMode, type IosRunContext, type IosSession } from './types'

/** Ctrl+Z (envoyé par la console) : quitte la configuration, comme `end`. */
export const IOS_CTRL_Z = '\u001a'

/** Message journalisé en quittant la configuration (end, Ctrl+Z, exit). */
export const CONFIG_I_MESSAGE = '%SYS-5-CONFIG_I: Configured from console by console'

class RunContext implements IosRunContext {
  output: OutputLine[] = []
  loggedOut = false
  trace: PacketTrace | null = null
  private asked = 0

  constructor(
    public state: LabState,
    public readonly deviceId: string,
    public session: IosSession,
    private readonly answers: readonly string[]
  ) {}

  print(text: string): void {
    this.output.push({ text, kind: 'out' })
  }

  setMode(mode: IosMode, extra: Omit<IosSession, 'mode'> = {}): void {
    // Sortie de la configuration vers le mode privilégié : message de journalisation
    if (isConfigMode(this.session.mode) && mode === 'exec') this.print(CONFIG_I_MESSAGE)
    this.session = { mode, ...extra }
  }

  apply(result: { ok: true; state: LabState } | { ok: false; error: { message: string } }): boolean {
    if (result.ok) {
      this.state = result.state
      return true
    }
    this.print(`% ${result.error.message}`)
    return false
  }

  ask(message: string, secure = false): string {
    const answer = this.answers[this.asked]
    if (answer === undefined) throw new NeedInput({ message, secure })
    this.asked++
    return answer
  }

  addTrace(trace: PacketTrace): void {
    this.trace = trace
  }

  logout(): void {
    const name = this.state.devices[this.deviceId]?.name ?? 'Router'
    const device = this.state.devices[this.deviceId]
    const motd = isIos(device) ? iosState(device).bannerMotd : null
    const lines = ['', `${name} con0 is now available`, '', '', 'Press RETURN to get started.', '']
    if (motd) lines.push(...motd.split('\n'))
    this.output.push(...lines.map((text) => ({ text, kind: 'out' as const })))
    this.session = { mode: 'user' }
    this.loggedOut = true
  }
}

/** Analyse dans le mode courant ; un sous-mode de configuration se replie sur la configuration globale. */
function parseInMode(
  mode: IosMode,
  tokens: string[],
  ctx: RunContext
): { outcome: ParseOutcome; mode: IosMode } {
  const argCtx = { state: ctx.state, deviceId: ctx.deviceId, session: ctx.session }
  const outcome = parseLine(modeTree(mode), tokens, argCtx)
  if (CONFIG_SUBMODES.includes(mode) && outcome.kind === 'invalid' && outcome.index === 0) {
    const global = parseLine(modeTree('config'), tokens, argCtx)
    if (global.kind !== 'invalid' || global.index > 0) return { outcome: global, mode: 'config' }
  }
  return { outcome, mode }
}

/** Mot abrégé d'un mot-clé IOS (sh, sho, show). */
const abbrev = (word: string | undefined, keyword: string): boolean =>
  !!word && word.length >= 2 && keyword.startsWith(word.toLowerCase())

/**
 * Position du `|` d'un filtre de sortie : seulement après une commande show (ou `do show` depuis
 * la configuration) ; ailleurs, `|` reste un caractère ordinaire (description, banner…).
 */
function pipeIndex(tokens: readonly Token[]): number {
  const first = tokens[0]?.text.toLowerCase()
  const cmd = first === 'do' ? tokens[1]?.text : tokens[0]?.text
  if (!abbrev(cmd, 'show')) return -1
  return tokens.findIndex((t) => t.text === '|')
}

export function executeIos(
  state: LabState,
  session: ShellSession,
  line: string,
  answers: readonly string[] = []
): ShellResult {
  const ctx = new RunContext(state, session.deviceId, iosSessionOf(session), answers)
  const prompt = iosPrompt(session, state)
  const done = (): ShellResult => {
    // Effets des paquets échangés puis stabilisation (élection HSRP…), messages de la console
    const after = settleIos(applyTraceEffects(ctx.state, ctx.trace))
    for (const text of settleMessages(state, after, session.deviceId)) ctx.print(text)
    return {
      state: after,
      session: { ...session, ios: ctx.session },
      output: ctx.output,
      trace: ctx.trace,
      clear: false,
      prompt: null,
      exit: false
    }
  }

  if (line === IOS_CTRL_Z) {
    if (isConfigMode(ctx.session.mode)) ctx.setMode('exec')
    return done()
  }
  const allTokens = tokenize(line)
  if (allTokens.length === 0) return done()
  const pipe = pipeIndex(allTokens)
  const tokens = pipe < 0 ? allTokens : allTokens.slice(0, pipe)
  const filter: FilterParse | null = pipe < 0 ? null : parseFilter(line, allTokens, pipe + 1)
  const words = tokens.map((t) => t.text)
  const caret = (token: Token | undefined): void => {
    ctx.print(`${' '.repeat(prompt.length + (token?.start ?? 0))}^`)
    ctx.print("% Invalid input detected at '^' marker.")
    ctx.print('')
  }
  const { outcome, mode } = parseInMode(ctx.session.mode, words, ctx)

  try {
    switch (outcome.kind) {
      case 'run': {
        if (filter?.kind === 'invalid') {
          caret(allTokens[filter.index])
          break
        }
        if (filter?.kind === 'incomplete') {
          ctx.print('% Incomplete command.')
          ctx.print('')
          break
        }
        if (filter?.kind === 'unsimulated') {
          ctx.print(`% ${unsimulatedIosMessage(filter.name)}`)
          break
        }
        if (mode !== ctx.session.mode) ctx.session = { mode }
        const from = ctx.output.length
        outcome.run(ctx, outcome.args)
        if (filter?.kind === 'ok') {
          // Filtre appliqué aux seules lignes affichées par la commande
          const lines = ctx.output.splice(from).map((l) => l.text)
          for (const text of applyFilter(lines, filter.filter)) ctx.print(text)
        }
        break
      }
      case 'incomplete':
        ctx.print('% Incomplete command.')
        ctx.print('')
        break
      case 'ambiguous':
        ctx.print(`% Ambiguous command: "${line.trim()}"`)
        break
      case 'invalid': {
        const mode = ctx.session.mode
        if ((mode === 'user' || mode === 'exec') && outcome.index === 0) {
          // Mot inconnu en mode utilisateur ou privilégié : pris pour un nom d'hôte (Telnet)
          const device = ctx.state.devices[ctx.deviceId]
          const lookup = !isIos(device) || iosState(device).domainLookup
          ctx.print(`Translating "${words[0]}"${lookup ? '...domain server (255.255.255.255)' : ''}`)
          ctx.print('% Unknown command or computer name, or unable to find computer address')
          break
        }
        caret(tokens[outcome.index] ?? tokens[tokens.length - 1])
        break
      }
    }
  } catch (e) {
    if (e instanceof NeedInput) return { ...done(), state, session, prompt: e.prompt }
    throw e
  }
  return done()
}
