/**
 * Sous-commandes de comptes de `net` : user, localgroup, group, accounts.
 *
 * Syntaxe et comportement d'après Microsoft Learn :
 * - net user : https://learn.microsoft.com/fr-fr/windows-server/administration/windows-commands/net-user
 *   (/add, /delete, /domain, /active:{yes|no}, `*` = invite de mot de passe, /fullname, /comment) ;
 * - net localgroup : https://learn.microsoft.com/fr-fr/previous-versions/windows/it-pro/windows-server-2012-r2-and-2012/cc725622(v=ws.11)
 * - net group : https://learn.microsoft.com/fr-fr/previous-versions/windows/it-pro/windows-server-2012-r2-and-2012/cc754051(v=ws.11)
 *   (sans paramètre : nom du serveur puis groupes précédés d'un astérisque, colonnes de 25) ;
 * - net accounts : https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-xp/bb490698(v=technet.10)
 *
 * ServerLab ne simule pas la base de comptes locale (SAM) des serveurs membres et des postes :
 * sans /domain, seules les opérations sur un contrôleur de domaine (qui n'a pas de comptes
 * locaux) sont simulées. Les en-têtes et libellés français des sorties ne figurent pas sur Learn
 * (« à vérifier », docs/fidelite.md, Lot 3).
 * Modifications par les actions des commandes nommées `adds.*` (objects.ts).
 */
import type { AdGroup, AdUser, Domain } from '../../model/schema'
import type { ExecContext } from '../../shell/context'
import { domainLockoutPolicy, domainPasswordPolicy } from '../gpo/scope'
import { findPrincipal, isDomainAdmin, PASSWORD_POLICY_ERROR } from './directory'
import {
  addGroup,
  addGroupMembers,
  addUser,
  removeGroupMembers,
  removeObject,
  resetPassword,
  setAccountEnabled
} from './objects'

const DONE = 'La commande s’est terminée correctement.'

function systemError(ctx: ExecContext, code: number, message: string): void {
  ctx.writeLines([`Erreur système ${code}.`, '', message, ''], 'error')
}

/** Erreur NET avec renvoi vers NET HELPMSG (format des messages NET). */
function helpMsgError(ctx: ExecContext, message: string, code: number): void {
  ctx.writeLines(
    [message, '', `Vous obtiendrez une aide supplémentaire en entrant NET HELPMSG ${code}.`, ''],
    'error'
  )
}

interface Parsed {
  values: string[]
  flags: Set<string>
  options: Map<string, string>
}

/** Arguments sans option, options sans valeur (/add) et options avec valeur (/active:no). */
function parse(args: string[]): Parsed {
  const values: string[] = []
  const flags = new Set<string>()
  const options = new Map<string, string>()
  for (const a of args) {
    if (a.startsWith('/')) {
      const i = a.indexOf(':')
      if (i > 0) options.set(a.slice(1, i).toLowerCase(), a.slice(i + 1))
      else flags.add(a.slice(1).toLowerCase())
    } else values.push(a)
  }
  return { values, flags, options }
}

/** Domaine visé ; null si l'opération porte sur la base locale (non simulée) ou est impossible. */
function targetDomain(ctx: ExecContext, p: Parsed): Domain | null {
  const name = ctx.host.host.domain
  const domain = name ? ctx.state.domains[name] : undefined
  const isDc = !!domain?.controllers.includes(ctx.deviceId)
  if (!p.flags.has('domain') && !isDc) {
    ctx.write(
      'La base de comptes locale (SAM) de cet ordinateur n’est pas simulée dans ServerLab : utilisez /domain sur un membre du domaine, ou la console d’un contrôleur de domaine.',
      'error'
    )
    return null
  }
  if (!domain || !domain.controllers.some((id) => ctx.state.devices[id]?.powered)) {
    systemError(ctx, 1355, 'Le domaine spécifié n’existe pas ou n’a pas pu être contacté.')
    return null
  }
  return domain
}

