/**
 * Actions de topologie : ajout/suppression d'équipements, câblage, renommage…
 * Toutes les actions sont pures : (état, paramètres) → EngineResult.
 */
import type { Draft } from 'immer'
import { logEvent } from '../core/eventlog'
import { raise, transact, type EngineResult } from '../core/result'
import { buildDevice, createInterface, SERVER_MAX_INTERFACES, nextSeq } from '../model/factory'
import type { DeviceKind } from '../model/kinds'
import type { Device, HostOs, LabState, LinkEnd, Position } from '../model/schema'
import { linkOnInterface } from './queries'
import { bootServices } from '../services/servicestate'
import { IOS_MODEL_INFO, type IosModel } from '../ios/models'

/** Refus d'une opération de topologie sur un équipement virtuel (géré par Hyper-V). */
const HYPERV_MANAGED = (name: string) =>
  `${name} est un équipement virtuel : gérez-le depuis le Gestionnaire Hyper-V de son hôte.`

/** Récupère un équipement dans un brouillon, ou lève une erreur. */
export function requireDevice(draft: Draft<LabState>, id: string): Draft<Device> {
  const device = draft.devices[id]
  if (!device) raise('DeviceNotFound', `Équipement introuvable (${id}).`)
  return device
}

/**
 * Valide un nom d'équipement.
 * Serveurs et postes suivent les règles NetBIOS (15 caractères, lettres, chiffres, tirets).
 */
export function deviceNameError(kind: DeviceKind, name: string): string | null {
  const n = name.trim()
  if (n.length === 0) return 'Le nom ne peut pas être vide.'
  if (kind === 'server' || kind === 'client') {
    if (n.length > 15) return 'Le nom de l’ordinateur ne peut pas dépasser 15 caractères.'
    if (!/^[A-Za-z0-9-]+$/.test(n))
      return 'Le nom ne peut contenir que des lettres, des chiffres et des tirets.'
    if (/^\d+$/.test(n)) return 'Le nom ne peut pas être composé uniquement de chiffres.'
    if (n.startsWith('-') || n.endsWith('-')) return 'Le nom ne peut pas commencer ni finir par un tiret.'
    return null
  }
  if (n.length > 32) return 'Le nom ne peut pas dépasser 32 caractères.'
  // pfSense (System > General Setup) : le nom d'hôte commence par une lettre ; lettres, chiffres, tiret
  if (kind === 'firewall' && !/^[A-Za-z][A-Za-z0-9-]*$/.test(n))
    return 'Le nom d’hôte doit commencer par une lettre et ne contenir que des lettres, des chiffres et des tirets.'
  if (!/^[A-Za-z0-9_-]+$/.test(n))
    return 'Le nom ne peut contenir que des lettres, des chiffres, « - » et « _ ».'
  return null
}

function assertNameAvailable(draft: Draft<LabState>, name: string, exceptId?: string): void {
  const upper = name.toUpperCase()
  const taken = Object.values(draft.devices).some((d) => d.id !== exceptId && d.name.toUpperCase() === upper)
  if (taken) raise('DuplicateName', `Un équipement nommé « ${name} » existe déjà dans la topologie.`)
}

export interface AddDeviceParams {
  kind: DeviceKind
  position: Position
  name?: string
  /** Poste client : Windows (par défaut) ou Linux (Ubuntu simulé). */
  os?: HostOs
  /** Routeur ou switch Cisco IOS : modèle (du même type que `kind`). */
  model?: IosModel
}

/** Ajoute un équipement et renvoie son identifiant. */
export function addDevice(state: LabState, params: AddDeviceParams): EngineResult<string> {
  return transact(state, (draft) => {
    if (params.name !== undefined) {
      const err = deviceNameError(params.kind, params.name)
      if (err) raise('InvalidName', err)
      assertNameAvailable(draft, params.name.trim())
    }
    if (params.model !== undefined && IOS_MODEL_INFO[params.model]?.kind !== params.kind)
      raise(
        'InvalidModel',
        `Le modèle ${params.model} ne correspond pas à un équipement de type ${params.kind}.`
      )
    const device = buildDevice(
      draft,
      params.kind,
      params.position,
      params.name?.trim(),
      params.os,
      params.model
    )
    draft.devices[device.id] = device
    return device.id
  })
}

/**
 * Supprime des équipements et tous les câbles qui y sont branchés. Supprimer un hôte Hyper-V
 * supprime ses machines et commutateurs virtuels ; ceux-ci ne se suppriment que depuis Hyper-V.
 */
export function removeDevices(state: LabState, ids: string[]): EngineResult {
  return transact(state, (draft) => {
    const set = new Set(ids)
    for (const id of ids) {
      const device = requireDevice(draft, id)
      if (device.hostedBy && !set.has(device.hostedBy)) raise('HyperVManaged', HYPERV_MANAGED(device.name))
    }
    for (const d of Object.values(draft.devices)) if (d.hostedBy && set.has(d.hostedBy)) set.add(d.id)
    ids = [...set]
    for (const link of Object.values(draft.links)) {
      if (set.has(link.a.deviceId) || set.has(link.b.deviceId)) delete draft.links[link.id]
    }
    for (const id of ids) delete draft.devices[id]
    return undefined
  })
}

