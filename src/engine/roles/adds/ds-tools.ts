/**
 * Outils en ligne de commande d'Active Directory : dcdiag, dsquery (user, computer, ou), dsadd user.
 *
 * Sources Microsoft Learn :
 * - dcdiag : https://learn.microsoft.com/fr-fr/windows-server/administration/windows-commands/dcdiag
 *   (sortie d'exemple en anglais « Directory Server Diagnosis », « Starting test: X »,
 *   « ......................... NOM passed test X » ; test DNS non exécuté par défaut, /test:DNS) ;
 * - dsquery user / computer / ou :
 *   https://learn.microsoft.com/fr-fr/previous-versions/windows/it-pro/windows-server-2012-r2-and-2012/cc725702(v=ws.11),
 *   cc730720(v=ws.11), cc770509(v=ws.11) (-o dn|rdn|upn|samid, -name, -samid, -scope, -limit 100
 *   par défaut, 0 = tout, StartNode domainroot par défaut) ;
 * - dsadd user : …/cc731279(v=ws.11) (UserDN obligatoire, -samid, -upn, -fn, -ln, -display,
 *   -pwd {mot de passe | *}, -desc, -mustchpwd, -disabled {yes|no}, compte désactivé par défaut).
 * Libellé « failed test » de dcdiag, réussite / échec de dsadd et guillemets de dsquery -o samid :
 * à vérifier (docs/fidelite.md, Lot 3). Création par l'action de la commande nommée `adds.addUser`.
 */
import type { Domain } from '../../model/schema'
import type { ExecContext } from '../../shell/context'
import type { ToolDef } from '../../shell/tools/types'
import { firstAddress, resolveName } from '../dns/resolver'
import { allObjects, isDomainAdmin, objectDn, resolveContainerDn, type AdObject } from './directory'
import { addUser } from './objects'
import { replicationAttempt, replicationConnections } from './replication'
import { addressOf, dcSite } from './sites'

const OLD =
  'https://learn.microsoft.com/fr-fr/previous-versions/windows/it-pro/windows-server-2012-r2-and-2012/'
const hasTools = (ctx: ExecContext) => ctx.host.host.features.includes('RSAT-ADDS')

function domainOf(ctx: ExecContext, tool: string): Domain | null {
  const name = ctx.host.host.domain
  const domain = name ? ctx.state.domains[name] : undefined
  if (!domain || !domain.controllers.some((id) => ctx.state.devices[id]?.powered)) {
    ctx.write(`${tool} échec:Le domaine spécifié n’existe pas ou n’a pas pu être contacté.`, 'error')
    return null
  }
  return domain
}

// ---------------------------------------------------------------------------------------------
// dcdiag

interface TestResult {
  name: string
  ok: boolean
}

function dcTests(
  ctx: ExecContext,
  domain: Domain,
  dcId: string,
  withDns: boolean
): { initial: TestResult; primary: TestResult[] } {
  const dc = ctx.state.devices[dcId]
  const dcName = dc?.name ?? dcId
  const fqdn = `${dcName.toLowerCase()}.${domain.name}`
  const ip = addressOf(ctx.state, dcId)
  // Connectivity : le contrôleur est allumé, adressé et son nom est résolu par le DNS
  const resolved = resolveName(ctx.state, ctx.deviceId, fqdn)
  ctx.addTrace(resolved.trace)
  const connectivity = !!dc?.powered && !!ip && firstAddress(resolved) === ip
  // Advertising : enregistrements SRV du localisateur (_ldap._tcp.dc._msdcs.<domaine>)
  const srv = resolveName(ctx.state, ctx.deviceId, `_ldap._tcp.dc._msdcs.${domain.name}`, 'SRV')
  ctx.addTrace(srv.trace)
  const advertising =
    connectivity &&
    srv.result.kind === 'answer' &&
    srv.result.records.some((r) => r.type === 'SRV' && r.data.toLowerCase().includes(`${fqdn}.`))
  // Replications : chaque partenaire entrant est joignable
  const partners = replicationConnections(domain).filter((c) => c.dcId === dcId)
  const replications =
    connectivity && partners.every((c) => replicationAttempt(ctx.state, c.dcId, c.partnerId))
  // Services : services du contrôleur présents (rôle AD DS installé, DNS si le serveur est DNS)
  const features = dc && (dc.kind === 'server' || dc.kind === 'client') ? dc.host.features : []
  const services = connectivity && features.includes('AD-Domain-Services')
  const primary: TestResult[] = [
    { name: 'Advertising', ok: advertising },
    { name: 'Replications', ok: replications },
    { name: 'Services', ok: services }
  ]
  if (withDns) primary.push({ name: 'DNS', ok: connectivity && advertising })
  return { initial: { name: 'Connectivity', ok: connectivity }, primary }
}

