/**
 * Fabriques d'arguments valides pour les commandes nommées du catalogue (src/engine/commands).
 *
 * Trois niveaux :
 *  - générique : les noms des paramètres de l'action (lus dans `run.toString()`) désignent la
 *    nature de l'argument (`deviceId`, `domainName`, `enabled`…) ; la valeur est tirée de l'état
 *    du lab (identifiants, noms, adresses déjà présents) avec la graine fixe du PRNG de tests ;
 *  - spécifique : `OVERRIDES` fournit les arguments complets des commandes dont un paramètre est
 *    un objet structuré (`input`, `patch`…) que le nom seul ne permet pas de deviner ;
 *  - préparation : `warmupCommands` installe les rôles et crée une forêt, pour que les commandes
 *    des rôles (DNS, DHCP, GPO, partages…) trouvent un état sur lequel s'exécuter.
 * Le type d'équipement visé dépend du préfixe de la commande (`pf.*` → pare-feu, `net.addVlan` → switch…).
 * Aucun `Math.random()` : tout vient du PRNG passé en paramètre.
 */
import { commandDefinitions, type AnyCommand, type LabState } from '@engine/index'
import type { Rng } from './prng'

type Pool = Map<string, string[]>
type Device = LabState['devices'][string]

/** Valeurs (chaînes) présentes dans l'état, groupées par nom de clé (profondeur limitée). */
function harvest(state: LabState): Pool {
  const pool: Pool = new Map()
  const add = (key: string, v: string): void => {
    const list = pool.get(key) ?? []
    if (list.length < 40 && !list.includes(v)) list.push(v)
    pool.set(key, list)
  }
  const walk = (value: unknown, key: string, depth: number): void => {
    if (depth > 8 || value === null) return
    if (typeof value === 'string') {
      if (value.length < 80) add(key, value)
    } else if (Array.isArray(value)) {
      for (const v of value.slice(0, 12)) walk(v, key, depth + 1)
    } else if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 60)) {
        // Les clés d'un dictionnaire (identifiants, noms) sont aussi des valeurs candidates
        if (depth > 0 && key !== '') add(`@${key}`, k)
        walk(v, k, depth + 1)
      }
    }
  }
  walk(state, '', 0)
  return pool
}

/** Contexte de tirage : état, réservoir de valeurs, commande visée, équipement courant. */
interface Ctx {
  rng: Rng
  state: LabState
  pool: Pool
  type: string
  device: Device | undefined
}

const SAFE_STRINGS = ['alpha', 'Beta', 'srv-test', 'Partage', 'Compta', 'Docs']

const fromPool = (ctx: Ctx, ...keys: string[]): string | undefined => {
  const all = keys.flatMap((k) => ctx.pool.get(k) ?? [])
  return all.length ? ctx.rng.pick(all) : undefined
}
const anyString = (ctx: Ctx, key: string): string =>
  fromPool(ctx, key, `@${key}`) ?? ctx.rng.pick(SAFE_STRINGS) + ctx.rng.int(5)
const randomIp = (rng: Rng): string => `10.${rng.int(3)}.${rng.int(4)}.${1 + rng.int(200)}`
const uniq = (c: Ctx, prefix: string): string => prefix + c.rng.int(900)

/** Jeton d'un administrateur local (les actions `files.*` exigent un jeton d'accès). */
const ADMIN_TOKEN = {
  account: 'Administrateur',
  sids: ['S-1-1-0', 'S-1-5-11', 'S-1-5-32-545', 'S-1-5-32-544'],
  admin: true
}

const HOST_PREFIXES = [
  'service.',
  'local.',
  'firewall.',
  'vpn.',
  'files.',
  'linux.',
  'system.',
  'host.',
  'adcs.request'
]
const SERVER_PREFIXES = [
  'dns.',
  'dhcp.',
  'adds.install',
  'wsus.',
  'iis.',
  'rds.',
  'hyperv.',
  'adcs.',
  'dfs.',
  'backup.',
  'nps.',
  'rras.',
  'files.',
  'local.',
  'service.',
  'system.',
  'vpn.',
  'firewall.',
  'topology.addServer'
]

