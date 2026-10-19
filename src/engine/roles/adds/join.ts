/**
 * Postes et serveurs membres : jonction au domaine, ouverture de session, inscription DNS.
 * La localisation du contrôleur de domaine passe par le DNS (enregistrement SRV) :
 * un poste dont le DNS ne pointe pas vers le DC ne peut pas joindre le domaine.
 */
import type { Draft } from 'immer'
import { logEvent } from '../../core/eventlog'
import { logAudited } from '../gpo/auditpolicy'
import { transact } from '../../core/result'
import { clockOffset, KERBEROS_MAX_SKEW_SECONDS, TIME_SKEW_MESSAGE } from '../../services/hostclock'
import type { Domain, HostDevice, LabState } from '../../model/schema'
import { effectiveIpv4 } from '../../net/addressing'
import { isApipa } from '../../net/ipv4'
import { concatTraces, type PacketTrace } from '../../sim/trace'
import { normalizeName, ptrQueryName } from '../dns/server'
import { dnsServersOf } from '../dns/resolver'
import {
  defaultContainer,
  findPrincipal,
  isDomainAdmin,
  newAdId,
  passwordMeetsPolicy,
  PASSWORD_POLICY_ERROR,
  resolveContainerDn
} from './directory'
import { domainLockoutPolicy, domainPasswordPolicy } from '../gpo/scope'
import { fsmoHolder } from './fsmo'
import { isLockedOut, lockoutExpired } from './lockout'
import { computerPolicyStale, processGroupPolicy } from '../gpo/processing'
import { exchange, locateDc } from './locator'
import { dnsServerOf } from '../dns/state'

/** Message d'un compte verrouillé (ouverture de session). */
export const ACCOUNT_LOCKED =
  'Le compte référencé est actuellement verrouillé et vous ne pourrez peut-être pas vous y connecter.'

export interface DirectoryOperation {
  state: LabState
  trace: PacketTrace
  ok: boolean
  message: string
}

/** Nom d'ouverture de session sans domaine (LAB\jdupont, jdupont@lab.local → jdupont). */
export function accountName(user: string): string {
  const u = user.trim()
  if (u.includes('\\')) return u.split('\\')[1] ?? u
  if (u.includes('@')) return u.split('@')[0] ?? u
  return u
}

function hostOf(state: LabState, id: string): HostDevice | null {
  const d = state.devices[id]
  return d && (d.kind === 'server' || d.kind === 'client') ? d : null
}

export interface JoinInput {
  domain: string
  user: string
  password: string
  ouPath?: string
}

