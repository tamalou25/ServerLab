/**
 * Types de la CLI IOS : modes, session, arbre de commandes déclaratif.
 */
import type { LabState } from '../../model/schema'
import type { PacketTrace } from '../../sim/trace'

/** Modes de la CLI (invite affichée : voir MODE_PROMPT). */
export const IOS_MODES = [
  'user',
  'exec',
  'config',
  'config-if',
  'config-if-range',
  'config-subif',
  'config-line',
  'config-router',
  'config-vlan',
  'dhcp-config',
  'config-std-nacl',
  'config-ext-nacl'
] as const
export type IosMode = (typeof IOS_MODES)[number]

/** Sous-modes de configuration : une commande inconnue y est cherchée en configuration globale. */
export const CONFIG_SUBMODES: readonly IosMode[] = [
  'config-if',
  'config-if-range',
  'config-subif',
  'config-line',
  'config-router',
  'config-vlan',
  'dhcp-config',
  'config-std-nacl',
  'config-ext-nacl'
]

/** Modes de configuration (Ctrl+Z, end et do y sont disponibles). */
export function isConfigMode(mode: IosMode): boolean {
  return mode === 'config' || CONFIG_SUBMODES.includes(mode)
}

/** Lignes d'accès (line console 0, line vty 0 4). */
export interface IosLineRef {
  type: 'console' | 'vty'
  first: number
  last: number
}

/** État de la console IOS (persisté avec la session de console de l'interface). */
export interface IosSession {
  mode: IosMode
  /** Interfaces en cours de configuration (identifiants), en config-if, config-if-range, config-subif. */
  ifaces?: string[]
  /** Lignes en cours de configuration, en config-line. */
  line?: IosLineRef
  /** Liste d'accès nommée en cours de configuration (config-std-nacl, config-ext-nacl). */
  acl?: string
  /** Pool DHCP en cours de configuration, en dhcp-config. */
  pool?: string
  /** VLAN en cours de configuration, en config-vlan. */
  vlans?: number[]
  /** Processus de routage en cours de configuration, en config-router. */
  router?: { protocol: 'ospf' | 'rip'; process: number }
  /** Commandes saisies en mode utilisateur ou privilégié (show history, 10 au plus). */
  history?: string[]
  /** Lignes par écran (terminal length) ; absente : 24. */
  length?: number
}

/** Valeur d'un argument reconnu. */
export type ArgValue = string

/** Résultat de la reconnaissance d'un argument à partir du jeton `index`. */
export interface ArgMatch {
  /** Nombre de jetons consommés (1, ou 2 pour « g 0/0 »). */
  consumed: number
  value: ArgValue
}

/** Contexte de lecture d'un argument (équipement concerné). */
export interface ArgContext {
  state: LabState
  deviceId: string
  /** Session (mode et interfaces en cours de configuration). */
  session: IosSession
}

/** Disponibilité d'une commande selon l'équipement ou l'interface configurée. */
export type Guard = (ctx: ArgContext) => boolean

/** Type d'argument : reconnaissance, aide (`?`) et complétion. */
export interface ArgType {
  /** Libellé dans l'aide (WORD, A.B.C.D, <1-4094>, LINE). */
  label: string
  /** Reconnaît l'argument à partir de tokens[index] (null : invalide). */
  match(tokens: readonly string[], index: number, ctx: ArgContext): ArgMatch | null
  /** Jeton fautif quand `match` échoue (marqueur ^ sous ce jeton plutôt que sous le premier). */
  failure?(tokens: readonly string[], index: number, ctx: ArgContext): number
  /** Entrées d'aide propres (ex. types d'interface) ; par défaut une ligne label + aide. */
  helpEntries?(ctx: ArgContext): HelpEntry[]
  /** Complétion Tab d'un jeton partiel. */
  complete?(partial: string, ctx: ArgContext): string[]
  /** L'argument consomme tout le reste de la ligne (texte libre). */
  rest?: boolean
}

export interface HelpEntry {
  word: string
  help: string
}

/** Élément d'une syntaxe : mot-clé ou argument nommé. */
export type SyntaxToken = { keyword: string; help: string } | { arg: string; type: ArgType; help: string }

/** Arguments reconnus d'une commande, par nom. */
export type CommandArgs = Readonly<Record<string, ArgValue>>

/** Contexte d'exécution d'une commande (voir exec.ts). */
export interface IosRunContext {
  state: LabState
  deviceId: string
  session: IosSession
  /** Écrit une ligne de sortie. */
  print(text: string): void
  /** Passe dans un autre mode. */
  setMode(mode: IosMode, extra?: Omit<IosSession, 'mode'>): void
  /** Applique un nouvel état (résultat d'une action du moteur) ; erreur affichée sinon. */
  apply(result: { ok: true; state: LabState } | { ok: false; error: { message: string } }): boolean
  /** Saisie demandée à l'utilisateur (mot de passe…) : renvoie la réponse. */
  ask(message: string, secure?: boolean): string
  /** Fermeture de la session console (exit en mode utilisateur ou privilégié). */
  logout(): void
  /** Paquets échangés par la commande (rejoués en mode Simulation). */
  addTrace(trace: PacketTrace): void
}

export type CommandHandler = (ctx: IosRunContext, args: CommandArgs) => void

/** Commande déclarée par une fonctionnalité IOS. */
export interface CliCommand {
  /** Modes où la commande est disponible. */
  modes: readonly IosMode[]
  syntax: readonly SyntaxToken[]
  run?: CommandHandler
  /**
   * Forme `no` : exécutable dès `min` éléments de syntaxe (les suivants restent facultatifs).
   * Absente : la commande n'a pas de forme `no`.
   */
  no?: { run: CommandHandler; min?: number }
  /** false : commande de navigation, absente de `do` (enable, configure, exit…). */
  doAllowed?: boolean
  /** Commande disponible seulement si (switch, routeur, interface de niveau 3…). */
  available?: Guard
}

/** Nœud de l'arbre de commandes d'un mode (dérivé des syntaxes déclarées). */
export interface CliNode {
  keywords: Map<string, KeywordNode>
  args: ArgNode[]
  run?: CommandHandler
  /** Conditions des commandes qui passent par ce nœud (null : toujours disponible). */
  guards?: (Guard | null)[]
  /** Condition de la commande qui s'arrête à ce nœud. */
  runGuard?: Guard | null
}

export interface KeywordNode extends CliNode {
  word: string
  help: string
}

export interface ArgNode extends CliNode {
  name: string
  type: ArgType
  help: string
}