/** Contrôleur affiché dans les en-têtes (\\DC1). */
function dcName(ctx: ExecContext, domain: Domain): string {
  const id = domain.controllers.find((d) => ctx.state.devices[d]?.powered) ?? domain.controllers[0]
  return (id && ctx.state.devices[id]?.name) || ctx.host.name
}

function requireAdmin(ctx: ExecContext, domain: Domain): boolean {
  const user = ctx.user
  if (user.domain && isDomainAdmin(domain, user.name)) return true
  systemError(ctx, 5, 'Accès refusé.')
  return false
}

/** Colonnes de 25 caractères, trois par ligne (exemple « Group Accounts for » de Learn). */
function columns(names: string[]): string[] {
  const rows: string[] = []
  for (let i = 0; i < names.length; i += 3)
    rows.push(
      names
        .slice(i, i + 3)
        .map((n, j, row) => (j === row.length - 1 ? n : n.padEnd(25)))
        .join('')
    )
  return rows
}

function listing(ctx: ExecContext, title: string, names: string[]): void {
  ctx.writeLines(['', title, '', '-'.repeat(79), ...columns(names), DONE, ''])
}

/** Applique un résultat du moteur ; sinon erreur système (5 : accès refusé). */
function applyOr(
  ctx: ExecContext,
  r: { ok: true; state: ExecContext['state'] } | { ok: false; error: { code: string; message: string } },
  codes: Record<string, number> = {}
): boolean {
  if (!r.ok) {
    systemError(ctx, codes[r.error.code] ?? 2, r.error.message)
    return false
  }
  ctx.state = r.state
  return true
}

const directGroups = (domain: Domain, id: string): AdGroup[] =>
  domain.groups.filter((g) => g.members.includes(id))

const yesNo = (v: string): boolean | null =>
  /^(yes|oui)$/i.test(v) ? true : /^(no|non)$/i.test(v) ? false : null

// ---------------------------------------------------------------------------------------------
// net user

function userDetails(ctx: ExecContext, domain: Domain, u: AdUser): void {
  const groups = directGroups(domain, u.id)
  const local = groups.filter((g) => g.scope === 'DomainLocal').map((g) => `*${g.name}`)
  const global = groups.filter((g) => g.scope !== 'DomainLocal').map((g) => `*${g.name}`)
  const pad = (label: string) => label.padEnd(29)
  const multi = (label: string, names: string[]) => {
    const list = names.length === 0 ? ['*Aucun'] : names
    const rows: string[] = []
    for (let i = 0; i < list.length; i += 2)
      rows.push(
        list
          .slice(i, i + 2)
          .map((n) => n.padEnd(25))
          .join('')
          .trimEnd()
      )
    return rows.map((r, i) => `${i === 0 ? pad(label) : ' '.repeat(29)}${r}`)
  }
  ctx.writeLines([
    `${pad('Nom d’utilisateur')}${u.sam}`,
    `${pad('Nom complet')}${u.name}`,
    `${pad('Commentaire')}${u.description}`,
    `${pad('Compte : actif')}${u.enabled ? 'Oui' : 'Non'}`,
    `${pad('Le mot de passe expire')}${u.passwordNeverExpires ? 'Jamais' : 'Oui'}`,
    `${pad('Mot de passe exigé')}Oui`,
    `${pad('L’utilisateur peut changer de mot de passe')}Oui`,
    '',
    ...multi('Appartient aux groupes locaux', local),
    ...multi('Appartient aux groupes globaux', global),
    DONE,
    ''
  ])
}

