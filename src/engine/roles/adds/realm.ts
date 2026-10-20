/**
 * Poste Linux dans le domaine (realmd, sssd) : realm discover / join / list / leave et id des
 * comptes du domaine. La jonction crée le compte d'ordinateur comme pour Windows (même
 * localisation du contrôleur par DNS, même authentification) mais prend effet sans redémarrage.
 */
import type { Draft } from 'immer'
import { transact, type EngineResult } from '../../core/result'
import type { AdGroup, AdUser, Domain, HostDevice, LabState } from '../../model/schema'
import { CommandFailure } from '../../shell/context'
import { runId } from '../../shell/bash/accounts'
import type { ToolDef } from '../../shell/tools/types'
import { findPrincipal } from './directory'
import { accountName, joinDomain } from './join'
import { locateDc } from './locator'

const REALM_PACKAGES = ['sssd-tools', 'sssd', 'libnss-sss', 'libpam-sss', 'adcli', 'samba-common-bin']

function realmLines(domain: Domain, joined: boolean): string[] {
  return [
    domain.name,
    '  type: kerberos',
    `  realm-name: ${domain.name.toUpperCase()}`,
    `  domain-name: ${domain.name}`,
    `  configured: ${joined ? 'kerberos-member' : 'no'}`,
    '  server-software: active-directory',
    '  client-software: sssd',
    ...REALM_PACKAGES.map((p) => `  required-package: ${p}`),
    ...(joined ? [`  login-formats: %U@${domain.name}`, '  login-policy: allow-realm-logins'] : [])
  ]
}

/** Jonction d'un poste Linux : compte d'ordinateur créé, appartenance effective aussitôt. */
export function realmJoin(
  state: LabState,
  deviceId: string,
  input: { domain: string; user: string; password: string }
): EngineResult<{ trace: ReturnType<typeof joinDomain>['trace'] }> {
  const op = joinDomain(state, deviceId, input)
  if (!op.ok) return { ok: false, error: { code: 'JoinFailed', message: op.message } }
  const done = transact(op.state, (draft) => {
    const device = draft.devices[deviceId] as Draft<HostDevice>
    device.host.domain = device.host.pendingDomain
    device.host.pendingDomain = null
    device.host.pendingReboot = false
    return undefined
  })
  return done.ok ? { ok: true, state: done.state, value: { trace: op.trace } } : done
}

/** Quitte le domaine localement (le compte d'ordinateur reste dans l'annuaire, comme realm leave). */
export function realmLeave(state: LabState, deviceId: string): EngineResult {
  return transact(state, (draft) => {
    const device = draft.devices[deviceId] as Draft<HostDevice>
    device.host.domain = null
    device.host.mounts = []
    return undefined
  })
}