const testLine = (target: string, t: TestResult) => [
  `      Starting test: ${t.name}`,
  `         ......................... ${target} ${t.ok ? 'passed' : 'failed'} test ${t.name}`
]

export const dcdiagTool: ToolDef = {
  name: 'dcdiag',
  synopsis: 'Diagnostique un contrôleur de domaine (Connectivity, Advertising, Replications, Services, DNS).',
  switches: ['/s:', '/test:', '/q', '/v'],
  available: hasTools,
  help: {
    syntax: [
      'dcdiag [/s:<DomainController>] [/n:<NamingContext>] [/u:<Domain>\\<UserName> /p:{* | <Password> | ""}] [{/a | /e}] [{/q | /v}] [/i] [/f:<LogFile>] [/c [/skip:<Test>]] [/test:<Test>] [/fix] [{/h | /?}] [/ReplSource:<SourceDomainController>]'
    ],
    url: 'https://learn.microsoft.com/fr-fr/windows-server/administration/windows-commands/dcdiag'
  },
  run(ctx, args) {
    const domain = domainOf(ctx, 'dcdiag')
    if (!domain) return
    let target: string | undefined
    let only: string | undefined
    for (const a of args) {
      const l = a.toLowerCase()
      if (l.startsWith('/s:')) target = a.slice(3)
      else if (l.startsWith('/test:')) only = a.slice(6).toLowerCase()
      else if (l === '/q' || l === '/v') continue
      else {
        ctx.write(`L’option ${a} de dcdiag n’est pas simulée dans ServerLab.`, 'error')
        return
      }
    }
    const known = ['connectivity', 'advertising', 'replications', 'services', 'dns']
    if (only && !known.includes(only)) {
      ctx.write(
        `Le test « ${only} » de dcdiag n’est pas simulé dans ServerLab (${known.join(', ')}).`,
        'error'
      )
      return
    }
    const dcId = target
      ? domain.controllers.find((id) => ctx.state.devices[id]?.name.toLowerCase() === target?.toLowerCase())
      : domain.controllers.includes(ctx.deviceId)
        ? ctx.deviceId
        : domain.controllers.find((id) => ctx.state.devices[id]?.powered)
    if (!dcId) {
      ctx.write(`dcdiag : le contrôleur de domaine « ${target ?? ''} » est introuvable.`, 'error')
      return
    }
    const name = ctx.state.devices[dcId]?.name ?? dcId
    const upper = name.toUpperCase()
    const site = dcSite(domain, dcId)
    const { initial, primary } = dcTests(ctx, domain, dcId, only === 'dns')
    const selected =
      only && only !== 'connectivity' ? primary.filter((t) => t.name.toLowerCase() === only) : primary
    ctx.writeLines([
      '',
      'Directory Server Diagnosis',
      '',
      'Performing initial setup:',
      '   Trying to find home server...',
      `   Home Server = ${name}`,
      '   * Identified AD Forest. ',
      '   Done gathering initial info.',
      '',
      'Doing initial required tests',
      '',
      `   Testing server: ${site}\\${upper}`,
      ...testLine(upper, initial),
      '',
      ...(only === 'connectivity'
        ? []
        : [
            'Doing primary tests',
            '',
            `   Testing server: ${site}\\${upper}`,
            ...selected.flatMap((t) => testLine(upper, t))
          ]),
      ''
    ])
  }
}

// ---------------------------------------------------------------------------------------------
// dsquery

/** Filtre de nom dsquery (* générique), insensible à la casse. */
const matches = (pattern: string, value: string) =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i').test(value)

/** Le conteneur `id` est-il sous `startId` (null = racine du domaine) ? */
function under(domain: Domain, id: string | null, startId: string | null, scope: string): boolean {
  if (scope === 'onelevel') return id === startId
  if (startId === null) return true
  let current = id
  while (current !== null) {
    if (current === startId) return true
    current = domain.containers.find((c) => c.id === current)?.parentId ?? null
  }
  return false
}

