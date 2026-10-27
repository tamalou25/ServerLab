/**
 * Catalogue des commandes : toute modification de l'état du lab demandée par l'interface, les
 * consoles ou les labs est une commande nommée `{ type, args }`, sérialisable et rejouable.
 * Chaque commande réutilise telle quelle une action du moteur et fournit un libellé en français
 * (journal, menu « Annuler : … »).
 *
 * Commandes du système de base ici ; celles d'un rôle sont déclarées par son module
 * (`roles/<rôle>/commands.ts`) et rassemblées par le registre.
 */
import { clearEventLog } from '../core/eventlog'
import { playStep, type StepRecord } from '../cyber/scenario'
import { getScenario } from '../cyber/registry'
import { configureCyber, setAdminAccess } from '../cyber/config'
import { applyCountermeasure, getCountermeasure } from '../cyber/countermeasures'
import { fail, type EngineResult } from '../core/result'
import { nextDeviceName } from '../model/factory'
import type { LabState, Position } from '../model/schema'
import {
  addPfRule,
  clearPfLog,
  movePfRule,
  removePfAlias,
  removePfRule,
  resetPfStates,
  setPfAlias,
  setPfBlockNetworks,
  updatePfRule
} from '../net/pf-rules'
import {
  addPfOutboundNat,
  addPfPortForward,
  removePfOutboundNat,
  removePfPortForward,
  setPfNatMode,
  updatePfOutboundNat,
  updatePfPortForward
} from '../net/pf-nat'
import { addStaticRoute, removeStaticRoute, setHelperAddresses, setInterfaceIpv4 } from '../net/config'
import {
  addSubinterface,
  addVlan,
  removeSubinterface,
  removeVlan,
  renameVlan,
  setSwitchport
} from '../net/vlan'
import { backgroundLabel, runBackgroundTasks } from '../roles/background'
import { installFeatures, uninstallFeatures } from '../roles/features'
import { roleModules, type RoleModules } from '../roles/registry'
import { newSelfSignedCertificate } from '../services/certificates'
import {
  newFirewallRule,
  PROFILE_LABELS,
  removeFirewallRule,
  setFirewallProfile,
  setFirewallRuleEnabled,
  setNetworkCategory
} from '../services/firewall'
import { resyncClock, setHostClock } from '../services/hostclock'
import {
  clearServiceFailure,
  restartService,
  setServiceFailure,
  setServiceRecovery,
  setServiceStartType,
  startService,
  stopService
} from '../services/hostservices'
import {
  addLocalGroupMembers,
  newLocalGroup,
  newLocalUser,
  removeLocalGroupMembers,
  removeLocalUser,
  setLocalUser
} from '../services/localaccounts'
import { installPackages } from '../services/linuxsystem'
import { renameComputer, restartComputer } from '../services/system'
import { useHint } from '../troubleshoot/hints'
import { executeLine } from '../shell/exec'
import type { ShellResult, ShellSession } from '../shell/types'
import type { PacketTrace } from '../sim/trace'
import {
  addDevice,
  addServerInterface,
  connect,
  disconnect,
  duplicateDevices,
  moveDevice,
  removeDevices,
  renameDevice,
  setInterfaceEnabled,
  setPower
} from '../topology/actions'
import { def, on, type AnyCommand, type CommandDef, type CommandDefs } from './define'
import { deviceName, deviceNames, interfaceName, linkName } from './labels'

export { def, type AnyCommand, type CommandDef, type CommandDefs } from './define'
export type { DirectoryOutcome } from '../roles/adds/commands'
export type { DhcpClientOutcome } from '../roles/dhcp/commands'

/** Déplacement de plusieurs équipements (fin d'un glisser sur le canvas). */
function moveDevices(state: LabState, moves: { id: string; position: Position }[]): EngineResult {
  let current = state
  for (const move of moves) {
    const result = moveDevice(current, move.id, move.position)
    if (!result.ok) return result
    current = result.state
  }
  return { ok: true, state: current, value: undefined }
}

/** Résultat d'une ligne de console (sans l'état, porté par EngineResult). */
export type ShellOutcome = Omit<ShellResult, 'state'>

