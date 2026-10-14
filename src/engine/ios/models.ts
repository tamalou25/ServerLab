/**
 * Catalogue des équipements Cisco IOS simulés : modèle, type d'équipement du moteur (routeur ou
 * switch) et ports d'usine. Les noms de ports sont stockés sous leur forme courte (Gi0/0, Fa0/1,
 * Gi1/0/1), comme sur les autres équipements ; la CLI affiche la forme longue (ifaceLongName).
 */

export const IOS_ROUTER_MODELS = ['c1921', 'c2811'] as const
export const IOS_SWITCH_MODELS = ['c2960', 'c9200'] as const
export const IOS_MODELS = [...IOS_ROUTER_MODELS, ...IOS_SWITCH_MODELS] as const

export type IosRouterModel = (typeof IOS_ROUTER_MODELS)[number]
export type IosSwitchModel = (typeof IOS_SWITCH_MODELS)[number]
export type IosModel = (typeof IOS_MODELS)[number]

export interface IosModelInfo {
  /** Type d'équipement du moteur réseau (pas de second moteur : routeur ou switch existant). */
  kind: 'router' | 'switch'
  /** Désignation commerciale (show version, propriétés). */
  name: string
  /** Ports d'usine (forme courte). */
  ports: string[]
  /** Commutateur de niveau 3 (ip routing, interfaces VLAN routées). */
  layer3: boolean
  /** Version courte (ligne `version` de la running-config). */
  version: string
  /** Première ligne de show version. */
  software: string
  /** Image système (show version). */
  image: string
  /** Processeur et mémoire (show version). */
  hardware: string
}

const range = (prefix: string, from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`)

export const IOS_MODEL_INFO: Record<IosModel, IosModelInfo> = {
  c1921: {
    kind: 'router',
    name: 'CISCO1921/K9',
    ports: ['Gi0/0', 'Gi0/1'],
    layer3: true,
    version: '15.1',
    software:
      'Cisco IOS Software, C1900 Software (C1900-UNIVERSALK9-M), Version 15.1(4)M4, RELEASE SOFTWARE (fc1)',
    image: 'flash0:c1900-universalk9-mz.SPA.151-4.M4.bin',
    hardware: 'Cisco CISCO1921/K9 (revision 1.0) with 491520K/32768K bytes of memory.'
  },
  c2811: {
    kind: 'router',
    name: 'Cisco 2811',
    ports: ['Fa0/0', 'Fa0/1'],
    layer3: true,
    version: '15.1',
    software:
      'Cisco IOS Software, 2800 Software (C2800NM-ADVIPSERVICESK9-M), Version 15.1(4)M4, RELEASE SOFTWARE (fc1)',
    image: 'flash:c2800nm-advipservicesk9-mz.151-4.M4.bin',
    hardware: 'Cisco 2811 (revision 1.0) with 249856K/12288K bytes of memory.'
  },
  c2960: {
    kind: 'switch',
    name: 'WS-C2960-24TT-L',
    ports: [...range('Fa0/', 1, 24), ...range('Gi0/', 1, 2)],
    layer3: false,
    version: '15.0',
    software:
      'Cisco IOS Software, C2960 Software (C2960-LANBASEK9-M), Version 15.0(2)SE4, RELEASE SOFTWARE (fc1)',
    image: 'flash:c2960-lanbasek9-mz.150-2.SE4.bin',
    hardware: 'cisco WS-C2960-24TT-L (PowerPC405) processor (revision B0) with 65536K bytes of memory.'
  },
  c9200: {
    kind: 'switch',
    name: 'C9200-24T',
    ports: range('Gi1/0/', 1, 24),
    layer3: true,
    version: '17.3',
    software:
      'Cisco IOS XE Software, Version 17.03.04\nCisco IOS Software [Amsterdam], Catalyst L3 Switch Software (CAT9K_LITE_IOSXE), Version 17.3.4, RELEASE SOFTWARE (fc3)',
    image: 'flash:packages.conf',
    hardware: 'cisco C9200-24T (ARM64) processor with 1366884K/6147K bytes of memory.'
  }
}

/** Vrai si la valeur est un modèle IOS connu. */
export function isIosModel(value: unknown): value is IosModel {
  return typeof value === 'string' && (IOS_MODELS as readonly string[]).includes(value)
}

const LONG_PREFIX: Record<string, string> = {
  Gi: 'GigabitEthernet',
  Fa: 'FastEthernet',
  Vl: 'Vlan',
  Po: 'Port-channel'
}

/** Nom long IOS d'un port (Gi0/0 → GigabitEthernet0/0, Gi0/0.10 → GigabitEthernet0/0.10). */
export function ifaceLongName(short: string): string {
  const m = /^([A-Za-z]+)(.*)$/.exec(short)
  if (!m) return short
  const long = LONG_PREFIX[m[1] as string]
  return long ? `${long}${m[2]}` : short
}