/** Équipements pouvant recevoir la commande, selon son préfixe (tous si aucune règle). */
function candidates(ctx: Ctx): Device[] {
  const all = Object.values(ctx.state.devices)
  const t = ctx.type
  const kinds = (...k: string[]): Device[] => all.filter((d) => k.includes(d.kind))
  let list: Device[] = []
  if (t.startsWith('pf.')) list = kinds('firewall')
  else if (
    t === 'net.addStaticRoute' ||
    t === 'net.removeStaticRoute' ||
    t.startsWith('net.addSub') ||
    t.startsWith('net.removeSub')
  )
    list = kinds('router')
  else if (/^net\.(add|rename|remove)Vlan$|^net\.setSwitchport$/.test(t)) list = kinds('switch')
  else if (SERVER_PREFIXES.some((p) => t.startsWith(p))) list = kinds('server')
  else if (HOST_PREFIXES.some((p) => t.startsWith(p))) list = kinds('server', 'client')
  return list.length ? list : all
}

/** Choisit un équipement adapté à la commande et le retient comme équipement courant. */
function pickDevice(ctx: Ctx): string | undefined {
  const list = candidates(ctx)
  if (!list.length) return undefined
  ctx.device = ctx.rng.pick(list)
  return ctx.device.id
}

const interfacesOf = (d: Device | undefined): { id: string }[] =>
  d && 'interfaces' in d ? (d.interfaces as { id: string }[]) : []
const firstIface = (d: Device | undefined): string | undefined => interfacesOf(d)[0]?.id
const domainOf = (c: Ctx): string => fromPool(c, '@domains') ?? 'lab.local'

/** Noms de paramètres de l'action (sans l'état), lus dans sa source : « (state, a, b = 1) ». */
export function paramNames(run: (...a: never[]) => unknown): string[] {
  const m = /^[^(]*\(([^)]*)\)/.exec(String(run))
  if (!m) return []
  return (m[1] as string)
    .split(',')
    .map((p) => p.trim().replace(/\s*=.*$/, ''))
    .filter(Boolean)
    .slice(1)
}

const BOOLEANS = new Set([
  'enabled',
  'powered',
  'active',
  'started',
  'approved',
  'declined',
  'authorized',
  'blocked',
  'apply',
  'force',
  'recursive',
  'running',
  'mustChange'
])
const DEVICE_PARAMS = new Set([
  'deviceId',
  'serverId',
  'hostId',
  'clientId',
  'requesterId',
  'dcId',
  'computerId'
])
const LISTS = new Set([
  'names',
  'members',
  'dnsNames',
  'forwarders',
  'servers',
  'addresses',
  'spns',
  'userGroups'
])

