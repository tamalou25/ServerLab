/**
 * Configuration IOS : valeurs d'usine, instantané (startup-config) et rechargement.
 */
import type { Draft } from 'immer'
import type { IosSnapshot, IosState, NetInterface } from '../model/schema'
import type { IosDevice } from './device'

/** Copie profonde de données sérialisables. */
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** Configuration IOS d'usine. */
export function defaultIosState(): IosState {
  return {
    enableSecret: null,
    bannerMotd: null,
    domainLookup: true,
    ipRouting: false,
    ospf: [],
    dhcpServer: null,
    dhcpExcluded: [],
    acls: [],
    natRules: [],
    interfaces: {},
    startup: null,
    natTranslations: [],
    aclCounters: {},
    hsrpStates: {},
    domainName: null,
    rsaBits: null,
    sshVersion: null,
    users: [],
    lines: [],
    passwordEncryption: false,
    dhcpSnooping: false,
    dhcpSnoopingVlans: [],
    arpInspectionVlans: [],
    syslog: [],
    defaultGateway: null,
    cdpRun: true,
    stpMode: 'pvst',
    stpPriorities: {},
    macTable: []
  }
}

/** Configuration IOS de l'équipement (valeurs d'usine si jamais configuré). */
export function iosState(device: IosDevice): IosState {
  return device.ios ?? defaultIosState()
}

/** Configuration IOS modifiable (créée à la première modification). */
export function draftIosState(device: Draft<IosDevice>): Draft<IosState> {
  device.ios ??= defaultIosState()
  return device.ios
}

/** Instantané de la running-config (copy running-config startup-config). */
export function snapshotOf(device: IosDevice): IosSnapshot {
  // État de fonctionnement exclu : traductions NAT, baux DHCP
  const {
    startup: _startup,
    natTranslations: _nat,
    hsrpStates: _hsrp,
    aclCounters: _acl,
    syslog: _syslog,
    macTable: _mac,
    ...running
  } = iosState(device)
  const config = clone(running)
  // Port-security : seules les adresses collées (sticky) et configurées sont enregistrées
  for (const entry of Object.values(config.interfaces)) {
    entry.errDisabled = false
    if (entry.portSecurity)
      entry.portSecurity = { ...entry.portSecurity, dynamicMacs: [], violations: 0, lastViolation: null }
  }
  for (const scope of config.dhcpServer?.scopes ?? []) scope.leases = []
  const byId = new Map(device.interfaces.map((i) => [i.id, i.name]))
  return clone({
    hostname: device.name,
    config,
    interfaces: device.interfaces.map((i) => ({
      name: i.name,
      enabled: i.enabled,
      address: i.address,
      prefixLength: i.prefixLength,
      // Le saut de VLAN est un état de fonctionnement, pas une configuration enregistrable
      ...(i.switchport ? { switchport: { ...i.switchport, hoppedVlan: null } } : {}),
      ...(i.subinterface
        ? { subinterface: { parent: byId.get(i.subinterface.parent) ?? '', vlan: i.subinterface.vlan } }
        : {}),
      ...(i.helperAddresses ? { helperAddresses: i.helperAddresses } : {}),
      ...(i.svi ? { svi: i.svi } : {})
    })),
    ...(device.routes ? { routes: device.routes } : {})
  })
}

/** Vrai si la running-config diffère de la startup-config (question « Save? » de reload). */
export function configModified(device: IosDevice): boolean {
  const startup = iosState(device).startup
  return JSON.stringify(startup) !== JSON.stringify(snapshotOf(device))
}

/** Interface physique d'usine : routeur administrativement coupé, port de switch actif. */
function factoryInterface(iface: Draft<NetInterface>, router: boolean): void {
  iface.enabled = !router
  iface.addressing = 'static'
  iface.address = null
  iface.prefixLength = null
  iface.gateway = null
  iface.dhcpLease = null
  iface.dhcpReleased = false
  delete iface.switchport
  delete iface.helperAddresses
}

/**
 * Redémarrage (reload) : la running-config repart de la startup-config, ou des valeurs d'usine si
 * elle est absente. Le nom de l'équipement est conservé sans startup-config (nœud de la topologie) ;
 * la base des VLAN d'un switch (vlan.dat) survit au redémarrage. `nextId` fournit les identifiants
 * des sous-interfaces et interfaces VLAN recréées.
 */
