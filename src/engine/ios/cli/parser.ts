/**
 * Analyse d'une ligne IOS : abréviations non ambiguës, arguments typés, messages d'erreur IOS,
 * aide contextuelle (`?`) et complétion (Tab).
 */
import type { ArgContext, CliNode, CommandArgs, CommandHandler, HelpEntry, KeywordNode } from './types'

/** Jeton saisi et sa position dans la ligne (marqueur ^ des erreurs). */
export interface Token {
  text: string
  start: number
}

export function tokenize(line: string): Token[] {
  return [...line.matchAll(/\S+/g)].map((m) => ({ text: m[0], start: m.index ?? 0 }))
}

export type ParseOutcome =
  | { kind: 'run'; run: CommandHandler; args: CommandArgs }
  | { kind: 'incomplete' }
  | { kind: 'ambiguous' }
  /** Jeton non reconnu (index du jeton). */
  | { kind: 'invalid'; index: number }

/** Nœud disponible pour cet équipement (au moins une commande qui y passe l'est). */
function available(node: CliNode, ctx: ArgContext): boolean {
  return !node.guards || node.guards.some((g) => g === null || g(ctx))
}

/** Commande exécutable à ce nœud pour cet équipement. */
function runnable(node: CliNode, ctx: ArgContext): CommandHandler | undefined {
  return node.run && (!node.runGuard || node.runGuard(ctx)) ? node.run : undefined
}

/** Mots-clés disponibles du nœud. */
function keywordsOf(node: CliNode, ctx: ArgContext): KeywordNode[] {
  return [...node.keywords.values()].filter((k) => available(k, ctx))
}

/** Mots-clés du nœud commençant par `prefix` (le mot exact l'emporte). */
function keywordMatches(node: CliNode, prefix: string, ctx: ArgContext): KeywordNode[] {
  const lower = prefix.toLowerCase()
  const exact = node.keywords.get(lower)
  if (exact && available(exact, ctx)) return [exact]
  return keywordsOf(node, ctx).filter((k) => k.word.toLowerCase().startsWith(lower))
}

/** Parcourt l'arbre à partir du jeton `index`. */
function walk(
  node: CliNode,
  tokens: readonly string[],
  index: number,
  args: Record<string, string>,
  ctx: ArgContext
): ParseOutcome {
  if (index >= tokens.length) {
    const run = runnable(node, ctx)
    return run ? { kind: 'run', run, args } : { kind: 'incomplete' }
  }
  const token = tokens[index] as string
  const keywords = keywordMatches(node, token, ctx)
  if (keywords.length > 1) return { kind: 'ambiguous' }
  const keyword = keywords[0]
  if (keyword) return walk(keyword, tokens, index + 1, args, ctx)
  // Arguments : le premier qui mène à une commande ; sinon l'erreur la plus lointaine
  let best: ParseOutcome = { kind: 'invalid', index }
  for (const arg of node.args) {
    if (!available(arg, ctx)) continue
    const m = arg.type.match(tokens, index, ctx)
    if (!m) {
      // Argument sur plusieurs jetons (interface range) : erreur sous le jeton fautif
      const at = arg.type.failure?.(tokens, index, ctx)
      if (at !== undefined && best.kind === 'invalid' && at > best.index) best = { kind: 'invalid', index: at }
      continue
    }
    const outcome = walk(arg, tokens, index + m.consumed, { ...args, [arg.name]: m.value }, ctx)
    if (outcome.kind === 'run') return outcome
    if (best.kind === 'invalid' && (outcome.kind !== 'invalid' || outcome.index > best.index)) best = outcome
  }
  return best
}

/** Analyse une ligne complète dans l'arbre d'un mode. */
export function parseLine(root: CliNode, tokens: readonly string[], ctx: ArgContext): ParseOutcome {
  return walk(root, tokens, 0, {}, ctx)
}

