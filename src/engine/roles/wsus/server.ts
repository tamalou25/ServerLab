/**
 * Serveur WSUS : post-installation, synchronisation, classifications, groupes d'ordinateurs,
 * ciblage et approbations.
 */
import type { Draft } from 'immer'
import { raise, transact, type EngineResult } from '../../core/result'
import type { LabState, ServerDevice } from '../../model/schema'
import { requireDevice } from '../../topology/actions'
import { ensureRoleState } from '../state'
import { serviceRunning } from '../../services/servicestate'
import { wsusServiceStoppedMessage } from './client'
import { UPDATE_CATALOG, catalogUpdate } from './catalog'
import type { WsusClassification, WsusServer } from './schema'
import { ALL_COMPUTERS, UNASSIGNED_COMPUTERS, WSUS_STATE, findWsusGroup } from './state'

/** Serveur WSUS d'un équipement (rôle installé), sinon erreur métier. */
export function requireWsus(
  draft: Draft<LabState>,
  deviceId: string
): { device: Draft<ServerDevice>; wsus: Draft<WsusServer> } {
  const device = requireDevice(draft, deviceId)
  if (device.kind !== 'server' || !device.host.features.includes('UpdateServices'))
    raise('WsusNotInstalled', 'Le rôle Services WSUS n’est pas installé sur cet ordinateur.')
  return { device, wsus: ensureRoleState(device, WSUS_STATE) }
}

/** Serveur WSUS dont les tâches de post-installation sont terminées. */
function requireConfigured(draft: Draft<LabState>, deviceId: string): Draft<WsusServer> {
  const { wsus } = requireWsus(draft, deviceId)
  if (!wsus.configured)
    raise(
      'WsusNotConfigured',
      'Les tâches de post-installation de WSUS ne sont pas terminées : choisissez l’emplacement du contenu des mises à jour.'
    )
  return wsus
}