// --- Lot de commandes ---------------------------------------------------------------------------

/** Exécute plusieurs commandes dans l'ordre ; la première erreur annule tout le lot. */
function runBatch(state: LabState, commands: AnyCommand[]): EngineResult<unknown[]> {
  let current = state
  const values: unknown[] = []
  for (const command of commands) {
    const entry = isCommandType(command.type) ? commandDefinitions()[command.type] : undefined
    if (!entry || command.type === 'batch')
      return { ok: false, error: { code: 'UnknownCommand', message: `Commande inconnue : ${command.type}.` } }
    const result = entry.run(current, ...command.args)
    if (!result.ok) return result
    current = result.state
    values.push(result.value)
  }
  return { ok: true, state: current, value: values }
}

/** Tâches de fond (mode Temps réel) déclarées par les modules de rôles. */
function backgroundTick(state: LabState): EngineResult<PacketTrace[]> {
  const { state: next, traces } = runBackgroundTasks(state)
  return { ok: true, state: next, value: traces }
}

function shellExec(
  state: LabState,
  session: ShellSession,
  line: string,
  answers: string[]
): EngineResult<ShellOutcome> {
  const { state: next, ...outcome } = executeLine(state, session, line, answers)
  return { ok: true, state: next, value: outcome }
}

/** Joue une étape d'un scénario enregistré (cyber) : « une étape = un tour ». */
function playScenarioStep(state: LabState, scenarioId: string, index: number): EngineResult<StepRecord> {
  const scenario = getScenario(scenarioId)
  if (!scenario) return fail('ScenarioNotFound', `Scénario introuvable : ${scenarioId}.`)
  if (state.cyber.scenarios !== null && !state.cyber.scenarios.includes(scenarioId))
    return fail('ScenarioDisabled', 'Ce scénario n’est pas activé dans ce lab.')
  return playStep(state, scenario, index)
}

// --- Catalogue ----------------------------------------------------------------------------------