function genericArg(name: string, ctx: Ctx): unknown {
  const { rng } = ctx
  const type = ctx.type
  if (DEVICE_PARAMS.has(name) || (name === 'id' && type.startsWith('topology.')))
    return pickDevice(ctx) ?? 'inconnu'
  if (name === 'ifaceId' || name === 'parentId') {
    const ifaces = interfacesOf(ctx.device)
    return ifaces.length ? rng.pick(ifaces).id : 'eth0'
  }
  if (name === 'linkId') return fromPool(ctx, '@links') ?? 'lien-inconnu'
  if (name === 'ids' || name === 'targetIds') {
    const id = pickDevice(ctx)
    return id ? [id] : []
  }
  if (name === 'token') return ADMIN_TOKEN
  if (BOOLEANS.has(name)) return rng.next() < 0.5
  if (name === 'index' || name === 'vlan') return rng.int(3)
  if (name === 'memoryMB') return 512 * (1 + rng.int(4))
  if (name === 'delta') return rng.next() < 0.5 ? -1 : 1
  if (name === 'offsetSeconds') return rng.int(600)
  if (name === 'prefixLength') return 8 + rng.int(20)
  if (name === 'id' && type.startsWith('net.')) return 2 + rng.int(100) // numéro de VLAN
  if (['ip', 'startIp', 'endIp', 'network', 'gateway'].includes(name)) return randomIp(rng)
  if (name === 'domainName') return domainOf(ctx)
  if (['identity', 'groupIdentity', 'objectId', 'targetId', 'targetPath'].includes(name))
    return fromPool(ctx, 'sam', 'distinguishedName', 'dn', 'id', 'name') ?? anyString(ctx, name)
  if (name === 'gpoId') return fromPool(ctx, '@gpos', 'id') ?? 'gpo-inconnue'
  if (name === 'scopeId') return fromPool(ctx, 'scopeId', 'id', 'network') ?? '10.0.0.0'
  if (name === 'sessionId') return fromPool(ctx, 'id') ?? 'session-inconnue'
  if (name.endsWith('Id')) return fromPool(ctx, name, 'id') ?? anyString(ctx, name)
  if (LISTS.has(name))
    return Array.from({ length: 1 + rng.int(2) }, () =>
      ['forwarders', 'servers', 'addresses'].includes(name) ? randomIp(rng) : anyString(ctx, 'name')
    )
  if (name === 'path' || name === 'source' || name === 'destination' || name === 'target')
    return (
      fromPool(ctx, 'path') ??
      (type.startsWith('dfs.') ? `\\\\${domainOf(ctx)}\\racine\\Dossier${rng.int(5)}` : 'C:\\Partage')
    )
  if (name === 'zoneName') return fromPool(ctx, '@zones', 'zoneName') ?? anyString(ctx, 'name')
  if (/^(input|patch|settings|options|route|entry|params|app|acl|rights|credentials)$/.test(name))
    return { name: anyString(ctx, 'name'), ip: randomIp(rng), enabled: rng.next() < 0.5 }
  return anyString(ctx, name)
}

type Factory = (ctx: Ctx) => unknown[]