/** Tâches de post-installation : emplacement local du contenu (C:\WSUS). */
export function completeWsusPostInstall(state: LabState, deviceId: string, contentDir: string): EngineResult {
  return transact(state, (draft) => {
    const { wsus } = requireWsus(draft, deviceId)
    const dir = contentDir.trim().replace(/\\+$/, '')
    if (!/^[A-Za-z]:\\[^<>:"/|?*]+$/.test(dir))
      raise(
        'InvalidPath',
        `Le chemin « ${contentDir} » n’est pas valide. Indiquez un dossier local, par exemple C:\\WSUS.`
      )
    wsus.configured = true
    wsus.contentDir = dir.charAt(0).toUpperCase() + dir.slice(1)
    return undefined
  })
}

/**
 * Synchronisation avec le service en amont : récupère les mises à jour des classifications
 * choisies. Les mises à jour déjà synchronisées restent, même si leur classification est retirée.
 */
export function synchronizeWsus(state: LabState, deviceId: string): EngineResult<number> {
  return transact(state, (draft) => {
    const wsus = requireConfigured(draft, deviceId)
    const { device } = requireWsus(draft, deviceId)
    // Service WSUS arrêté : la synchronisation est refusée (v2.8, #222)
    if (!serviceRunning(device, 'WsusService'))
      raise('WsusServiceStopped', wsusServiceStoppedMessage(device.name))
    const added = UPDATE_CATALOG.filter(
      (u) => wsus.classifications.includes(u.classification) && !wsus.updates.includes(u.id)
    ).map((u) => u.id)
    wsus.updates.push(...added)
    wsus.lastSync = draft.clock
    return added.length
  })
}

export function setWsusClassification(
  state: LabState,
  deviceId: string,
  classification: WsusClassification,
  enabled: boolean
): EngineResult {
  return transact(state, (draft) => {
    const { wsus } = requireWsus(draft, deviceId)
    const list = wsus.classifications.filter((c) => c !== classification)
    wsus.classifications = enabled ? [...list, classification] : list
    return undefined
  })
}

/** Ciblage : console Update Services (serveur) ou paramètres de stratégie de groupe (client). */
export function setWsusTargeting(state: LabState, deviceId: string, mode: 'server' | 'client'): EngineResult {
  return transact(state, (draft) => {
    requireWsus(draft, deviceId).wsus.targeting = mode
    return undefined
  })
}

export function addWsusGroup(state: LabState, deviceId: string, name: string): EngineResult<string> {
  return transact(state, (draft) => {
    const { wsus } = requireWsus(draft, deviceId)
    const clean = name.trim()
    if (!clean) raise('InvalidName', 'Indiquez le nom du groupe d’ordinateurs.')
    if (findWsusGroup(wsus, clean))
      raise('GroupExists', `Un groupe d’ordinateurs nommé « ${clean} » existe déjà.`)
    wsus.groups.push(clean)
    return clean
  })
}

export function removeWsusGroup(state: LabState, deviceId: string, name: string): EngineResult {
  return transact(state, (draft) => {
    const { wsus } = requireWsus(draft, deviceId)
    const group = findWsusGroup(wsus, name)
    if (!group) raise('GroupNotFound', `Le groupe d’ordinateurs « ${name} » n’existe pas.`)
    if (group === ALL_COMPUTERS || group === UNASSIGNED_COMPUTERS)
      raise('BuiltInGroup', `Le groupe « ${group} » est un groupe intégré : il ne peut pas être supprimé.`)
    // Les ordinateurs du groupe retournent dans « Ordinateurs non attribués »
    wsus.groups = wsus.groups.filter((g) => g !== group)
    wsus.assignments = wsus.assignments.filter((a) => a.group !== group)
    wsus.approvals = wsus.approvals.filter((a) => a.group !== group)
    return undefined
  })
}

/**
 * Place un ordinateur dans un groupe (ciblage côté serveur). `group` null ou « Ordinateurs non
 * attribués » : retour dans le groupe par défaut.
 */
export function assignWsusComputer(
  state: LabState,
  deviceId: string,
  computerId: string,
  group: string | null
): EngineResult {
  return transact(state, (draft) => {
    const { wsus } = requireWsus(draft, deviceId)
    if (wsus.targeting === 'client')
      raise(
        'ClientSideTargeting',
        'Le serveur utilise le ciblage côté client : l’appartenance aux groupes est définie par la stratégie de groupe des ordinateurs.'
      )
    const computer = draft.devices[computerId]
    if (!computer || (computer.kind !== 'server' && computer.kind !== 'client'))
      raise('ComputerNotFound', 'Cet ordinateur est introuvable.')
    const target = group === null ? UNASSIGNED_COMPUTERS : findWsusGroup(wsus, group)
    if (!target) raise('GroupNotFound', `Le groupe d’ordinateurs « ${group} » n’existe pas.`)
    if (target === ALL_COMPUTERS)
      raise(
        'InvalidGroup',
        'Choisissez un groupe : tous les ordinateurs appartiennent déjà à « Tous les ordinateurs ».'
      )
    wsus.assignments = wsus.assignments.filter((a) => a.computerId !== computerId)
    if (target !== UNASSIGNED_COMPUTERS) wsus.assignments.push({ computerId, group: target })
    return undefined
  })
}

function requireSyncedUpdate(wsus: Draft<WsusServer>, updateId: string): string {
  const update = catalogUpdate(updateId)
  if (!update || !wsus.updates.includes(update.id))
    raise('UpdateNotFound', `La mise à jour « ${updateId} » n’est pas présente sur ce serveur WSUS.`)
  return update.id
}

/** Approuve (Installer) ou retire l'approbation d'une mise à jour pour un groupe. */
export function approveWsusUpdate(
  state: LabState,
  deviceId: string,
  updateId: string,
  group: string,
  approved: boolean
): EngineResult {
  return transact(state, (draft) => {
    const { wsus } = requireWsus(draft, deviceId)
    const id = requireSyncedUpdate(wsus, updateId)
    const target = findWsusGroup(wsus, group)
    if (!target) raise('GroupNotFound', `Le groupe d’ordinateurs « ${group} » n’existe pas.`)
    wsus.approvals = wsus.approvals.filter((a) => !(a.updateId === id && a.group === target))
    if (approved) {
      wsus.approvals.push({ updateId: id, group: target })
      wsus.declined = wsus.declined.filter((d) => d !== id)
    }
    return undefined
  })
}

/** Refuse une mise à jour (retire toutes ses approbations) ou annule le refus. */
export function declineWsusUpdate(
  state: LabState,
  deviceId: string,
  updateId: string,
  declined: boolean
): EngineResult {
  return transact(state, (draft) => {
    const { wsus } = requireWsus(draft, deviceId)
    const id = requireSyncedUpdate(wsus, updateId)
    wsus.declined = wsus.declined.filter((d) => d !== id)
    if (declined) {
      wsus.declined.push(id)
      wsus.approvals = wsus.approvals.filter((a) => a.updateId !== id)
    }
    return undefined
  })
}

/** Groupes pour lesquels une mise à jour est approuvée. */
export function approvedGroups(wsus: WsusServer, updateId: string): string[] {
  return wsus.approvals.filter((a) => a.updateId === updateId).map((a) => a.group)
}
