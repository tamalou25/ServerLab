/**
 * Pare-feu Windows Defender avec fonctions avancées de sécurité : profils (domaine, privé,
 * public), règles prédéfinies des services installés, règles locales et règles déployées par
 * stratégie de groupe. Le trafic entrant non sollicité est bloqué sauf règle d'autorisation, le
 * trafic sortant est autorisé sauf règle de blocage ; une règle de blocage l'emporte toujours.
 * Les réponses à un échange autorisé passent (pare-feu à états).
 */
import type { Draft } from 'immer'
import { guidFromSeed } from '../core/guid'
import { raise, transact, type EngineResult } from '../core/result'
import { nextSeq } from '../model/factory'
import type { FirewallProfileName, FirewallRule, HostDevice, LabState } from '../model/schema'
import { FIREWALL_PROFILES, FIREWALL_PROTOCOLS } from '../model/schema'
import { inNetwork, isIpv4, parseMaskOrPrefix } from '../net/ipv4'
import { requireDevice } from '../topology/actions'
import { serviceRunning } from './servicestate'

export const PROFILE_LABELS: Record<FirewallProfileName, string> = {
  Domain: 'Domaine',
  Private: 'Privé',
  Public: 'Public'
}

/** Groupes de règles prédéfinies (libellés de la version française). */
export const FPS_GROUP = 'Partage de fichiers et d’imprimantes'
export const RDP_GROUP = 'Bureau à distance'

type Predefined = Omit<FirewallRule, 'enabled'> & {
  /** Règle présente sur l'ordinateur (service installé). */
  present: (host: HostDevice) => boolean
  /** Activée sans intervention de l'administrateur. */
  enabledByDefault: (host: HostDevice) => boolean
}

const inbound = (
  id: string,
  displayName: string,
  group: string,
  protocol: FirewallRule['protocol'],
  localPorts: number[],
  present: Predefined['present'],
  enabledByDefault: Predefined['enabledByDefault'] = () => true
): Predefined => ({
  id,
  displayName,
  group,
  direction: 'Inbound',
  action: 'Allow',
  protocol,
  localPorts,
  remoteAddresses: [],
  profiles: [],
  present,
  enabledByDefault
})

const always = () => true
const hasFeature = (name: string) => (host: HostDevice) => host.host.features.includes(name)

/** Règles prédéfinies : créées avec Windows ou à l'installation d'un rôle (activées par celui-ci). */
const PREDEFINED: Predefined[] = [
  inbound(
    'FPS-ICMP4-ERQ-In',
    `${FPS_GROUP} (Demande d’écho - Trafic entrant ICMPv4)`,
    FPS_GROUP,
    'ICMPv4',
    [],
    always
  ),
  inbound('FPS-SMB-In-TCP', `${FPS_GROUP} (SMB-Entrée)`, FPS_GROUP, 'TCP', [445], always),
  inbound(
    'RemoteDesktop-UserMode-In-TCP',
    'Bureau à distance - Mode utilisateur (TCP-Entrée)',
    RDP_GROUP,
    'TCP',
    [3389],
    always,
    // Autoriser les connexions à distance active le groupe de règles
    (host) => host.host.remoteDesktop.enabled
  ),
  inbound('DNSSrv-TCP-In', 'Serveur DNS (TCP, entrant)', 'Serveur DNS', 'TCP', [53], hasFeature('DNS')),
  inbound('DNSSrv-UDP-In', 'Serveur DNS (UDP, entrant)', 'Serveur DNS', 'UDP', [53], hasFeature('DNS')),
  inbound(
    'ADDS-LDAP-TCP-In',
    'Services de domaine Active Directory (LDAP-Entrée)',
    'Services de domaine Active Directory',
    'TCP',
    [389],
    hasFeature('AD-Domain-Services')
  ),
  inbound(
    'ADDS-LDAP-UDP-In',
    'Services de domaine Active Directory (LDAP UDP-Entrée)',
    'Services de domaine Active Directory',
    'UDP',
    [389],
    hasFeature('AD-Domain-Services')
  ),
  inbound(
    'KDC-TCP-In',
    'Centre de distribution de clés Kerberos (TCP-Entrée)',
    'Centre de distribution de clés Kerberos',
    'TCP',
    [88],
    hasFeature('AD-Domain-Services')
  ),
  inbound(
    'Microsoft-Windows-DHCP-ClientSvc-DHCPv4-In',
    'Serveur DHCP v4 (UDP-Entrée)',
    'Serveur DHCP',
    'UDP',
    [67],
    hasFeature('DHCP')
  ),
  inbound(
    'IIS-WebServerRole-HTTP-In-TCP',
    'Services World Wide Web (HTTP Trafic entrant)',
    'Services World Wide Web (HTTP)',
    'TCP',
    [80],
    // WSUS s'installe avec IIS (site par défaut sur le port 80)
    (host) => hasFeature('Web-Server')(host) || hasFeature('UpdateServices')(host)
  ),
  inbound(
    'IIS-WebServerRole-HTTPS-In-TCP',
    'Services World Wide Web (HTTPS Trafic entrant)',
    'Services World Wide Web (HTTPS)',
    'TCP',
    [443],
    hasFeature('Web-Server')
  ),
  inbound(
    'WSUS-HTTP-In-TCP',
    'Windows Server Update Services (HTTP-Entrée)',
    'Windows Server Update Services',
    'TCP',
    [8530],
    hasFeature('UpdateServices')
  ),
  inbound(
    'RemoteAccess-SSTP-In-TCP',
    'Routage et accès distant (SSTP-Entrée)',
    'Routage et accès distant',
    'TCP',
    [443],
    hasFeature('RemoteAccess')
  ),
  inbound(
    'NPS-NPSSvc-In-UDP-1812-1645',
    'Serveur NPS (Network Policy Server) (Authentification RADIUS - Trafic entrant UDP)',
    'Serveur NPS (Network Policy Server)',
    'UDP',
    [1812, 1645],
    hasFeature('NPAS')
  ),
  inbound(
    'DFSR-DFSRSvc-In-TCP',
    'Réplication DFS (RPC-Entrée)',
    'Réplication DFS',
    'TCP',
    [5722],
    hasFeature('FS-DFS-Replication')
  )
]