/** Arguments complets des commandes à objet structuré (formes des formulaires de l'interface). */
const OVERRIDES: Record<string, Factory> = {
  'topology.addDevice': ({ rng }) => [
    {
      kind: rng.pick(['server', 'client', 'switch', 'router']),
      position: { x: rng.int(900), y: rng.int(600) }
    }
  ],
  'topology.moveDevice': (c) => [pickDevice(c), { x: c.rng.int(900), y: c.rng.int(600) }],
  'topology.moveDevices': (c) => [
    [{ id: pickDevice(c), position: { x: c.rng.int(900), y: c.rng.int(600) } }]
  ],
  'topology.duplicateDevices': (c) => {
    pickDevice(c)
    return [
      { devices: c.device ? [c.device] : [], links: [] },
      { x: 40, y: 40 }
    ]
  },
  'topology.connect': (c) => {
    const a = c.rng.pick(Object.values(c.state.devices))
    const b = c.rng.pick(Object.values(c.state.devices))
    const port = (d: Device): string | undefined => interfacesOf(d)[c.rng.int(4)]?.id
    return [
      { deviceId: a.id, ifaceId: port(a) },
      { deviceId: b.id, ifaceId: port(b) }
    ]
  },
  'net.setInterfaceIpv4': (c) => {
    const id = pickDevice(c)
    return [
      id,
      firstIface(c.device),
      { addressing: 'static', address: randomIp(c.rng), mask: '255.255.255.0' }
    ]
  },
  'net.addStaticRoute': (c) => [
    pickDevice(c),
    { network: `10.${c.rng.int(250)}.0.0`, mask: '255.255.0.0', nextHop: randomIp(c.rng) }
  ],
  'net.setSwitchport': (c) => {
    const id = pickDevice(c)
    return [id, firstIface(c.device), { mode: 'access', accessVlan: 1 + c.rng.int(30) }]
  },
  'firewall.setProfile': (c) => [
    pickDevice(c),
    [c.rng.pick(['Domain', 'Private', 'Public'])],
    { enabled: c.rng.next() < 0.5 }
  ],
  'firewall.newRule': (c) => [
    pickDevice(c),
    {
      displayName: uniq(c, 'Regle'),
      direction: 'Inbound',
      action: c.rng.pick(['Allow', 'Block']),
      protocol: 'TCP',
      localPorts: [1000 + c.rng.int(8000)]
    }
  ],
  'local.newUser': (c) => [pickDevice(c), { name: uniq(c, 'user'), password: 'P@ssw0rd!2026' }],
  'local.newGroup': (c) => [pickDevice(c), { name: uniq(c, 'groupe') }],
  'system.renameComputer': (c) => [pickDevice(c), uniq(c, 'SRV')],
  'system.installFeatures': (c) => [
    pickDevice(c),
    [c.rng.pick(ROLE_FEATURES)],
    { includeManagementTools: true }
  ],
  'system.restartComputer': (c) => [pickDevice(c), 'test'],
  'adds.installForest': (c) => [
    pickDevice(c),
    { domainName: `d${c.rng.int(900)}.local`, safeModePassword: 'P@ssw0rd!2026', installDns: true }
  ],
  'adds.addOrganizationalUnit': (c) => [domainOf(c), { name: uniq(c, 'OU') }],
  'adds.addUser': (c) => [
    domainOf(c),
    { name: uniq(c, 'Utilisateur'), sam: uniq(c, 'u'), password: 'P@ssw0rd!2026' },
    false
  ],
  'adds.addGroup': (c) => [domainOf(c), { name: uniq(c, 'GG_'), scope: 'Global' }],
  'adds.addComputer': (c) => [domainOf(c), { name: uniq(c, 'PC') }],
  'adds.newSite': (c) => [domainOf(c), { name: uniq(c, 'Site') }],
  'adds.newSubnet': (c) => [
    domainOf(c),
    { prefix: `10.${c.rng.int(200)}.0.0/24`, site: 'Default-First-Site-Name' }
  ],
  'gpo.create': (c) => [domainOf(c), { name: uniq(c, 'GPO') }],
  'dns.addPrimaryZone': (c) => [pickDevice(c), { name: `z${c.rng.int(900)}.local` }],
  'dns.addRecord': (c) => [
    pickDevice(c),
    fromPool(c, '@zones', 'zoneName') ?? 'lab.local',
    { name: uniq(c, 'h'), type: 'A', data: randomIp(c.rng) }
  ],
  'dhcp.addScope': (c) => [
    pickDevice(c),
    {
      name: uniq(c, 'Etendue'),
      start: `10.9.${c.rng.int(200)}.10`,
      end: `10.9.${c.rng.int(200)}.50`,
      mask: '255.255.255.0'
    }
  ],
  'dhcp.createScope': (c) => [
    pickDevice(c),
    {
      name: uniq(c, 'Etendue'),
      start: `10.8.${c.rng.int(200)}.10`,
      end: `10.8.${c.rng.int(200)}.50`,
      mask: '255.255.255.0'
    },
    {}
  ],
  'files.createItem': (c) => [
    pickDevice(c),
    `C:\\Dossier${c.rng.int(50)}`,
    'folder',
    ADMIN_TOKEN,
    { parents: true }
  ],
  'files.createShare': (c) => [pickDevice(c), { name: uniq(c, 'Partage'), path: 'C:\\Partage' }, ADMIN_TOKEN],
  'files.shareFolder': (c) => [
    pickDevice(c),
    { name: uniq(c, 'Share'), path: `C:\\Dossier${c.rng.int(50)}` },
    ADMIN_TOKEN
  ],
  'iis.addSite': (c) => [
    pickDevice(c),
    {
      name: uniq(c, 'Site'),
      physicalPath: 'C:\\inetpub\\wwwroot',
      binding: { protocol: 'http', port: 8000 + c.rng.int(900) }
    }
  ],
  'hyperv.newSwitch': (c) => [pickDevice(c), { name: uniq(c, 'vs'), type: 'Private' }],
  'hyperv.newVm': (c) => [
    pickDevice(c),
    { name: uniq(c, 'vm'), memoryMB: 1024, generation: 2, guest: 'server' }
  ],
  'wsus.addGroup': (c) => [pickDevice(c), uniq(c, 'Groupe')],
  'rds.addCollection': (c) => [pickDevice(c), { name: uniq(c, 'Collection'), userGroups: [] }],
  'nps.addClient': (c) => [
    pickDevice(c),
    { name: uniq(c, 'cli'), address: randomIp(c.rng), secret: 'secret' }
  ],
  'nps.addPolicy': (c) => [pickDevice(c), { name: uniq(c, 'Strat'), groups: [], access: 'Grant' }],
  'dfs.newGroup': (c) => [pickDevice(c), uniq(c, 'RG')],
  'backup.setPolicy': (c) => [pickDevice(c), { items: ['C:'], target: 'D:', time: '21:00' }],
  'vpn.addConnection': (c) => [pickDevice(c), { name: uniq(c, 'vpn'), server: randomIp(c.rng) }],
  'wsus.setTargeting': (c) => [pickDevice(c), c.rng.pick(['server', 'client'])],
  'wsus.setClassification': (c) => [
    pickDevice(c),
    c.rng.pick(['security', 'critical', 'drivers']),
    c.rng.next() < 0.5
  ],
  'cyber.playStep': ({ rng }) => ['ransomware-simule', rng.int(3)]
}

