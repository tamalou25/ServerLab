/**
 * Apparence des équipements (icônes maison, couleurs) — purement visuel.
 */
import {
  ClientGlyph,
  CloudGlyph,
  FirewallGlyph,
  LinuxClientGlyph,
  LinuxServerGlyph,
  RouterGlyph,
  ServerGlyph,
  SwitchGlyph,
  type DeviceGlyph
} from '../assets/icons/devices'
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

/**
 * Correspondance type → icône : la forme porte la catégorie (serveur, poste, switch, routeur…) ;
 * un modèle Cisco garde la forme de sa catégorie, le bandeau « IOS » le distingue sur le canvas.
 */
export const DEVICE_ICONS: Record<PaletteKind, DeviceGlyph> = {
  server: ServerGlyph,
  client: ClientGlyph,
  linux: LinuxClientGlyph,
  'linux-server': LinuxServerGlyph,
  switch: SwitchGlyph,
  router: RouterGlyph,
  cloud: CloudGlyph,
  firewall: FirewallGlyph,
  c1921: RouterGlyph,
  c2811: RouterGlyph,
  c2960: SwitchGlyph,
  c9200: SwitchGlyph
}

/** Icône d'un équipement (poste Linux distingué). */
export const deviceIcon = (device: Device): DeviceGlyph => DEVICE_ICONS[paletteKind(device)]