/** Déplace un équipement sur le canvas. */
export function moveDevice(state: LabState, id: string, position: Position): EngineResult {
  return transact(state, (draft) => {
    requireDevice(draft, id).position = { x: position.x, y: position.y }
    return undefined
  })
}

export function renameDevice(state: LabState, id: string, name: string): EngineResult {
  return transact(state, (draft) => {
    const device = requireDevice(draft, id)
    const trimmed = name.trim()
    const err = deviceNameError(device.kind, trimmed)
    if (err) raise('InvalidName', err)
    assertNameAvailable(draft, trimmed, id)
    device.name = trimmed
    if (device.kind === 'firewall') device.pf.hostname = trimmed
    return undefined
  })
}

/** Allume ou éteint un équipement. */
export function setPower(state: LabState, id: string, powered: boolean): EngineResult {
  return transact(state, (draft) => {
    const device = requireDevice(draft, id)
    if (device.powered === powered) return undefined
    if (powered && device.hostedBy && !draft.devices[device.hostedBy]?.powered)
      raise('HostPoweredOff', `L’hôte Hyper-V de ${device.name} est éteint.`)
    if (!powered) {
      logEvent(draft, id, {
        level: 'information',
        source: 'EventLog',
        eventId: 6006,
        message: 'Le service Journal des événements a été arrêté.'
      })
    }
    device.powered = powered
    // Hôte Hyper-V éteint : ses machines et commutateurs virtuels s'arrêtent avec lui
    if (!powered)
      for (const hosted of Object.values(draft.devices)) if (hosted.hostedBy === id) hosted.powered = false
    if (powered) {
      for (const hosted of Object.values(draft.devices))
        if (hosted.hostedBy === id && hosted.kind === 'switch') hosted.powered = true
      logEvent(draft, id, {
        level: 'information',
        source: 'EventLog',
        eventId: 6005,
        message: 'Le service Journal des événements a été démarré.'
      })
      // Nouveau démarrage : le Bureau simulé revient à l'écran de verrouillage
      if (device.kind === 'server' || device.kind === 'client') {
        device.host.bootedAt = draft.clock
        bootServices(device)
        // Stratégies de groupe retraitées après le démarrage (arrière-plan, ouverture de session)
        device.host.policy.user = null
        device.host.policy.attempt = null
      }
    }
    return undefined
  })
}

/** Ajoute une carte réseau à un serveur (4 maximum). Renvoie l'identifiant de la carte. */
export function addServerInterface(state: LabState, id: string): EngineResult<string> {
  return transact(state, (draft) => {
    const device = requireDevice(draft, id)
    if (device.kind !== 'server')
      raise('NotSupported', 'Seuls les serveurs peuvent recevoir une carte réseau supplémentaire.')
    if (device.interfaces.length >= SERVER_MAX_INTERFACES)
      raise('LimitReached', `Un serveur ne peut pas avoir plus de ${SERVER_MAX_INTERFACES} cartes réseau.`)
    const used = new Set(device.interfaces.map((i) => i.name))
    let n = 0
    while (used.has(`Ethernet${n}`)) n++
    const iface = createInterface(draft, `Ethernet${n}`, 'server')
    device.interfaces.push(iface)
    return iface.id
  })
}

/** Supprime une carte réseau d'un serveur (et le câble éventuel). La première carte est conservée. */
export function removeServerInterface(state: LabState, id: string, ifaceId: string): EngineResult {
  return transact(state, (draft) => {
    const device = requireDevice(draft, id)
    if (device.kind !== 'server') raise('NotSupported', 'Opération réservée aux serveurs.')
    if (device.interfaces.length <= 1)
      raise('LimitReached', 'Un serveur doit conserver au moins une carte réseau.')
    const index = device.interfaces.findIndex((i) => i.id === ifaceId)
    if (index < 0) raise('InterfaceNotFound', 'Carte réseau introuvable.')
    const link = linkOnInterface(draft, id, ifaceId)
    if (device.interfaces[index]?.bridge || link?.virtual)
      raise('HyperVManaged', 'Cette carte réseau est utilisée par un commutateur virtuel Hyper-V.')
    if (link) delete draft.links[link.id]
    device.interfaces.splice(index, 1)
    return undefined
  })
}

/** Active ou désactive un port / une carte réseau. */
export function setInterfaceEnabled(
  state: LabState,
  deviceId: string,
  ifaceId: string,
  enabled: boolean
): EngineResult {
  return transact(state, (draft) => {
    const iface = requireDevice(draft, deviceId).interfaces.find((i) => i.id === ifaceId)
    if (!iface) raise('InterfaceNotFound', 'Carte réseau introuvable.')
    iface.enabled = enabled
    return undefined
  })
}