/** Règles prédéfinies présentes sur l'ordinateur, avec leur état. */
export function predefinedRules(host: HostDevice): FirewallRule[] {
  return PREDEFINED.filter((p) => p.present(host)).map(({ present: _p, enabledByDefault, ...rule }) => ({
    ...rule,
    enabled: host.host.firewall.predefined[rule.id] ?? enabledByDefault(host)
  }))
}

/** Profil actif : domaine pour un membre du domaine, sinon la catégorie du réseau. */
export function activeProfile(host: HostDevice): FirewallProfileName {
  return host.host.domain ? 'Domain' : host.host.firewall.networkCategory
}

/** Règles appliquées : prédéfinies, locales, puis de stratégie de groupe. */
export function effectiveRules(host: HostDevice): (FirewallRule & { source: 'local' | 'gpo' })[] {
  const gpo = host.host.policy.computer?.settings.firewallRules ?? []
  return [
    ...predefinedRules(host).map((r) => ({ ...r, source: 'local' as const })),
    ...host.host.firewall.rules.map((r) => ({ ...r, source: 'local' as const })),
    ...gpo.map((r) => ({ ...r, source: 'gpo' as const }))
  ]
}

/** Profil activé, compte tenu de la stratégie de groupe (« protéger toutes les connexions réseau »). */
export function profileEnabled(host: HostDevice, profile: FirewallProfileName): boolean {
  const settings = host.host.policy.computer?.settings
  const policy = profile === 'Domain' ? settings?.firewallDomain : settings?.firewallStandard
  if (policy === 'Enabled') return true
  if (policy === 'Disabled') return false
  return host.host.firewall.profiles[profile].enabled
}

export type FirewallTransport = 'TCP' | 'UDP' | 'ICMPv4'

export interface FirewallPacket {
  direction: 'Inbound' | 'Outbound'
  transport: FirewallTransport
  /** Port local (destination d'un trafic entrant, source d'un sortant). */
  localPort: number | null
  remoteAddress: string
}

export interface FirewallVerdict {
  allowed: boolean
  profile: FirewallProfileName
  /** Règle déterminante (null : action par défaut ou profil désactivé). */
  rule: FirewallRule | null
  reason: string
}

function addressMatches(spec: string, ip: string): boolean {
  const [base = '', prefix] = spec.split('/')
  if (prefix === undefined) return base === ip
  const length = parseMaskOrPrefix(prefix)
  return length !== null && inNetwork(ip, base, length)
}

function ruleMatches(rule: FirewallRule, packet: FirewallPacket, profile: FirewallProfileName): boolean {
  if (!rule.enabled || rule.direction !== packet.direction) return false
  if (rule.profiles.length > 0 && !rule.profiles.includes(profile)) return false
  if (rule.protocol !== 'Any' && rule.protocol !== packet.transport) return false
  if (
    rule.localPorts.length > 0 &&
    (packet.localPort === null || !rule.localPorts.includes(packet.localPort))
  )
    return false
  if (
    rule.remoteAddresses.length > 0 &&
    !rule.remoteAddresses.some((a) => addressMatches(a, packet.remoteAddress))
  )
    return false
  return true
}