/** Jonction d'un ordinateur au domaine (Add-Computer / Propriétés système). */
export function joinDomain(state: LabState, deviceId: string, input: JoinInput): DirectoryOperation {
  const host = hostOf(state, deviceId)
  const empty: PacketTrace = { title: 'Jonction au domaine', events: [] }
  if (!host || !host.powered) return { state, trace: empty, ok: false, message: 'L’ordinateur est éteint.' }
  const domainName = normalizeName(input.domain)
  const fail = (reason: string, traces: PacketTrace[] = []): DirectoryOperation => ({
    state,
    trace: concatTraces(`Jonction de ${host.name} au domaine ${domainName}`, traces),
    ok: false,
    message: `L’ordinateur « ${host.name} » n’a pas pu joindre le domaine « ${domainName} » à partir de son groupe de travail actuel « ${host.host.workgroup} » avec l’erreur suivante : ${reason}`
  })
  if (host.host.domain === domainName || host.host.pendingDomain === domainName)
    return {
      state,
      trace: empty,
      ok: false,
      message: `L’ordinateur « ${host.name} » est déjà membre du domaine « ${domainName} ».`
    }
  if (Object.values(state.domains).some((d) => d.controllers.includes(deviceId)))
    return {
      state,
      trace: empty,
      ok: false,
      message: 'Un contrôleur de domaine ne peut pas changer de domaine.'
    }

  const traces: PacketTrace[] = []
  const located = locateDc(state, deviceId, domainName, traces)
  if (!located) return fail('Le domaine spécifié n’existe pas ou n’a pas pu être contacté.', traces)

  const sam = accountName(input.user)
  const principal = findPrincipal(located.domain, sam)
  const user = principal?.kind === 'user' ? principal.obj : null
  const credentialsOk = !!user && user.enabled && user.password === input.password
  const kerberos = exchange(
    state,
    deviceId,
    located.dcIp,
    'KERBEROS',
    88,
    `Kerberos AS-REQ (${located.domain.netbios}\\${sam})`,
    credentialsOk ? 'Kerberos AS-REP (ticket accordé)' : 'Kerberos KRB-ERROR (pré-authentification refusée)',
    [['Compte', `${sam}@${located.domain.name.toUpperCase()}`]]
  )
  traces.push(kerberos.trace)
  if (!user || user.password !== input.password)
    return fail('Nom d’utilisateur ou mot de passe incorrect.', traces)
  if (!user.enabled)
    return fail('Le compte référencé est actuellement désactivé et ne peut pas être utilisé.', traces)

  let parentId: string | null | undefined = defaultContainer(located.domain, 'Computers')
  if (input.ouPath) {
    parentId = resolveContainerDn(located.domain, input.ouPath)
    if (parentId === undefined || parentId === null)
      return fail(`Le chemin d’unité d’organisation « ${input.ouPath} » est introuvable.`, traces)
  }

  const result = transact(state, (draft) => {
    const domain = draft.domains[located.domain.name] as Draft<Domain>
    const device = draft.devices[deviceId] as Draft<HostDevice>
    const computerName = device.host.pendingName ?? device.name
    const computer = domain.computers.find((c) => c.name.toLowerCase() === computerName.toLowerCase())
    if (computer) {
      computer.deviceId = deviceId
      computer.enabled = true
    } else {
      const id = newAdId(draft)
      domain.computers.push({
        id,
        name: computerName,
        parentId: parentId as string,
        deviceId,
        enabled: true,
        dnsHostName: `${computerName.toLowerCase()}.${domain.name}`
      })
      domain.groups.find((g) => g.name === 'Ordinateurs du domaine')?.members.push(id)
    }
    device.host.pendingDomain = domain.name
    device.host.pendingReboot = true
    logAudited(draft, located.dcId, 'accountManagement', 'success', {
      level: 'information',
      source: 'Security-Auditing',
      eventId: 4741,
      log: 'Sécurité',
      message: `Un compte d’ordinateur a été créé : ${domain.netbios}\\${computerName}$ (par ${domain.netbios}\\${sam}).`
    })
    return undefined
  })
  return {
    state: result.ok ? result.state : state,
    trace: concatTraces(`Jonction de ${host.name} au domaine ${domainName}`, traces),
    ok: true,
    message: `Bienvenue dans le domaine ${domainName}. Vous devez redémarrer l’ordinateur pour appliquer ces modifications.`
  }
}

/** Quitte le domaine (retour en groupe de travail au prochain redémarrage). */
export function leaveDomain(state: LabState, deviceId: string): DirectoryOperation {
  const empty: PacketTrace = { title: 'Groupe de travail', events: [] }
  const result = transact(state, (draft) => {
    const device = draft.devices[deviceId]
    if (!device || (device.kind !== 'server' && device.kind !== 'client') || !device.host.domain) return false
    device.host.pendingDomain = ''
    device.host.pendingReboot = true
    return true
  })
  if (!result.ok || !result.value)
    return { state, trace: empty, ok: false, message: 'Cet ordinateur n’est membre d’aucun domaine.' }
  return {
    state: result.state,
    trace: empty,
    ok: true,
    message:
      'Bienvenue dans le groupe de travail WORKGROUP. Redémarrez l’ordinateur pour appliquer la modification.'
  }
}

/** Évènement 4672 : ouverture de session d'un compte administrateur (privilèges sensibles). */
function logSpecialPrivileges(draft: Draft<LabState>, deviceId: string, account: string): void {
  logAudited(draft, deviceId, 'logon', 'success', {
    level: 'information',
    source: 'Security-Auditing',
    eventId: 4672,
    log: 'Sécurité',
    account,
    message: `Privilèges spéciaux attribués à la nouvelle ouverture de session. Compte : ${account}. Privilèges : SeSecurityPrivilege, SeBackupPrivilege, SeRestorePrivilege, SeTakeOwnershipPrivilege, SeDebugPrivilege, SeSystemEnvironmentPrivilege, SeLoadDriverPrivilege, SeImpersonatePrivilege.`
  })
}