export const dsqueryTool: ToolDef = {
  name: 'dsquery',
  synopsis: 'Recherche des utilisateurs, ordinateurs ou unités d’organisation de l’annuaire.',
  switches: ['user', 'computer', 'ou', '-name', '-samid', '-o', '-scope', '-limit'],
  available: hasTools,
  help: {
    syntax: [
      'dsquery user [{<StartNode> | forestroot | domainroot}] [-o {dn | rdn | upn | samid}] [-scope {subtree | onelevel | base}] [-name <Name>] [-desc <Description>] [-upn <UPN>] [-samid <SAMName>] [-disabled] [-limit <NumberOfObjects>]',
      'dsquery computer [{<StartNode> | forestroot | domainroot}] [-o {dn | rdn | samid}] [-scope {subtree | onelevel | base}] [-name <Name>] [-desc <Description>] [-samid <SAMName>] [-disabled] [-limit <NumberOfObjects>]',
      'dsquery ou [{<StartNode> | forestroot | domainroot}] [-o {dn | rdn}][-scope {subtree | onelevel | base}][-name <Name] [-desc <Description>] [-limit <NumberOfObjects>]'
    ],
    url: `${OLD}cc732952(v=ws.11)`
  },
  run(ctx, args) {
    const [kind = '', ...rest] = args.map((a) => a)
    const k = kind.toLowerCase()
    if (k !== 'user' && k !== 'computer' && k !== 'ou') {
      ctx.write(
        `dsquery échec:« ${kind} » n’est pas un type d’objet simulé dans ServerLab (user, computer, ou).`,
        'error'
      )
      return
    }
    const domain = domainOf(ctx, 'dsquery')
    if (!domain) return
    const opts: Record<string, string> = {}
    const flags = new Set<string>()
    let start: string | undefined
    const withValue = ['o', 'scope', 'name', 'samid', 'desc', 'upn', 'limit']
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i] as string
      if (a.startsWith('-')) {
        const key = a.slice(1).toLowerCase()
        if (withValue.includes(key)) opts[key] = rest[++i] ?? ''
        else if (key === 'disabled') flags.add(key)
        else {
          ctx.write(`dsquery échec:L’option ${a} n’est pas simulée dans ServerLab.`, 'error')
          return
        }
      } else start = a
    }
    const format = (opts['o'] ?? 'dn').toLowerCase()
    const allowed =
      k === 'user' ? ['dn', 'rdn', 'upn', 'samid'] : k === 'computer' ? ['dn', 'rdn', 'samid'] : ['dn', 'rdn']
    const scope = (opts['scope'] ?? 'subtree').toLowerCase()
    const limit = opts['limit'] === undefined ? 100 : Number(opts['limit'])
    if (
      !allowed.includes(format) ||
      !['subtree', 'onelevel', 'base'].includes(scope) ||
      !Number.isInteger(limit) ||
      limit < 0
    ) {
      ctx.write('dsquery échec:Valeur de paramètre non valide.', 'error')
      return
    }
    let startId: string | null = null
    if (start && !['domainroot', 'forestroot'].includes(start.toLowerCase())) {
      const resolved = resolveContainerDn(domain, start)
      if (resolved === undefined) {
        ctx.write(`dsquery échec:L’objet de répertoire « ${start} » est introuvable.`, 'error')
        return
      }
      startId = resolved
    }
    const want = k === 'ou' ? 'container' : k
    const found = allObjects(domain).filter((o): o is AdObject => {
      if (o.kind !== want) return false
      if (o.kind === 'container' && o.obj.kind !== 'ou') return false
      if (scope === 'base') return o.obj.id === startId
      const parent = o.obj.parentId ?? null
      if (!under(domain, parent, startId, scope)) return false
      if (opts['name'] && !matches(opts['name'], o.obj.name)) return false
      const sam = o.kind === 'user' ? o.obj.sam : o.kind === 'computer' ? `${o.obj.name}$` : ''
      if (opts['samid'] && !matches(opts['samid'], sam)) return false
      if (opts['desc'] && !matches(opts['desc'], 'description' in o.obj ? (o.obj.description ?? '') : ''))
        return false
      if (opts['upn'] && !(o.kind === 'user' && matches(opts['upn'], o.obj.upn))) return false
      if (flags.has('disabled') && !(o.kind !== 'container' && 'enabled' in o.obj && !o.obj.enabled))
        return false
      return true
    })
    const shown = limit === 0 ? found : found.slice(0, limit)
    ctx.writeLines(
      shown.map((o) => {
        if (format === 'rdn') return `"${o.obj.name}"`
        if (format === 'samid') return `"${o.kind === 'user' ? o.obj.sam : `${o.obj.name}$`}"`
        if (format === 'upn') return `"${o.kind === 'user' ? o.obj.upn : ''}"`
        return `"${objectDn(domain, o)}"`
      })
    )
  }
}

// ---------------------------------------------------------------------------------------------
// dsadd user

