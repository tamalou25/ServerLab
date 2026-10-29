/**
 * État système d'un serveur ou poste Linux (v2.9, #236) : paquets apt, unités systemd, journal,
 * sockets en écoute et processus. Même logique d'effets réels que les services Windows
 * (`servicestate.ts`, `hostservices.ts`) :
 *
 * - `status` Running / Stopped  ⇔ unité `active (running)` / `inactive (dead)` ;
 * - `startType` Automatic        ⇔ `enabled` ; Manual ⇔ `disabled` (une unité désactivée peut
 *   toujours être démarrée à la main ; au redémarrage, `bootServices` ne démarre que les
 *   unités activées) ;
 * - l'état par défaut (démarré, activé) n'est pas stocké dans le .slab ;
 * - le journal est le journal d'évènements de l'ordinateur (`host.eventLog`) : source `systemd`,
 *   unité concernée dans `account` ;
 * - un port écoute quand l'unité qui l'ouvre est active (comme `listening.ts` pour Windows) ;
 * - PID : dérivés de l'unité et du nombre de démarrages (un redémarrage change le PID).
 *
 * Aucune valeur n'est tirée au hasard : tout est calculé depuis l'état du lab.
 */
import type { Draft } from 'immer'
import { logEvent } from '../core/eventlog'
import { LAB_EPOCH_MS } from '../core/clock'
import { raise, transact, type EngineResult } from '../core/result'
import { effectiveIpv4 } from '../net/addressing'
import type { EventLogEntry, HostDevice, LabState } from '../model/schema'
import { UNITS, findPackage, findUnit, type LinuxUnit } from './linuxcatalog'
import { configTest, configuredLogs } from './linuxapache'
import { checkConf, loadServer } from './linuxbind'
import { DHCP_DEFAULT, DHCPD_CONF, bundleMap, configTextOf, fileText, unbundle } from './linuxconfig'
import { dhcpdStartProblem, readDhcpd } from './linuxdhcp'
import {
  apacheConfig,
  appendErrorLog,
  pushUntimed,
  serverDescription,
  touchLogFiles
} from './linuxapachehost'
import { installedPackages, isInstalled } from './linuxpackages'
import { parseSshd, runningConfigText } from './linuxconfig'
import { isDefaultServiceState, serviceState } from './servicestate'

type AnyHost = HostDevice | Draft<HostDevice>

export { basePackages, installedPackages, isInstalled, linuxRelease } from './linuxpackages'

/** Unités des paquets installés. */
export function installedUnits(host: AnyHost): LinuxUnit[] {
  const pkgs = installedPackages(host)
  return UNITS.filter((u) => pkgs.includes(u.pkg))
}

export interface UnitStatus {
  unit: LinuxUnit
  active: boolean
  enabled: boolean
}

export function unitStatus(host: AnyHost, unit: LinuxUnit): UnitStatus {
  const s = serviceState(host, unit.name)
  return { unit, active: s.status === 'Running', enabled: s.startType === 'Automatic' }
}

/** Entrées du journal propres à une unité (ordre chronologique). */
export function unitJournal(host: AnyHost, unit: string): EventLogEntry[] {
  return host.host.eventLog.filter((e) => e.source === 'systemd' && e.account === unit)
}

/** Libellé de l'unité dans les messages de systemd : « ssh.service - OpenBSD Secure Shell server ». */
export const unitTitle = (u: LinuxUnit) => `${u.name}.service - ${u.description}`

const started = (e: EventLogEntry) => e.message.startsWith('Started ')

/** Nombre de démarrages de l'unité depuis le début du journal. */
export function startCount(host: AnyHost, unit: string): number {
  return unitJournal(host, unit).filter(started).length
}

/** Horloge (lab) du dernier démarrage de l'unité ; 0 : démarrée au démarrage du système. */
export function activeSince(host: AnyHost, unit: string): number {
  return unitJournal(host, unit).filter(started).at(-1)?.time ?? 0
}

/** L'unité est-elle tombée en échec (arrêtée, dernier évènement : échec du démarrage) ? */
export function unitFailed(host: AnyHost, unit: LinuxUnit): boolean {
  const last = unitJournal(host, unit.name).at(-1)
  return !unitStatus(host, unit).active && !!last && last.message.startsWith('Failed to start ')
}

