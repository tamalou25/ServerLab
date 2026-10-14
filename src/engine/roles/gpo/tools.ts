/**
 * Outils de stratégie de groupe : gpupdate (actualisation) et gpresult (jeu de stratégie résultant).
 */
import { formatShortDate } from '../../core/clock'
import type { Domain, FilteredGpo, AppliedGpo } from '../../model/schema'
import { findContainer, groupsOf, isDomainAdmin } from '../adds/directory'
import { emptyComputerSettings, emptyUserSettings } from './defaults'
import { processGroupPolicy } from './processing'
import { describeSettings } from './settings'
import { FILTER_REASONS } from './scope'
import type { ExecContext } from '../../shell/context'
import type { ToolDef } from '../../shell/tools/types'

const LOCAL_POLICY = 'Stratégie de groupe locale'

function invalidOption(ctx: ExecContext, tool: string, option: string): void {
  ctx.writeLines(
    [
      `ERREUR : argument ou option non valide - « ${option} ».`,
      `Tapez « ${tool.toUpperCase()} /? » pour afficher la syntaxe.`
    ],
    'error'
  )
}

export const gpupdateTool: ToolDef = {
  name: 'gpupdate',
  handlesHelp: true,
  synopsis: 'Actualise les paramètres de stratégie de groupe.',
  switches: ['/force', '/target:computer', '/target:user', '/wait:0', '/logoff', '/boot', '/sync', '/?'],
  run(ctx, args) {
    let target: 'computer' | 'user' | null = null
    for (const raw of args) {
      const o = raw.toLowerCase()
      if (o === '/?') {
        ctx.writeLines([
          'Actualise les paramètres de stratégie de groupe.',
          '',
          'GPUPDATE [/Target:{Computer | User}] [/Force] [/Wait:<valeur>] [/Logoff] [/Boot] [/Sync]',
          '',
          '    /Target:{Computer | User}  Actualise uniquement les paramètres de l’ordinateur ou de l’utilisateur.',
          '    /Force                     Réapplique tous les paramètres de stratégie.',
          '    /Wait:<valeur>             Délai d’attente du traitement, en secondes.',
          '    /Logoff                    Ferme la session après l’actualisation, si nécessaire.',
          '    /Boot                      Redémarre l’ordinateur après l’actualisation, si nécessaire.',
          ''
        ])
        return
      }
      if (o.startsWith('/target:')) {
        const t = o.slice(8)
        if (t !== 'computer' && t !== 'user') return invalidOption(ctx, 'gpupdate', raw)
        target = t
      } else if (!['/force', '/logoff', '/boot', '/sync'].includes(o) && !o.startsWith('/wait:'))
        return invalidOption(ctx, 'gpupdate', raw)
    }
    ctx.writeLines(['Mise à jour de la stratégie...', ''])
    const op = processGroupPolicy(ctx.state, ctx.deviceId, {
      computer: target !== 'user',
      user: target !== 'computer'
    })
    ctx.state = op.state
    ctx.addTrace(op.trace)
    const report = (part: 'computer' | 'user') => {
      const outcome = part === 'computer' ? op.computer : op.user
      const label = part === 'computer' ? 'd’ordinateur' : 'utilisateur'
      if (outcome === 'ok') ctx.write(`La mise à jour de la stratégie ${label} s’est terminée sans erreur.`)
      else if (outcome === 'failed') {
        ctx.writeLines(
          [
            `La mise à jour de la stratégie ${label} n’a pas pu se terminer correctement. Les erreurs suivantes ont été détectées :`,
            '',
            op.error ?? ''
          ],
          'error'
        )
      }
    }
    report('computer')
    report('user')
    if (op.computer === 'failed' || op.user === 'failed')
      ctx.writeLines([
        '',
        'Pour diagnostiquer l’échec, consultez le journal des événements ou exécutez GPRESULT /R à partir de la ligne de commande pour accéder à des informations sur les résultats de la stratégie de groupe.'
      ])
    ctx.write('')
  }
}

/** Le compte de la session est-il administrateur de l'ordinateur ? */
function isAdminSession(ctx: ExecContext): boolean {
  const user = ctx.user
  if (!user.domain) return user.name.toLowerCase() === 'administrateur'
  const domain = ctx.host.host.domain ? ctx.state.domains[ctx.host.host.domain] : undefined
  return !!domain && isDomainAdmin(domain, user.name)
}

/** « 05/10/2026 à 15:16:00 ». */
function gpDate(clock: number): string {
  const [date, time] = formatShortDate(clock).split(' ')
  return `${date ?? ''} à ${time ?? ''}`
}

function line(label: string, value: string, width = 52): string {
  return `    ${`${label} :`.padEnd(width)} ${value}`
}