export interface LogonInput {
  user: string
  password: string
  /** Nom NetBIOS du domaine, ou null pour un compte local. */
  domain: string | null
}

export type LogonOutcome = DirectoryOperation & { mustChangePassword?: boolean }

/** Ouverture de session interactive (écran de connexion). */
export function logon(state: LabState, deviceId: string, input: LogonInput): LogonOutcome {
  const host = hostOf(state, deviceId)
  const empty: PacketTrace = { title: 'Ouverture de session', events: [] }
  const incorrect = 'Le nom d’utilisateur ou le mot de passe est incorrect.'
  if (!host || !host.powered) return { state, trace: empty, ok: false, message: 'L’ordinateur est éteint.' }
  const sam = accountName(input.user)

  // Compte local
  if (!input.domain || input.domain.toUpperCase() === host.name.toUpperCase()) {
    const localOk =
      (sam.toLowerCase() === 'administrateur' && input.password === host.host.localAdminPassword) ||
      (host.kind === 'client' && sam.toLowerCase() === 'utilisateur' && input.password === '')
    const localAccount = `${host.name}\\${sam.toLowerCase() === 'administrateur' ? 'Administrateur' : sam}`
    if (!localOk) {
      const failed = transact(state, (draft) => {
        logAudited(draft, deviceId, 'logon', 'failure', {
          level: 'warning',
          source: 'Security-Auditing',
          eventId: 4625,
          log: 'Sécurité',
          account: localAccount,
          message: `Échec d’ouverture de session pour ${localAccount}. Type d’ouverture de session : 2 (Interactive).`
        })
        return undefined
      })
      return { state: failed.ok ? failed.state : state, trace: empty, ok: false, message: incorrect }
    }
    const r = transact(state, (draft) => {
      const d = draft.devices[deviceId] as Draft<HostDevice>
      d.host.session = {
        user: sam.toLowerCase() === 'administrateur' ? 'Administrateur' : 'Utilisateur',
        domain: null
      }
      logAudited(draft, deviceId, 'logon', 'success', {
        level: 'information',
        source: 'Security-Auditing',
        eventId: 4624,
        log: 'Sécurité',
        account: localAccount,
        message: `Ouverture de session réussie : ${localAccount}. Type d’ouverture de session : 2 (Interactive).`
      })
      if (sam.toLowerCase() === 'administrateur') logSpecialPrivileges(draft, deviceId, localAccount)
      return undefined
    })
    return { state: r.ok ? r.state : state, trace: empty, ok: true, message: '' }
  }

  const domain = Object.values(state.domains).find(
    (d) => d.netbios.toUpperCase() === input.domain?.toUpperCase() || d.name === input.domain?.toLowerCase()
  )
  if (!host.host.domain || !domain || domain.name !== host.host.domain)
    return {
      state,
      trace: empty,
      ok: false,
      message: 'Le domaine spécifié n’existe pas ou n’a pas pu être contacté.'
    }
  const traces: PacketTrace[] = []
  const located = locateDc(state, deviceId, domain.name, traces)
  if (!located)
    return {
      state,
      trace: concatTraces('Ouverture de session', traces),
      ok: false,
      message:
        'Il n’y a actuellement aucun serveur d’accès disponible pour traiter la demande d’ouverture de session.'
    }
  // Horloge : au-delà de la tolérance Kerberos (5 minutes), le KDC refuse l'authentification
  // (KRB_AP_ERR_SKEW) avant même d'évaluer le mot de passe (v2.8)
  const skew = Math.abs(clockOffset(state, deviceId) - clockOffset(state, located.dcId))
  if (skew > KERBEROS_MAX_SKEW_SECONDS) {
    const account = `${domain.netbios}\\${sam}`
    const refused = transact(state, (draft) => {
      logEvent(draft, located.dcId, {
        level: 'warning',
        source: 'Security-Auditing',
        eventId: 4771,
        log: 'Sécurité',
        account,
        message: `La pré-authentification Kerberos a échoué pour ${account} depuis ${host.name}. Code d’échec : 0x25 (KRB_AP_ERR_SKEW : écart d’horloge trop important).`
      })
      logAudited(draft, deviceId, 'logon', 'failure', {
        level: 'warning',
        source: 'Security-Auditing',
        eventId: 4625,
        log: 'Sécurité',
        account,
        message: `Échec d’ouverture de session pour ${account}. Type d’ouverture de session : 2 (Interactive). État : 0xC0000133 (STATUS_TIME_DIFFERENCE_AT_DC).`
      })
      return undefined
    })
    return {
      state: refused.ok ? refused.state : state,
      trace: concatTraces('Ouverture de session', traces),
      ok: false,
      message: TIME_SKEW_MESSAGE
    }
  }
  const principal = findPrincipal(domain, sam)
  const user = principal?.kind === 'user' ? principal.obj : null
  // Verrouillage : un compte verrouillé est refusé tant que la durée n'est pas écoulée
  const lockout = domainLockoutPolicy(domain)
  const locked = !!user && isLockedOut(domain, user, state.clock)
  const good = !!user && !locked && user.password === input.password
  const kerberos = exchange(
    state,
    deviceId,
    located.dcIp,
    'KERBEROS',
    88,
    `Kerberos AS-REQ (${domain.netbios}\\${sam})`,
    good && user?.enabled ? 'Kerberos AS-REP (TGT accordé)' : 'Kerberos KRB-ERROR',
    [['Compte', `${sam}@${domain.name.toUpperCase()}`]]
  )
  traces.push(kerberos.trace)
  const trace = concatTraces(`Ouverture de session ${domain.netbios}\\${sam}`, traces)
  // Compte verrouillé : le KDC répond KDC_ERR_CLIENT_REVOKED (4768 en échec, code 0x12)
  // au lieu d'évaluer le mot de passe (4771, code 0x18)
  const audit = (draft: Draft<LabState>, ok: boolean) =>
    logEvent(draft, located.dcId, {
      level: ok ? 'information' : 'warning',
      source: 'Security-Auditing',
      eventId: ok || locked ? 4768 : 4771,
      log: 'Sécurité',
      account: `${domain.netbios}\\${sam}`,
      message: ok
        ? `Un ticket d’authentification Kerberos (TGT) a été demandé pour ${domain.netbios}\\${sam} depuis ${host.name}.`
        : locked
          ? `Un ticket d’authentification Kerberos (TGT) a été demandé pour ${domain.netbios}\\${sam} depuis ${host.name}. Code d’échec : 0x12.`
          : `La pré-authentification Kerberos a échoué pour le compte ${sam} depuis ${host.name}.`
    })
  if (!user || !good) {
    const r = transact(state, (draft) => {
      audit(draft, false)
      logAudited(draft, deviceId, 'logon', 'failure', {
        level: 'warning',
        source: 'Security-Auditing',
        eventId: 4625,
        log: 'Sécurité',
        account: `${domain.netbios}\\${sam}`,
        message: `Échec d’ouverture de session pour ${domain.netbios}\\${sam}.${locked ? ' Raison : le compte est verrouillé.' : ''}`
      })
      const account = user ? draft.domains[domain.name]?.users.find((u) => u.id === user.id) : undefined
      if (account && !locked) {
        if (lockoutExpired(domain, account, state.clock)) account.lockoutTime = null
        // Compteur d'échecs remis à zéro passé le délai de réinitialisation
        if (
          account.lastBadPassword !== null &&
          state.clock - account.lastBadPassword >= lockout.reset * 60_000
        )
          account.badPwdCount = 0
        account.badPwdCount += 1
        account.lastBadPassword = draft.clock
        if (lockout.threshold > 0 && account.badPwdCount >= lockout.threshold) {
          account.lockoutTime = draft.clock
          const pdc = fsmoHolder(domain, 'PDCEmulator') ?? located.dcId
          logAudited(draft, pdc, 'accountManagement', 'success', {
            level: 'information',
            source: 'Security-Auditing',
            eventId: 4740,
            log: 'Sécurité',
            account: `${domain.netbios}\\${account.sam}`,
            message: `Un compte d’utilisateur a été verrouillé. Compte : ${domain.netbios}\\${account.sam}. Ordinateur appelant : ${host.name}.`
          })
        }
      }
      return undefined
    })
    return {
      state: r.ok ? r.state : state,
      trace,
      ok: false,
      // La tentative qui atteint le seuil reste un mauvais mot de passe : seules les suivantes
      // voient le verrouillage
      message: locked ? ACCOUNT_LOCKED : incorrect
    }
  }
  if (!user.enabled)
    return {
      state,
      trace,
      ok: false,
      message: 'Votre compte a été désactivé. Contactez votre administrateur système.'
    }
  if (user.mustChangePassword)
    return {
      state,
      trace,
      ok: false,
      mustChangePassword: true,
      message: 'Vous devez changer votre mot de passe avant d’ouvrir une session pour la première fois.'
    }
  const r = transact(state, (draft) => {
    const d = draft.devices[deviceId] as Draft<HostDevice>
    const acct = draft.domains[domain.name]?.users.find((u) => u.id === user.id)
    if (acct) {
      acct.badPwdCount = 0
      acct.lastBadPassword = null
      acct.lockoutTime = null
    }
    d.host.session = {
      user: user.sam,
      domain: domain.netbios,
      logonServer: draft.devices[located.dcId]?.name ?? ''
    }
    audit(draft, true)
    // Ticket de service pour l'ordinateur où la session s'ouvre (TGS host/<poste>)
    logEvent(draft, located.dcId, {
      level: 'information',
      source: 'Security-Auditing',
      eventId: 4769,
      log: 'Sécurité',
      account: `${domain.netbios}\\${user.sam}`,
      message: `Un ticket de service Kerberos a été demandé. Compte : ${user.sam}@${domain.name.toUpperCase()}. Nom du service : ${host.name}$. Adresse du client : ${host.name}.`
    })
    const account = draft.domains[domain.name]?.users.find((u) => u.id === user.id)
    if (account) account.lastLogon = draft.clock
    logAudited(draft, deviceId, 'logon', 'success', {
      level: 'information',
      source: 'Security-Auditing',
      eventId: 4624,
      log: 'Sécurité',
      account: `${domain.netbios}\\${user.sam}`,
      message: `Ouverture de session réussie : ${domain.netbios}\\${user.sam}. Type d’ouverture de session : 2 (Interactive).`
    })
    if (isDomainAdmin(domain, user.sam))
      logSpecialPrivileges(draft, deviceId, `${domain.netbios}\\${user.sam}`)
    return undefined
  })
  if (!r.ok) return { state, trace, ok: false, message: r.error.message }
  // Stratégies de groupe : utilisateur à chaque ouverture, ordinateur si pas encore traitée
  const opened = r.state.devices[deviceId] as HostDevice
  const gp = processGroupPolicy(r.state, deviceId, {
    computer: computerPolicyStale(opened),
    user: true,
    dc: located
  })
  return {
    state: gp.state,
    trace: concatTraces(`Ouverture de session ${domain.netbios}\\${sam}`, [...traces, gp.trace]),
    ok: true,
    message: ''
  }
}

