/**
 * Fabriques : création d'un lab vide et d'équipements avec leurs valeurs par défaut.
 */
import type { Draft } from 'immer'
import { DEVICE_KIND_INFO, type DeviceKind } from './kinds'
import { IOS_MODEL_INFO, type IosModel } from '../ios/models'
import {
  CyberConfigSchema,
  defaultFsNodes,
  defaultRootAcl,
  type Device,
  type Host,
  type LabState,
  type NetInterface,
  type Position,
  type HostOs
} from './schema'

/** Nombre de ports par type d'équipement. */
export const SWITCH_PORT_COUNT = 16
export const ROUTER_INTERFACE_COUNT = 4
/** Nombre maximal de cartes réseau sur un serveur. */
export const SERVER_MAX_INTERFACES = 4

export function createLab(): LabState {
  return {
    devices: {},
    links: {},
    seq: 0,
    clock: 0,
    domains: {},
    cyber: CyberConfigSchema.parse({})
  }
}

/** Incrémente le compteur et renvoie la nouvelle valeur. */
export function nextSeq(draft: Draft<LabState>): number {
  draft.seq += 1
  return draft.seq
}

/**
 * Adresse MAC déterministe, préfixe « administré localement » 02-53-4C (« SL »).
 * Format Windows : octets séparés par des tirets.
 */
export function macFromSeq(seq: number): string {
  const hex = seq.toString(16).toUpperCase().padStart(6, '0').slice(-6)
  return `02-53-4C-${hex.slice(0, 2)}-${hex.slice(2, 4)}-${hex.slice(4, 6)}`
}

/** Compte local par défaut (session ouverte automatiquement). */
export const DEFAULT_LOCAL_USER = { server: 'Administrateur', client: 'Utilisateur' } as const

/** Poste Linux : compte local, préfixe du nom d'hôte et carte réseau. */
export const LINUX_USER = 'etudiant'
export const LINUX_NAME_PREFIX = 'LNX'
export const LINUX_INTERFACE = 'eth0'
/** Serveur Linux (Debian 12 simulé) : compte d'administration (sudo) et préfixe de nom. */
export const LINUX_SERVER_USER = 'admin'
export const LINUX_SERVER_NAME_PREFIX = 'LSRV'

/** Fonctionnalités présentes dès l'installation d'un serveur. */
export const DEFAULT_SERVER_FEATURES = ['FS-FileServer', 'PowerShell']

export function createHost(kind: 'server' | 'client', os: HostOs = 'windows'): Host {
  return {
    os,
    workgroup: 'WORKGROUP',
    domain: null,
    features: os === 'linux' ? [] : kind === 'server' ? [...DEFAULT_SERVER_FEATURES] : ['PowerShell'],
    pendingReboot: false,
    adminTargets: [],
    controlled: false,
    pendingName: null,
    pendingDomain: null,
    localAdminPassword: 'P@ssw0rd',
    session: {
      user: os === 'linux' ? (kind === 'server' ? LINUX_SERVER_USER : LINUX_USER) : DEFAULT_LOCAL_USER[kind],
      domain: null
    },
    bootedAt: 0,
    clockOffsetSeconds: 0,
    policy: { computer: null, user: null, attempt: null },
    drives: [],
    certificates: [],
    remoteDesktop: { enabled: false, users: [] },
    remoteSessions: [],
    firewall: defaultFirewall(),
    vpnConnections: [],
    smb1: false,
    eventLog: [],
    services: {},
    localUsers: [],
    localGroups: [],
    mounts: []
  }
}

/** Pare-feu d'une installation neuve : trois profils actifs, entrant bloqué, sortant autorisé. */
export function defaultFirewall(): Host['firewall'] {
  const profile = () => ({
    enabled: true,
    defaultInbound: 'Block' as const,
    defaultOutbound: 'Allow' as const
  })
  return {
    profiles: { Domain: profile(), Private: profile(), Public: profile() },
    networkCategory: 'Public',
    predefined: {},
    rules: []
  }
}

