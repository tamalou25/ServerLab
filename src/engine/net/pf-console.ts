/**
 * Actions pures déclenchées par la console du pare-feu pfSense (v2.10, #247) : menu numéroté
 * (affecter les interfaces, définir les adresses IP, réinitialiser le mot de passe, valeurs d'usine,
 * redémarrage) et shell (`pfctl -d` / `pfctl -e`).
 *
 * Appelées par les commandes nommées `pf.*` (commands/catalog.ts) ; l'annulation vient des patches immer.
 * La console ne contient aucune logique métier : elle ne fait que demander ces commandes.
 */
import { raise, transact, type EngineResult } from '../core/result'
import { defaultPfState } from '../model/factory'
import {
  PF_IFACE_KEYS,
  PF_LAN_ADDRESS,
  PF_LAN_PREFIX,
  PfDhcpSchema,
  type PfIfaceKey,
  type PfState
} from '../model/firewall'
import type { Device, LabState, NetInterface } from '../model/schema'
import { setInterfaceIpv4 } from './config'
import { isIpv4 } from './ipv4'
import { requirePf } from './pf-rules'

type PfDevice = Extract<Device, { kind: 'firewall' }>

/** Affectation demandée par la console : nom de carte (em0…) de chaque interface logique ; null : aucune. */
export interface PfAssignmentInput {
  wan: string
  lan: string | null
  opt1: string | null
}

/** Configuration IPv4 portée par une carte (déplacée avec l'interface logique quand on la réaffecte). */
interface NicConfig {
  addressing: NetInterface['addressing']
  address: string | null
  prefixLength: number | null
  gateway: string | null
}

const readConfig = (nic: NetInterface): NicConfig => ({
  addressing: nic.addressing,
  address: nic.address,
  prefixLength: nic.prefixLength,
  gateway: nic.gateway
})

const writeConfig = (nic: NetInterface, cfg: NicConfig | null): void => {
  nic.addressing = cfg?.addressing ?? 'static'
  nic.address = cfg?.address ?? null
  nic.prefixLength = cfg?.prefixLength ?? null
  nic.gateway = cfg?.gateway ?? null
  nic.dhcpLease = null
  nic.dhcpReleased = false
}

function firewallOf(draft: LabState, deviceId: string): PfDevice {
  const device = draft.devices[deviceId]
  if (!device) raise('DeviceNotFound', 'Équipement introuvable.')
  if (device.kind !== 'firewall') raise('NotAFirewall', `${device.name} n’est pas un pare-feu pfSense.`)
  return device as PfDevice
}

/**
 * Option 1 de la console (Assign Interfaces) : affecte les cartes aux interfaces logiques WAN, LAN et OPT1.
 * La configuration IP appartient à l'interface logique : elle suit la carte quand on réaffecte (échange
 * du WAN et du LAN). Comme le script d'origine, retirer le LAN supprime aussi le NAT et le serveur DHCP du
 * LAN et décoche le blocage des réseaux privés du WAN.
 */
