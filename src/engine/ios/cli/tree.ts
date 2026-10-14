/**
 * Arbres de commandes IOS : un arbre par mode, dérivé des syntaxes déclarées par les
 * fonctionnalités (registre), avec les préfixes `no` (forme négative) et `do` (commande d'exec
 * depuis la configuration).
 */
import { iosCommands } from '../registry'
import {
  IOS_MODES,
  isConfigMode,
  type CliCommand,
  type CliNode,
  type CommandHandler,
  type Guard,
  type IosMode,
  type KeywordNode,
  type SyntaxToken
} from './types'

const emptyNode = (): CliNode => ({ keywords: new Map(), args: [] })

/** Descend dans l'arbre en créant les nœuds de la syntaxe ; appelle `visit` à chaque profondeur. */
function insert(
  root: CliNode,
  syntax: readonly SyntaxToken[],
  guard: Guard | null,
  visit: (node: CliNode, depth: number) => void
) {
  let node = root
  syntax.forEach((token, i) => {
    let next: CliNode | undefined
    if ('keyword' in token) {
      const key = token.keyword.toLowerCase()
      next = node.keywords.get(key)
      if (!next) {
        const created: KeywordNode = { ...emptyNode(), word: token.keyword, help: token.help }
        node.keywords.set(key, created)
        next = created
      }
    } else {
      next = node.args.find((a) => a.name === token.arg && a.type === token.type)
      if (!next) {
        const created = { ...emptyNode(), name: token.arg, type: token.type, help: token.help }
        node.args.push(created)
        next = created
      }
    }
    node = next
    ;(node.guards ??= []).push(guard)
    visit(node, i + 1)
  })
}

function setRun(node: CliNode, run: CommandHandler, guard: Guard | null): void {
  node.run = run
  node.runGuard = guard
}

/**
 * Commande disponible dans ce mode : config-if-range reprend toutes les commandes de config-if,
 * appliquées à chaque interface de la plage (les actions parcourent session.ifaces).
 */
const inMode = (c: CliCommand, mode: IosMode): boolean =>
  c.modes.includes(mode) || (mode === 'config-if-range' && c.modes.includes('config-if'))

/** Arbre des commandes d'un mode (sans `no` ni `do`). */
function plainTree(commands: readonly CliCommand[], mode: IosMode): CliNode {
  const root = emptyNode()
  for (const c of commands) {
    if (!inMode(c, mode) || !c.run) continue
    const run = c.run
    const guard = c.available ?? null
    insert(root, c.syntax, guard, (node, depth) => {
      if (depth === c.syntax.length) setRun(node, run, guard)
    })
  }
  return root
}

/** Sous-arbre `no` d'un mode : exécutable dès `min` éléments de syntaxe. */
function noTree(commands: readonly CliCommand[], mode: IosMode): CliNode | null {
  const root = emptyNode()
  let any = false
  for (const c of commands) {
    if (!inMode(c, mode) || !c.no) continue
    any = true
    const { run, min = c.syntax.length } = c.no
    const guard = c.available ?? null
    insert(root, c.syntax, guard, (node, depth) => {
      if (depth >= min) setRun(node, run, guard)
    })
  }
  return any ? root : null
}

const NO_HELP = 'Negate a command or set its defaults'
const DO_HELP = 'To run exec commands in config mode'

function build(): Record<IosMode, CliNode> {
  const commands = iosCommands()
  const trees = {} as Record<IosMode, CliNode>
  for (const mode of IOS_MODES) trees[mode] = plainTree(commands, mode)
  // `do` : commandes d'exec (hors navigation) depuis tout mode de configuration
  const doRoot = plainTree(
    commands.filter((c) => c.doAllowed !== false),
    'exec'
  )
  for (const mode of IOS_MODES) {
    const tree = trees[mode]
    const no = noTree(commands, mode)
    if (no) tree.keywords.set('no', { ...no, word: 'no', help: NO_HELP })
    if (isConfigMode(mode)) tree.keywords.set('do', { ...doRoot, word: 'do', help: DO_HELP })
  }
  return trees
}

let cache: Record<IosMode, CliNode> | null = null

/** Arbre de commandes d'un mode (construit une fois, le registre est statique). */
export function modeTree(mode: IosMode): CliNode {
  cache ??= build()
  return cache[mode]
}