export function netUser(ctx: ExecContext, args: string[]): void {
  const p = parse(args)
  const domain = targetDomain(ctx, p)
  if (!domain) return
  const [name, password] = p.values
  if (!name) {
    listing(
      ctx,
      `comptes d’utilisateurs de \\\\${dcName(ctx, domain)}`,
      [...domain.users].sort((a, b) => a.sam.localeCompare(b.sam)).map((u) => u.sam)
    )
    return
  }
  const found = findPrincipal(domain, name)
  const user = found?.kind === 'user' ? found.obj : undefined
  const active = p.options.get('active')
  const modifies =
    p.flags.has('add') || p.flags.has('delete') || password !== undefined || active !== undefined
  if (!modifies) {
    if (!user) helpMsgError(ctx, 'Le nom d’utilisateur est introuvable.', 2221)
    else userDetails(ctx, domain, user)
    return
  }
  if (!requireAdmin(ctx, domain)) return
  let secret = password
  if (secret === '*') {
    secret = ctx.ask('Tapez un mot de passe pour l’utilisateur : ', true)
    const again = ctx.ask('Retapez le mot de passe pour confirmer : ', true)
    if (again !== secret) {
      helpMsgError(ctx, 'Les mots de passe ne correspondent pas.', 2203)
      return
    }
  }
  const enabled = active === undefined ? true : yesNo(active)
  if (enabled === null) {
    ctx.write(
      'La syntaxe de cette commande est :\n\nNET USER\n[nom_utilisateur [mot_de_passe | *] [options]] [/DOMAIN]',
      'error'
    )
    return
  }
  if (p.flags.has('add')) {
    if (user) {
      helpMsgError(ctx, 'Le compte existe déjà.', 2224)
      return
    }
    const r = addUser(ctx.state, domain.name, {
      name: p.options.get('fullname') ?? name,
      sam: name,
      password: secret ?? '',
      enabled,
      description: p.options.get('comment') ?? ''
    })
    if (!r.ok) return void applyOr(ctx, r)
    if (r.value.passwordError) {
      // net user échoue entièrement (aucun compte créé) si le mot de passe est refusé
      systemError(ctx, 2245, PASSWORD_POLICY_ERROR)
      return
    }
    ctx.state = r.state
    ctx.writeLines([DONE, ''])
    return
  }
  if (!user) {
    helpMsgError(ctx, 'Le nom d’utilisateur est introuvable.', 2221)
    return
  }
  if (p.flags.has('delete')) {
    if (user.builtin) return systemError(ctx, 5, 'Accès refusé.')
    if (!applyOr(ctx, removeObject(ctx.state, domain.name, user.id))) return
    ctx.writeLines([DONE, ''])
    return
  }
  if (
    secret !== undefined &&
    !applyOr(ctx, resetPassword(ctx.state, domain.name, user.sam, secret), { PasswordPolicy: 2245 })
  )
    return
  if (active !== undefined && !applyOr(ctx, setAccountEnabled(ctx.state, domain.name, user.sam, enabled)))
    return
  ctx.writeLines([DONE, ''])
}

// ---------------------------------------------------------------------------------------------
// net localgroup / net group

