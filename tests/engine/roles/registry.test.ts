/**
 * Registre des modules de rôles : cohérence des déclarations et dérivations (fonctionnalités,
 * cmdlets, commandes, critères, tâches de fond, vues).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  addScope,
  allFeatures,
  autoConfigureDhcp,
  autoGroupPolicy,
  commandDefinitions,
  createLab,
  criterionTypes,
  featureInfo,
  installFeatures,
  roleModules,
  roleOfFeature,
  roleViews,
  runBackgroundTasks,
  uninstallFeatures,
  unwrap,
  viewAvailable,
  type ServerDevice
} from '@engine/index'
import { shellCatalog } from '../../../src/engine/shell/catalog'
import { build, cable, setIp } from '../helpers'
import { run } from '../shell/helpers'

const duplicates = (list: string[]) => list.filter((x, i) => list.indexOf(x) !== i)

describe('registre des rôles', () => {
  it('déclare chaque rôle une fois, après les rôles dont il dépend', () => {
    const ids = roleModules().map((m) => m.id)
    expect(ids).toEqual([
      'dns',
      'dhcp',
      'adds',
      'gpo',
      'files',
      'wsus',
      'iis',
      'rds',
      'hyperv',
      'adcs',
      'dfs',
      'backup',
      'nps',
      'rras'
    ])
    roleModules().forEach((m, index) => {
      for (const dep of m.dependencies) expect(ids.indexOf(dep), `${m.id} → ${dep}`).toBeLessThan(index)
      expect(
        m.features.some((f) => f.name === m.feature),
        m.id
      ).toBe(true)
      if (m.state)
        expect(
          m.features.some((f) => f.name === m.state?.feature),
          m.id
        ).toBe(true)
    })
  })

  it('catalogue des fonctionnalités : ordre de Get-WindowsFeature, références valides', () => {
    expect(allFeatures().map((f) => f.name)).toEqual([
      'AD-Certificate',
      'ADCS-Cert-Authority',
      'AD-Domain-Services',
      'DHCP',
      'DNS',
      'FileAndStorage-Services',
      'FS-FileServer',
      'FS-DFS-Namespace',
      'FS-DFS-Replication',
      'GPMC',
      'Hyper-V',
      'NPAS',
      'PowerShell',
      'Remote-Desktop-Services',
      'RDS-RD-Server',
      'RDS-Connection-Broker',
      'RDS-Web-Access',
      'RemoteAccess',
      'DirectAccess-VPN',
      'Routing',
      'RSAT-AD-Tools',
      'RSAT-AD-PowerShell',
      'RSAT-ADDS',
      'RSAT-ADCS',
      'RSAT-ADCS-Mgmt',
      'RSAT-DFS-Mgmt-Con',
      'RSAT-DHCP',
      'RSAT-DNS-Server',
      'RSAT-Hyper-V-Tools',
      'Hyper-V-Tools',
      'Hyper-V-PowerShell',
      'RSAT-NPAS',
      'RSAT-RDS-Tools',
      'RSAT-RemoteAccess',
      'UpdateServices',
      'UpdateServices-WidDB',
      'UpdateServices-Services',
      'UpdateServices-RSAT',
      'UpdateServices-API',
      'UpdateServices-UI',
      'Web-Server',
      'Web-WebServer',
      'Web-Mgmt-Tools',
      'Web-Mgmt-Console',
      'Windows-Server-Backup'
    ])
    for (const f of allFeatures()) {
      for (const ref of [
        ...(f.requires ?? []),
        ...(f.managementTools ?? []),
        ...(f.parent ? [f.parent] : [])
      ])
        expect(featureInfo(ref), `${f.name} → ${ref}`).toBeDefined()
    }
    expect(roleOfFeature('rsat-dhcp')?.id).toBe('dhcp')
    expect(roleOfFeature('PowerShell')).toBeUndefined()
  })

  it('noms uniques : commandes, cmdlets, outils, critères, vues', () => {
    const commandNames = roleModules().flatMap((m) => Object.keys(m.commands))
    expect(duplicates(commandNames)).toEqual([])
    for (const name of commandNames) expect(commandDefinitions()[name], name).toBeDefined()

    const catalog = shellCatalog()
    expect(duplicates(catalog.cmdlets.map((c) => c.name.toLowerCase()))).toEqual([])
    expect(duplicates(catalog.tools.map((t) => t.name.toLowerCase()))).toEqual([])
    for (const m of roleModules()) {
      for (const c of m.cmdlets) expect(catalog.cmdlets).toContain(c)
      for (const t of m.tools) expect(catalog.tools).toContain(t)
    }

    const criteria = roleModules().flatMap((m) => m.criteria.map((c) => c.type))
    expect(duplicates(criteria)).toEqual([])
    for (const type of criteria) expect(criterionTypes().has(type)).toBe(true)
    expect(criterionTypes().has('ping')).toBe(true)

    expect(duplicates(roleViews().map((v) => v.app))).toEqual([])
  })

  it('installer un rôle crée son état initial déclaré par le module', () => {
    const { state, ids } = build([['server', 'SRV1']])
    // Fonctionnalité de chaque module qui déclare un état
    const features = roleModules().flatMap((m) => (m.state ? [m.state.feature] : []))
    const s = unwrap(installFeatures(state, ids.SRV1!, features)).state
    const srv = s.devices[ids.SRV1!] as ServerDevice
    for (const m of roleModules().filter((r) => r.state)) {
      expect(srv.roles[m.state!.key]).toEqual(m.state!.create())
    }
  })

  it('le module AD DS refuse sa désinstallation sur un contrôleur de domaine', () => {
    const { state, ids } = build([['server', 'SRV1']])
    let s = setIp(state, ids.SRV1!, 0, '192.168.1.1/24')
    s = unwrap(installFeatures(s, ids.SRV1!, ['AD-Domain-Services'], { includeManagementTools: true })).state
    s = run(s, ids.SRV1!, 'Install-ADDSForest -DomainName lab.local -InstallDns', {
      answers: ['P@ssw0rd!', 'P@ssw0rd!', 'O']
    }).state
    const r = uninstallFeatures(s, ids.SRV1!, ['AD-Domain-Services'])
    expect(r.ok === false && r.error.code).toBe('DcRoleRemoval')
    expect(uninstallFeatures(s, ids.SRV1!, ['DHCP']).ok).toBe(true)
  })

  it('tâches de fond : bail DHCP puis stratégies de groupe, dans l’ordre du registre', () => {
    const { state, ids } = build([
      ['server', 'SRV1'],
      ['client', 'PC1'],
      ['switch', 'SW1']
    ])
    let s = cable(state, ids.SRV1!, 0, ids.SW1!, 0)
    s = cable(s, ids.PC1!, 0, ids.SW1!, 1)
    s = setIp(s, ids.SRV1!, 0, '192.168.1.1/24')
    s = unwrap(installFeatures(s, ids.SRV1!, ['DHCP'])).state
    s = unwrap(
      addScope(s, ids.SRV1!, {
        name: 'LAN',
        start: '192.168.1.100',
        end: '192.168.1.200',
        mask: '255.255.255.0'
      })
    ).state
    const expected = autoGroupPolicy(autoConfigureDhcp(s).state).state
    const result = runBackgroundTasks(s)
    expect(result.state).toEqual(expected)
    expect(result.state.devices[ids.PC1!]!.interfaces[0]!.dhcpLease?.address).toBe('192.168.1.100')
    // Point fixe : un second passage ne change rien
    expect(runBackgroundTasks(result.state).state).toBe(result.state)
  })

  it('vues : disponibilité selon fonctionnalité, domaine et type d’ordinateur', () => {
    const { state, ids } = build([
      ['server', 'SRV1'],
      ['client', 'PC1']
    ])
    const s = unwrap(installFeatures(state, ids.SRV1!, ['DHCP'], { includeManagementTools: true })).state
    const srv = s.devices[ids.SRV1!] as ServerDevice
    const pc = s.devices[ids.PC1!]
    const view = (app: string) => roleViews().find((v) => v.app === app)!
    expect(viewAvailable(view('dhcp'), srv)).toBe(true)
    expect(viewAvailable(view('dns'), srv)).toBe(false)
    expect(viewAvailable(view('aduc'), srv)).toBe(false)
    expect(pc?.kind === 'client' && viewAvailable(view('dhcppost'), pc)).toBe(false)
  })

  it('tout module chargé en premier laisse le registre complet (imports circulaires)', async () => {
    for (const entry of [
      'dhcp',
      'dns',
      'adds',
      'gpo',
      'files',
      'wsus',
      'iis',
      'rds',
      'hyperv',
      'adcs',
      'dfs',
      'backup',
      'nps',
      'rras'
    ]) {
      vi.resetModules()
      await import(`../../../src/engine/roles/${entry}/index.ts`)
      const registry = await import('../../../src/engine/roles/registry')
      expect(
        registry.roleModules().every((m) => m && m.id),
        entry
      ).toBe(true)
      const { commandDefinitions: defs } = await import('../../../src/engine/commands/catalog')
      expect(Object.keys(defs()).length).toBe(Object.keys(commandDefinitions()).length)
    }
    expect(createLab().devices).toEqual({})
  })
})

describe('dépendances réelles entre rôles (audit A-01)', () => {
  const base = join(__dirname, '../../../src/engine/roles')
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []
    )

  /** Rôles dont le code d'un rôle importe un module (chemins relatifs vers un autre dossier de rôle). */
  function importedRoles(id: string, ids: string[]): string[] {
    const found = new Set<string>()
    for (const file of files(join(base, id))) {
      for (const m of readFileSync(file, 'utf8').matchAll(/from '(\.{1,2}\/[^']+)'/g)) {
        const target = relative(base, resolve(dirname(file), m[1]!)).split(sep)[0]!
        if (target !== id && ids.includes(target)) found.add(target)
      }
    }
    return [...found].sort()
  }

  it('tout import d’un autre rôle est déclaré (dependencies ou uses), sans déclaration superflue', () => {
    const ids = roleModules().map((m) => m.id)
    for (const m of roleModules()) {
      const imported = importedRoles(m.id, ids)
      const declared = new Set([...m.dependencies, ...(m.uses ?? [])])
      expect(
        imported.filter((r) => !declared.has(r)),
        `${m.id} : imports non déclarés`
      ).toEqual([])
      expect(
        (m.uses ?? []).filter((r) => !imported.includes(r)),
        `${m.id} : uses sans import`
      ).toEqual([])
    }
  })
})