export function applyStartup(device: Draft<IosDevice>, nextId: () => number): void {
  const startup = iosState(device as IosDevice).startup
  const router = device.kind === 'router'
  // Interfaces physiques d'usine ; les sous-interfaces disparaissent
  const svis = new Map(device.interfaces.filter((i) => i.svi).map((i) => [i.name, clone(i as NetInterface)]))
  device.interfaces = device.interfaces.filter((i) => !i.subinterface && !i.svi)
  for (const iface of device.interfaces) factoryInterface(iface, router)
  if (device.kind === 'router') device.routes = []
  else delete device.routes
  device.ios = {
    ...clone(startup?.config ?? defaultIosState()),
    startup,
    natTranslations: [],
    hsrpStates: {},
    aclCounters: {},
    syslog: [],
    macTable: []
  }
  if (!startup) return
  device.name = startup.hostname
  for (const saved of startup.interfaces) {
    let iface = device.interfaces.find((i) => i.name === saved.name)
    if (!iface && saved.svi) {
      // Interface VLAN : même carte qu'avant le redémarrage si elle existait (identifiant conservé)
      const created = svis.get(saved.name) ?? createSviDraft(device as IosDevice, saved.svi.vlan, nextId())
      factoryInterface(created, false)
      created.svi = { vlan: saved.svi.vlan }
      device.interfaces.push(created)
      iface = device.interfaces[device.interfaces.length - 1]
    }
    if (!iface && saved.subinterface) {
      const parent = device.interfaces.find((i) => i.name === saved.subinterface?.parent)
      if (!parent) continue
      insertSubinterface(device.interfaces, createSubinterfaceDraft(parent, saved.name, nextId()))
      iface = device.interfaces.find((i) => i.name === saved.name)
    }
    if (!iface) continue
    iface.enabled = saved.enabled
    iface.address = saved.address
    iface.prefixLength = saved.prefixLength
    if (saved.switchport) iface.switchport = { ...saved.switchport }
    if (saved.helperAddresses) iface.helperAddresses = [...saved.helperAddresses]
    if (saved.subinterface && iface.subinterface) iface.subinterface.vlan = saved.subinterface.vlan
  }
  if (startup.routes && (device.kind === 'router' || startup.routes.length > 0))
    device.routes = clone(startup.routes)
}

/** Sous-interface IOS sans encapsulation (partage la MAC de sa carte parente). */
export function createSubinterfaceDraft(parent: NetInterface, name: string, seq: number): NetInterface {
  return {
    id: `if${seq}`,
    name,
    mac: parent.mac,
    enabled: true,
    l3: true,
    addressing: 'static',
    address: null,
    prefixLength: null,
    gateway: null,
    dnsMode: 'static',
    dnsServers: [],
    dhcpLease: null,
    dhcpReleased: false,
    bridge: null,
    subinterface: { parent: parent.id, vlan: null }
  }
}

/** Insère une sous-interface après sa carte parente et les sous-interfaces existantes. */
export function insertSubinterface(interfaces: NetInterface[], sub: NetInterface): void {
  const parentId = sub.subinterface?.parent
  let at = interfaces.findIndex((i) => i.id === parentId) + 1
  while (interfaces[at]?.subinterface?.parent === parentId) at++
  interfaces.splice(at, 0, sub)
}

/** Interface VLAN (SVI) d'un switch (même adresse MAC que le switch). */
export function createSviDraft(device: IosDevice, vlan: number, seq: number): NetInterface {
  return {
    id: `if${seq}`,
    name: `Vl${vlan}`,
    mac: device.interfaces[0]?.mac ?? '02-53-4C-00-00-00',
    enabled: true,
    l3: true,
    addressing: 'static',
    address: null,
    prefixLength: null,
    gateway: null,
    dnsMode: 'static',
    dnsServers: [],
    dhcpLease: null,
    dhcpReleased: false,
    bridge: null,
    svi: { vlan }
  }
}

/** Données IOS modifiables d'une interface (créées à la première modification). */
export function draftIfaceEntry(ios: Draft<IosState>, name: string): Draft<IosState['interfaces'][string]> {
  return (ios.interfaces[name] ??= {
    description: null,
    nat: null,
    hsrp: [],
    aclIn: null,
    aclOut: null,
    portSecurity: null,
    errDisabled: false,
    dhcpSnoopingTrust: false,
    arpInspectionTrust: false,
    nonegotiate: false,
    portfast: false,
    bpduGuard: false
  })
}