/** Fonctionnalités de rôle installables (voir `feature:` des modules de src/engine/roles). */
const ROLE_FEATURES = [
  'DNS',
  'DHCP',
  'AD-Domain-Services',
  'GPMC',
  'FileAndStorage-Services',
  'Web-Server',
  'UpdateServices',
  'RDS-RD-Server',
  'Hyper-V',
  'ADCS-Cert-Authority',
  'FS-DFS-Namespace',
  'Windows-Server-Backup',
  'NPAS',
  'RemoteAccess'
]

const defs = commandDefinitions()
const PARAMS = new Map<string, string[]>()
for (const [type, def] of Object.entries(defs)) PARAMS.set(type, paramNames(def.run as never))

/** Types de commandes du catalogue (hors lot, composé de sous-commandes). */
export const COMMAND_TYPES = Object.keys(defs).filter((t) => t !== 'batch')

/** Réservoir de valeurs d'un état ; à recalculer quand l'état change. */
export function makePool(state: LabState): Pool {
  return harvest(state)
}

/**
 * Commandes de préparation : installer les rôles sur les serveurs (hors Hyper-V et RDS, rares)
 * puis promouvoir le premier serveur, pour donner un domaine aux commandes `adds.*` et `gpo.*`.
 */
export function warmupCommands(state: LabState): AnyCommand[] {
  const servers = Object.values(state.devices).filter((d) => d.kind === 'server')
  const out: AnyCommand[] = []
  for (const s of servers) {
    out.push({
      type: 'system.installFeatures',
      args: [s.id, ROLE_FEATURES, { includeManagementTools: true }]
    })
  }
  const first = servers[0]
  if (first)
    out.push({
      type: 'adds.installForest',
      args: [first.id, { domainName: 'robuste.local', safeModePassword: 'P@ssw0rd!2026', installDns: true }]
    })
  return out
}

/** Commande du type demandé avec des arguments plausibles tirés de l'état. */
export function factoryCommand(type: string, rng: Rng, state: LabState, pool: Pool): AnyCommand {
  const ctx: Ctx = { rng, state, pool, type, device: undefined }
  const override = OVERRIDES[type]
  if (override) {
    try {
      return { type, args: override(ctx) }
    } catch {
      // lab sans équipement adapté : repli sur les arguments génériques
    }
  }
  ctx.device = undefined
  return { type, args: (PARAMS.get(type) ?? []).map((n) => genericArg(n, ctx)) }
}