/** PID du processus principal de l'unité (dérivé du rang de l'unité et du nombre de démarrages). */
export function unitPid(host: AnyHost, unit: LinuxUnit): number {
  return 400 + UNITS.indexOf(unit) * 57 + startCount(host, unit.name) * 13
}

// --- Écoute ---------------------------------------------------------------------------------------

export interface LinuxSocket {
  proto: 'tcp' | 'udp'
  /** Adresse locale telle qu'affichée par ss (`0.0.0.0`, `[::]`, `*`, `127.0.0.1`…). */
  address: string
  port: number
  backlog: number
  unit: LinuxUnit
  pid: number
}

function bindAddresses(host: AnyHost, spec: LinuxUnit['listens'][number]): string[] {
  if (spec.address !== undefined) return [spec.address]
  const bind = spec.bind
  switch (bind) {
    case 'any4':
      return ['0.0.0.0']
    case 'any6':
    case 'dual':
      return bind === 'dual' ? ['0.0.0.0', '[::]'] : ['*']
    case 'loopback':
      return ['127.0.0.1']
    case 'ifaces':
      return [
        '127.0.0.1',
        ...host.interfaces.flatMap((i) => {
          const eff = effectiveIpv4(i)
          return i.enabled && eff ? [eff.address] : []
        })
      ]
  }
}

/** Sockets ouverts par l'unité : ceux du catalogue, sauf sshd dont les ports viennent de sa configuration en vigueur. */
export function listensOf(host: AnyHost, unit: LinuxUnit): LinuxUnit['listens'] {
  if (unit.name === 'apache2') {
    // Directives Listen de la configuration en vigueur (ports.conf et sites) ; v2.9, #238
    return apacheConfig(host, 'running').listens.map((l) => ({
      proto: 'tcp' as const,
      port: l.port,
      bind: l.host === null ? ('any6' as const) : ('any4' as const),
      backlog: 511,
      ...(l.host === null ? {} : { address: l.host })
    }))
  }
  if (unit.name !== 'ssh') return unit.listens
  const ports = parseSshd(runningConfigText(host.host.linux, 'ssh')).ports
  return ports.map((port) => ({ proto: 'tcp' as const, port, bind: 'dual' as const, backlog: 128 }))
}

/** Sockets en écoute des unités actives (TCP puis UDP, par port). */
export function linuxSockets(host: AnyHost): LinuxSocket[] {
  if (!host.powered) return []
  return installedUnits(host)
    .filter((u) => unitStatus(host, u).active)
    .flatMap((unit) =>
      listensOf(host, unit).flatMap((l) =>
        bindAddresses(host, l).map((address) => ({
          proto: l.proto,
          address,
          port: l.port,
          backlog: l.backlog,
          unit,
          pid: unitPid(host, unit)
        }))
      )
    )
    .sort((a, b) => (a.proto === b.proto ? a.port - b.port : a.proto === 'udp' ? -1 : 1))
}

/** Une autre unité active écoute-t-elle déjà ce port (conflit « Address already in use ») ? */
function portConflict(host: AnyHost, unit: LinuxUnit): LinuxUnit | undefined {
  for (const l of listensOf(host, unit))
    for (const other of installedUnits(host)) {
      if (other === unit || !unitStatus(host, other).active) continue
      if (listensOf(host, other).some((o) => o.proto === l.proto && o.port === l.port)) return other
    }
  return undefined
}

// --- Écriture de l'état ---------------------------------------------------------------------------

function hostOf(state: LabState | Draft<LabState>, deviceId: string): Draft<HostDevice> {
  const d = state.devices[deviceId]
  if (!d || (d.kind !== 'server' && d.kind !== 'client') || d.host.os !== 'linux')
    raise('NotSupported', 'Cet équipement n’exécute pas Linux.')
  return d as Draft<HostDevice>
}

