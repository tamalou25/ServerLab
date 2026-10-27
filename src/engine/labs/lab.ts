/**
 * Labs pédagogiques : format JSON (énoncé, topologie de départ, critères) et construction de
 * l'état de départ avec les actions du moteur (déterministe : même lab = même état).
 */
import { z } from 'zod'
import { command, type Command, type CommandType, type CommandValue } from '../commands/catalog'
import { dispatch } from '../commands/dispatch'
import { runIosScript } from '../ios/cli'
import { createShellSession } from '../shell/exec'
import type { CyberConfigPatch } from '../cyber/config'
import { IOS_MODELS } from '../ios/models'
import { createLab } from '../model/factory'
import { DEVICE_KINDS } from '../model/kinds'
import type { LabState } from '../model/schema'
import { FaultParamsSchema, FIREWALL_PROFILES } from '../model/schema'
import { localToken } from '../roles/files/acl'
import { DEFAULT_DOMAIN_POLICY_ID } from '../roles/gpo/defaults'
import { parseSlabValue } from '../serialization/slab'
import { startTroubleshooting } from '../troubleshoot/session'
import { CriterionSchema, evaluateCriteria, type CriterionResult } from './criteria'

export const LAB_FORMAT_VERSION = 1

export const LabDeviceSchema = z.object({
  kind: z.enum(DEVICE_KINDS),
  name: z.string(),
  /** Routeur ou switch Cisco IOS (1921, 2811, 2960, 9200) : console IOS à la place de la configuration graphique. */
  model: z.enum(IOS_MODELS).optional(),
  /** Système Linux (serveur Debian 12 ou poste Ubuntu) à la place de Windows. */
  os: z.literal('linux').optional(),
  /**
   * Configuration IOS de départ : lignes saisies dans la console, comme à la main (« enable »,
   * « configure terminal », « interface Gi0/0 »… « end »).
   */
  ios: z.array(z.string()).optional(),
  x: z.number(),
  y: z.number(),
  powered: z.boolean().default(true),
  /** Adresse statique de la première carte (CIDR : 192.168.10.1/24). */
  ip: z.string().optional(),
  gateway: z.string().optional(),
  dns: z.array(z.string()).optional(),
  /** Première carte en DHCP (postes). */
  dhcp: z.boolean().optional(),
  /**
   * Adresses par carte : { "Gi0/0": "192.168.10.254/24" } ; passerelle facultative après une
   * espace : { "Ethernet1": "203.0.113.2/24 203.0.113.1" }.
   */
  interfaces: z.record(z.string(), z.string()).optional(),
  /** Nombre de cartes réseau d'un serveur (Ethernet0, Ethernet1…). */
  nics: z.number().int().min(1).max(4).optional(),
  /** Rôles et fonctionnalités installés (avec les outils de gestion). */
  features: z.array(z.string()).optional(),
  /** Protocole SMB 1.0 activé (labs de durcissement). */
  smb1: z.boolean().optional(),
  /** Profils du pare-feu désactivés. */
  firewallDisabled: z.array(z.enum(FIREWALL_PROFILES)).optional(),
  /** Compte local ouvert en session sur le poste (après la jonction au domaine) : { user, password }. */
  logon: z.object({ user: z.string(), password: z.string() }).optional(),
  /** Machines vers lesquelles les sessions de ce poste ont un accès administrateur (cyber). */
  adminAccess: z.array(z.string()).optional(),
  /** État initial de services système : { name: "DNS", running: false, startType: "Manual" }. */
  services: z
    .array(
      z.object({
        name: z.string(),
        running: z.boolean().default(true),
        startType: z.enum(['Automatic', 'Manual', 'Disabled']).optional()
      })
    )
    .optional(),
  /** Écart de l'horloge du poste avec celle du lab, en secondes (appliqué en dernier ; labs de diagnostic Kerberos). */
  clockOffsetSeconds: z.number().int().optional(),
  /** Dossiers partagés (créés au besoin) : comptes par niveau d'autorisation. */
  shares: z
    .array(
      z.object({
        name: z.string(),
        path: z.string(),
        full: z.array(z.string()).optional(),
        change: z.array(z.string()).optional(),
        read: z.array(z.string()).optional()
      })
    )
    .optional(),
  /** Fichiers présents au départ (dossiers parents créés au besoin) : chemin local et contenu texte. */
  files: z.array(z.object({ path: z.string(), content: z.string() })).optional(),
  /** Serveur Linux : paquets installés au départ (apache2, bind9…), leurs services démarrés comme avec `apt install`. */
  packages: z.array(z.string()).optional(),
  /**
   * Serveur ou poste Linux : lignes saisies dans la console bash (compte `admin`, `sudo` permis) pour
   * préparer l'ordinateur (écriture de fichiers avec `echo … | sudo tee`, `systemctl restart`…). Une ligne
   * qui échoue interrompt la construction du lab : le départ est sain ou n'existe pas. Une ligne qui
   * demande une saisie (mot de passe de `smbpasswd`) s'écrit { line, answers }.
   */
  bash: z
    .array(z.union([z.string(), z.object({ line: z.string(), answers: z.array(z.string()) })]))
    .optional()
})

