/**
 * Opérations système : redémarrage, renommage de l'ordinateur.
 */
import type { Draft } from 'immer'
import { logEvent } from '../core/eventlog'
import { raise, transact, type EngineResult } from '../core/result'
import { DEFAULT_LOCAL_USER } from '../model/factory'
import type { HostDevice, LabState } from '../model/schema'
import { deviceNameError, requireDevice } from '../topology/actions'
import { registerHostDns } from '../roles/adds/join'
import { bootServices } from './servicestate'

/** Applique les opérations en attente d'un redémarrage (renommage…). */
export function applyRestart(draft: Draft<LabState>, device: Draft<HostDevice>, reason?: string): void {
  const account = device.host.session
    ? `${device.host.session.domain ?? device.name}\\${device.host.session.user}`
    : 'SYSTEM'
  logEvent(draft, device.id, {
    level: 'information',
    source: 'User32',
    eventId: 1074,
    message: `Le processus a déclenché le redémarrage de l’ordinateur ${device.name} pour le compte ${account}${reason ? ` pour la raison suivante : ${reason}` : ''}.`
  })
  logEvent(draft, device.id, {
    level: 'information',
    source: 'EventLog',
    eventId: 6006,
    message: 'Le service Journal des événements a été arrêté.'
  })
  if (device.host.pendingName) {
    device.name = device.host.pendingName
    device.host.pendingName = null
  }
  // Jonction (ou départ) du domaine en attente
  if (device.host.pendingDomain !== null) {
    const target = device.host.pendingDomain
    device.host.domain = target === '' ? null : target
    device.host.workgroup =
      target === '' ? 'WORKGROUP' : (draft.domains[target]?.netbios ?? device.host.workgroup)
    device.host.pendingDomain = null
    if (device.host.session?.domain) device.host.session = null
  }
  device.host.pendingReboot = false
  device.host.bootedAt = draft.clock
  // Services : démarrage automatique ou arrêt selon leur type de démarrage
  bootServices(device)
  // Stratégie utilisateur déchargée ; la stratégie d'ordinateur (conservée) sera retraitée
  device.host.policy.user = null
  device.host.policy.attempt = null
  device.host.drives = device.host.drives.filter((drive) => drive.persistent)
  // Les baux DHCP sont redemandés au démarrage
  for (const iface of device.interfaces) {
    if (iface.addressing === 'dhcp') iface.dhcpLease = null
  }
  // Session : un serveur se reconnecte en administrateur, un poste du domaine revient à l'écran de connexion
  if (device.kind === 'client' && device.host.domain) device.host.session = null
  else if (device.kind === 'server' && !device.host.session)
    device.host.session = { user: DEFAULT_LOCAL_USER.server, domain: null }
  logEvent(draft, device.id, {
    level: 'information',
    source: 'EventLog',
    eventId: 6005,
    message: 'Le service Journal des événements a été démarré.'
  })
  // Membre d'un domaine : inscription de son nom dans le DNS (mise à jour dynamique)
  registerHostDns(draft, device)
}

/** Redémarre un serveur ou un poste (raison facultative, comme le suivi des arrêts d'un serveur). */
export function restartComputer(state: LabState, deviceId: string, reason?: string): EngineResult {
  return transact(state, (draft) => {
    const device = requireDevice(draft, deviceId)
    if (device.kind !== 'server' && device.kind !== 'client')
      raise('NotSupported', 'Équipement non redémarrable.')
    if (!device.powered) raise('PoweredOff', `${device.name} est éteint.`)
    applyRestart(draft, device, reason)
    return undefined
  })
}

/** Renomme l'ordinateur ; effectif au prochain redémarrage. */
export function renameComputer(state: LabState, deviceId: string, newName: string): EngineResult {
  return transact(state, (draft) => {
    const device = requireDevice(draft, deviceId)
    if (device.kind !== 'server' && device.kind !== 'client')
      raise('NotSupported', 'Équipement non renommable.')
    const name = newName.trim()
    const err = deviceNameError(device.kind, name)
    if (err) raise('InvalidName', err)
    const upper = name.toUpperCase()
    if (Object.values(draft.devices).some((d) => d.id !== deviceId && d.name.toUpperCase() === upper))
      raise('DuplicateName', `Le nom « ${name} » est déjà utilisé par un autre ordinateur du réseau.`)
    if (name.toUpperCase() === device.name.toUpperCase())
      raise(
        'SameName',
        `Impossible de renommer l’ordinateur « ${device.name} » en « ${name} », car le nouveau nom est identique à l’actuel.`
      )
    device.host.pendingName = name
    device.host.pendingReboot = true
    return undefined
  })
}