/**
 * Vérifie un mot de passe sans ouvrir de session ni contacter le contrôleur (déverrouillage
 * d'une session déjà ouverte : identifiants mis en cache par l'ordinateur).
 */
export function verifyCredentials(state: LabState, deviceId: string, input: LogonInput): boolean {
  const host = hostOf(state, deviceId)
  if (!host) return false
  const sam = accountName(input.user).toLowerCase()
  if (!input.domain || input.domain.toUpperCase() === host.name.toUpperCase()) {
    if (sam === 'administrateur') return input.password === host.host.localAdminPassword
    return host.kind === 'client' && sam === 'utilisateur' && input.password === ''
  }
  const domain = Object.values(state.domains).find(
    (d) => d.netbios.toUpperCase() === input.domain?.toUpperCase() || d.name === input.domain?.toLowerCase()
  )
  if (!domain) return false
  const principal = findPrincipal(domain, sam)
  return principal?.kind === 'user' && principal.obj.enabled && principal.obj.password === input.password
}

/** Changement du mot de passe imposé à la première ouverture de session, puis connexion. */
export function changePasswordAndLogon(
  state: LabState,
  deviceId: string,
  input: LogonInput & { newPassword: string }
): LogonOutcome {
  const domain = Object.values(state.domains).find(
    (d) => d.netbios.toUpperCase() === input.domain?.toUpperCase()
  )
  const empty: PacketTrace = { title: 'Changement de mot de passe', events: [] }
  if (!domain) return { state, trace: empty, ok: false, message: 'Domaine introuvable.' }
  const sam = accountName(input.user)
  const user = domain.users.find((u) => u.sam.toLowerCase() === sam.toLowerCase())
  if (!user || user.password !== input.password)
    return {
      state,
      trace: empty,
      ok: false,
      message: 'Le nom d’utilisateur ou le mot de passe est incorrect.'
    }
  if (!passwordMeetsPolicy(input.newPassword, sam, domainPasswordPolicy(domain)))
    return { state, trace: empty, ok: false, message: PASSWORD_POLICY_ERROR }
  const r = transact(state, (draft) => {
    const u = draft.domains[domain.name]?.users.find((x) => x.id === user.id)
    if (u) {
      u.password = input.newPassword
      u.passwordLastSet = draft.clock
      u.mustChangePassword = false
    }
    return undefined
  })
  if (!r.ok) return { state, trace: empty, ok: false, message: r.error.message }
  return logon(r.state, deviceId, { ...input, password: input.newPassword })
}

