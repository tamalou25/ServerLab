/**
 * Contrat d'un module de rôle serveur (DHCP, DNS, AD DS…) : tout ce qui concerne un rôle est
 * déclaré dans son dossier `src/engine/roles/<rôle>` et rassemblé par le registre
 * (`registry.ts`). Le cœur du moteur (installation, consoles, critères de lab, tâches de fond,
 * commandes) ne connaît aucun rôle par son nom : il parcourt le registre.
 */
import type { Draft } from 'immer'
import type { AuditRule } from '../audit/types'
import type { TransitHooks } from '../sim/transit'
import type { z } from 'zod'
import type { CommandDefs } from '../commands/define'
import type { EngineError } from '../core/result'
import type { Domain, HostDevice, LabState, ServerDevice } from '../model/schema'
import type { CmdletDef } from '../shell/ps/registry'
import type { ToolDef } from '../shell/tools/types'
import type { PacketTrace } from '../sim/trace'

/** Rôle ou fonctionnalité installable (Install-WindowsFeature, assistant « Ajouter des rôles »). */
export interface FeatureInfo {
  name: string
  displayName: string
  /** Rôle (true) ou simple fonctionnalité. */
  role: boolean
  /** Fonctionnalités installées en même temps (dépendances obligatoires). */
  requires?: string[]
  /** Outils d'administration ajoutés avec -IncludeManagementTools. */
  managementTools?: string[]
  /** Fonctionnalité parente (affichage arborescent). */
  parent?: string
}

/** Données propres à un rôle, stockées sur le serveur (`device.roles[key]`). */
export interface RoleStateDef<S> {
  /** Clé dans `device.roles` (identifiant du rôle). */
  key: string
  /** Fonctionnalité dont l'installation crée l'état initial. */
  feature: string
  /** Schéma zod (validation et valeurs par défaut à l'ouverture d'un fichier .slab). */
  schema: z.ZodType<S>
  /** État initial à l'installation du rôle. */
  create(): S
}

/** Type de critère de lab (« dhcpScope », « gpoLinked »…) : schéma et évaluateur. */
export interface CriterionType<C extends { type: string } = { type: string }> {
  type: string
  /** Libellé français (éditeur de labs). */
  label: string
  /** Objet zod portant le discriminant `type` (z.literal). */
  schema: z.ZodObject
  /** Lit l'état sans le modifier (mêmes fonctions que les consoles et l'interface). */
  evaluate(state: LabState, check: C): boolean
}

/** Tâche de fond (mode Temps réel), exécutée par le moteur après chaque modification du lab. */
export interface BackgroundTask {
  id: string
  /** Libellé français (journal des tâches de fond). */
  label: string
  /**
   * Parties de l'état dont dépend la tâche (comparées par référence) : si aucune n'a changé
   * depuis son dernier passage, elle n'est pas relancée (pas de DORA retenté à chaque
   * déplacement). Absent : la tâche passe à chaque fois.
   */
  deps?(state: LabState): readonly unknown[]
  run(state: LabState): { state: LabState; traces: PacketTrace[] }
}

/** Condition d'accès à une vue (fonctionnalité installée, membre d'un domaine, serveur). */
export interface ViewRequirement {
  feature?: string
  domain?: boolean
  server?: boolean
}

/**
 * Vue graphique du rôle : application du Bureau simulé. Le moteur n'importe pas React : la vue
 * est décrite ici (titre, commande Exécuter, disponibilité) et son composant est associé par
 * l'interface (`renderer/src/components/desktop/roleViews.ts`, composant dans `renderApp.tsx`).
 */
export interface RoleView {
  /** Identifiant de l'application du Bureau. */
  app: string
  label: string
  /** Commandes reconnues par la boîte Exécuter (en minuscules). */
  run?: string[]
  /** Outil d'administration (menu Outils du Gestionnaire de serveur, menu Démarrer). */
  tool?: boolean
  /** Boîte de dialogue : taille fixe, pas de bouton Agrandir. */
  dialog?: boolean
  requires: ViewRequirement
}