function gpoLists(applied: AppliedGpo[], filtered: FilteredGpo[], withLocal: boolean): string[] {
  const out = ['', '    Objets Stratégie de groupe appliqués', '    -------------------------------------']
  if (applied.length === 0) out.push('        N/A')
  for (const a of applied) out.push(`        ${a.name}`)
  out.push(
    '',
    '    Les GPO suivants n’ont pas été appliqués parce qu’ils ont été filtrés',
    '    -------------------------------------------------------------------'
  )
  const all = withLocal ? [{ name: LOCAL_POLICY, reason: FILTER_REASONS.empty }, ...filtered] : filtered
  if (all.length === 0) out.push('        N/A')
  for (const f of all) out.push(`        ${f.name}`, `            Filtrage :  ${f.reason}`, '')
  return out
}

/** Nom d'affichage d'un groupe (BUILTIN\… pour les groupes intégrés, sinon DOMAINE\…). */
function groupLabel(domain: Domain, group: { name: string; parentId: string }): string {
  return findContainer(domain, group.parentId)?.name === 'Builtin'
    ? `BUILTIN\\${group.name}`
    : `${domain.netbios}\\${group.name}`
}

function settingsBlock(title: string, lines: ReturnType<typeof describeSettings>): string[] {
  const out = ['', `    ${title}`, `    ${'-'.repeat(title.length)}`]
  if (lines.length === 0) out.push('        N/A')
  let category = ''
  for (const l of lines) {
    if (l.category !== category) {
      category = l.category
      out.push(`        ${category}`)
    }
    out.push(
      `            Paramètre de stratégie : ${l.label}`,
      `            Valeur :                 ${l.value}`,
      ''
    )
  }
  return out
}