/** Commandes du système de base (topologie, réseau, système, consoles, lots). */
const CORE_COMMANDS = {
  // Cybersécurité : données de départ d'un lab (cibles, scénarios activés, réglages de partie)
  'cyber.configure': def(configureCyber, () => 'Configurer les scénarios de cybersécurité'),
  'cyber.setAdminAccess': def(setAdminAccess, (s, id) => `Accès administrateur depuis ${deviceName(s, id)}`),
  // Cybersécurité : contre-mesure du camp Blue (mode Red/Blue), actions de durcissement existantes
  'cyber.applyCountermeasure': def(
    applyCountermeasure,
    (_s, id) => `Contre-mesure : ${getCountermeasure(id)?.label ?? id}`
  ),
  // Cybersécurité : un tour d'un scénario (le déroulé vit dans l'interface, l'effet dans l'état)
  'cyber.playStep': def(playScenarioStep, (_s, id, index) => {
    const step = getScenario(id)?.steps[index]
    return `Scénario ${getScenario(id)?.name ?? id} : ${step?.label ?? `étape ${index + 1}`}`
  }),
  // Topologie
  // Sans nom imposé : le nom que l'équipement recevra (SRV1, PC2…)
  'topology.addDevice': def(addDevice, (s, p) => `Ajouter ${p.name?.trim() || nextDeviceName(s, p.kind)}`),
  'topology.removeDevices': def(removeDevices, (s, ids) => `Supprimer ${deviceNames(s, ids)}`),
  'topology.renameDevice': def(renameDevice, (s, id, name) => `Renommer ${deviceName(s, id)} en ${name}`),
  'topology.moveDevice': def(moveDevice, (s, id) => `Déplacer ${deviceName(s, id)}`),
  'topology.moveDevices': def(
    moveDevices,
    (s, moves) =>
      `Déplacer ${deviceNames(
        s,
        moves.map((m) => m.id)
      )}`
  ),
  'topology.setPower': def(setPower, (s, id, on) => `${on ? 'Allumer' : 'Éteindre'} ${deviceName(s, id)}`),
  'topology.connect': def(
    connect,
    (s, a, b) =>
      `Câbler ${interfaceName(s, a.deviceId, a.ifaceId)} ↔ ${interfaceName(s, b.deviceId, b.ifaceId)}`
  ),
  'topology.disconnect': def(disconnect, (s, linkId) => `Débrancher ${linkName(s, linkId)}`),
  'topology.duplicateDevices': def(
    duplicateDevices,
    (_s, source) => `Coller ${source.devices.length} équipement(s)`
  ),
  'topology.addServerInterface': def(addServerInterface, (s, id) => `Ajouter une carte réseau${on(s, id)}`),

  // Réseau
  'net.setInterfaceEnabled': def(
    setInterfaceEnabled,
    (s, id, ifaceId, enabled) => `${enabled ? 'Activer' : 'Désactiver'} ${interfaceName(s, id, ifaceId)}`
  ),
  'net.setInterfaceIpv4': def(
    setInterfaceIpv4,
    (s, id, ifaceId) => `Configurer IPv4 de ${interfaceName(s, id, ifaceId)}`
  ),
  'net.addStaticRoute': def(
    addStaticRoute,
    (s, id, r) => `Ajouter la route ${r.network}/${r.mask}${on(s, id)}`
  ),
  'net.removeStaticRoute': def(removeStaticRoute, (s, id) => `Supprimer une route statique${on(s, id)}`),
  'net.setHelperAddresses': def(setHelperAddresses, (s, id, ifaceId, list) =>
    list.length > 0
      ? `Relayer DHCP de ${interfaceName(s, id, ifaceId)} vers ${list.join(', ')}`
      : `Désactiver le relais DHCP de ${interfaceName(s, id, ifaceId)}`
  ),
  'net.addVlan': def(addVlan, (s, id, vlan) => `Créer le VLAN ${vlan}${on(s, id)}`),
  'net.renameVlan': def(renameVlan, (s, id, vlan, name) => `Renommer le VLAN ${vlan} en ${name}${on(s, id)}`),
  'net.removeVlan': def(removeVlan, (s, id, vlan) => `Supprimer le VLAN ${vlan}${on(s, id)}`),
  'net.setSwitchport': def(setSwitchport, (s, id, ifaceId, input) =>
    input.mode === 'trunk'
      ? `Configurer ${interfaceName(s, id, ifaceId)} en trunk 802.1Q`
      : `Affecter ${interfaceName(s, id, ifaceId)} au VLAN ${input.accessVlan ?? 1}`
  ),
  'net.addSubinterface': def(
    addSubinterface,
    (s, id, parentId, vlan) => `Créer la sous-interface ${interfaceName(s, id, parentId)}.${vlan}`
  ),
  'net.removeSubinterface': def(
    removeSubinterface,
    (s, id, ifaceId) => `Supprimer la sous-interface ${interfaceName(s, id, ifaceId)}`
  ),

  // Pare-feu Windows Defender
  'firewall.setProfile': def(setFirewallProfile, (s, id, profiles, input) => {
    const names = profiles.map((p) => PROFILE_LABELS[p]).join(', ')
    const what =
      input.enabled === undefined
        ? 'Modifier les actions par défaut'
        : input.enabled
          ? 'Activer le pare-feu'
          : 'Désactiver le pare-feu'
    return `${what} (profil ${names})${on(s, id)}`
  }),
  'firewall.setNetworkCategory': def(
    setNetworkCategory,
    (s, id, category) => `Réseau ${category === 'Private' ? 'privé' : 'public'}${on(s, id)}`
  ),
  'firewall.newRule': def(
    newFirewallRule,
    (s, id, input) => `Nouvelle règle de pare-feu « ${input.displayName} »${on(s, id)}`
  ),
  'firewall.setRuleEnabled': def(setFirewallRuleEnabled, (s, id, selector, enabled) => {
    const target = selector.displayName ?? selector.group ?? selector.name ?? ''
    return `${enabled ? 'Activer' : 'Désactiver'} la règle de pare-feu « ${target} »${on(s, id)}`
  }),
  'firewall.removeRule': def(removeFirewallRule, (s, id, selector) => {
    const target = selector.displayName ?? selector.group ?? selector.name ?? ''
    return `Supprimer la règle de pare-feu « ${target} »${on(s, id)}`
  }),

  // Pare-feu pfSense (v2.10)
  'pf.addRule': def(
    addPfRule,
    (s, id, input) =>
      `Ajouter une règle ${input.action ?? 'pass'} sur ${input.iface.toUpperCase()}${on(s, id)}`
  ),
  'pf.updateRule': def(updatePfRule, (s, id, ruleId) => `Modifier la règle ${ruleId}${on(s, id)}`),
  'pf.removeRule': def(removePfRule, (s, id, ruleId) => `Supprimer la règle ${ruleId}${on(s, id)}`),
  'pf.moveRule': def(movePfRule, (s, id, ruleId) => `Déplacer la règle ${ruleId}${on(s, id)}`),
  'pf.setAlias': def(setPfAlias, (s, id, alias) => `Définir l’alias ${alias.name}${on(s, id)}`),
  'pf.removeAlias': def(removePfAlias, (s, id, name) => `Supprimer l’alias ${name}${on(s, id)}`),
  'pf.setBlockNetworks': def(
    setPfBlockNetworks,
    (s, id, key) => `Blocage des réseaux privés et bogons de ${key.toUpperCase()}${on(s, id)}`
  ),
  'pf.setNatMode': def(setPfNatMode, (s, id, mode) => `Mode de NAT sortant : ${mode}${on(s, id)}`),
  'pf.addOutboundNat': def(addPfOutboundNat, (s, id) => `Ajouter une règle de NAT sortant${on(s, id)}`),
  'pf.updateOutboundNat': def(
    updatePfOutboundNat,
    (s, id, natId) => `Modifier la règle de NAT sortant ${natId}${on(s, id)}`
  ),
  'pf.removeOutboundNat': def(
    removePfOutboundNat,
    (s, id, natId) => `Supprimer la règle de NAT sortant ${natId}${on(s, id)}`
  ),
  'pf.addPortForward': def(
    addPfPortForward,
    (s, id, input) => `Ajouter une redirection de port vers ${input.targetAddress}${on(s, id)}`
  ),
  'pf.updatePortForward': def(
    updatePfPortForward,
    (s, id, natId) => `Modifier la redirection de port ${natId}${on(s, id)}`
  ),
  'pf.removePortForward': def(
    removePfPortForward,
    (s, id, natId) => `Supprimer la redirection de port ${natId}${on(s, id)}`
  ),
  'pf.clearLog': def(clearPfLog, (s, id) => `Vider le journal du pare-feu${on(s, id)}`),
  'pf.resetStates': def(resetPfStates, (s, id) => `Réinitialiser la table d’états${on(s, id)}`),

  // Système
  'system.restartComputer': def(restartComputer, (s, id) => `Redémarrer ${deviceName(s, id)}`),
  'system.renameComputer': def(
    renameComputer,
    (s, id, name) => `Renommer l’ordinateur ${deviceName(s, id)} en ${name}`
  ),
  'host.setClock': def(
    setHostClock,
    (s, id, offsetSeconds) =>
      `Régler l’horloge de ${deviceName(s, id)} (écart de ${offsetSeconds} s avec l’horloge du lab)`
  ),
  'host.resyncClock': def(resyncClock, (s, id) => `Resynchroniser l’horloge de ${deviceName(s, id)}`),
  'service.start': def(startService, (s, id, name) => `Démarrer le service ${name}${on(s, id)}`),
  'service.stop': def(stopService, (s, id, name) => `Arrêter le service ${name}${on(s, id)}`),
  'service.restart': def(restartService, (s, id, name) => `Redémarrer le service ${name}${on(s, id)}`),
  'service.setStartType': def(
    setServiceStartType,
    (s, id, name, type) => `Type de démarrage ${type} pour le service ${name}${on(s, id)}`
  ),
  'service.setFailure': def(
    setServiceFailure,
    (s, id, name) => `Mettre le service ${name} en échec au démarrage${on(s, id)}`
  ),
  'service.clearFailure': def(
    clearServiceFailure,
    (s, id, name) => `Réparer la configuration du service ${name}${on(s, id)}`
  ),
  'service.setRecovery': def(
    setServiceRecovery,
    (s, id, name) => `Options de récupération du service ${name}${on(s, id)}`
  ),
  'local.newUser': def(newLocalUser, (s, id, input) => `Créer l’utilisateur local ${input.name}${on(s, id)}`),
  'local.setUser': def(setLocalUser, (s, id, name) => `Modifier l’utilisateur local ${name}${on(s, id)}`),
  'local.removeUser': def(
    removeLocalUser,
    (s, id, name) => `Supprimer l’utilisateur local ${name}${on(s, id)}`
  ),
  'local.newGroup': def(newLocalGroup, (s, id, input) => `Créer le groupe local ${input.name}${on(s, id)}`),
  'local.addGroupMembers': def(
    addLocalGroupMembers,
    (s, id, group, members) => `Ajouter ${members.join(', ')} au groupe local ${group}${on(s, id)}`
  ),
  'local.removeGroupMembers': def(
    removeLocalGroupMembers,
    (s, id, group, members) => `Retirer ${members.join(', ')} du groupe local ${group}${on(s, id)}`
  ),
  'system.clearEventLog': def(clearEventLog, (s, id, log) => `Effacer le journal ${log}${on(s, id)}`),
  'system.newSelfSignedCertificate': def(
    newSelfSignedCertificate,
    (s, id, names) => `Créer un certificat auto-signé pour ${names.join(', ')}${on(s, id)}`
  ),
  'system.installFeatures': def(
    installFeatures,
    (s, id, names) => `Installer ${names.join(', ')}${on(s, id)}`
  ),
  'system.uninstallFeatures': def(
    uninstallFeatures,
    (s, id, names) => `Supprimer ${names.join(', ')}${on(s, id)}`
  ),

  // Serveur Linux : paquets installés au départ d'un lab (comme `apt install`, sans dépôt distant)
  'linux.installPackages': def(
    installPackages,
    (s, id, names) => `Installer ${names.join(', ')}${on(s, id)}`
  ),

  // Mode panne : un indice de plus (le compteur sert au bilan)
  'troubleshoot.useHint': def(useHint, () => 'Demander un indice'),

  // Consoles, tâches de fond, lots
  'shell.exec': def(shellExec, (s, session, line) => `${line}${on(s, session.deviceId)}`),
  'background.tick': def(backgroundTick, () => backgroundLabel()),
  batch: def(runBatch, (_s, commands) => `${commands.length} opération(s)`)
}

