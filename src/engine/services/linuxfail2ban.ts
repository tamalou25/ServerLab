/**
 * fail2ban simulé (v2.9, #237) : la prison `sshd` surveille les échecs d'authentification SSH
 * consignés dans /var/log/auth.log. Après `maxretry` échecs d'une même adresse dans `findtime`,
 * l'adresse est BANNIE pour `bantime` : le serveur refuse alors ses connexions (REJECT).
 *
 * Garde-fou (docs/fidelite.md) : le bannissement est ABSTRAIT. Il réagit aux échecs que l'élève
 * provoque lui-même avec `ssh` (une saisie de mot de passe = un échec) ; aucune attaque n'est
 * générée ni simulée, aucun mot de passe n'est deviné.
 *
 * Tout est calculé depuis l'état du lab : échecs et bannissements dans le journal de l'ordinateur
 * (`host.eventLog`, sources `fail2ban.filter` et `fail2ban.actions`) et `host.linux.bans`.
 */
import type { Draft } from 'immer'
import { raise, transact, type EngineResult } from '../core/result'
import { inNetwork, isIpv4 } from '../net/ipv4'
import type { HostDevice, LabState } from '../model/schema'
import { parseJails, runningConfigText, type JailConfig } from './linuxconfig'
import { appendLine, f2bStamp } from './linuxlogbase'
import { activeSince, isInstalled, unitPid, unitStatus } from './linuxsystem'
import { findUnit } from './linuxcatalog'

type AnyHost = HostDevice | Draft<HostDevice>

export const JAIL = 'sshd'

const unit = () => findUnit('fail2ban')

/** fail2ban est-il installé et démarré ? */
export function fail2banRunning(host: AnyHost): boolean {
  const u = unit()
  return !!u && host.powered && isInstalled(host, u.pkg) && unitStatus(host, u).active
}

/** Prisons définies par la configuration en vigueur. */
export function jailsOf(host: AnyHost): JailConfig[] {
  return parseJails(runningConfigText(host.host.linux, 'fail2ban'))
}

/** Prisons activées (`enabled = true`) quand fail2ban fonctionne. */
export function enabledJails(host: AnyHost): JailConfig[] {
  return fail2banRunning(host) ? jailsOf(host).filter((j) => j.enabled) : []
}

/** La prison sshd, si fail2ban fonctionne et qu'elle est activée. */
export const sshdJail = (host: AnyHost): JailConfig | undefined =>
  enabledJails(host).find((j) => j.name === JAIL)

/** Adresse ignorée par la prison (ignoreip : adresses ou réseaux IPv4) ? */
function ignored(jail: JailConfig, ip: string): boolean {
  if (!isIpv4(ip)) return false
  return jail.ignoreip.some((entry) => {
    const [net = '', bits] = entry.split('/')
    return isIpv4(net) && inNetwork(ip, net, bits === undefined ? 32 : Number(bits))
  })
}

export interface BanRecord {
  jail: string
  ip: string
  time: number
  duration: number
  unbanned?: number
}

/** Bannissements en vigueur (non levés à la main, non expirés). */
export function activeBans(host: AnyHost, clock: number, jail?: string): BanRecord[] {
  return (host.host.linux?.bans ?? []).filter(
    (b) =>
      (jail === undefined || b.jail === jail) &&
      b.unbanned === undefined &&
      (b.duration < 0 || clock < b.time + b.duration)
  )
}

/** Le serveur refuse-t-il les connexions de cette adresse (règle de pare-feu posée par fail2ban) ? */
export function isBanned(host: AnyHost, clock: number, ip: string): boolean {
  return fail2banRunning(host) && activeBans(host, clock).some((b) => b.ip === ip)
}

const foundPrefix = (jail: string, ip: string) => `[${jail}] Found ${ip} - `

/** Échecs `Found` de l'adresse depuis `since` (horloge du lab). */
function foundCount(host: AnyHost, jail: string, ip: string, since: number): number {
  return host.host.eventLog.filter(
    (e) => e.source === 'fail2ban.filter' && e.time > since && e.message.startsWith(foundPrefix(jail, ip))
  ).length
}

export interface JailStats {
  currentlyFailed: number
  totalFailed: number
  currentlyBanned: number
  totalBanned: number
  banned: string[]
}