export const LabDomainSchema = z.object({
  name: z.string(),
  netbios: z.string().optional(),
  /** Serveur promu contrôleur du domaine. */
  dc: z.string(),
  ous: z.array(z.string()).default([]),
  groups: z
    .array(
      z.object({
        name: z.string(),
        ou: z.string().optional(),
        scope: z.enum(['DomainLocal', 'Global', 'Universal']).default('Global'),
        members: z.array(z.string()).default([])
      })
    )
    .default([]),
  users: z
    .array(
      z.object({
        name: z.string(),
        sam: z.string(),
        ou: z.string().optional(),
        password: z.string(),
        enabled: z.boolean().default(true),
        passwordNeverExpires: z.boolean().optional(),
        /** Groupes existants (Admins du domaine…) dont le compte est membre. */
        memberOf: z.array(z.string()).optional(),
        /** Compte créé il y a N jours ; dernière ouverture de session il y a N jours (null : jamais). */
        createdDaysAgo: z.number().int().nonnegative().optional(),
        /** Noms de principal de service (compte de service) ; mot de passe inchangé depuis N jours. */
        spns: z.array(z.string()).optional(),
        passwordAgeDays: z.number().int().nonnegative().optional(),
        lastLogonDaysAgo: z.number().int().nonnegative().nullable().optional()
      })
    )
    .default([]),
  /**
   * Stratégie en vigueur à la création des comptes (laxiste : comptes hérités aux mots de passe
   * désormais non conformes) ; `passwordPolicy` s'applique ensuite.
   */
  creationPolicy: z
    .object({ minLength: z.number().int().min(0).max(14).optional(), complexity: z.boolean().optional() })
    .optional(),
  /** Stratégie de mot de passe de la Default Domain Policy. */
  passwordPolicy: z
    .object({ minLength: z.number().int().min(0).max(14).optional(), complexity: z.boolean().optional() })
    .optional(),
  /** Postes et serveurs joints au domaine (redémarrés). */
  join: z.array(z.string()).default([])
})

/** Départ décrit équipement par équipement (labs fournis avec l'application). */
export const LabDeclarativeStartSchema = z.object({
  devices: z.array(LabDeviceSchema),
  /** Câbles entre ports : ["PC1:Ethernet0", "SW1:Fa0/1"]. */
  links: z.array(z.tuple([z.string(), z.string()])).default([]),
  domain: LabDomainSchema.optional(),
  /** Paramètres des scénarios de cybersécurité (cibles, scénarios activés, mode Red/Blue) : voir `cyber.*`. */
  cyber: z.record(z.string(), z.unknown()).optional()
})

/**
 * Départ « instantané » (éditeur de labs) : document .slab complet du lab de l'auteur, validé et
 * migré comme un fichier ouvert (parseSlabValue) au moment de construire le départ.
 */
export const LabSnapshotStartSchema = z.object({ snapshot: z.record(z.string(), z.unknown()) })

export const LabStartSchema = z.union([LabDeclarativeStartSchema, LabSnapshotStartSchema])

/**
 * Dépannage (mode panne) : le lab démarre cassé. `start` décrit le lab SAIN ; les pannes sont
 * tirées de la graine (filtres facultatifs) ou imposées par `faults`.
 */
export const LabTroubleshootingSchema = z.object({
  seed: z.number().int(),
  domain: z.enum(['reseau', 'windows', 'linux', 'pare-feu']).optional(),
  difficulty: z.number().int().min(1).max(3).optional(),
  count: z.number().int().min(1).max(5).optional(),
  faults: z.array(z.object({ id: z.string(), params: FaultParamsSchema.optional() })).optional()
})