type UnionToIntersection<U> = (U extends unknown ? (u: U) => void : never) extends (i: infer I) => void
  ? I
  : never

/** Commandes de tous les modules de rôles (type exact, dérivé du registre). */
type RoleCommands = UnionToIntersection<RoleModules[number]['commands']>
type Commands = typeof CORE_COMMANDS & RoleCommands

let commands: CommandDefs | null = null

/** Toutes les commandes : système de base + modules de rôles (construit à la première lecture). */
export function commandDefinitions(): CommandDefs {
  return (commands ??= Object.assign({}, CORE_COMMANDS, ...roleModules().map((m) => m.commands)))
}

export type CommandType = keyof Commands & string
type DefOf<K extends CommandType> = Commands[K]
export type CommandArgs<K extends CommandType> = DefOf<K> extends CommandDef<infer A, unknown> ? A : never
export type CommandValue<K extends CommandType> = DefOf<K> extends CommandDef<never, infer T> ? T : never

export interface Command<K extends CommandType = CommandType> {
  type: K
  args: CommandArgs<K>
  /** Libellé imposé (lots d'un assistant : « Créer le partage Compta »). */
  label?: string
}

/** Construit une commande typée : `command('dhcp.addScope', serverId, { name: 'LAN', … })`. */
export function command<K extends CommandType>(type: K, ...args: CommandArgs<K>): Command<K> {
  return { type, args }
}

/** Lot de commandes exécutées comme une seule (une entrée du journal, un seul « Annuler »). */
export function batch(label: string, commands: AnyCommand[]): Command<'batch'> {
  return { type: 'batch', args: [commands], label }
}

export function isCommandType(type: string): type is CommandType {
  return Object.prototype.hasOwnProperty.call(commandDefinitions(), type)
}