/** Nœud atteint après les jetons complets (aide et complétion), ou l'échec rencontré. */
function reach(
  root: CliNode,
  tokens: readonly string[],
  ctx: ArgContext
): { node: CliNode } | { error: 'ambiguous' | 'unrecognized' } {
  let node = root
  let i = 0
  while (i < tokens.length) {
    const token = tokens[i] as string
    const keywords = keywordMatches(node, token, ctx)
    if (keywords.length > 1) return { error: 'ambiguous' }
    if (keywords[0]) {
      node = keywords[0]
      i++
      continue
    }
    const arg = node.args
      .filter((a) => available(a, ctx))
      .map((a) => ({ a, m: a.type.match(tokens, i, ctx) }))
      .find((x) => x.m !== null)
    if (!arg?.m) return { error: 'unrecognized' }
    node = arg.a
    i += arg.m.consumed
  }
  return { node }
}

/** Entrées d'aide d'un nœud : mots-clés, arguments, <cr> si la commande peut s'arrêter là. */
function nodeHelp(node: CliNode, ctx: ArgContext): HelpEntry[] {
  const entries: HelpEntry[] = keywordsOf(node, ctx)
    .map((k) => ({ word: k.word, help: k.help }))
    .sort((a, b) => a.word.localeCompare(b.word))
  for (const arg of node.args.filter((a) => available(a, ctx))) {
    entries.push(...(arg.type.helpEntries?.(ctx) ?? [{ word: arg.type.label, help: arg.help }]))
  }
  if (runnable(node, ctx)) entries.push({ word: '<cr>', help: '' })
  return entries
}

/** Mise en colonnes de l'aide IOS (mot puis description). */
export function formatHelp(entries: readonly HelpEntry[]): string[] {
  const width = Math.max(0, ...entries.map((e) => e.word.length)) + 2
  return entries.map((e) => (e.help ? `  ${e.word.padEnd(width)}${e.help}` : `  ${e.word}`))
}

/**
 * Aide `?` : « show ? » liste les suites possibles ; « sh? » liste les mots-clés qui commencent
 * par « sh » (sur une ligne).
 */
export function helpLines(root: CliNode, input: string, ctx: ArgContext): string[] {
  const tokens = tokenize(input).map((t) => t.text)
  const partial = input.length > 0 && !/\s$/.test(input) ? (tokens.pop() ?? '') : null
  const reached = reach(root, tokens, ctx)
  if ('error' in reached)
    return reached.error === 'ambiguous'
      ? [`% Ambiguous command: "${input.trim()}"`]
      : ['% Unrecognized command']
  if (partial === null) return formatHelp(nodeHelp(reached.node, ctx))
  const words = completions(reached.node, partial, ctx)
  return words.length > 0 ? [words.join('  ') + '  '] : ['% Unrecognized command']
}

function completions(node: CliNode, partial: string, ctx: ArgContext): string[] {
  const lower = partial.toLowerCase()
  const words = keywordsOf(node, ctx)
    .map((k) => k.word)
    .filter((w) => w.toLowerCase().startsWith(lower))
  for (const arg of node.args.filter((a) => available(a, ctx)))
    words.push(...(arg.type.complete?.(partial, ctx) ?? []))
  return words.sort((a, b) => a.localeCompare(b))
}

/**
 * Complétion Tab du dernier mot : mot complet suivi d'une espace s'il est le seul possible,
 * sinon null (IOS laisse la ligne inchangée).
 */
export function completeWord(
  root: CliNode,
  input: string,
  ctx: ArgContext
): { start: number; word: string } | null {
  if (input.length === 0 || /\s$/.test(input)) return null
  const tokens = tokenize(input)
  const last = tokens.pop()
  if (!last) return null
  const reached = reach(
    root,
    tokens.map((t) => t.text),
    ctx
  )
  if ('error' in reached) return null
  const words = completions(reached.node, last.text, ctx)
  return words.length === 1 ? { start: last.start, word: `${words[0]} ` } : null
}