function netGroups(ctx: ExecContext, args: string[], kind: 'localgroup' | 'group'): void {
  const p = parse(args)
  const domain = targetDomain(ctx, p)
  if (!domain) return
  const local = kind === 'localgroup'
  const ofKind = (g: AdGroup) => (local ? g.scope === 'DomainLocal' : g.scope !== 'DomainLocal')
  const [name, ...members] = p.values
  if (!name) {
    listing(
      ctx,
      `${local ? 'Alias pour' : 'Comptes de groupe pour'} \\\\${dcName(ctx, domain)}`,
      domain.groups
        .filter(ofKind)
        .map((g) => `*${g.name}`)
        .sort((a, b) => a.localeCompare(b, 'fr'))
    )
    return
  }
  const found = findPrincipal(domain, name)
  const group = found?.kind === 'group' && ofKind(found.obj) ? found.obj : undefined
  const add = p.flags.has('add')
  const del = p.flags.has('delete')
  const comment = p.options.get('comment')
  const missing = () =>
    helpMsgError(
      ctx,
      local ? 'Ce groupe local n’existe pas.' : 'Ce groupe est introuvable.',
      local ? 1376 : 2220
    )
  if (!add && !del && comment === undefined) {
    if (!group) return missing()
    const names = group.members
      .map(
        (id) =>
          domain.users.find((u) => u.id === id)?.sam ??
          domain.groups.find((g) => g.id === id)?.name ??
          domain.computers.find((c) => c.id === id)?.name
      )
      .filter((n): n is string => !!n)
    ctx.writeLines([
      `${(local ? 'Nom alias' : 'Nom de groupe').padEnd(16)}${group.name}`,
      `${'Commentaire'.padEnd(16)}${group.description}`,
      '',
      'Membres',
      '',
      '-'.repeat(79),
      ...columns(names),
      DONE,
      ''
    ])
    return
  }
  if (!requireAdmin(ctx, domain)) return
  if (members.length > 0) {
    if (!group) return missing()
    const r = (add ? addGroupMembers : removeGroupMembers)(ctx.state, domain.name, group.sam, members)
    if (!r.ok) {
      if (r.error.code === 'ADIdentityNotFound')
        systemError(
          ctx,
          1332,
          'Le mappage entre les noms de compte et les ID de sécurité n’a pas été effectué.'
        )
      else applyOr(ctx, r)
      return
    }
    ctx.state = r.state
    ctx.writeLines([DONE, ''])
    return
  }
  if (add) {
    if (found)
      return helpMsgError(
        ctx,
        local ? 'Le groupe spécifié existe déjà.' : 'Le groupe existe déjà.',
        local ? 1379 : 2223
      )
    if (
      !applyOr(
        ctx,
        addGroup(ctx.state, domain.name, {
          name,
          scope: local ? 'DomainLocal' : 'Global',
          description: comment ?? ''
        })
      )
    )
      return
    ctx.writeLines([DONE, ''])
    return
  }
  if (!group) return missing()
  if (del) {
    if (group.builtin) return systemError(ctx, 5, 'Accès refusé.')
    if (!applyOr(ctx, removeObject(ctx.state, domain.name, group.id))) return
    ctx.writeLines([DONE, ''])
    return
  }
  ctx.write('La modification du commentaire d’un groupe par net n’est pas simulée dans ServerLab.', 'error')
}

export const netLocalGroup = (ctx: ExecContext, args: string[]) => netGroups(ctx, args, 'localgroup')
export const netGroup = (ctx: ExecContext, args: string[]) => netGroups(ctx, args, 'group')

// ---------------------------------------------------------------------------------------------
// net accounts

export function netAccounts(ctx: ExecContext, args: string[]): void {
  const p = parse(args)
  if (p.options.size > 0 || [...p.flags].some((f) => f !== 'domain')) {
    ctx.write(
      'La modification de la stratégie de comptes par net accounts n’est pas simulée dans ServerLab : modifiez la stratégie de groupe (Default Domain Policy).',
      'error'
    )
    return
  }
  const name = ctx.host.host.domain
  const domain = name ? ctx.state.domains[name] : undefined
  if (!domain) {
    ctx.write('La stratégie de comptes locale de cet ordinateur n’est pas simulée dans ServerLab.', 'error')
    return
  }
  const pwd = domainPasswordPolicy(domain)
  const lock = domainLockoutPolicy(domain)
  const isDc = domain.controllers.includes(ctx.deviceId)
  const row = (label: string, value: string | number) => `${label.padEnd(54)}${value}`
  ctx.writeLines([
    row('Longueur minimale du mot de passe :', pwd.minLength),
    row('Seuil de verrouillage :', lock.threshold === 0 ? 'Jamais' : lock.threshold),
    row('Durée du verrouillage (minutes) :', lock.duration),
    row('Fenêtre d’observation du verrouillage (minutes) :', lock.reset),
    row('Rôle de l’ordinateur :', isDc ? 'PRINCIPAL' : 'STATION DE TRAVAIL'),
    DONE,
    ''
  ])
}