function setUnitState(
  host: Draft<HostDevice>,
  unit: LinuxUnit,
  patch: { active?: boolean; enabled?: boolean }
) {
  const cur = serviceState(host, unit.name)
  const next = {
    ...cur,
    status:
      patch.active === undefined ? cur.status : patch.active ? ('Running' as const) : ('Stopped' as const),
    startType:
      patch.enabled === undefined
        ? cur.startType
        : patch.enabled
          ? ('Automatic' as const)
          : ('Manual' as const)
  }
  if (isDefaultServiceState(next)) delete host.host.services[unit.name]
  else host.host.services[unit.name] = next
}

/** Le service (re)démarre ou recharge : il relit ses fichiers (l'instantané de linuxconfig.ts est oublié). */
function forgetLoadedConfig(host: Draft<HostDevice>, unit: LinuxUnit) {
  const loaded = host.host.linux?.loaded
  if (!loaded || loaded[unit.name] === undefined) return
  delete loaded[unit.name]
  if (Object.keys(loaded).length === 0 && host.host.linux) delete host.host.linux.loaded
}

function journal(
  draft: Draft<LabState>,
  deviceId: string,
  unit: LinuxUnit,
  message: string,
  level: EventLogEntry['level'] = 'information'
) {
  logEvent(draft, deviceId, { level, source: 'systemd', eventId: 0, message, account: unit.name })
}

/** Ligne d'un processus de l'unité (apachectl) : même instant que l'évènement qui l'a provoquée. */
function journalUntimed(draft: Draft<LabState>, deviceId: string, unit: LinuxUnit, message: string) {
  pushUntimed(draft, deviceId, { level: 'error', source: 'systemd', eventId: 0, message, account: unit.name })
}

/**
 * Apache refuse de démarrer : configuration invalide, aucun Listen ou port déjà pris (v2.9, #238).
 * Renvoie les lignes que `apachectl` écrit dans le journal de l'unité, ou null si le démarrage est possible.
 */
function apacheStartProblem(
  host: Draft<HostDevice>,
  unit: LinuxUnit,
  conflict: LinuxUnit | undefined,
  action: string
): string[] | null {
  const test = configTest(apacheConfig(host, 'live'))
  const tail = [`Action '${action}' failed.`, 'The Apache error log may have more information.']
  if (!test.ok) return [...test.stderr, ...tail]
  const specs = listensOf(host, unit)
  if (specs.length > 0 && !conflict) return null
  const lines = conflict
    ? specs.flatMap((l) =>
        l.address === undefined ? [`[::]:${l.port}`, `0.0.0.0:${l.port}`] : [`${l.address}:${l.port}`]
      )
    : []
  return [
    ...lines.map((a) => `(98)Address already in use: AH00072: make_sock: could not bind to address ${a}`),
    'no listening sockets available, shutting down',
    'AH00015: Unable to open logs',
    ...tail
  ]
}

/** error.log à la mise en route d'Apache : AH00489 puis AH00094 (+ création des journaux des sites). */
function apacheStarted(draft: Draft<LabState>, deviceId: string, unit: LinuxUnit, graceful: boolean) {
  const host = hostOf(draft, deviceId)
  const pid = unitPid(host, unit)
  touchLogFiles(draft, deviceId, configuredLogs(apacheConfig(host, 'live')))
  if (graceful)
    appendErrorLog(draft, deviceId, {
      module: 'mpm_event',
      level: 'notice',
      pid,
      message: 'AH00493: SIGUSR1 received.  Doing graceful restart'
    })
  appendErrorLog(draft, deviceId, {
    module: 'mpm_event',
    level: 'notice',
    pid,
    message: `AH00489: ${serverDescription(host)} configured -- resuming normal operations`
  })
  appendErrorLog(draft, deviceId, {
    module: 'core',
    level: 'notice',
    pid,
    message: "AH00094: Command line: '/usr/sbin/apache2'"
  })
}

/**
 * Bind9 et isc-dhcp-server refusent de démarrer avec une configuration invalide (v2.9, #240) : lignes de
 * leur journal, ou null si le démarrage est possible.
 */