/** Fermeture de session. */
export function logoff(state: LabState, deviceId: string): LabState {
  const r = transact(state, (draft) => {
    const d = draft.devices[deviceId]
    if (d && (d.kind === 'server' || d.kind === 'client') && d.host.session) {
      logAudited(draft, deviceId, 'logon', 'success', {
        level: 'information',
        source: 'Security-Auditing',
        eventId: 4634,
        log: 'Sécurité',
        account: `${d.host.session.domain ?? d.name}\\${d.host.session.user}`,
        message: `Fermeture de session : ${d.host.session.domain ?? d.name}\\${d.host.session.user}.`
      })
      d.host.session = null
      // Le profil de l'utilisateur est déchargé : sa stratégie sera retraitée à la prochaine ouverture
      d.host.policy.user = null
      // Les lecteurs réseau non persistants sont déconnectés
      d.host.drives = d.host.drives.filter((drive) => drive.persistent)
    }
    return undefined
  })
  return r.ok ? r.state : state
}

/**
 * Inscription DNS dynamique d'un membre du domaine : enregistrement A (et PTR si la zone
 * inverse existe) sur le serveur DNS du domaine, à condition que le poste l'utilise comme DNS.
 */
export function registerHostDns(draft: Draft<LabState>, device: Draft<HostDevice>): boolean {
  if (!device.host.domain || !device.powered) return false
  const domain = draft.domains[device.host.domain]
  if (!domain) return false
  const ip = device.interfaces.map((i) => effectiveIpv4(i)?.address).find((a) => a && !isApipa(a))
  if (!ip) return false
  const clientDns = dnsServersOf(device)
  for (const dcId of domain.controllers) {
    const dc = draft.devices[dcId]
    const dcDns = dnsServerOf(dc)
    if (!dc || !dcDns) continue
    const dcIps = dc.interfaces.map((i) => effectiveIpv4(i)?.address).filter((a): a is string => !!a)
    const usesDc = dc.id === device.id || clientDns.some((s) => dcIps.includes(s))
    if (!usesDc) continue
    const zone = dcDns.zones.find((z) => z.name === domain.name)
    if (!zone || zone.dynamicUpdate === 'None') continue
    const name = device.name.toLowerCase()
    zone.records = zone.records.filter((r) => !(r.name === name && r.type === 'A' && r.dynamic))
    if (!zone.records.some((r) => r.name === name && r.type === 'A'))
      zone.records.push({ name, type: 'A', data: ip, ttl: 1200, dynamic: true })
    const reverse = dcDns.zones.find(
      (z) => z.reverse && ptrQueryName(ip).endsWith(`.${z.name}`) && z.dynamicUpdate !== 'None'
    )
    if (reverse) {
      const ptr = ptrQueryName(ip).slice(0, -(reverse.name.length + 1))
      reverse.records = reverse.records.filter((r) => !(r.name === ptr && r.type === 'PTR' && r.dynamic))
      reverse.records.push({
        name: ptr,
        type: 'PTR',
        data: `${name}.${domain.name}.`,
        ttl: 1200,
        dynamic: true
      })
    }
    return true
  }
  return false
}
