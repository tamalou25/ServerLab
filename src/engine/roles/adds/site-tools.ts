/**
 * Outils des contrôleurs de domaine : repadmin (état et déclenchement de la réplication),
 * netdom query fsmo (détenteurs des rôles), nltest /dsgetdc (contrôleur et site du client).
 */
import { formatShortDate } from '../../core/clock'
import type { Domain } from '../../model/schema'
import { FSMO_ROLES } from '../../model/schema'
import type { ExecContext } from '../../shell/context'
import { CommandFailure } from '../../shell/context'
import type { ToolDef } from '../../shell/tools/types'
import { FSMO_LABELS, fsmoHolder } from './fsmo'
import { locateDc } from './locator'
import { syncDomain } from './replication'
import { addressOf, dcSite, siteOfAddress } from './sites'

const hasTools = (ctx: ExecContext) => ctx.host.host.features.includes('RSAT-ADDS')

function domainOf(ctx: ExecContext): Domain {
  const name = ctx.host.host.domain
  const domain = name ? ctx.state.domains[name] : undefined
  if (!domain) throw new CommandFailure('Cet ordinateur n’est membre d’aucun domaine.', 'NotDomainMember')
  return domain
}

const nameOf = (ctx: ExecContext, id: string) => ctx.state.devices[id]?.name ?? id

/** repadmin /replsummary, /showrepl, /syncall. */
export const repadminTool: ToolDef = {
  name: 'repadmin',
  synopsis: 'Diagnostique et déclenche la réplication Active Directory.',
  switches: ['/replsummary', '/showrepl', '/syncall'],
  available: hasTools,
  run(ctx, args) {
    const domain = domainOf(ctx)
    const op = (args[0] ?? '').toLowerCase()
    const when = (t: number | null) => (t === null ? 'jamais' : formatShortDate(t))
    if (op === '/syncall') {
      const r = syncDomain(ctx.state, domain.name)
      if (!r.ok) throw new CommandFailure(r.error.message, r.error.code)
      ctx.state = r.state
      for (const e of r.value.errors)
        ctx.write(
          `Erreur de réplication de ${nameOf(ctx, e.partnerId)} vers ${nameOf(ctx, e.dcId)} : ${e.result} (le serveur RPC n’est pas disponible).`,
          'error'
        )
      ctx.write(
        r.value.errors.length === 0
          ? 'SyncAll s’est terminé sans erreur.'
          : 'SyncAll s’est terminé avec des erreurs.'
      )
      return
    }
    const status = domain.replication.status
    if (op === '/showrepl') {
      const target = args[1]?.toLowerCase()
      const dcId =
        domain.controllers.find((id) => nameOf(ctx, id).toLowerCase() === target) ??
        domain.controllers.find((id) => id === ctx.deviceId) ??
        domain.controllers[0] ??
        ''
      ctx.writeLines([
        `${dcSite(domain, dcId)}\\${nameOf(ctx, dcId)}`,
        '',
        '==== VOISINS ENTRANTS ======================================',
        ''
      ])
      const inbound = status.filter((s) => s.dcId === dcId)
      if (inbound.length === 0) ctx.write('Aucun voisin entrant.')
      for (const s of inbound)
        ctx.writeLines([
          domain.name
            .split('.')
            .map((p) => `DC=${p}`)
            .join(','),
          `    ${dcSite(domain, s.partnerId)}\\${nameOf(ctx, s.partnerId)} via RPC`,
          s.result === 0
            ? `        La dernière tentative @ ${when(s.lastAttempt)} a réussi.`
            : `        La dernière tentative @ ${when(s.lastAttempt)} a échoué, résultat ${s.result} : le serveur RPC n’est pas disponible.\n        ${s.failures} échec(s) consécutif(s). Dernière réussite @ ${when(s.lastSuccess)}.`,
          ''
        ])
      return
    }
    if (op !== '/replsummary')
      throw new CommandFailure(
        'Syntaxe : repadmin /replsummary | /showrepl [DC] | /syncall',
        'InvalidArgument'
      )
    const rows = (key: 'dcId' | 'partnerId') =>
      domain.controllers.map((id) => {
        const mine = status.filter((s) => s[key] === id)
        const fails = mine.filter((s) => s.result !== 0).length
        const pct = mine.length ? Math.round((fails / mine.length) * 100) : 0
        return ` ${nameOf(ctx, id).padEnd(20)}${String(fails).padStart(5)} / ${String(mine.length).padStart(3)}${String(pct).padStart(6)}${fails ? '  1722' : ''}`
      })
    ctx.writeLines([
      `Heure de début de la synthèse de réplication : ${formatShortDate(ctx.state.clock)}`,
      '',
      'DSA source           échecs/total  %%  erreur',
      ...rows('partnerId'),
      '',
      'DSA de destination   échecs/total  %%  erreur',
      ...rows('dcId')
    ])
  }
}

/** netdom query fsmo. */
export const netdomTool: ToolDef = {
  name: 'netdom',
  synopsis: 'Gère les domaines ; « netdom query fsmo » liste les maîtres d’opérations.',
  available: hasTools,
  run(ctx, args) {
    if ((args[0] ?? '').toLowerCase() !== 'query' || (args[1] ?? '').toLowerCase() !== 'fsmo')
      throw new CommandFailure('Syntaxe simulée : netdom query fsmo', 'InvalidArgument')
    const domain = domainOf(ctx)
    for (const role of FSMO_ROLES) {
      const id = fsmoHolder(domain, role)
      ctx.write(`${FSMO_LABELS[role].padEnd(42)}${id ? `${nameOf(ctx, id)}.${domain.name}` : ''}`)
    }
    ctx.write('La commande s’est terminée correctement.')
  }
}

/** nltest /dsgetdc:<domaine> : contrôleur localisé et sites. */
export const nltestTool: ToolDef = {
  name: 'nltest',
  synopsis: 'Localise un contrôleur de domaine (/dsgetdc:domaine).',
  switches: ['/dsgetdc:'],
  run(ctx, args) {
    const m = /^\/dsgetdc:(.+)$/i.exec(args[0] ?? '')
    if (!m?.[1]) throw new CommandFailure('Syntaxe simulée : nltest /dsgetdc:<domaine>', 'InvalidArgument')
    const traces: Parameters<typeof locateDc>[3] = []
    const located = locateDc(ctx.state, ctx.deviceId, m[1], traces)
    for (const t of traces) ctx.addTrace(t)
    if (!located) {
      // Aucun contrôleur ne répond (domaine inconnu, éteint, NTDS ou Netlogon arrêté) : 1355
      // (docs/captures/cmd/nltest-dsgetdc-echec.txt)
      ctx.writeLines(
        [
          'Échec de l’obtention du nom du DC : état = 1355 0x54b ERROR_NO_SUCH_DOMAIN',
          'Le domaine spécifié n’existe pas ou n’a pas pu être contacté.'
        ],
        'error'
      )
      return
    }
    const domain = located.domain
    const ip = addressOf(ctx.state, ctx.deviceId)
    ctx.writeLines([
      `           DC : \\\\${nameOf(ctx, located.dcId)}.${domain.name}`,
      `      Adresse : \\\\${located.dcIp}`,
      `  Nom de domaine : ${domain.name}`,
      `  Nom de forêt : ${domain.name}`,
      `  Nom du site du DC : ${dcSite(domain, located.dcId)}`,
      `  Nom de notre site : ${(ip && siteOfAddress(domain, ip)) || '(aucun)'}`,
      'La commande s’est correctement déroulée'
    ])
  }
}