export function assignPfInterfaces(
  state: LabState,
  deviceId: string,
  input: PfAssignmentInput
): EngineResult<void> {
  return transact(state, (draft) => {
    const device = firewallOf(draft as LabState, deviceId)
    const pf = requirePf(draft, deviceId)
    const wanted: [PfIfaceKey, string | null][] = [
      ['wan', input.wan],
      ['lan', input.lan],
      ['opt1', input.opt1]
    ]
    const names = wanted.map(([, n]) => n).filter((n): n is string => !!n)
    if (!input.wan) raise('InvalidAssignment', 'L’interface WAN doit être affectée.')
    if (new Set(names).size !== names.length)
      raise('InvalidAssignment', 'La même interface ne peut pas être affectée deux fois.')
    if (input.opt1 && !input.lan)
      raise('InvalidAssignment', 'Une interface optionnelle exige une interface LAN affectée.')
    const resolved = new Map<PfIfaceKey, NetInterface | null>()
    for (const [key, name] of wanted) {
      if (!name) {
        resolved.set(key, null)
        continue
      }
      const nic = device.interfaces.find((i) => i.name === name)
      if (!nic) raise('InterfaceNotFound', `L’interface « ${name} » n’existe pas sur ${device.name}.`)
      resolved.set(key, nic)
    }

    // La configuration IP suit l'interface logique : relevée avant de toucher aux cartes
    const configs = new Map<PfIfaceKey, NicConfig>()
    const touched = new Set<string>()
    for (const a of pf.assignments) {
      const nic = a.ifaceId ? device.interfaces.find((i) => i.id === a.ifaceId) : undefined
      if (nic) {
        configs.set(a.key, readConfig(nic))
        touched.add(nic.id)
      }
    }
    for (const nic of resolved.values()) if (nic) touched.add(nic.id)
    for (const nic of device.interfaces) if (touched.has(nic.id)) writeConfig(nic, null)

    for (const key of PF_IFACE_KEYS) {
      const a = pf.assignments.find((x) => x.key === key)
      if (!a) continue
      const nic = resolved.get(key) ?? null
      a.ifaceId = nic?.id ?? null
      if (nic) {
        const cfg = configs.get(key)
        if (cfg) writeConfig(nic, cfg)
        if (key !== 'opt1') a.enabled = true
      }
    }
    if (!input.lan) {
      pf.nat = { outboundMode: 'automatic', outbound: [], portForwards: [] }
      delete pf.dhcp.lan
      const wan = pf.assignments.find((a) => a.key === 'wan')
      if (wan) wan.blockPrivate = false
    }
  })
}

/** Réglages saisis dans l'option 2 de la console (Set interface(s) IP address). */
export interface PfConsoleInterfaceInput {
  key: PfIfaceKey
  /** Adresse IPv4 et longueur de préfixe ; null : aucune adresse (touche Entrée). */
  address: string | null
  prefixLength: number | null
  /** Passerelle amont (WAN) ; null : aucune. */
  gateway: string | null
  /** Faire de cette passerelle la passerelle par défaut. */
  gatewayIsDefault: boolean
  /** Serveur DHCP de l'interface : plage d'adresses, ou désactivé. */
  dhcp: { enabled: boolean; from?: string; to?: string }
  /** « Do you want to revert to HTTP as the webConfigurator protocol? » : true = passer en http. */
  revertToHttp: boolean
}

/** Nom de passerelle libre de la forme WANGW, WANGW_2… (comme `next_unused_gateway_name` de la console). */
function nextGatewayName(pf: PfState, key: PfIfaceKey): string {
  const base = `${key.toUpperCase()}GW`
  let name = base
  for (let n = 2; pf.gateways.some((g) => g.name === name); n++) name = `${base}_${n}`
  return name
}

/**
 * Option 2 de la console : adresse IPv4 d'une interface, passerelle, serveur DHCP et protocole du
 * webConfigurator. L'adresse est portée par la carte affectée : le moteur de routage et de filtrage la voit
 * aussitôt.
 */