/** Décision du pare-feu de l'ordinateur pour un paquet. */
export function evaluateFirewall(host: HostDevice, packet: FirewallPacket): FirewallVerdict {
  const profile = activeProfile(host)
  // Poste Ubuntu : pas de pare-feu Windows ; ufw est installé mais inactif par défaut
  if (host.host.os === 'linux')
    return { allowed: true, profile, rule: null, reason: 'poste Linux : pare-feu (ufw) inactif' }
  // Service Pare-feu Windows Defender (MpsSvc) arrêté : plus aucune règle n'est appliquée (v2.8, #222).
  // Microsoft : « Stopping the Windows Firewall service isn't supported by Microsoft and can cause
  // problems » (Start menu, applications modernes, activation par téléphone…) ; la méthode prise en
  // charge est de désactiver les profils en laissant le service démarré :
  // https://learn.microsoft.com/en-us/windows/security/operating-system-security/network-security/windows-firewall/
  // Que l'arrêt laisse passer tout le trafic n'est pas sourcé (docs/fidelite.md, « À vérifier »).
  if (!serviceRunning(host, 'MpsSvc'))
    return {
      allowed: true,
      profile,
      rule: null,
      reason: 'service Pare-feu (MpsSvc) arrêté : aucune règle appliquée'
    }
  const label = PROFILE_LABELS[profile]
  if (!profileEnabled(host, profile))
    return { allowed: true, profile, rule: null, reason: `pare-feu désactivé pour le profil ${label}` }
  const rules = effectiveRules(host).filter((r) => ruleMatches(r, packet, profile))
  const block = rules.find((r) => r.action === 'Block')
  if (block)
    return { allowed: false, profile, rule: block, reason: `règle de blocage « ${block.displayName} »` }
  const allow = rules.find((r) => r.action === 'Allow')
  if (allow) return { allowed: true, profile, rule: allow, reason: `règle « ${allow.displayName} »` }
  const settings = host.host.firewall.profiles[profile]
  const action = packet.direction === 'Inbound' ? settings.defaultInbound : settings.defaultOutbound
  return {
    allowed: action === 'Allow',
    profile,
    rule: null,
    reason:
      action === 'Allow'
        ? `action par défaut du profil ${label} (autoriser)`
        : `aucune règle ne l’autorise, action par défaut du profil ${label} : bloquer`
  }
}

// --- Actions -------------------------------------------------------------------------------------

function requireHost(draft: Draft<LabState>, deviceId: string): Draft<HostDevice> {
  const device = requireDevice(draft, deviceId)
  if (device.kind !== 'server' && device.kind !== 'client')
    raise('NotSupported', 'Le pare-feu Windows se configure sur un serveur ou un poste.')
  return device
}

export interface ProfileInput {
  enabled?: boolean
  defaultInbound?: 'Block' | 'Allow'
  defaultOutbound?: 'Block' | 'Allow'
}

/** Active ou désactive des profils, ou change leurs actions par défaut (Set-NetFirewallProfile). */
export function setFirewallProfile(
  state: LabState,
  deviceId: string,
  profiles: FirewallProfileName[],
  input: ProfileInput
): EngineResult {
  return transact(state, (draft) => {
    const host = requireHost(draft, deviceId)
    if (profiles.length === 0)
      raise('InvalidProfile', 'Indiquez au moins un profil (Domain, Private, Public).')
    for (const name of profiles) {
      const profile = host.host.firewall.profiles[name]
      if (input.enabled !== undefined) profile.enabled = input.enabled
      if (input.defaultInbound) profile.defaultInbound = input.defaultInbound
      if (input.defaultOutbound) profile.defaultOutbound = input.defaultOutbound
    }
    return undefined
  })
}

/** Catégorie du réseau hors domaine (Set-NetConnectionProfile -NetworkCategory). */
export function setNetworkCategory(
  state: LabState,
  deviceId: string,
  category: 'Public' | 'Private'
): EngineResult {
  return transact(state, (draft) => {
    const host = requireHost(draft, deviceId)
    if (host.host.domain)
      raise(
        'DomainNetwork',
        'Le réseau est authentifié par le domaine (DomainAuthenticated) : sa catégorie ne peut pas être modifiée.'
      )
    host.host.firewall.networkCategory = category
    return undefined
  })
}

export interface RuleInput {
  displayName: string
  name?: string
  direction: 'Inbound' | 'Outbound'
  action: 'Allow' | 'Block'
  protocol?: FirewallRule['protocol']
  localPorts?: number[]
  remoteAddresses?: string[]
  profiles?: FirewallProfileName[]
  enabled?: boolean
  group?: string
}