export const LabDefinitionSchema = z.object({
  formatVersion: z.literal(LAB_FORMAT_VERSION),
  id: z.string(),
  title: z.string(),
  difficulty: z.enum(['Débutant', 'Intermédiaire', 'Avancé']),
  /** Durée indicative (« 20 min »). */
  duration: z.string(),
  summary: z.string(),
  /** Énoncé en Markdown (titres, listes, gras, code). */
  statement: z.string(),
  start: LabStartSchema,
  criteria: z.array(CriterionSchema).min(1),
  /** Mode panne : facultatif (absent = lab ordinaire). */
  troubleshooting: LabTroubleshootingSchema.optional()
})

export type LabDefinition = z.infer<typeof LabDefinitionSchema>
export type LabStart = z.infer<typeof LabStartSchema>
export type LabDeclarativeStart = z.infer<typeof LabDeclarativeStartSchema>

export type LabParseResult = { ok: true; lab: LabDefinition } | { ok: false; message: string }

/** Taille maximale d'un fichier de lab (texte JSON). */
export const MAX_LAB_LENGTH = 1024 * 1024

/**
 * Valide le texte d'un fichier de lab (import, bibliothèque) : taille, JSON puis schéma.
 * Un lab n'est que des données : aucun contenu n'est exécuté ni interprété comme du HTML.
 */
export function parseLabText(text: string): LabParseResult {
  if (text.length > MAX_LAB_LENGTH) return { ok: false, message: 'Lab invalide : fichier trop volumineux.' }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, message: 'Lab invalide : JSON illisible.' }
  }
  return parseLab(raw)
}

/**
 * Valide un lab (objet JSON) ; message d'erreur explicite si invalide. Les champs inconnus sont
 * ignorés et retirés du résultat.
 */
export function parseLab(raw: unknown): LabParseResult {
  const parsed = LabDefinitionSchema.safeParse(raw)
  if (parsed.success) return { ok: true, lab: parsed.data }
  const issue = parsed.error.issues[0]
  return {
    ok: false,
    message: `Lab invalide${issue && issue.path.length > 0 ? ` (champ ${issue.path.join('.')})` : ''} : ${issue?.message ?? 'structure inattendue'}.`
  }
}

/** « 192.168.10.1/24 » → adresse et préfixe. */
function cidr(text: string): { address: string; mask: string } {
  const [address = '', prefix = '24'] = (text.trim().split(/\s+/)[0] ?? '').split('/')
  return { address, mask: prefix }
}

/** Passerelle facultative après l'adresse : « 203.0.113.2/24 203.0.113.1 ». */
const gatewayOf = (text: string): string | null => text.trim().split(/\s+/)[1] ?? null

/** Construit l'état de départ d'un lab (lève une erreur si le lab est incohérent). */
export function buildLabStart(start: LabStart): LabState {
  if ('snapshot' in start) {
    const parsed = parseSlabValue(start.snapshot)
    if (!parsed.ok) throw new Error(`Topologie de départ invalide : ${parsed.message}`)
    return parsed.doc.lab
  }
  return buildDeclarativeStart(start)
}

/**
 * État de départ complet d'un lab : `buildLabStart`, puis l'injection des pannes si le lab est un
 * lab de dépannage (le résultat est le point de départ : rien n'est annulable).
 */
export function buildLabState(lab: LabDefinition): LabState {
  const healthy = buildLabStart(lab.start)
  if (!lab.troubleshooting) return healthy
  const r = startTroubleshooting(healthy, lab.troubleshooting)
  if (!r.ok) throw new Error(`Dépannage impossible : ${r.error.message}`)
  return r.state
}