/** Relie deux ports par un câble. Renvoie l'identifiant du câble. */
export function connect(state: LabState, a: LinkEnd, b: LinkEnd): EngineResult<string> {
  return transact(state, (draft) => {
    if (a.deviceId === b.deviceId) raise('SameDevice', 'Impossible de relier un équipement à lui-même.')
    for (const end of [a, b]) {
      const device = requireDevice(draft, end.deviceId)
      if (device.hostedBy) raise('HyperVManaged', HYPERV_MANAGED(device.name))
      const iface = device.interfaces.find((i) => i.id === end.ifaceId)
      if (!iface) raise('InterfaceNotFound', `Port introuvable sur ${device.name}.`)
      if (iface.subinterface)
        raise(
          'Subinterface',
          `${iface.name} est une sous-interface : branchez le câble sur sa carte physique.`
        )
      if (linkOnInterface(draft, end.deviceId, end.ifaceId))
        raise('PortInUse', `Le port ${iface.name} de ${device.name} est déjà utilisé.`)
    }
    const id = `l${nextSeq(draft)}`
    draft.links[id] = { id, a: { ...a }, b: { ...b }, virtual: false }
    return id
  })
}

export function disconnect(state: LabState, linkId: string): EngineResult {
  return transact(state, (draft) => {
    const link = draft.links[linkId]
    if (!link) raise('LinkNotFound', 'Câble introuvable.')
    if (link.virtual)
      raise(
        'HyperVManaged',
        'Cette liaison virtuelle se gère dans le Gestionnaire Hyper-V (carte réseau de la VM).'
      )
    delete draft.links[linkId]
    return undefined
  })
}

/**
 * Duplique des équipements (copier/coller) avec un décalage.
 * Les câbles entre équipements copiés sont recréés. Les identifiants, MAC et noms sont régénérés ;
 * les baux DHCP et l'appartenance à un domaine ne sont pas copiés.
 * Renvoie les identifiants des nouveaux équipements.
 */
export function duplicateDevices(
  state: LabState,
  source: { devices: Device[]; links: LabState['links'][string][] },
  offset: Position
): EngineResult<string[]> {
  return transact(state, (draft) => {
    const idMap = new Map<string, string>()
    const ifaceMap = new Map<string, string>()
    const created: string[] = []
    for (const original of source.devices) {
      const copy = buildDevice(
        draft,
        original.kind,
        { x: original.position.x + offset.x, y: original.position.y + offset.y },
        undefined,
        'windows',
        original.kind === 'router' || original.kind === 'switch' ? original.model : undefined
      )
      // Recopie la configuration des cartes (hors identité matérielle et bail)
      copy.interfaces = original.interfaces.map((iface) => {
        const fresh = createInterface(draft, iface.name, original.kind)
        ifaceMap.set(`${original.id}/${iface.id}`, fresh.id)
        return {
          ...iface,
          id: fresh.id,
          mac: fresh.mac,
          dnsServers: [...iface.dnsServers],
          dhcpLease: null,
          dhcpReleased: false,
          bridge: null
        }
      })
      // Sous-interfaces : carte parente recopiée, dont elles partagent l'adresse MAC
      for (const iface of copy.interfaces) {
        if (!iface.subinterface) continue
        const parent = ifaceMap.get(`${original.id}/${iface.subinterface.parent}`) ?? ''
        iface.subinterface = { ...iface.subinterface, parent }
        iface.mac = copy.interfaces.find((i) => i.id === parent)?.mac ?? iface.mac
      }
      if (copy.kind === 'firewall' && original.kind === 'firewall') {
        // État du pare-feu recopié ; les affectations suivent les nouvelles cartes
        copy.pf = JSON.parse(JSON.stringify(original.pf)) as typeof original.pf
        copy.pf.hostname = copy.name
        copy.pf.log = []
        copy.pf.states = []
        for (const a of copy.pf.assignments)
          a.ifaceId = a.ifaceId ? (ifaceMap.get(`${original.id}/${a.ifaceId}`) ?? null) : null
      }
      if (copy.kind === 'router' && original.kind === 'router')
        copy.routes = original.routes.map((r) => ({ ...r }))
      if (copy.kind === 'switch' && original.kind === 'switch')
        copy.vlans = original.vlans.map((v) => ({ ...v }))
      if (
        (copy.kind === 'server' || copy.kind === 'client') &&
        (original.kind === 'server' || original.kind === 'client')
      ) {
        copy.host.features = [...original.host.features]
      }
      draft.devices[copy.id] = copy
      idMap.set(original.id, copy.id)
      created.push(copy.id)
    }
    for (const link of source.links) {
      const da = idMap.get(link.a.deviceId)
      const db = idMap.get(link.b.deviceId)
      const ia = ifaceMap.get(`${link.a.deviceId}/${link.a.ifaceId}`)
      const ib = ifaceMap.get(`${link.b.deviceId}/${link.b.ifaceId}`)
      if (da && db && ia && ib) {
        const id = `l${nextSeq(draft)}`
        draft.links[id] = {
          id,
          a: { deviceId: da, ifaceId: ia },
          b: { deviceId: db, ifaceId: ib },
          virtual: false
        }
      }
    }
    return created
  })
}