export const gpresultTool: ToolDef = {
  name: 'gpresult',
  handlesHelp: true,
  synopsis: 'Affiche le jeu de stratégie résultant (RSoP) de l’ordinateur et de l’utilisateur.',
  switches: ['/r', '/v', '/z', '/scope', 'user', 'computer', '/user', '/h', '/?'],
  run(ctx, args) {
    const opts = args.map((a) => a.toLowerCase())
    let scope: 'user' | 'computer' | null = null
    let verbose = false
    let summary = false
    for (let i = 0; i < opts.length; i++) {
      const o = opts[i] as string
      if (o === '/?') {
        summary = false
        verbose = false
        break
      }
      if (o === '/r') summary = true
      else if (o === '/v' || o === '/z') verbose = true
      else if (o === '/scope') {
        const value = opts[++i]
        if (value !== 'user' && value !== 'computer')
          return invalidOption(ctx, 'gpresult', args[i] ?? '/scope')
        scope = value
      } else if (o === '/user') {
        const wanted = (args[++i] ?? '').toLowerCase()
        const current = `${(ctx.user.domain ?? ctx.host.name).toLowerCase()}\\${ctx.user.name.toLowerCase()}`
        if (wanted !== current && wanted !== ctx.user.name.toLowerCase()) {
          ctx.write(`INFO : L’utilisateur « ${args[i] ?? ''} » n’a pas de données RSoP.`)
          return
        }
      } else if (o === '/h' || o === '/x') {
        ctx.write(
          'ERREUR : la génération de rapports HTML ou XML n’est pas disponible dans le simulateur. Utilisez /R ou /V.',
          'error'
        )
        return
      } else return invalidOption(ctx, 'gpresult', args[i] ?? o)
    }
    if (!summary && !verbose) {
      ctx.writeLines([
        '',
        'GPRESULT [/S système [/U nom_utilisateur [/P [mot_de_passe]]]] [/SCOPE étendue]',
        '         [/USER nom_utilisateur_cible] [/R | /V | /Z] [(/X | /H) <nom_fichier> [/F]]',
        '',
        'Description :',
        '    Affiche les informations du jeu de stratégie résultant (RSoP) pour un utilisateur',
        '    et un ordinateur cibles.',
        '',
        'Liste de paramètres :',
        '    /SCOPE   étendue      Affiche les paramètres USER ou COMPUTER.',
        '    /USER    utilisateur  Spécifie le nom de l’utilisateur dont les données RSoP doivent être affichées.',
        '    /R                    Affiche les données de synthèse RSoP.',
        '    /V                    Affiche les informations détaillées de la stratégie.',
        '    /Z                    Affiche toutes les informations disponibles.',
        ''
      ])
      return
    }

    const host = ctx.host
    const admin = isAdminSession(ctx)
    if (scope === 'computer' && !admin) {
      ctx.write('ERREUR : Accès refusé.', 'error')
      return
    }
    const domain = host.host.domain ? ctx.state.domains[host.host.domain] : undefined
    const user = ctx.user
    const account = `${user.domain ?? host.name}\\${user.name}`
    const isDc = !!domain && domain.controllers.includes(host.id)
    const role = isDc
      ? 'Contrôleur de domaine principal'
      : host.kind === 'server'
        ? domain
          ? 'Serveur membre'
          : 'Serveur autonome'
        : domain
          ? 'Station de travail membre'
          : 'Station de travail autonome'
    const out: string[] = [
      '',
      'Outil de résultat de la stratégie de groupe v2.0 (ServerLab)',
      '',
      `Créé le ${gpDate(ctx.state.clock)}`,
      '',
      '',
      `Données RSOP pour ${account} sur ${host.name} : Mode de journalisation`,
      '-'.repeat(`Données RSOP pour ${account} sur ${host.name} : Mode de journalisation`.length),
      '',
      `${'Configuration de l’OS :'.padEnd(40)}${role}`,
      `${'Version du système d’exploitation :'.padEnd(40)}${host.kind === 'server' ? '10.0.20348' : '10.0.19045'}`,
      `${'Nom du site :'.padEnd(40)}${domain ? 'Default-First-Site-Name' : 'N/A'}`,
      `${'Profil itinérant :'.padEnd(40)}N/A`,
      `${'Profil local :'.padEnd(40)}C:\\Users\\${user.name}`,
      `${'Connexion via une liaison lente ? :'.padEnd(40)}Non`,
      ''
    ]

    // Paramètres de l'ordinateur (réservés aux administrateurs)
    if (admin && scope !== 'user') {
      out.push('', 'PARAMÈTRES DE L’ORDINATEUR', '---------------------------')
      const computer = host.host.policy.computer
      if (!domain) {
        out.push(
          line('Dernière application de la stratégie de groupe', gpDate(host.host.bootedAt)),
          line('Stratégie de groupe appliquée depuis', 'N/A'),
          line('Nom de domaine', host.name),
          line('Type de domaine', '<ordinateur local>'),
          ...gpoLists([], [], true)
        )
      } else if (!computer) {
        out.push(`    INFO : L’ordinateur « ${host.name} » n’a pas de données RSoP.`)
      } else {
        const computerObj = domain.computers.find((c) => c.deviceId === host.id)
        out.push(
          `    ${computer.dn}`,
          line('Dernière application de la stratégie de groupe', gpDate(computer.time)),
          line('Stratégie de groupe appliquée depuis', computer.source),
          line('Seuil de liaison lente de la stratégie de groupe', '500 kbps'),
          line('Nom de domaine', domain.netbios),
          line('Type de domaine', 'Active Directory'),
          ...gpoLists(computer.applied, computer.filtered, true),
          '    L’ordinateur fait partie des groupes de sécurité suivants',
          '    ---------------------------------------------------------',
          '        BUILTIN\\Administrateurs',
          '        Tout le monde',
          '        BUILTIN\\Utilisateurs',
          '        AUTORITE NT\\RÉSEAU',
          '        AUTORITE NT\\Utilisateurs authentifiés',
          '        Cette organisation',
          `        ${host.name}$`,
          ...(computerObj
            ? groupsOf(domain, computerObj.id).map((g) => `        ${groupLabel(domain, g)}`)
            : []),
          '        Niveau obligatoire système'
        )
        if (verbose)
          out.push(
            ...settingsBlock(
              'Jeu de stratégie résultant pour l’ordinateur',
              describeSettings('computer', computer.settings, emptyUserSettings())
            )
          )
      }
      out.push('')
    }

    // Paramètres de l'utilisateur
    if (scope !== 'computer') {
      out.push('', 'PARAMÈTRES UTILISATEUR', '-----------------------')
      const result = host.host.policy.user
      if (!domain || !user.domain) {
        out.push(
          `    ${host.name}\\${user.name}`,
          line('Dernière application de la stratégie de groupe', gpDate(host.host.bootedAt)),
          line('Stratégie de groupe appliquée depuis', 'N/A'),
          line('Nom de domaine', host.name),
          line('Type de domaine', '<ordinateur local>'),
          ...gpoLists([], [], true)
        )
      } else if (!result) {
        out.push(`    INFO : L’utilisateur « ${account} » n’a pas de données RSoP.`)
      } else {
        const userObj = domain.users.find((u) => u.sam.toLowerCase() === user.name.toLowerCase())
        out.push(
          `    ${result.dn}`,
          line('Dernière application de la stratégie de groupe', gpDate(result.time)),
          line('Stratégie de groupe appliquée depuis', result.source),
          line('Seuil de liaison lente de la stratégie de groupe', '500 kbps'),
          line('Nom de domaine', domain.netbios),
          line('Type de domaine', 'Active Directory'),
          ...gpoLists(result.applied, result.filtered, true),
          '    L’utilisateur fait partie des groupes de sécurité suivants',
          '    ----------------------------------------------------------',
          ...(userObj ? groupsOf(domain, userObj.id).map((g) => `        ${groupLabel(domain, g)}`) : []),
          '        Tout le monde',
          '        AUTORITE NT\\INTERACTIF',
          '        OUVERTURE DE SESSION DE CONSOLE',
          '        AUTORITE NT\\Utilisateurs authentifiés',
          '        Cette organisation',
          '        LOCAL',
          '        Niveau obligatoire moyen'
        )
        if (verbose)
          out.push(
            ...settingsBlock(
              'Jeu de stratégie résultant pour l’utilisateur',
              describeSettings('user', emptyComputerSettings(), result.settings)
            )
          )
      }
      out.push('')
    }
    ctx.writeLines(out)
  }
}
