/**
 * Pannes de stratégie de groupe (chantier D, #230) : la GPO ne s'applique plus à un utilisateur.
 * - `win.gpo-unlinked` : la liaison de la GPO a été supprimée (`gpo.unlink`) ;
 * - `win.gpo-filtered` : « Utilisateurs authentifiés » a été retiré du filtrage de sécurité
 *   (`gpo.setSecurityFilter`) : plus personne n'a le droit d'appliquer la GPO.
 * Symptôme : la GPO n'est plus dans les stratégies appliquées de l'utilisateur après `gpupdate`
 * (`gpresult`, sortie existante : liste des GPO appliquées / filtrées). Il n'est observable que si le
 * poste atteint un contrôleur : sinon `gpupdate` échoue avant (événement 1129, A-22).
 */
import { command } from '../../commands/catalog'
import { AUTHENTICATED_USERS_SID, type Domain, type LabState } from '../../model/schema'
import { locateDc } from '../../roles/adds/locator'
import { userRsop } from '../../roles/gpo/scope'
import type { FaultDef, FaultTargetParams } from '../types'
import { firstViable } from './viable'

const domainOf = (state: LabState, p: FaultTargetParams): Domain | undefined =>
  state.domains[String(p['domain'])]

/** La GPO s'applique-t-elle à l'utilisateur d'après la stratégie résultante ? */
function applies(state: LabState, p: FaultTargetParams): boolean {
  const domain = domainOf(state, p)
  const user = domain?.users.find((u) => u.sam === p['sam'])
  return !!domain && !!user && userRsop(domain, user).applied.some((a) => a.gpo.id === String(p['gpo']))
}

/** Le poste atteint-il un contrôleur (donc `gpupdate` et `gpresult` aboutissent) ? */
const refreshable = (state: LabState, p: FaultTargetParams): boolean =>
  locateDc(state, String(p['client']), String(p['domain']), []) !== null

/** GPO à paramètres utilisateur, liée à la racine ou à une OU, qui s'applique à un utilisateur. */
function candidates(state: LabState, filtered: boolean): FaultTargetParams[] {
  const out: FaultTargetParams[] = []
  for (const domain of Object.values(state.domains)) {
    const targets: { id: string | null; links: Domain['gpLinks'] }[] = [
      { id: null, links: domain.gpLinks },
      ...domain.containers.filter((c) => c.kind === 'ou').map((c) => ({ id: c.id, links: c.gpLinks }))
    ]
    const clients = Object.values(state.devices).filter(
      (d) =>
        (d.kind === 'client' || d.kind === 'server') &&
        d.powered &&
        d.host.domain === domain.name &&
        !domain.controllers.includes(d.id)
    )
    for (const { id: target, links } of targets)
      links.forEach((link, index) => {
        const gpo = domain.gpos.find((g) => g.id === link.gpoId)
        if (!gpo || !link.enabled || gpo.userVersion === 0 || gpo.status === 'AllSettingsDisabled') return
        if (filtered && !gpo.securityFilter.includes(AUTHENTICATED_USERS_SID)) return
        for (const user of domain.users) {
          if (!user.enabled || !userRsop(domain, user).applied.some((a) => a.gpo.id === gpo.id)) continue
          for (const client of clients)
            out.push({
              domain: domain.name,
              gpo: gpo.id,
              gpoName: gpo.name,
              target: target ?? '',
              enforced: link.enforced,
              order: index + 1,
              sam: user.sam,
              client: client.id
            })
        }
      })
  }
  return out.filter((p) => refreshable(state, p))
}

const targetOf = (p: FaultTargetParams): string | null => (p['target'] === '' ? null : String(p['target']))
const clientName = (state: LabState, p: FaultTargetParams): string =>
  state.devices[String(p['client'])]?.name ?? 'le poste'

const ticket = (state: LabState, p: FaultTargetParams): string =>
  `Depuis ce matin, ${String(p['sam'])} ne retrouve plus ses paramètres imposés par l’entreprise sur ${clientName(state, p)} (restrictions, lecteurs réseau…), même après une nouvelle ouverture de session.`

export const gpoUnlinked: FaultDef = {
  id: 'win.gpo-unlinked',
  domain: 'windows',
  difficulty: 2,
  title: 'GPO non liée',
  pick: (state, rand) => firstViable(state, rand, candidates(state, false), gpoUnlinked),
  inject: (_s, p) => [command('gpo.unlink', String(p['domain']), String(p['gpo']), targetOf(p))],
  symptomVisible: (state, p) => refreshable(state, p) && !applies(state, p),
  ticket,
  hints: (state, p) => [
    `Sur ${clientName(state, p)}, après gpupdate /force, gpresult n’affiche plus la stratégie attendue pour ${String(p['sam'])}.`,
    `La GPO existe toujours et ses paramètres sont corrects : regardez où elle est liée dans la console de gestion des stratégies de groupe.`,
    `Vérifiez que la GPO « ${String(p['gpoName'])} » est liée à l’unité d’organisation (ou au domaine) qui contient ${String(p['sam'])}.`
  ],
  cause: (_s, p) =>
    `La GPO « ${String(p['gpoName'])} » n’était plus liée à son emplacement : elle ne s’appliquait plus à ${String(p['sam'])}.`,
  repair: (_s, p) => [
    command('gpo.link', String(p['domain']), String(p['gpo']), targetOf(p), {
      enforced: p['enforced'] === true,
      order: Number(p['order'])
    })
  ],
  healed: (state, p) => applies(state, p)
}

export const gpoFiltered: FaultDef = {
  id: 'win.gpo-filtered',
  domain: 'windows',
  difficulty: 3,
  title: 'GPO filtrée (filtrage de sécurité)',
  pick: (state, rand) => firstViable(state, rand, candidates(state, true), gpoFiltered),
  inject: (_s, p) => [
    command('gpo.setSecurityFilter', String(p['domain']), String(p['gpo']), AUTHENTICATED_USERS_SID, false)
  ],
  symptomVisible: (state, p) => refreshable(state, p) && !applies(state, p),
  ticket,
  hints: (state, p) => [
    `Sur ${clientName(state, p)}, gpresult liste la GPO parmi les stratégies refusées ou absentes pour ${String(p['sam'])}.`,
    `La liaison de la GPO est correcte : regardez l’onglet Étendue de la GPO « ${String(p['gpoName'])} », section Filtrage de sécurité.`,
    `Qui a le droit d’appliquer cette GPO ? Comparez la liste du filtrage de sécurité avec l’utilisateur concerné.`
  ],
  cause: (_s, p) =>
    `Le groupe « Utilisateurs authentifiés » avait été retiré du filtrage de sécurité de la GPO « ${String(p['gpoName'])} » : plus aucun compte n’avait le droit de l’appliquer.`,
  repair: (_s, p) => [
    command('gpo.setSecurityFilter', String(p['domain']), String(p['gpo']), AUTHENTICATED_USERS_SID, true)
  ],
  healed: (state, p) => applies(state, p)
}