/** Compteurs de `fail2ban-client status <prison>`, depuis le dernier démarrage de fail2ban. */
export function jailStats(host: AnyHost, clock: number, jail: JailConfig): JailStats {
  const u = unit()
  const since = u ? activeSince(host, u.name) : 0
  const found = host.host.eventLog.filter(
    (e) => e.source === 'fail2ban.filter' && e.time >= since && e.message.startsWith(`[${jail.name}] Found `)
  )
  const active = activeBans(host, clock, jail.name)
  const lastBan = (ip: string) =>
    Math.max(-1, ...(host.host.linux?.bans ?? []).filter((b) => b.ip === ip).map((b) => b.time))
  // Adresses suivies : au moins un échec dans la fenêtre depuis leur dernier bannissement, pas encore bannies
  const tracked = new Set(
    found
      .filter((e) => e.time >= clock - jail.findtime && e.time > lastBan(ipOfFound(e.message)))
      .map((e) => ipOfFound(e.message))
      .filter((ip) => !active.some((b) => b.ip === ip))
  )
  const all = (host.host.linux?.bans ?? []).filter((b) => b.jail === jail.name)
  return {
    currentlyFailed: tracked.size,
    totalFailed: found.length,
    currentlyBanned: active.length,
    totalBanned: all.filter((b) => b.time >= since || active.includes(b)).length,
    banned: active.map((b) => b.ip)
  }
}

const ipOfFound = (message: string) => /Found (\S+) - /.exec(message)?.[1] ?? ''

/** Ajoute un bannissement (journalise `Ban`) ; faux si l'adresse l'est déjà. */
function addBan(draft: Draft<LabState>, deviceId: string, jail: JailConfig, ip: string): boolean {
  const host = draft.devices[deviceId] as Draft<HostDevice>
  if (activeBans(host, draft.clock, jail.name).some((b) => b.ip === ip)) return false
  host.host.linux = {
    ...host.host.linux,
    distro: host.host.linux?.distro ?? 'debian12',
    bans: [
      ...(host.host.linux?.bans ?? []),
      { jail: jail.name, ip, time: draft.clock + 1000, duration: jail.bantime }
    ]
  }
  const u = unit()
  appendLine(draft, deviceId, {
    source: 'fail2ban.actions',
    pid: u ? unitPid(host, u) : 0,
    message: `[${jail.name}] Ban ${ip}`
  })
  return true
}

/**
 * Un échec d'authentification SSH vient d'être consigné dans auth.log : fail2ban le « trouve »
 * (ligne `Found`) et bannit l'adresse au `maxretry`-ième échec de la fenêtre `findtime`.
 */
export function observeSshFailure(draft: Draft<LabState>, deviceId: string, ip: string): void {
  const host = draft.devices[deviceId] as Draft<HostDevice>
  const jail = sshdJail(host)
  if (!jail || ignored(jail, ip) || isBanned(host, draft.clock, ip)) return
  const u = unit()
  const pid = u ? unitPid(host, u) : 0
  const lastBan = Math.max(-1, ...(host.host.linux?.bans ?? []).filter((b) => b.ip === ip).map((b) => b.time))
  const stamp = f2bStamp(host, draft.clock, false)
  appendLine(draft, deviceId, {
    source: 'fail2ban.filter',
    pid,
    message: `${foundPrefix(jail.name, ip)}${stamp}`
  })
  const recent = foundCount(host, jail.name, ip, Math.max(lastBan, draft.clock - jail.findtime))
  if (recent >= jail.maxretry) addBan(draft, deviceId, jail, ip)
}

/** `fail2ban-client set <prison> banip <adresse>` : renvoie le nombre d'adresses bannies. */
export function banIp(
  state: LabState,
  deviceId: string,
  jailName: string,
  ips: string[]
): EngineResult<number> {
  return transact(state, (draft) => {
    const host = draft.devices[deviceId] as Draft<HostDevice>
    const jail = enabledJails(host).find((j) => j.name === jailName)
    if (!jail) raise('NotFound', `Sorry but the jail '${jailName}' does not exist`)
    return ips.filter((ip) => addBan(draft, deviceId, jail, ip)).length
  })
}

/** `fail2ban-client set <prison> unbanip <adresse>` : renvoie le nombre d'adresses débannies. */
export function unbanIp(
  state: LabState,
  deviceId: string,
  jailName: string,
  ips: string[]
): EngineResult<number> {
  return transact(state, (draft) => {
    const host = draft.devices[deviceId] as Draft<HostDevice>
    const jail = enabledJails(host).find((j) => j.name === jailName)
    if (!jail) raise('NotFound', `Sorry but the jail '${jailName}' does not exist`)
    let count = 0
    for (const ip of ips) {
      const ban = (host.host.linux?.bans ?? []).find(
        (b) =>
          b.jail === jailName &&
          b.ip === ip &&
          b.unbanned === undefined &&
          (b.duration < 0 || draft.clock < b.time + b.duration)
      )
      if (!ban) continue
      ban.unbanned = draft.clock + 1000
      count++
      const u = unit()
      appendLine(draft, deviceId, {
        source: 'fail2ban.actions',
        pid: u ? unitPid(host, u) : 0,
        message: `[${jailName}] Unban ${ip}`
      })
    }
    return count
  })
}