/** Contrôle d'une règle saisie : nom, ports réservés à TCP/UDP, adresses valides. */
export function validateRule(input: RuleInput, id: string): FirewallRule {
  const displayName = input.displayName.trim()
  if (!displayName) raise('InvalidName', 'Indiquez le nom de la règle.')
  const protocol = input.protocol ?? 'Any'
  if (!FIREWALL_PROTOCOLS.includes(protocol)) raise('InvalidProtocol', `Protocole « ${protocol} » inconnu.`)
  const localPorts = [...new Set(input.localPorts ?? [])]
  for (const port of localPorts)
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      raise('InvalidPort', `Le port « ${port} » n’est pas valide (1 à 65535).`)
  if (localPorts.length > 0 && protocol !== 'TCP' && protocol !== 'UDP')
    raise('InvalidPort', 'Les ports ne peuvent être indiqués que pour les protocoles TCP et UDP.')
  const remoteAddresses = (input.remoteAddresses ?? []).map((a) => a.trim()).filter(Boolean)
  for (const a of remoteAddresses) {
    const [base = '', prefix] = a.split('/')
    if (!isIpv4(base) || (prefix !== undefined && parseMaskOrPrefix(prefix) === null))
      raise(
        'InvalidAddress',
        `L’adresse distante « ${a} » n’est pas valide (192.168.1.10 ou 192.168.1.0/24).`
      )
  }
  for (const p of input.profiles ?? [])
    if (!FIREWALL_PROFILES.includes(p)) raise('InvalidProfile', `Profil « ${p} » inconnu.`)
  return {
    id,
    displayName,
    group: input.group?.trim() ?? '',
    direction: input.direction,
    action: input.action,
    enabled: input.enabled ?? true,
    protocol,
    localPorts,
    remoteAddresses,
    profiles: [...(input.profiles ?? [])]
  }
}

/** Identifiant d'une nouvelle règle : le nom fourni, sinon un identifiant dérivé de state.seq. */
function newRuleId(draft: Draft<LabState>, name: string | undefined): string {
  if (name?.trim()) return name.trim()
  return `{${guidFromSeed(`firewall-rule-${nextSeq(draft)}`)}}`
}

/** Nouvelle règle locale (New-NetFirewallRule, netsh advfirewall firewall add rule). */
export function newFirewallRule(state: LabState, deviceId: string, input: RuleInput): EngineResult<string> {
  return transact(state, (draft) => {
    const host = requireHost(draft, deviceId)
    const id = newRuleId(draft, input.name)
    if (effectiveRules(host as HostDevice).some((r) => r.id.toLowerCase() === id.toLowerCase()))
      raise('RuleExists', `Une règle nommée « ${id} » existe déjà.`)
    host.host.firewall.rules.push(validateRule(input, id))
    return id
  })
}

/** Sélection de règles : par nom, nom complet ou groupe (comparaison insensible à la casse). */
export interface RuleSelector {
  name?: string
  displayName?: string
  group?: string
}

function selects(rule: FirewallRule, selector: RuleSelector): boolean {
  const eq = (a: string, b: string | undefined) =>
    b !== undefined && a.toLowerCase() === b.trim().toLowerCase()
  return (
    eq(rule.id, selector.name) || eq(rule.displayName, selector.displayName) || eq(rule.group, selector.group)
  )
}

/** Active ou désactive des règles locales ou prédéfinies. Renvoie le nombre de règles modifiées. */
export function setFirewallRuleEnabled(
  state: LabState,
  deviceId: string,
  selector: RuleSelector,
  enabled: boolean
): EngineResult<number> {
  return transact(state, (draft) => {
    const host = requireHost(draft, deviceId)
    let count = 0
    for (const rule of predefinedRules(host as HostDevice))
      if (selects(rule, selector)) {
        host.host.firewall.predefined[rule.id] = enabled
        count++
      }
    for (const rule of host.host.firewall.rules)
      if (selects(rule, selector)) {
        rule.enabled = enabled
        count++
      }
    if (count === 0) raise('RuleNotFound', 'Aucune règle ne correspond aux critères spécifiés.')
    return count
  })
}

/** Supprime des règles locales (les règles prédéfinies se désactivent). Renvoie leur nombre. */
export function removeFirewallRule(
  state: LabState,
  deviceId: string,
  selector: RuleSelector
): EngineResult<number> {
  return transact(state, (draft) => {
    const host = requireHost(draft, deviceId)
    const before = host.host.firewall.rules.length
    host.host.firewall.rules = host.host.firewall.rules.filter((r) => !selects(r, selector))
    const removed = before - host.host.firewall.rules.length
    if (removed === 0) {
      if (predefinedRules(host as HostDevice).some((r) => selects(r, selector)))
        raise('PredefinedRule', 'Une règle prédéfinie ne peut pas être supprimée : désactivez-la.')
      raise('RuleNotFound', 'Aucune règle ne correspond aux critères spécifiés.')
    }
    return removed
  })
}