/** Crée une carte réseau avec un identifiant et une MAC uniques. */
export function createInterface(draft: Draft<LabState>, name: string, kind: DeviceKind): NetInterface {
  const seq = nextSeq(draft)
  const l3 = kind !== 'switch'
  // Serveurs et postes sont en DHCP par défaut, comme une installation neuve
  const isHost = kind === 'server' || kind === 'client'
  return {
    id: `if${seq}`,
    name,
    mac: macFromSeq(seq),
    enabled: true,
    l3,
    addressing: isHost ? 'dhcp' : 'static',
    address: null,
    prefixLength: null,
    gateway: null,
    dnsMode: isHost ? 'dhcp' : 'static',
    dnsServers: [],
    dhcpLease: null,
    dhcpReleased: false,
    bridge: null
  }
}

/**
 * Noms des interfaces par défaut selon le type d'équipement, à la manière du matériel réel :
 * cartes Ethernet0 (serveur, poste), FastEthernet Fa0/1… (switch), GigabitEthernet Gi0/0… (routeur).
 */
export function defaultInterfaceNames(kind: DeviceKind): string[] {
  switch (kind) {
    case 'server':
    case 'client':
      return ['Ethernet0']
    case 'switch':
      return Array.from({ length: SWITCH_PORT_COUNT }, (_, i) => `Fa0/${i + 1}`)
    case 'router':
      return Array.from({ length: ROUTER_INTERFACE_COUNT }, (_, i) => `Gi0/${i}`)
    case 'cloud':
      return ['WAN']
  }
}

/** Premier nom libre de la forme PREFIXEn (SRV1, SRV2…). Comparaison insensible à la casse. */
export function nextDeviceName(
  state: LabState | Draft<LabState>,
  kind: DeviceKind,
  os: HostOs = 'windows'
): string {
  const used = new Set(Object.values(state.devices).map((d) => d.name.toUpperCase()))
  const prefix =
    os === 'linux'
      ? kind === 'server'
        ? LINUX_SERVER_NAME_PREFIX
        : LINUX_NAME_PREFIX
      : DEVICE_KIND_INFO[kind].namePrefix
  for (let n = 1; ; n++) {
    const candidate = `${prefix}${n}`
    if (!used.has(candidate)) return candidate
  }
}

/** Construit un équipement complet (sans l'ajouter à l'état). */
export function buildDevice(
  draft: Draft<LabState>,
  kind: DeviceKind,
  position: Position,
  name?: string,
  /** Poste Linux (Ubuntu) ou serveur Linux (Debian 12) : os « linux » sur un client ou un serveur. */
  os: HostOs = 'windows',
  /** Équipement Cisco IOS (routeur ou switch du même type que `kind`). */
  model?: IosModel
): Device {
  const linux = (kind === 'client' || kind === 'server') && os === 'linux'
  const id = `d${nextSeq(draft)}`
  const deviceName = name ?? nextDeviceName(draft, kind, linux ? 'linux' : 'windows')
  const ios = model && IOS_MODEL_INFO[model].kind === kind ? model : undefined
  const names = linux ? [LINUX_INTERFACE] : ios ? IOS_MODEL_INFO[ios].ports : defaultInterfaceNames(kind)
  // Routeur IOS : interfaces administrativement coupées en sortie d'usine (no shutdown requis)
  const interfaces = names.map((n) => ({
    ...createInterface(draft, n, kind),
    ...(ios && kind === 'router' ? { enabled: false } : {})
  }))
  const base = { id, name: deviceName, position: { ...position }, powered: true, interfaces, hostedBy: null }
  switch (kind) {
    case 'server':
      return {
        ...base,
        kind,
        host: linux
          ? { ...createHost('server', 'linux'), linux: { distro: 'debian12' as const } }
          : createHost('server'),
        roles: {},
        storage: { rootAcl: defaultRootAcl(), nodes: defaultFsNodes(), shares: [] }
      }
    case 'client':
      return { ...base, kind, host: createHost('client', linux ? 'linux' : 'windows') }
    case 'switch':
      return {
        ...base,
        kind,
        vlans: [{ id: 1, name: 'default' }],
        ...(ios === 'c2960' || ios === 'c9200' ? { model: ios } : {})
      }
    case 'router':
      return { ...base, kind, routes: [], ...(ios === 'c1921' || ios === 'c2811' ? { model: ios } : {}) }
    case 'cloud':
      return { ...base, kind }
  }
}
