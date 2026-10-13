/**
 * Migrations du format .slab : chaque fichier de référence (fixtures/vN.slab, produit par le code
 * de la version N) doit toujours s'ouvrir, migrer jusqu'au format courant et rester utilisable.
 */
import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  listScenarios,
  scenariosOf,
  CURRENT_SCHEMA_VERSION,
  DEFAULT_DC_POLICY_ID,
  DEFAULT_DOMAIN_POLICY_ID,
  evaluateCheck,
  migrateDocument,
  migrations,
  parseSlab,
  processGroupPolicy,
  serializeSlab,
  type LabState,
  type SlabDocument
} from '@engine/index'
import { fixtureUrl, readFixture } from './fixtures'
import { REFERENCE_SAVED_AT } from './reference-lab'

const VERSIONS = Array.from({ length: CURRENT_SCHEMA_VERSION }, (_, i) => i + 1)

function open(version: number): SlabDocument {
  const parsed = parseSlab(readFixture(version))
  if (!parsed.ok) throw new Error(`v${version}.slab : ${parsed.message}`)
  return parsed.doc
}

const deviceId = (lab: LabState, name: string) =>
  Object.values(lab.devices).find((d) => d.name === name)?.id ?? ''

describe('fichiers .slab de référence', () => {
  it('un fichier de référence existe pour chaque version du format', () => {
    for (const v of VERSIONS)
      expect(
        existsSync(fixtureUrl(v)),
        `fixtures/v${v}.slab manquant : générez-le avec « npm run fixture:slab » (voir CLAUDE.md)`
      ).toBe(true)
  })

  it('chaque migration est déclarée (n → n + 1)', () => {
    for (const v of VERSIONS.slice(0, -1))
      expect(migrations[v], `migration ${v} → ${v + 1}`).toBeTypeOf('function')
  })

  for (const version of VERSIONS) {
    describe(`v${version}.slab`, () => {
      it('est bien un fichier de sa version, jamais régénéré', () => {
        const raw = JSON.parse(readFixture(version)) as { schemaVersion: number; savedAt: string }
        expect(raw.schemaVersion).toBe(version)
        expect(raw.savedAt).toBe(REFERENCE_SAVED_AT)
      })

      it('s’ouvre, migre jusqu’au format courant et conserve le lab', () => {
        const doc = open(version)
        expect(doc.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
        expect(doc.meta.labId).toBe('')
        expect(doc.ui.viewport).toEqual({ x: 0, y: 0, zoom: 1 })
        const lab = doc.lab
        expect(
          Object.values(lab.devices)
            .map((d) => d.name)
            .sort()
        ).toEqual(
          version >= 9
            ? ['CR1', 'CSW1', 'PC1', 'PC2', 'R1', 'SRV1', 'SW1']
            : ['PC1', 'PC2', 'R1', 'SRV1', 'SW1']
        )
        expect(Object.keys(lab.links)).toHaveLength(version >= 9 ? 5 : 4)
        const domain = lab.domains['lab.local']
        expect(domain?.users.map((u) => u.sam)).toContain('jdupont')
        expect(domain?.groups.find((g) => g.name === 'GG_Compta')?.members).toHaveLength(1)
        // Stratégies par défaut présentes (ajoutées par la migration 1 → 2 pour un fichier v1)
        expect(domain?.gpos.map((g) => g.id)).toEqual(
          expect.arrayContaining([DEFAULT_DOMAIN_POLICY_ID, DEFAULT_DC_POLICY_ID])
        )
      })

      it('reste utilisable : réseau, DNS, domaine et stratégies de groupe', () => {
        const lab = open(version).lab
        expect(evaluateCheck(lab, { type: 'ping', from: 'PC2', to: '192.168.10.1' })).toBe(true)
        expect(
          evaluateCheck(lab, {
            type: 'nslookup',
            client: 'PC2',
            name: 'intranet.lab.local',
            address: '192.168.10.1'
          })
        ).toBe(true)
        expect(evaluateCheck(lab, { type: 'domainJoined', device: 'PC1', domain: 'lab.local' })).toBe(true)
        expect(evaluateCheck(lab, { type: 'dhcpLease', client: 'PC1', server: 'SRV1' })).toBe(true)
        const gp = processGroupPolicy(lab, deviceId(lab, 'PC1'), { computer: true, user: false })
        expect(gp.error).toBeNull()
        expect(gp.computer).toBe('ok')
        expect(
          evaluateCheck(gp.state, {
            type: 'gpoApplied',
            device: 'PC1',
            gpo: 'Default Domain Policy',
            part: 'computer'
          })
        ).toBe(true)
      })

      it('se réenregistre au format courant sans perte', () => {
        const doc = open(version)
        const again = parseSlab(serializeSlab(doc.lab, { savedAt: REFERENCE_SAVED_AT, appVersion: 'test' }))
        expect(again.ok && again.doc.lab).toEqual(doc.lab)
      })
    })
  }
})

describe('migration 1 → 2 (stratégies de groupe par défaut)', () => {
  const v1 = () => JSON.parse(readFixture(1)) as Record<string, unknown>
  const domainOf = (doc: Record<string, unknown>) =>
    (doc['lab'] as { domains: Record<string, Record<string, unknown>> }).domains['lab.local']!

  it('ajoute les deux GPO par défaut et leurs liaisons', () => {
    const migrated = migrations[1]!(v1())
    expect(migrated['schemaVersion']).toBe(2)
    const domain = domainOf(migrated)
    expect((domain['gpos'] as { id: string }[]).map((g) => g.id)).toEqual([
      DEFAULT_DOMAIN_POLICY_ID,
      DEFAULT_DC_POLICY_ID
    ])
    expect(domain['gpLinks']).toEqual([{ gpoId: DEFAULT_DOMAIN_POLICY_ID, enabled: true, enforced: false }])
    const dcs = (domain['containers'] as Record<string, unknown>[]).find(
      (c) => c['name'] === 'Domain Controllers' && c['parentId'] === null
    )
    expect(dcs?.['gpLinks']).toEqual([{ gpoId: DEFAULT_DC_POLICY_ID, enabled: true, enforced: false }])
  })

  it('ne touche pas un domaine qui a déjà des GPO', () => {
    const doc = v1()
    const domain = domainOf(doc)
    domain['gpos'] = []
    domain['gpLinks'] = []
    const migrated = domainOf(migrations[1]!(doc))
    expect(migrated['gpos']).toEqual([])
    expect(migrated['gpLinks']).toEqual([])
  })

  it('accepte un lab sans domaine ni conteneur', () => {
    const doc = v1()
    ;(doc['lab'] as Record<string, unknown>)['domains'] = { 'vide.local': { name: 'vide.local' } }
    const migrated = migrations[1]!(doc)
    expect(migrated['schemaVersion']).toBe(2)
  })
})

describe('migration 2 → 3 (identifiant du lab pédagogique)', () => {
  it('ajoute un identifiant vide et conserve un identifiant existant', () => {
    const doc = JSON.parse(readFixture(2)) as Record<string, unknown>
    expect(migrations[2]!(doc)['meta']).toMatchObject({ labId: '' })
    const withId = { ...doc, meta: { labId: 'lab-01-adressage' } }
    expect(migrations[2]!(withId)['meta']).toMatchObject({ labId: 'lab-01-adressage' })
  })
})

describe('migration 3 → 4 (données des rôles génériques)', () => {
  type RawDevice = Record<string, unknown> & { name: string; kind: string }
  const devicesOf = (doc: Record<string, unknown>) =>
    Object.values((doc['lab'] as { devices: Record<string, RawDevice> }).devices)

  it('déplace services.dhcp / services.dns vers roles et retire services', () => {
    const migrated = migrations[3]!(JSON.parse(readFixture(3)) as Record<string, unknown>)
    expect(migrated['schemaVersion']).toBe(4)
    const srv = devicesOf(migrated).find((d) => d.name === 'SRV1')!
    expect(srv['services']).toBeUndefined()
    expect(Object.keys(srv['roles'] as object).sort()).toEqual(['dhcp', 'dns'])
    expect((srv['roles'] as { dhcp: { authorized: boolean } }).dhcp.authorized).toBe(true)
    // Les autres équipements ne portent pas de données de rôles
    expect(devicesOf(migrated).filter((d) => 'roles' in d)).toHaveLength(1)
  })

  it('un rôle jamais installé (null) ne crée pas d’entrée ; des données déjà migrées sont conservées', () => {
    const doc = JSON.parse(readFixture(3)) as Record<string, unknown>
    const srv = devicesOf(doc).find((d) => d.name === 'SRV1')!
    srv['services'] = { dhcp: null, dns: { zones: [] } }
    srv['roles'] = { dns: { zones: [], forwarders: ['1.1.1.1'] } }
    const migrated = devicesOf(migrations[3]!(doc)).find((d) => d.name === 'SRV1')!
    expect(migrated['roles']).toEqual({ dns: { zones: [], forwarders: ['1.1.1.1'] } })
  })
})

describe('migration 4 → 5 (rôles et stratégies de la v2.1)', () => {
  it('change seulement la version ; les paramètres Windows Update reçoivent leurs valeurs par défaut', () => {
    const doc = JSON.parse(readFixture(4)) as Record<string, unknown>
    const migrated = migrations[4]!(doc)
    expect(migrated).toEqual({ ...doc, schemaVersion: 5 })
    const parsed = parseSlab(readFixture(4))
    const gpo = parsed.ok ? Object.values(parsed.doc.lab.domains)[0]?.gpos[0] : undefined
    expect(gpo?.computer.wuServer).toEqual({ state: 'NotConfigured', url: '' })
    expect(gpo?.computer.wuTargetGroup).toEqual({ state: 'NotConfigured', group: '' })
  })
})

describe('migration 5 → 6 (VLAN et réseau de la v2.2)', () => {
  it('change seulement la version ; switchs et ports reçoivent la configuration par défaut', () => {
    const doc = JSON.parse(readFixture(5)) as Record<string, unknown>
    const migrated = migrations[5]!(doc)
    expect(migrated).toEqual({ ...doc, schemaVersion: 6 })
    const parsed = parseSlab(readFixture(5))
    const sw = parsed.ok ? Object.values(parsed.doc.lab.devices).find((d) => d.kind === 'switch') : undefined
    expect(sw?.kind === 'switch' && sw.vlans).toEqual([{ id: 1, name: 'default' }])
    expect(sw?.interfaces.every((i) => i.switchport === undefined && i.subinterface === undefined)).toBe(true)
  })

  it('le fichier v6 conserve le VLAN 20, le trunk et la sous-interface du routeur', () => {
    const parsed = parseSlab(readFixture(6))
    if (!parsed.ok) throw new Error(parsed.message)
    const lab = parsed.doc.lab
    const sw = lab.devices[deviceId(lab, 'SW1')]
    expect(sw?.kind === 'switch' && sw.vlans.map((v) => v.name)).toEqual(['default', 'Compta'])
    expect(sw?.interfaces.map((i) => i.switchport?.mode ?? '-').slice(0, 5)).toEqual([
      '-',
      '-',
      '-',
      'trunk',
      'access'
    ])
    const sub = lab.devices[deviceId(lab, 'R1')]?.interfaces.find((i) => i.name === 'Gi0/0.20')
    expect(sub?.subinterface?.vlan).toBe(20)
    expect(sub?.address).toBe('192.168.20.254')
  })
})

describe('validation des données de rôles', () => {
  const withRoles = (roles: unknown) => {
    const doc = JSON.parse(readFixture(4)) as { lab: { devices: Record<string, RawDevice> } }
    const srv = Object.values(doc.lab.devices).find((d) => d.name === 'SRV1')!
    srv['roles'] = roles
    return JSON.stringify(doc)
  }
  type RawDevice = Record<string, unknown> & { name: string }

  it('applique les valeurs par défaut du schéma déclaré par le module', () => {
    const parsed = parseSlab(withRoles({ dhcp: {} }))
    expect(parsed.ok).toBe(true)
    const srv = parsed.ok ? Object.values(parsed.doc.lab.devices).find((d) => d.name === 'SRV1') : undefined
    expect(srv?.kind === 'server' && srv.roles['dhcp']).toEqual({
      authorized: false,
      configured: false,
      scopes: [],
      serverOptions: { router: [], dnsServers: [], dnsDomain: null }
    })
  })

  it('refuse des données invalides ou un rôle inconnu, avec le champ en cause', () => {
    const invalid = parseSlab(withRoles({ dhcp: { scopes: 'x' } }))
    expect(invalid.ok === false && invalid.message).toMatch(/champ lab\.devices\.[^.]+\.roles\.dhcp\.scopes/)
    const unknown = parseSlab(withRoles({ inconnu: {} }))
    expect(unknown.ok === false && unknown.message).toContain('rôle inconnu « inconnu »')
  })
})

describe('migrateDocument', () => {
  it('refuse un numéro de version absent ou invalide', () => {
    for (const schemaVersion of [undefined, 0, 1.5, '2'])
      expect(migrateDocument({ app: 'ServerLab', schemaVersion }).ok).toBe(false)
  })
})

describe('migration 6 → 7 (sécurité de la v2.3)', () => {
  it('change seulement la version ; comptes et ordinateurs reçoivent les valeurs par défaut', () => {
    const doc = JSON.parse(readFixture(6)) as Record<string, unknown>
    expect(migrations[6]!(doc)).toEqual({ ...doc, schemaVersion: 7 })
    const parsed = parseSlab(readFixture(6))
    if (!parsed.ok) throw new Error(parsed.message)
    const user = parsed.doc.lab.domains['lab.local']?.users.find((u) => u.sam === 'jdupont')
    expect(user && [user.passwordNeverExpires, user.lastLogon, user.whenCreated]).toEqual([false, null, 0])
    const srv = parsed.doc.lab.devices[deviceId(parsed.doc.lab, 'SRV1')]
    expect(srv?.kind === 'server' && srv.host.smb1).toBe(false)
  })
})

describe('migration 7 → 8 (postes Linux de la v2.4)', () => {
  it('change seulement la version ; les ordinateurs existants sont des ordinateurs Windows sans montage', () => {
    const doc = JSON.parse(readFixture(7)) as Record<string, unknown>
    expect(migrations[7]!(doc)).toEqual({ ...doc, schemaVersion: 8 })
    const parsed = parseSlab(readFixture(7))
    if (!parsed.ok) throw new Error(parsed.message)
    for (const name of ['SRV1', 'PC1', 'PC2']) {
      const d = parsed.doc.lab.devices[deviceId(parsed.doc.lab, name)]
      expect(d && (d.kind === 'server' || d.kind === 'client') && [d.host.os, d.host.mounts]).toEqual([
        'windows',
        []
      ])
    }
  })
})

describe('migration 8 → 9 (équipements Cisco IOS de la v2.5)', () => {
  it('change seulement la version ; les routeurs et switchs existants restent des équipements génériques', () => {
    const doc = JSON.parse(readFixture(8)) as Record<string, unknown>
    expect(migrations[8]!(doc)).toEqual({ ...doc, schemaVersion: 9 })
    const parsed = parseSlab(readFixture(8))
    if (!parsed.ok) throw new Error(parsed.message)
    for (const name of ['R1', 'SW1']) {
      const d = parsed.doc.lab.devices[deviceId(parsed.doc.lab, name)]
      expect(d && 'model' in d ? d.model : undefined).toBeUndefined()
      expect(d && 'ios' in d ? d.ios : undefined).toBeUndefined()
    }
  })

  it('v9.slab : la configuration IOS enregistrée est restituée', () => {
    const lab = open(9).lab
    const cr1 = lab.devices[deviceId(lab, 'CR1')]
    const csw1 = lab.devices[deviceId(lab, 'CSW1')]
    expect(cr1 && 'model' in cr1 && cr1.model).toBe('c1921')
    expect(csw1 && 'model' in csw1 && csw1.model).toBe('c2960')
    expect(
      evaluateCheck(lab, { type: 'iosRunning', device: 'CR1', line: 'standby 1 ip 192.168.30.254' })
    ).toBe(true)
    expect(evaluateCheck(lab, { type: 'iosStartup', device: 'CR1' })).toBe(true)
    expect(evaluateCheck(lab, { type: 'iosStartup', device: 'CSW1' })).toBe(true)
    expect(
      evaluateCheck(lab, { type: 'switchport', device: 'CSW1', port: 'Fa0/2', mode: 'access', vlan: 30 })
    ).toBe(true)
  })
})

describe('migration 9 → 10 (cybersécurité défensive de la v2.6)', () => {
  it('change seulement la version ; un switch IOS de la v9 n’a aucune sécurité L2 active', () => {
    const doc = JSON.parse(readFixture(9)) as Record<string, unknown>
    expect(migrations[9]!(doc)).toEqual({ ...doc, schemaVersion: 10 })
    const lab = open(9).lab
    expect(
      evaluateCheck(lab, {
        type: 'iosRunning',
        device: 'CSW1',
        line: 'ip dhcp snooping',
        match: 'exact',
        present: true
      })
    ).toBe(false)
  })

  it('v10.slab : DHCP snooping, inspection ARP et nonegotiate restitués', () => {
    const lab = open(10).lab
    for (const line of [
      'ip dhcp snooping',
      'ip dhcp snooping vlan 30',
      'ip arp inspection vlan 30',
      'switchport nonegotiate',
      'ip dhcp snooping trust'
    ])
      expect(
        evaluateCheck(lab, { type: 'iosRunning', device: 'CSW1', line, match: 'exact', present: true }),
        line
      ).toBe(true)
    expect(evaluateCheck(lab, { type: 'iosStartup', device: 'CSW1', line: 'ip arp inspection trust' })).toBe(
      true
    )
  })
})

describe('migration 15 → 16 (logging synchronous de la v2.7)', () => {
  const lines = (lab: ReturnType<typeof open>['lab']) =>
    Object.values(lab.devices)
      .filter((d) => d.name === 'CR1')
      .flatMap((d) => (d as { ios?: { lines: { loggingSync: boolean }[] } }).ios?.lines ?? [])

  it('change seulement la version ; logging synchronous désactivé par défaut', () => {
    const doc = JSON.parse(readFixture(15)) as Record<string, unknown>
    expect(migrations[15]!(doc)).toEqual({ ...doc, schemaVersion: 16 })
    expect(lines(open(15).lab).every((l) => !l.loggingSync)).toBe(true)
  })

  it('v16.slab : s’ouvre sans migration et garde logging synchronous', () => {
    expect(lines(open(16).lab).some((l) => l.loggingSync)).toBe(true)
  })
})

describe('migration 14 → 15 (journalisation des ACL IOS de la v2.7)', () => {
  const entries = (lab: ReturnType<typeof open>['lab']) =>
    Object.values(lab.devices)
      .filter((d) => d.name === 'CR1')
      .flatMap((d) => (d as { ios?: { acls: { entries: { log: string | null }[] }[] } }).ios?.acls ?? [])
      .flatMap((a) => a.entries)

  it('change seulement la version ; les entrées existantes ne sont pas journalisées', () => {
    const doc = JSON.parse(readFixture(14)) as Record<string, unknown>
    expect(migrations[14]!(doc)).toEqual({ ...doc, schemaVersion: 15 })
    const old = entries(open(14).lab)
    expect(old.length).toBeGreaterThan(0)
    expect(old.every((e) => e.log === null)).toBe(true)
  })

  it('v15.slab : s’ouvre sans migration et garde « log »', () => {
    expect(entries(open(15).lab).some((e) => e.log === 'log')).toBe(true)
  })
})

describe('migration 13 → 14 (labs de cybersécurité de la v2.6.1)', () => {
  it('change seulement la version ; scénarios, durcissement et camp de l’IA prennent leurs valeurs par défaut', () => {
    const doc = JSON.parse(readFixture(13)) as Record<string, unknown>
    expect(migrations[13]!(doc)).toEqual({ ...doc, schemaVersion: 14 })
    const { cyber } = open(13).lab
    expect(cyber.scenarios).toBeNull()
    expect(cyber.hardening).toEqual({ lockoutThreshold: 3, lockoutMinutes: 30 })
    expect(cyber.game.aiSide).toBeNull()
  })

  it('v14.slab : s’ouvre sans migration', () => {
    expect(open(14).lab.cyber.hardening.lockoutThreshold).toBe(3)
  })

  it('un lab de la v13 reste jouable : tous les scénarios sont activés', () => {
    expect(scenariosOf(open(13).lab).map((sc) => sc.id)).toEqual(listScenarios().map((sc) => sc.id))
  })
})

describe('migration 12 → 13 (mode Red/Blue de la v2.6.1)', () => {
  it('change seulement la version ; réglages de partie par défaut', () => {
    const doc = JSON.parse(readFixture(12)) as Record<string, unknown>
    expect(migrations[12]!(doc)).toEqual({ ...doc, schemaVersion: 13 })
    expect(open(12).lab.cyber.game).toMatchObject({ maxTurns: 8, timerSeconds: null, blueBudget: 3 })
  })

  it('v13.slab : s’ouvre sans migration', () => {
    expect(open(13).lab.cyber.game.maxTurns).toBe(8)
  })
})

describe('migration 11 → 12 (scénarios réseau de la v2.6.1)', () => {
  it('change seulement la version ; ports et journal IOS prennent leurs valeurs par défaut', () => {
    const doc = JSON.parse(readFixture(11)) as Record<string, unknown>
    expect(migrations[11]!(doc)).toEqual({ ...doc, schemaVersion: 12 })
    const lab = open(11).lab
    expect(lab.cyber).toMatchObject({ arpSpoof: null, vlanHop: null, intercepts: [] })
    const sw = Object.values(lab.devices).find((d) => d.name === 'CSW1')!
    expect(sw.kind === 'switch' && sw.ios?.syslog).toEqual([])
    expect(sw.interfaces.every((p) => (p.switchport?.hoppedVlan ?? null) === null)).toBe(true)
  })

  it('v12.slab : s’ouvre sans migration', () => {
    expect(open(12).lab.cyber.intercepts).toEqual([])
  })
})

describe('migration 10 → 11 (scénarios de cybersécurité de la v2.6.1)', () => {
  it('change seulement la version ; les défauts du schéma décrivent un lab sans faiblesse déclarée', () => {
    const doc = JSON.parse(readFixture(10)) as Record<string, unknown>
    expect(migrations[10]!(doc)).toEqual({ ...doc, schemaVersion: 11 })
    const lab = open(10).lab
    expect(lab.cyber).toMatchObject({ targetAccount: null, attempts: 5, serviceMaxAgeDays: 90 })
    const user = Object.values(lab.domains)[0]!.users[0]!
    expect(user).toMatchObject({ spns: [], passwordLastSet: 0, compromised: false })
  })

  it('v11.slab : s’ouvre sans migration', () => {
    expect(open(11).lab.cyber.serviceMaxAgeDays).toBe(90)
  })
})