function daemonStartProblem(host: Draft<HostDevice>, unit: LinuxUnit): string[] | null {
  const real = host as unknown as HostDevice
  const files = host.host.linux?.files
  if (unit.name === 'named') {
    const check = checkConf((p) => fileText(files, p))
    if (check.ok) return null
    return [...check.messages, `loading configuration: ${check.result}`, 'exiting (due to fatal error)']
  }
  if (unit.name === 'isc-dhcp-server')
    return dhcpdStartProblem(
      real,
      readDhcpd(real, fileText(files, DHCPD_CONF), fileText(files, DHCP_DEFAULT))
    )
  return null
}

/** Journal de named quand il démarre : zones chargées puis « running ». */
function namedStarted(draft: Draft<LabState>, deviceId: string, unit: LinuxUnit) {
  const host = hostOf(draft, deviceId)
  const files = host.host.linux?.files
  const server = loadServer(host as unknown as HostDevice, (p) => fileText(files, p))
  const pid = unitPid(host, unit)
  for (const z of server.zones)
    if (z.load)
      journal(
        draft,
        deviceId,
        unit,
        `named[${pid}]: zone ${z.zone.name}/IN: loaded serial ${z.load.serial ?? 0}`
      )
  journal(draft, deviceId, unit, `named[${pid}]: all zones loaded`)
  journal(draft, deviceId, unit, `named[${pid}]: running`)
}

/** Échec de démarrage d'une unité : lignes du programme, puis échec systemd (unité arrêtée). */
function failStart(draft: Draft<LabState>, deviceId: string, unit: LinuxUnit, problem: string[] | null) {
  const host = hostOf(draft, deviceId)
  // Les messages d'apachectl arrivent dans le journal de l'unité sous leur propre nom de programme
  const pid = 1000 + startCount(host, unit.name) * 7
  const program = unit.name === 'apache2' ? 'apachectl' : unit.process
  for (const line of problem ?? []) journalUntimed(draft, deviceId, unit, `${program}[${pid}]: ${line}`)
  journal(draft, deviceId, unit, `${unit.name}.service: Failed with result 'exit-code'.`, 'error')
  journal(draft, deviceId, unit, `Failed to start ${unitTitle(unit)}.`, 'error')
}

/**
 * Démarrage du système (audit v2.11.1, M-02) : `bootServices` remet les unités automatiques en
 * « Running » ; chacune doit valider sa configuration comme `systemctl start`. Une configuration
 * invalide (enregistrée sans restart) fait échouer l'unité : arrêtée, évènement « Failed to start ».
 */
export function validateLinuxBoot(draft: Draft<LabState>, deviceId: string): void {
  const host = draft.devices[deviceId]
  if (!host || (host.kind !== 'server' && host.kind !== 'client') || host.host.os !== 'linux') return
  const h = host as Draft<HostDevice>
  for (const unit of installedUnits(h)) {
    if (!unitStatus(h, unit).active) continue
    const problem =
      unit.name === 'apache2' ? apacheStartProblem(h, unit, undefined, 'start') : daemonStartProblem(h, unit)
    if (!problem) continue
    journal(draft, deviceId, unit, `Starting ${unitTitle(unit)}...`)
    setUnitState(h, unit, { active: false })
    failStart(draft, deviceId, unit, problem)
  }
}

/** Démarre l'unité ; renvoie false (et journalise l'échec) si le port est déjà pris. */
function startUnit(draft: Draft<LabState>, deviceId: string, unit: LinuxUnit): boolean {
  const host = hostOf(draft, deviceId)
  journal(draft, deviceId, unit, `Starting ${unitTitle(unit)}...`)
  forgetLoadedConfig(host, unit)
  const conflict = portConflict(host, unit)
  const problem =
    unit.name === 'apache2'
      ? apacheStartProblem(host, unit, conflict, 'start')
      : daemonStartProblem(host, unit)
  if (conflict || problem) {
    failStart(draft, deviceId, unit, problem)
    return false
  }
  setUnitState(host, unit, { active: true })
  journal(draft, deviceId, unit, `Started ${unitTitle(unit)}.`)
  if (unit.name === 'apache2') apacheStarted(draft, deviceId, unit, false)
  if (unit.name === 'named') namedStarted(draft, deviceId, unit)
  return true
}

