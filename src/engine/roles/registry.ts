/**
 * Registre unique des modules de rôles. Installation des fonctionnalités, catalogue des cmdlets
 * et outils, critères de lab, tâches de fond, vues et commandes en sont dérivés.
 *
 * Ajouter un rôle : créer `roles/<rôle>/index.ts` (voir `types.ts`) et l'ajouter à `load()`,
 * après les rôles dont il dépend.
 *
 * Le registre est construit à la première lecture : un module de rôle peut ainsi importer
 * n'importe quelle partie du cœur, même une partie qui lit le registre, quel que soit l'ordre
 * de chargement des modules.
 */
import { adcsRole } from './adcs'
import { addsRole } from './adds'
import { backupRole } from './backup'
import { dfsRole } from './dfs'
import { dhcpRole } from './dhcp'
import { dnsRole } from './dns'
import { filesRole } from './files'
import { gpoRole } from './gpo'
import { hypervRole } from './hyperv'
import { iisRole } from './iis'
import { npsRole } from './nps'
import { rdsRole } from './rds'
import { rrasRole } from './rras'
import { wsusRole } from './wsus'
import type { BackgroundTask, CriterionType, FeatureInfo, RoleModule, RoleView } from './types'

/** Modules dans l'ordre d'exécution (dépendances d'abord : DHCP avant les stratégies de groupe). */
const load = () =>
  [
    dnsRole,
    dhcpRole,
    addsRole,
    gpoRole,
    filesRole,
    wsusRole,
    iisRole,
    rdsRole,
    hypervRole,
    adcsRole,
    dfsRole,
    backupRole,
    npsRole,
    rrasRole
  ] as const

export type RoleModules = ReturnType<typeof load>

let modules: RoleModules | null = null

/** Modules de rôles enregistrés. */
export function roleModules(): RoleModules {
  return (modules ??= load())
}

export function roleModule(id: string): RoleModule | undefined {
  return roleModules().find((m) => m.id === id)
}

/** Fonctionnalités du système de base (présentes sans rôle). */
const CORE_FEATURES: FeatureInfo[] = [{ name: 'PowerShell', displayName: 'PowerShell 5.1', role: false }]

let features: FeatureInfo[] | null = null

/**
 * Catalogue des rôles et fonctionnalités, trié comme Get-WindowsFeature : par nom de la
 * fonctionnalité racine, chaque parent suivi de ses enfants.
 */
export function allFeatures(): FeatureInfo[] {
  if (features) return features
  const list = [...CORE_FEATURES, ...roleModules().flatMap((m) => m.features)]
  // Fonctionnalité racine (en remontant les parents : Web-Mgmt-Console → Web-Mgmt-Tools → Web-Server)
  const rootOf = (f: FeatureInfo): string => {
    let current = f
    for (let depth = 0; current.parent && depth < 8; depth++)
      current = list.find((x) => x.name === current.parent) ?? { ...current, parent: undefined }
    return current.name.toLowerCase()
  }
  features = list
    .map((f, index) => ({ f, index }))
    .sort((a, b) => {
      const byRoot = rootOf(a.f).localeCompare(rootOf(b.f))
      if (byRoot !== 0) return byRoot
      // Parent avant ses enfants, puis ordre de déclaration
      return Number(!!a.f.parent) - Number(!!b.f.parent) || a.index - b.index
    })
    .map(({ f }) => f)
  return features
}

export function featureInfo(name: string): FeatureInfo | undefined {
  const lower = name.toLowerCase()
  return allFeatures().find((f) => f.name.toLowerCase() === lower)
}

/** Module qui apporte une fonctionnalité. */
export function roleOfFeature(name: string): RoleModule | undefined {
  const lower = name.toLowerCase()
  return roleModules().find((m) => m.features.some((f) => f.name.toLowerCase() === lower))
}

export function roleCriteria(): CriterionType[] {
  return roleModules().flatMap((m) => m.criteria)
}

export function roleBackgroundTasks(): BackgroundTask[] {
  return roleModules().flatMap((m) => m.backgroundTasks)
}

export function roleViews(): (RoleView & { role: string })[] {
  return roleModules().flatMap((m) => m.views.map((v) => ({ ...v, role: m.id })))
}

/** Service système simulé d'un ordinateur (Gestionnaire de serveur > Services, net start, sc query). */
export interface HostService {
  display: string
  name: string
  /** Fonctionnalité du rôle qui apporte le service (absent : service du système). */
  role?: string
}

/** Services du système toujours présents (comme dans le Gestionnaire de serveur). */
const SYSTEM_SERVICES: HostService[] = [
  { display: 'Client DHCP', name: 'Dhcp' },
  { display: 'Client DNS', name: 'Dnscache' },
  { display: 'Journal d’événements', name: 'EventLog' },
  { display: 'Pare-feu', name: 'MpsSvc' },
  { display: 'Station de travail', name: 'LanmanWorkstation' }
]

/**
 * Services d'un ordinateur : ceux du système, puis ceux déclarés par les rôles installés
 * (`when`), triés par nom affiché. Tous sont considérés démarrés (état non simulé).
 */
export function hostServices(features: readonly string[], domainController: boolean): HostService[] {
  const fromRoles = roleModules().flatMap((m) =>
    m.services
      .filter((s) =>
        s.when === 'always' ? true : s.when === 'installed' ? features.includes(m.feature) : domainController
      )
      .map((s) => ({ display: s.display, name: s.name, role: m.feature }))
  )
  return [...SYSTEM_SERVICES, ...fromRoles].sort((a, b) => a.display.localeCompare(b.display, 'fr'))
}