export function setPfInterfaceFromConsole(
  state: LabState,
  deviceId: string,
  input: PfConsoleInterfaceInput
): EngineResult<void> {
  const device = state.devices[deviceId]
  if (!device) return { ok: false, error: { code: 'DeviceNotFound', message: 'Équipement introuvable.' } }
  if (device.kind !== 'firewall')
    return {
      ok: false,
      error: { code: 'NotAFirewall', message: `${device.name} n’est pas un pare-feu pfSense.` }
    }
  const nicId = device.pf.assignments.find((a) => a.key === input.key)?.ifaceId
  if (!nicId)
    return {
      ok: false,
      error: {
        code: 'InterfaceNotFound',
        message: `L’interface ${input.key.toUpperCase()} n’est pas affectée.`
      }
    }
  if (input.address !== null && !isIpv4(input.address))
    return {
      ok: false,
      error: { code: 'InvalidAddress', message: `« ${input.address} » n’est pas une adresse IPv4 valide.` }
    }
  const ip = setInterfaceIpv4(state, deviceId, nicId, {
    addressing: 'static',
    address: input.address,
    mask: input.prefixLength === null ? null : String(input.prefixLength)
  })
  if (!ip.ok) return ip
  return transact(ip.state, (draft) => {
    const pf = requirePf(draft, deviceId)
    if (input.address !== null && input.gateway) {
      let gw = pf.gateways.find((g) => g.iface === input.key && g.address === input.gateway)
      if (!gw) {
        pf.gateways.push({
          name: nextGatewayName(pf, input.key),
          iface: input.key,
          address: input.gateway,
          isDefault: false
        })
        gw = pf.gateways[pf.gateways.length - 1]
      }
      if (gw && input.gatewayIsDefault) for (const g of pf.gateways) g.isDefault = g === gw
    }
    if (input.dhcp.enabled) {
      pf.dhcp[input.key] = PfDhcpSchema.parse({
        ...(pf.dhcp[input.key] ?? {}),
        enabled: true,
        rangeFrom: input.dhcp.from ?? null,
        rangeTo: input.dhcp.to ?? null
      })
    } else if (pf.dhcp[input.key]) {
      pf.dhcp[input.key]!.enabled = false
    }
    if (input.revertToHttp) pf.webProtocol = 'http'
  })
}

/** Option 3 (Reset webConfigurator password) : le compte admin retrouve le mot de passe d'usine. */
export function resetPfAdminPassword(state: LabState, deviceId: string): EngineResult<void> {
  return transact(state, (draft) => {
    delete requirePf(draft, deviceId).adminPassword
  })
}

/**
 * Option 4 (Reset to factory defaults) : configuration d'usine (affectations, règles, NAT, services, journal),
 * LAN en 192.168.1.1/24 et aucune adresse sur les autres cartes, puis redémarrage (table d'états vide).
 */
export function factoryResetPf(state: LabState, deviceId: string): EngineResult<void> {
  return transact(state, (draft) => {
    const device = firewallOf(draft as LabState, deviceId)
    device.pf = defaultPfState(device.name, device.interfaces)
    device.pf.filterSince = draft.clock
    const lan = device.pf.assignments.find((a) => a.key === 'lan')?.ifaceId
    for (const nic of device.interfaces)
      writeConfig(
        nic,
        nic.id === lan
          ? { addressing: 'static', address: PF_LAN_ADDRESS, prefixLength: PF_LAN_PREFIX, gateway: null }
          : null
      )
  })
}

/**
 * Option 5 (Reboot system) : la table d'états (en mémoire) est perdue et le filtre redémarre actif ;
 * la configuration et les journaux (fichiers) sont conservés.
 */
export function rebootPf(state: LabState, deviceId: string): EngineResult<void> {
  return transact(state, (draft) => {
    const pf = requirePf(draft, deviceId)
    pf.states = []
    delete pf.filterDisabled
    pf.filterSince = draft.clock
  })
}

/** `pfctl -e` / `pfctl -d` : active ou désactive le filtre (règles et NAT). */
export function setPfFilterEnabled(state: LabState, deviceId: string, enabled: boolean): EngineResult<void> {
  return transact(state, (draft) => {
    const pf = requirePf(draft, deviceId)
    if (enabled === !pf.filterDisabled) raise('PfState', enabled ? 'pf already enabled' : 'pf not enabled')
    if (enabled) {
      delete pf.filterDisabled
      pf.filterSince = draft.clock
    } else {
      pf.filterDisabled = true
      pf.filterSince = draft.clock
    }
  })
}

/** Le filtre du pare-feu est-il actif (`pfctl -d` le désactive) ? */
export const pfFilterActive = (device: PfDevice): boolean => !device.pf.filterDisabled