function stopUnit(draft: Draft<LabState>, deviceId: string, unit: LinuxUnit) {
  const host = hostOf(draft, deviceId)
  journal(draft, deviceId, unit, `Stopping ${unitTitle(unit)}...`)
  if (unit.name === 'apache2')
    appendErrorLog(draft, deviceId, {
      module: 'mpm_event',
      level: 'notice',
      pid: unitPid(host, unit),
      message: 'AH00492: caught SIGWINCH, shutting down gracefully'
    })
  setUnitState(host, unit, { active: false })
  journal(draft, deviceId, unit, `Stopped ${unitTitle(unit)}.`)
}

/**
 * `systemctl reload apache2` (apachectl graceful) : configuration contrôlée d'abord ; si elle est invalide,
 * Apache garde l'ancienne (instantané conservé) et le rechargement échoue. Renvoie false en cas d'échec.
 */
function reloadApache(draft: Draft<LabState>, deviceId: string, unit: LinuxUnit): boolean {
  const host = hostOf(draft, deviceId)
  journal(draft, deviceId, unit, `Reloading ${unitTitle(unit)}...`)
  const test = configTest(apacheConfig(host, 'live'))
  if (!test.ok) {
    const pid = 1000 + startCount(host, unit.name) * 7
    for (const line of [
      ...test.stderr,
      "Action 'graceful' failed.",
      'The Apache error log may have more information.'
    ])
      journalUntimed(draft, deviceId, unit, `apachectl[${pid}]: ${line}`)
    journal(draft, deviceId, unit, `Reload failed for ${unitTitle(unit)}.`, 'error')
    return false
  }
  forgetLoadedConfig(host, unit)
  journal(draft, deviceId, unit, `Reloaded ${unitTitle(unit)}.`)
  apacheStarted(draft, deviceId, unit, true)
  return true
}

/** Message de systemctl quand le démarrage échoue (conflit de port). */
export const jobFailedLines = (unit: LinuxUnit) => [
  `Job for ${unit.name}.service failed because the control process exited with error code.`,
  `See "systemctl status ${unit.name}.service" and "journalctl -xeu ${unit.name}.service" for details.`
]

/**
 * `rndc reload [zone]` et `rndc reconfig` (v2.9, #240) : named relit sa configuration et ses zones (reload),
 * une seule zone (reload zone), ou la configuration et les nouvelles zones seulement (reconfig).
 * Renvoie le message affiché par rndc ; une configuration invalide échoue (« 'reload' failed: … »).
 */
export function rndcReload(
  state: LabState,
  deviceId: string,
  command: 'reload' | 'reconfig',
  zone: string | null
): EngineResult<{ message: string; failed?: boolean }> {
  return transact(state, (draft) => {
    const host = hostOf(draft, deviceId)
    const unit = findUnit('named')
    if (!unit) raise('UnitNotFound', 'Unit named.service not found.')
    const u = unit as LinuxUnit
    const real = host as unknown as HostDevice
    const files = host.host.linux?.files
    const pid = unitPid(host, u)
    const say = (m: string) => journal(draft, deviceId, u, `named[${pid}]: ${m}`)
    const running = unbundle(runningConfigText(host.host.linux, 'named'))
    const keep = (loaded: Map<string, string>) => {
      const text = bundleMap(loaded)
      const linux = host.host.linux
      if (!linux) return
      if (text === configTextOf('named', files)) forgetLoadedConfig(host, u)
      else linux.loaded = { ...linux.loaded, named: text }
    }
    say(`received control channel command '${zone ? `reload ${zone}` : command}'`)
    if (zone !== null) {
      const server = loadServer(real, (p) => running.get(p) ?? null)
      const name = zone.toLowerCase().replace(/\.$/, '') || '.'
      const z = server.zones.find((x) => x.zone.name === name)
      if (!z) raise('NotFound', "rndc: 'reload' failed: not found")
      const file = (z as (typeof server.zones)[number]).zone.file
      const path =
        file === null ? null : file.startsWith('/') ? file : `${server.check.model.directory}/${file}`
      const now = path === null ? null : fileText(files, path)
      if (path === null || now === null || now === running.get(path))
        return { message: 'zone reload up-to-date' }
      running.set(path, now)
      keep(running)
      const reloaded = loadServer(real, (p) => running.get(p) ?? null).zones.find((x) => x.zone.name === name)
      if (reloaded?.load) say(`zone ${name}/IN: loaded serial ${reloaded.load.serial ?? 0}`)
      return { message: 'zone reload queued' }
    }
    const check = checkConf((p) => fileText(files, p))
    if (!check.ok) {
      for (const m of check.messages) say(m)
      say(`reloading configuration failed: ${check.result}`)
      return { message: `rndc: '${command}' failed: ${check.result}`, failed: true }
    }
    if (command === 'reload') forgetLoadedConfig(host, u)
    else {
      // reconfig : les zones déjà chargées gardent leurs données
      const next = unbundle(configTextOf('named', files) ?? '')
      const loadedZones = loadServer(real, (p) => running.get(p) ?? null)
      for (const z of loadedZones.zones) {
        const file = z.zone.file
        const path =
          file === null ? null : file.startsWith('/') ? file : `${loadedZones.check.model.directory}/${file}`
        if (path !== null && running.has(path)) next.set(path, running.get(path) as string)
      }
      keep(next)
    }
    say('reloading configuration succeeded')
    if (command === 'reload') {
      say('reloading zones succeeded')
      const server = loadServer(real, (p) => fileText(files, p))
      for (const z of server.zones)
        if (z.load) say(`zone ${z.zone.name}/IN: loaded serial ${z.load.serial ?? 0}`)
      say('all zones loaded')
      say('running')
    }
    return { message: command === 'reload' ? 'server reload successful' : '' }
  })
}

