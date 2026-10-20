/**
 * Apparence des équipements (icônes lucide, couleurs) — purement visuel.
 */
import {
  Cloud,
  Monitor,
  Network,
  Router,
  Server,
  ServerCog,
  SquareTerminal,
  type LucideIcon
} from 'lucide-react'
import {
  DEVICE_KINDS,
  IOS_MODEL_INFO,
  IOS_MODELS,
  isLinuxHost,
  type Device,
  type DeviceKind,
  type IosModel
} from '@engine/index'
import { t } from './i18n'

/**
 * Entrée de la palette : un type d'équipement, le poste Linux (poste client Ubuntu simulé) ou un
 * modèle Cisco IOS (routeur ou switch).
 */
export type PaletteKind = DeviceKind | 'linux' | 'linux-server' | IosModel

/** Vrai si la valeur (glisser-déposer) est une entrée de la palette. */
export function isPaletteKind(value: string): value is PaletteKind {
  return (
    (DEVICE_KINDS as readonly string[]).includes(value) ||
    value === 'linux' ||
    value === 'linux-server' ||
    (IOS_MODELS as readonly string[]).includes(value)
  )
}

/** Modèle Cisco IOS de l'équipement (absent : équipement générique). */
export function iosModel(device: Device): IosModel | undefined {
  return device.kind === 'router' || device.kind === 'switch' ? device.model : undefined
}

/** Poste Linux : poste client dont le système est Ubuntu (simulé). */
export const isLinux = (device: Device): boolean => isLinuxHost(device)

/** Paramètres de création d'un équipement de la palette. */
export function paletteParams(kind: PaletteKind): { kind: DeviceKind; os?: 'linux'; model?: IosModel } {
  if (kind === 'linux') return { kind: 'client', os: 'linux' }
  if (kind === 'linux-server') return { kind: 'server', os: 'linux' }
  if ((IOS_MODELS as readonly string[]).includes(kind)) {
    const model = kind as IosModel
    return { kind: IOS_MODEL_INFO[model].kind, model }
  }
  return { kind: kind as DeviceKind }
}

/** Entrée de la palette correspondant à un équipement (poste Linux distingué). */
export const paletteKind = (device: Device): PaletteKind =>
  isLinux(device) ? (device.kind === 'server' ? 'linux-server' : 'linux') : (iosModel(device) ?? device.kind)

/**
 * Libellé, description (infobulle, recherche) et modèle d'une entrée de la palette, dans la langue
 * de l'interface (à appeler au rendu d'un composant abonné à la langue : useT).
 */
export const paletteLabel = (kind: PaletteKind): string => t(`device.${kind}.label`)
export const paletteDescription = (kind: PaletteKind): string => t(`device.${kind}.description`)
export const paletteModel = (kind: PaletteKind): string => t(`device.${kind}.model`)
export const deviceLabel = (device: Device): string => paletteLabel(paletteKind(device))

export const DEVICE_ICONS: Record<PaletteKind, LucideIcon> = {
  server: Server,
  client: Monitor,
  linux: SquareTerminal,
  'linux-server': ServerCog,
  switch: Network,
  router: Router,
  cloud: Cloud,
  c1921: Router,
  c2811: Router,
  c2960: Network,
  c9200: Network
}

/** Icône d'un équipement (poste Linux distingué). */
export const deviceIcon = (device: Device): LucideIcon => DEVICE_ICONS[paletteKind(device)]

/** Liseré de catégorie des nœuds du canvas. */
export const KIND_STRIPE: Record<PaletteKind, string> = {
  server: 'bg-kind-server',
  client: 'bg-kind-client',
  linux: 'bg-kind-client',
  'linux-server': 'bg-kind-server',
  switch: 'bg-kind-switch',
  router: 'bg-kind-router',
  cloud: 'bg-kind-cloud',
  c1921: 'bg-kind-router',
  c2811: 'bg-kind-router',
  c2960: 'bg-kind-switch',
  c9200: 'bg-kind-switch'
}

/** Classes de la pastille de chaque type d'équipement (tokens de catégorie, voir styles.css). */
export const DEVICE_COLORS: Record<DeviceKind, string> = {
  server: 'bg-kind-server text-white',
  client: 'bg-kind-client text-white',
  switch: 'bg-kind-switch text-white',
  router: 'bg-kind-router text-white',
  cloud: 'bg-kind-cloud text-white'
}