/** « CN=Marie Martin,OU=Compta,DC=lab,DC=local » → nom et conteneur parent (DN). */
function splitDn(dn: string): { name: string; parent: string } | null {
  const m = /^\s*cn=((?:\\,|[^,])+),(.+)$/i.exec(dn)
  return m ? { name: (m[1] as string).replace(/\\,/g, ','), parent: (m[2] as string).trim() } : null
}

export const dsaddTool: ToolDef = {
  name: 'dsadd',
  synopsis: 'Ajoute un utilisateur à l’annuaire (dsadd user).',
  switches: ['user', '-samid', '-upn', '-fn', '-ln', '-display', '-pwd', '-desc', '-mustchpwd', '-disabled'],
  available: hasTools,
  help: {
    syntax: [
      'dsadd user <UserDN> [-samid <SAMName>] [-upn <UPN>] [-fn <FirstName>] [-mi <Initial>] [-ln <LastName>] [-display <DisplayName>] [-pwd {<Password> | *}] [-desc <Description>] [-mustchpwd {yes | no}] [-pwdneverexpires {yes | no}] [-disabled {yes | no}]'
    ],
    url: `${OLD}cc731279(v=ws.11)`
  },
  run(ctx, args) {
    const [kind = '', dn = '', ...rest] = args
    if (kind.toLowerCase() !== 'user') {
      ctx.write(`dsadd échec:« ${kind} » n’est pas un type d’objet simulé dans ServerLab (user).`, 'error')
      return
    }
    const parts = splitDn(dn)
    if (!parts) {
      ctx.write(`dsadd échec:${dn}:Nom unique (DN) non valide.`, 'error')
      return
    }
    const opts: Record<string, string> = {}
    for (let i = 0; i < rest.length; i++) {
      const a = (rest[i] as string).replace(/^[–—]/, '-')
      if (!a.startsWith('-')) {
        ctx.write(`dsadd échec:Paramètre non valide « ${a} ».`, 'error')
        return
      }
      const key = a.slice(1).toLowerCase()
      if (
        ![
          'samid',
          'upn',
          'fn',
          'ln',
          'display',
          'pwd',
          'desc',
          'mustchpwd',
          'disabled',
          'pwdneverexpires'
        ].includes(key)
      ) {
        ctx.write(`dsadd échec:L’option ${a} n’est pas simulée dans ServerLab.`, 'error')
        return
      }
      opts[key] = rest[++i] ?? ''
    }
    const yes = (v: string | undefined, def: boolean) => (v === undefined ? def : /^yes$/i.test(v))
    const domain = domainOf(ctx, 'dsadd')
    if (!domain) return
    const user = ctx.user
    if (!user.domain || !isDomainAdmin(domain, user.name)) {
      ctx.write(`dsadd échec:${dn}:Accès refusé.`, 'error')
      return
    }
    if (resolveContainerDn(domain, parts.parent) === undefined) {
      ctx.write(`dsadd échec:${dn}:Le conteneur « ${parts.parent} » est introuvable.`, 'error')
      return
    }
    let password = opts['pwd']
    if (password === '*') password = ctx.ask('Entrez le mot de passe : ', true)
    const r = addUser(ctx.state, domain.name, {
      name: opts['display'] ?? parts.name,
      sam: opts['samid'] ?? parts.name,
      ...(opts['upn'] ? { upn: opts['upn'] } : {}),
      ...(opts['fn'] ? { givenName: opts['fn'] } : {}),
      ...(opts['ln'] ? { surname: opts['ln'] } : {}),
      ...(opts['desc'] ? { description: opts['desc'] } : {}),
      path: parts.parent,
      password: password ?? '',
      // Learn : compte désactivé par défaut (-disabled yes)
      enabled: !yes(opts['disabled'], true),
      mustChangePassword: yes(opts['mustchpwd'], false),
      passwordNeverExpires: yes(opts['pwdneverexpires'], false)
    })
    if (!r.ok) {
      ctx.write(`dsadd échec:${dn}:${r.error.message}`, 'error')
      return
    }
    if (r.value.passwordError) {
      ctx.write(`dsadd échec:${dn}:${r.value.passwordError}`, 'error')
      return
    }
    ctx.state = r.state
    const created = ctx.state.domains[domain.name]
    const obj = created?.users.find((u) => u.id === r.value.id)
    ctx.write(`dsadd réussite:${obj && created ? objectDn(created, { kind: 'user', obj }) : dn}`)
  }
}

export const dsTools: ToolDef[] = [dcdiagTool, dsqueryTool, dsaddTool]