/** `fail2ban-client reload` : le service relit ses fichiers sans changer d'état. */
export function reloadUnitConfig(state: LabState, deviceId: string, name: string): EngineResult<void> {
  return transact(state, (draft) => {
    const host = hostOf(draft, deviceId)
    const unit = findUnit(name)
    if (!unit || !isInstalled(host, unit.pkg)) raise('UnitNotFound', `Unit ${name}.service not found.`)
    forgetLoadedConfig(host, unit)
  })
}

export type UnitAction = 'start' | 'stop' | 'restart' | 'reload' | 'enable' | 'disable'

export interface UnitActionResult {
  /** Démarrage refusé (port déjà pris) : l'unité reste arrêtée. */
  startFailed: boolean
  /** Lignes affichées par systemctl (enable, disable). */
  lines: string[]
}

/**
 * Action de systemctl sur une unité installée. `reload` n'a de sens que sur une unité active.
 * Le test « unité inconnue » et le droit root sont faits par la console.
 */
export function unitAction(
  state: LabState,
  deviceId: string,
  name: string,
  action: UnitAction
): EngineResult<UnitActionResult> {
  return transact(state, (draft) => {
    const host = hostOf(draft, deviceId)
    const unit = findUnit(name)
    if (!unit || !isInstalled(host, unit.pkg)) raise('UnitNotFound', `Unit ${name}.service not found.`)
    const result: UnitActionResult = { startFailed: false, lines: [] }
    const st = unitStatus(host, unit)
    switch (action) {
      case 'start':
        if (!st.active) result.startFailed = !startUnit(draft, deviceId, unit)
        break
      case 'stop':
        if (st.active) stopUnit(draft, deviceId, unit)
        break
      case 'restart':
        if (st.active) stopUnit(draft, deviceId, unit)
        result.startFailed = !startUnit(draft, deviceId, unit)
        break
      case 'reload':
        if (!st.active)
          raise(
            'JobNotApplicable',
            `Failed to reload ${unit.name}.service: Job type reload is not applicable for unit ${unit.name}.service.`
          )
        if (unit.name === 'apache2') {
          result.startFailed = !reloadApache(draft, deviceId, unit)
          break
        }
        journal(draft, deviceId, unit, `Reloading ${unitTitle(unit)}...`)
        forgetLoadedConfig(host, unit)
        journal(draft, deviceId, unit, `Reloaded ${unitTitle(unit)}.`)
        break
      case 'enable':
        if (!st.enabled) {
          setUnitState(host, unit, { enabled: true })
          result.lines.push(
            `Created symlink /etc/systemd/system/multi-user.target.wants/${unit.name}.service → /lib/systemd/system/${unit.name}.service.`
          )
        }
        break
      case 'disable':
        if (st.enabled) {
          setUnitState(host, unit, { enabled: false })
          result.lines.push(`Removed "/etc/systemd/system/multi-user.target.wants/${unit.name}.service".`)
        }
        break
    }
    return result
  })
}