/** Service système simulé apporté par le rôle (Gestionnaire de serveur > Services). */
export interface RoleService {
  display: string
  name: string
  /** Toujours présent (serveur), dès l'installation du rôle, ou seulement sur un contrôleur de domaine. */
  when: 'always' | 'installed' | 'domainController'
}

/** Module d'un rôle serveur. */
export interface RoleModule<C extends CommandDefs = CommandDefs> {
  /** Identifiant court (dossier `roles/<id>`). */
  id: string
  /** Nom affiché (Gestionnaire de serveur). */
  displayName: string
  /** Fonctionnalité principale du rôle (tuile du Gestionnaire de serveur). */
  feature: string
  /** Rôles dont celui-ci a besoin (identifiants), déclarés avant lui dans le registre. */
  dependencies: string[]
  /**
   * Autres rôles dont le code est appelé à l'exécution, sans être un prérequis d'installation
   * (ex. RRAS authentifie par AD DS ou NPS quand ils sont présents). Vérifié par un test : tout
   * import d'un autre rôle est déclaré dans `dependencies` ou ici.
   */
  uses?: string[]
  /** Rôles et fonctionnalités installables apportés par le module. */
  features: FeatureInfo[]
  /** Données stockées sur le serveur (absent si le rôle n'a pas d'état propre au serveur). */
  state?: RoleStateDef<unknown>
  /** Commandes nommées (modifications déclenchées par l'interface, les consoles, les labs). */
  commands: C
  /** Cmdlets PowerShell. */
  cmdlets: CmdletDef[]
  /** Outils en ligne de commande (CMD et PowerShell). */
  tools: ToolDef[]
  /** Commandes de la console bash des postes Linux. */
  bashTools?: ToolDef[]
  /** Applications du Bureau. */
  views: RoleView[]
  /** Types de critères de lab. */
  criteria: CriterionType[]
  /** Règles de l'audit de sécurité (mode Audit). */
  auditRules?: AuditRule[]
  /** Tâches de fond. */
  backgroundTasks: BackgroundTask[]
  /** Sources des évènements journalisés par le rôle (Observateur, Gestionnaire de serveur). */
  events: { sources: string[] }
  /** Services système simulés. */
  services: RoleService[]
  /**
   * Préparation du serveur à l'installation de la fonctionnalité principale (dossiers créés…),
   * dans la transaction d'installation.
   */
  onInstall?(draft: Draft<LabState>, device: Draft<ServerDevice>): void
  /**
   * Traitement de la stratégie ordinateur d'un membre du domaine (démarrage, gpupdate), dans sa
   * transaction : distribution de certificats racines, inscription automatique…
   */
  onComputerPolicy?(draft: Draft<LabState>, deviceId: string, domain: Domain): void
  /**
   * Référence d'un chemin réseau (espace de noms DFS) : renvoie le chemin cible
   * (\\SRV1\Compta\…) qui remplace `path`, ou null si le rôle ne le gère pas.
   */
  resolveUnc?(state: LabState, clientId: string, path: string): string | null
  /** Acheminement des paquets : routage par un serveur, NAT, proxy ARP, tunnels (RRAS). */
  transit?: TransitHooks
  /** Refus de désinstaller une fonctionnalité (ex. AD DS sur un contrôleur de domaine). */
  uninstallBlocked?(state: LabState, deviceId: string, feature: string): EngineError | null
}

/** Déclare un module de rôle (conserve le type exact des commandes). */
export function defineRole<C extends CommandDefs>(module: RoleModule<C>): RoleModule<C> {
  return module
}

/** Déclare un type de critère : le type de la vérification est déduit du schéma. */
export function defineCriterion<S extends z.ZodObject<{ type: z.ZodLiteral<string> }>>(
  schema: S,
  evaluate: (state: LabState, check: z.output<S>) => boolean,
  label: string
): CriterionType {
  return {
    type: schema.shape.type.value,
    label,
    schema,
    evaluate: evaluate as CriterionType['evaluate']
  }
}

/** Une vue est-elle accessible sur cet ordinateur ? */
export function viewAvailable(view: RoleView, device: HostDevice): boolean {
  const { feature, domain, server } = view.requires
  if (server && device.kind !== 'server') return false
  if (feature && !device.host.features.includes(feature)) return false
  if (domain && !device.host.domain) return false
  return true
}