function buildDeclarativeStart(start: LabDeclarativeStart): LabState {
  let state = createLab()
  /** Applique une commande (mêmes commandes que l'interface et les consoles) ou lève une erreur. */
  const apply = <K extends CommandType>(cmd: Command<K>): CommandValue<K> => {
    const r = dispatch(state, cmd)
    if (!r.ok) throw new Error(`[${r.error.code}] ${r.error.message}`)
    state = r.state
    return r.value
  }
  const ids = new Map<string, string>()
  const idOf = (name: string): string => {
    const id = ids.get(name.toLowerCase())
    if (!id) throw new Error(`Équipement « ${name} » inconnu dans le lab.`)
    return id
  }
  for (const d of start.devices) {
    const id = apply(
      command('topology.addDevice', {
        kind: d.kind,
        position: { x: d.x, y: d.y },
        name: d.name,
        ...(d.model ? { model: d.model } : {}),
        ...(d.os ? { os: d.os } : {})
      })
    )
    ids.set(d.name.toLowerCase(), id)
    if (d.kind === 'server')
      for (let n = 1; n < (d.nics ?? 1); n++) apply(command('topology.addServerInterface', id))
  }
  const ifaceOf = (deviceId: string, name?: string) => {
    const device = state.devices[deviceId]
    const iface = name
      ? device?.interfaces.find((i) => i.name.toLowerCase() === name.toLowerCase())
      : device?.interfaces.find((i) => i.l3)
    if (!iface)
      throw new Error(`Port « ${name ?? '(premier)'} » introuvable sur ${device?.name ?? deviceId}.`)
    return iface.id
  }
  for (const [a, b] of start.links) {
    const [da = '', pa] = a.split(':')
    const [db = '', pb] = b.split(':')
    const left = { deviceId: idOf(da), ifaceId: ifaceOf(idOf(da), pa) }
    const right = { deviceId: idOf(db), ifaceId: ifaceOf(idOf(db), pb) }
    apply(command('topology.connect', left, right))
  }
  for (const d of start.devices) {
    const id = idOf(d.name)
    for (const [port, address] of Object.entries(d.interfaces ?? {}))
      apply(
        command('net.setInterfaceIpv4', id, ifaceOf(id, port), {
          addressing: 'static',
          ...cidr(address),
          gateway: gatewayOf(address),
          dnsServers: []
        })
      )
    if (d.ip)
      apply(
        command('net.setInterfaceIpv4', id, ifaceOf(id), {
          addressing: 'static',
          ...cidr(d.ip),
          gateway: d.gateway ?? null,
          dnsServers: d.dns ?? []
        })
      )
    else if (d.dhcp)
      apply(
        command('net.setInterfaceIpv4', id, ifaceOf(id), {
          addressing: 'dhcp',
          address: '',
          mask: '',
          gateway: null,
          dnsServers: []
        })
      )
    if (d.features?.length)
      apply(command('system.installFeatures', id, d.features, { includeManagementTools: true }))
    if (d.smb1) apply(command('files.setSmb1', id, true))
    if (d.firewallDisabled?.length)
      apply(command('firewall.setProfile', id, d.firewallDisabled, { enabled: false }))
    for (const share of d.shares ?? [])
      apply(
        command(
          'files.shareFolder',
          id,
          {
            name: share.name,
            path: share.path,
            ...(share.full ? { full: share.full } : {}),
            ...(share.change ? { change: share.change } : {}),
            ...(share.read ? { read: share.read } : {})
          },
          localToken(d.name, 'Administrateur')
        )
      )
    for (const f of d.files ?? [])
      apply(
        command('files.createItem', id, f.path, 'file', localToken(d.name, 'Administrateur'), {
          parents: true,
          content: f.content
        })
      )
    if (d.ios?.length) state = runIosScript(state, id, d.ios)
  }
  // Ordinateurs Linux : paquets puis lignes de console, une fois toutes les cartes configurées
  for (const d of start.devices) {
    const id = idOf(d.name)
    if (d.packages?.length) apply(command('linux.installPackages', id, d.packages))
    if (!d.bash?.length) continue
    let session = createShellSession(state, id, 'cmd')
    for (const entry of d.bash) {
      const line = typeof entry === 'string' ? entry : entry.line
      const outcome = apply(
        command('shell.exec', session, line, typeof entry === 'string' ? [] : entry.answers)
      )
      session = outcome.session
      const failure = outcome.output.find((o) => o.kind === 'error')
      if (failure || outcome.prompt)
        throw new Error(`${d.name} : « ${line} » a échoué (${failure?.text ?? 'saisie demandée'}).`)
    }
  }
  const domain = start.domain
  if (domain) {
    const dc = idOf(domain.dc)
    apply(command('system.installFeatures', dc, ['AD-Domain-Services'], { includeManagementTools: true }))
    apply(
      command('adds.installForest', dc, {
        domainName: domain.name,
        ...(domain.netbios ? { netbios: domain.netbios } : {}),
        safeModePassword: 'P@ssw0rd!'
      })
    )
    const dn = (ou?: string) =>
      [ou ? `OU=${ou}` : '', ...domain.name.split('.').map((p) => `DC=${p}`)].filter((x) => x).join(',')
    for (const ou of domain.ous) apply(command('adds.addOrganizationalUnit', domain.name, { name: ou }))
    // Stratégie en vigueur à la création des comptes (comptes hérités aux mots de passe faibles)
    const policyPatch = (p: { minLength?: number | undefined; complexity?: boolean | undefined }) =>
      apply(
        command('gpo.updateSettings', domain.name, DEFAULT_DOMAIN_POLICY_ID, {
          computer: {
            ...(p.minLength !== undefined ? { minPasswordLength: p.minLength } : {}),
            ...(p.complexity !== undefined ? { passwordComplexity: p.complexity } : {})
          }
        })
      )
    if (domain.creationPolicy) policyPatch(domain.creationPolicy)
    for (const u of domain.users)
      apply(
        command('adds.addUser', domain.name, {
          name: u.name,
          sam: u.sam,
          ...(u.ou ? { path: dn(u.ou) } : {}),
          upn: `${u.sam}@${domain.name}`,
          password: u.password,
          enabled: u.enabled,
          ...(u.passwordNeverExpires ? { passwordNeverExpires: true } : {})
        })
      )
    for (const g of domain.groups) {
      apply(
        command('adds.addGroup', domain.name, {
          name: g.name,
          scope: g.scope,
          ...(g.ou ? { path: dn(g.ou) } : {})
        })
      )
      if (g.members.length > 0) apply(command('adds.addGroupMembers', domain.name, g.name, g.members))
    }
    for (const u of domain.users) {
      for (const group of u.memberOf ?? [])
        apply(command('adds.addGroupMembers', domain.name, group, [u.sam]))
      if (u.spns?.length) apply(command('adds.setServicePrincipalNames', domain.name, u.sam, u.spns))
      if (
        u.createdDaysAgo !== undefined ||
        u.lastLogonDaysAgo !== undefined ||
        u.passwordAgeDays !== undefined
      )
        apply(
          command('adds.setAccountActivity', domain.name, u.sam, {
            ...(u.passwordAgeDays !== undefined ? { passwordAgeDays: u.passwordAgeDays } : {}),
            ...(u.createdDaysAgo !== undefined ? { createdDaysAgo: u.createdDaysAgo } : {}),
            ...(u.lastLogonDaysAgo !== undefined ? { lastLogonDaysAgo: u.lastLogonDaysAgo } : {})
          })
        )
    }
    // Stratégie finale (par défaut : celle d'une installation si une stratégie de création a été posée)
    if (domain.passwordPolicy) policyPatch(domain.passwordPolicy)
    else if (domain.creationPolicy) policyPatch({ minLength: 7, complexity: true })
    const netbios = state.domains[domain.name]?.netbios ?? ''
    const dcHost = state.devices[dc]
    const adminPassword = dcHost && dcHost.kind === 'server' ? dcHost.host.localAdminPassword : 'P@ssw0rd'
    for (const name of domain.join) {
      const id = idOf(name)
      const joined = apply(
        command('adds.joinDomain', id, {
          domain: domain.name,
          user: `${netbios}\\Administrateur`,
          password: adminPassword
        })
      )
      if (!joined.success) throw new Error(`Jonction de ${name} impossible : ${joined.message}`)
      apply(command('system.restartComputer', id))
    }
    // Sessions ouvertes sur les postes (compte de domaine)
    for (const d of start.devices) {
      if (!d.logon) continue
      const logged = apply(
        command('adds.logon', idOf(d.name), {
          user: d.logon.user,
          password: d.logon.password,
          domain: netbios
        })
      )
      if (!logged.success)
        throw new Error(`Session de ${d.logon.user} sur ${d.name} impossible : ${logged.message}`)
    }
  }
  // Services système : appliqués en dernier (rôles installés, redémarrages de jonction terminés)
  for (const d of start.devices)
    for (const svc of d.services ?? []) {
      const id = idOf(d.name)
      if (svc.startType) apply(command('service.setStartType', id, svc.name, svc.startType))
      apply(command(svc.running ? 'service.start' : 'service.stop', id, svc.name))
    }
  // Horloges décalées : après la jonction, qui exige des horloges à l'heure
  for (const d of start.devices)
    if (d.clockOffsetSeconds) apply(command('host.setClock', idOf(d.name), d.clockOffsetSeconds))
  for (const d of start.devices)
    if (d.adminAccess?.length) apply(command('cyber.setAdminAccess', idOf(d.name), d.adminAccess.map(idOf)))
  if (start.cyber) apply(command('cyber.configure', start.cyber as CyberConfigPatch))
  return state
}

export interface LabProgress {
  results: CriterionResult[]
  passed: number
  total: number
}

/** Vérifie la progression d'un lab sur l'état courant. */
export function checkLab(state: LabState, lab: LabDefinition): LabProgress {
  const results = evaluateCriteria(state, lab.criteria)
  return { results, passed: results.filter((r) => r.ok).length, total: results.length }
}