export interface PackageChange {
  /** Paquets effectivement ajoutés ou retirés. */
  changed: string[]
  /** Unités dont le démarrage a échoué à l'installation (port déjà pris). */
  failedUnits: LinuxUnit[]
}

/** `apt install` : ajoute les paquets du catalogue ; leurs services démarrent et sont activés. */
export function installPackages(
  state: LabState,
  deviceId: string,
  names: string[]
): EngineResult<PackageChange> {
  return transact(state, (draft) => {
    const host = hostOf(draft, deviceId)
    const have = installedPackages(host)
    const changed: string[] = []
    const failedUnits: LinuxUnit[] = []
    for (const name of names) {
      if (!findPackage(name)) raise('PackageNotFound', `E: Unable to locate package ${name}`)
    }
    for (const name of names) {
      if (have.includes(name) || changed.includes(name)) continue
      changed.push(name)
      host.host.linux = {
        ...host.host.linux,
        distro: host.host.linux?.distro ?? 'ubuntu2404',
        packages: [...have, ...changed].sort()
      }
      // Debian : les services d'un paquet installé sont démarrés et activés (invoke-rc.d)
      for (const unit of UNITS.filter((u) => u.pkg === name)) {
        delete host.host.services[unit.name]
        if (!startUnit(draft, deviceId, unit)) {
          setUnitState(host, unit, { active: false, enabled: true })
          failedUnits.push(unit)
        }
      }
    }
    return { changed, failedUnits }
  })
}

/** `apt remove` : retire les paquets installés (leurs unités disparaissent). */
export function removePackages(
  state: LabState,
  deviceId: string,
  names: string[]
): EngineResult<PackageChange> {
  return transact(state, (draft) => {
    const host = hostOf(draft, deviceId)
    const have = installedPackages(host)
    for (const name of names) {
      if (!findPackage(name)) raise('PackageNotFound', `E: Unable to locate package ${name}`)
    }
    const changed = names.filter((n, i) => have.includes(n) && names.indexOf(n) === i)
    for (const name of changed) {
      for (const unit of UNITS.filter((u) => u.pkg === name)) {
        if (unitStatus(host, unit).active) stopUnit(draft, deviceId, unit)
        delete host.host.services[unit.name]
      }
    }
    host.host.linux = {
      ...host.host.linux,
      distro: host.host.linux?.distro ?? 'ubuntu2404',
      packages: have.filter((p) => !changed.includes(p))
    }
    return { changed, failedUnits: [] }
  })
}

// --- Dates ----------------------------------------------------------------------------------------

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const p2 = (n: number) => String(n).padStart(2, '0')

/** Heure locale du poste pour une horloge du lab (décalage `clockOffsetSeconds` compris). */
function localDate(host: AnyHost, clock: number): Date {
  return new Date(LAB_EPOCH_MS + clock + (host.host.clockOffsetSeconds ?? 0) * 1000)
}

/** Horodatage de journalctl : « Jan 05 08:00:03 ». */
export function journalStamp(host: AnyHost, clock: number): string {
  const d = localDate(host, clock)
  return `${MONTHS[d.getUTCMonth()]} ${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`
}

/** Horodatage de systemctl status : « Mon 2026-01-05 08:00:03 UTC ». */
export function statusStamp(host: AnyHost, clock: number): string {
  const d = localDate(host, clock)
  return `${DAYS[d.getUTCDay()]} ${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} UTC`
}

/** « 5min ago », « 2min 11s ago », « 1h 3min ago », « 2 days ago ». */
export function relativeAgo(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 === 0 ? `${m}min ago` : `${m}min ${s % 60}s ago`
  const h = Math.floor(m / 60)
  if (h < 48) return m % 60 === 0 ? `${h}h ago` : `${h}h ${m % 60}min ago`
  return `${Math.floor(h / 24)} days ago`
}
