/**
 * Génération de la running-config (et de la startup-config) à partir de l'état : chaque
 * fonctionnalité IOS fournit ses blocs globaux et ses lignes d'interface. Rien n'est stocké en texte.
 */
import { produce } from 'immer'
import type { LabState, NetInterface } from '../model/schema'
import { applyStartup } from './config'
import type { IosDevice } from './device'
import { ifaceLongName, IOS_MODEL_INFO } from './models'
import { iosFeatures } from './registry'

/** Bloc de configuration : `order` < 100 avant les interfaces, ≥ 100 après. */
export interface ConfigBlock {
  order: number
  lines: string[]
}

/** Corps de la configuration (de « ! version » à « end »). */
export function configBody(device: IosDevice, state: LabState): string[] {
  const features = iosFeatures()
  const blocks = features.flatMap((f) => f.config?.(device, state) ?? []).sort((a, b) => a.order - b.order)
  const lines: string[] = ['!', `version ${IOS_MODEL_INFO[device.model].version}`]
  const emit = (block: ConfigBlock) => {
    if (block.lines.length === 0) return
    lines.push(...block.lines, '!')
  }
  blocks.filter((b) => b.order < 100).forEach(emit)
  for (const iface of device.interfaces) lines.push(...interfaceSection(device, iface, state), '!')
  blocks.filter((b) => b.order >= 100).forEach(emit)
  lines.push('end')
  return lines
}

export function interfaceSection(device: IosDevice, iface: NetInterface, state: LabState): string[] {
  const parts = iosFeatures()
    .flatMap((f) => f.interfaceConfig?.(device, iface, state) ?? [])
    .sort((a, b) => a.order - b.order)
  return [`interface ${ifaceLongName(iface.name)}`, ...parts.flatMap((p) => p.lines.map((l) => ` ${l}`))]
}

const byteCount = (lines: string[]): number => lines.reduce((n, l) => n + l.length + 1, 0)

/** show running-config. */
export function showRunningConfig(device: IosDevice, state: LabState): string[] {
  const body = configBody(device, state)
  return ['Building configuration...', '', `Current configuration : ${byteCount(body)} bytes`, ...body]
}

/** show startup-config. */
export function showStartupConfig(device: IosDevice, state: LabState): string[] {
  if (!device.ios?.startup) return ['startup-config is not present']
  let seq = 0
  const saved = produce(device, (draft) => applyStartup(draft, () => ++seq)) as IosDevice
  const body = configBody(saved, state)
  return [`Using ${byteCount(body)} out of 262136 bytes`, ...body]
}