const realmTool: ToolDef = {
  name: 'realm',
  synopsis: 'Découvre ou rejoint un domaine Active Directory (realm discover / join / list / leave).',
  run(ctx, args) {
    const [action = '', ...rest] = args
    const host = ctx.host
    const domainArg = rest.find(
      (a, i) => !a.startsWith('-') && rest[i - 1] !== '-U' && rest[i - 1] !== '--user'
    )
    switch (action) {
      case 'discover': {
        const name = domainArg ?? host.host.domain ?? ''
        const traces: Parameters<typeof locateDc>[3] = []
        const located = name ? locateDc(ctx.state, ctx.deviceId, name, traces) : null
        traces.forEach((t) => ctx.addTrace(t))
        if (!located) throw new CommandFailure('realm: No such realm found', 'NotFound')
        ctx.writeLines(realmLines(located.domain, host.host.domain === located.domain.name))
        return
      }
      case 'join': {
        if (!ctx.root)
          throw new CommandFailure('realm: Not authorized to perform this action', 'PermissionDenied')
        if (!domainArg) throw new CommandFailure('realm: Specify one realm to join', 'InvalidArgument')
        const userIndex = rest.findIndex((a) => a === '-U' || a === '--user')
        const user = userIndex >= 0 ? (rest[userIndex + 1] ?? '') : 'Administrator'
        if (host.host.domain)
          throw new CommandFailure('realm: Already joined to this domain', 'AlreadyJoined')
        const password = ctx.ask(`Password for ${accountName(user)}: `, true)
        const r = realmJoin(ctx.state, ctx.deviceId, { domain: domainArg, user, password })
        if (!r.ok) {
          const unreachable = r.error.message.includes('n’existe pas ou n’a pas pu être contacté')
          throw new CommandFailure(
            unreachable
              ? 'realm: No such realm found'
              : "realm: Couldn't join realm: Failed to join the domain",
            'JoinFailed'
          )
        }
        ctx.state = r.state
        ctx.addTrace(r.value.trace)
        return
      }
      case 'list': {
        const domain = host.host.domain ? ctx.state.domains[host.host.domain] : undefined
        if (domain) ctx.writeLines(realmLines(domain, true))
        return
      }
      case 'leave': {
        if (!ctx.root)
          throw new CommandFailure('realm: Not authorized to perform this action', 'PermissionDenied')
        if (!host.host.domain)
          throw new CommandFailure("realm: Couldn't find a configured realm", 'NotJoined')
        ctx.apply(realmLeave(ctx.state, ctx.deviceId))
        return
      }
      default:
        ctx.writeLines(['usage: realm [--verbose] COMMAND ...', '  discover, join, leave, list'], 'error')
    }
  }
}

/** Numéro relatif (RID) déduit de l'identifiant de l'objet (simulation déterministe). */
const rid = (id: string) => 1000 + (Number(/\d+/.exec(id)?.[0] ?? '0') % 100000)

/** Base de correspondance des identifiants de sssd (une tranche par domaine, déterministe). */
function idBase(domain: Domain): number {
  let h = 0
  for (const c of domain.name) h = (h * 31 + c.charCodeAt(0)) % 9000
  return 200000 * (5000 + h)
}

const lower = (name: string, domain: Domain) => `${name.toLowerCase()}@${domain.name}`

function idLine(domain: Domain, user: AdUser): string {
  const base = idBase(domain)
  const primary = domain.groups.find((g) => g.name === 'Utilisateurs du domaine')
  const groups: AdGroup[] = [
    ...(primary ? [primary] : []),
    ...domain.groups.filter((g) => g !== primary && g.members.includes(user.id))
  ]
  const fmt = (g: AdGroup) => `${base + rid(g.id)}(${lower(g.name, domain)})`
  return `uid=${base + rid(user.id)}(${lower(user.sam, domain)}) gid=${primary ? fmt(primary) : `${base + 513}(${lower('Utilisateurs du domaine', domain)})`} groups=${groups.map(fmt).join(',')}`
}

const idTool: ToolDef = {
  name: 'id',
  synopsis: 'Affiche les identifiants d’un compte (local ou du domaine : id jdupont@lab.local).',
  run(ctx, args) {
    const name = args.find((a) => !a.startsWith('-'))
    // Comptes locaux (/etc/passwd) : id de coreutils sur le système de fichiers simulé
    if (!name?.includes('@')) return runId(ctx, args)
    // Comptes du domaine : nom qualifié (use_fully_qualified_names de sssd)
    const domain = ctx.host.host.domain ? ctx.state.domains[ctx.host.host.domain] : undefined
    const [sam, realm] = name.split('@')
    const found =
      domain && realm?.toLowerCase() === domain.name ? findPrincipal(domain, sam ?? '') : undefined
    if (!domain || found?.kind !== 'user') throw new CommandFailure(`id: '${name}': no such user`, 'NotFound')
    ctx.write(idLine(domain, found.obj))
  }
}

export const addsBashTools: ToolDef[] = [realmTool, idTool]
