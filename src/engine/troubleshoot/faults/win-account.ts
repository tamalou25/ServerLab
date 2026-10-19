/**
 * Pannes de compte du domaine (chantier D, #230) : un utilisateur ne peut plus ouvrir de session.
 * - `win.account-locked` : compte verrouillé par la stratégie de verrouillage, après des
 *   ouvertures de session ratées (`adds.logon`, mauvais mot de passe) ; refus « Le compte référencé
 *   est actuellement verrouillé… » (événements 4740, 4768 code 0x12 déjà simulés) ;
 * - `win.account-disabled` : compte désactivé (`adds.setAccountEnabled`), refus « Votre compte a été
 *   désactivé… ».
 * Le compte « expiré » (date d'expiration du compte) n'est pas modélisé : voir docs/fidelite.md.
 */
import { command } from '../../commands/catalog'
import { domainLockoutPolicy } from '../../roles/gpo/scope'
import { isLockedOut } from '../../roles/adds/lockout'
import { ACCOUNT_LOCKED } from '../../roles/adds/join'
import type { FaultDef } from '../types'
import { firstViable } from './viable'
import { clientOf, domainLogonCandidates, domainOf, tryLogon } from './domain-probe'

const userOf = (domain: ReturnType<typeof domainOf>, sam: unknown) => domain?.users.find((u) => u.sam === sam)

const WRONG_PASSWORD = 'MotDePasseOublié#1'

export const accountLocked: FaultDef = {
  id: 'win.account-locked',
  domain: 'windows',
  difficulty: 2,
  title: 'Compte verrouillé',

  pick(state, rand) {
    const list = domainLogonCandidates(state).flatMap((p) => {
      const domain = domainOf(state, p)
      const threshold = domain ? domainLockoutPolicy(domain).threshold : 0
      return threshold > 0 && tryLogon(state, p).ok ? [{ ...p, threshold }] : []
    })
    return firstViable(state, rand, list, accountLocked)
  },

  // Autant de mots de passe erronés que le seuil de verrouillage : l'utilisateur s'est trompé
  inject(state, p) {
    const domain = domainOf(state, p)
    return Array.from({ length: Number(p['threshold']) }, () =>
      command('adds.logon', String(p['client']), {
        user: String(p['sam']),
        password: WRONG_PASSWORD,
        domain: domain?.netbios ?? null
      })
    )
  },

  symptomVisible: (state, p) => tryLogon(state, p).message === ACCOUNT_LOCKED,

  ticket: (state, p) =>
    `${String(p['sam'])} n’arrive plus à ouvrir sa session sur ${clientOf(state, p)?.name ?? 'son poste'} alors qu’il est sûr de son mot de passe : « Le compte référencé est actuellement verrouillé ».`,

  hints: (_state, p) => [
    `L’ouverture de session de ${String(p['sam'])} est refusée avec un message sur l’état du compte, pas sur le mot de passe.`,
    `Regardez le compte de ${String(p['sam'])} dans l’annuaire (Active Directory) et le journal de sécurité du contrôleur de domaine.`,
    `Le compte a peut-être été verrouillé par la stratégie après plusieurs échecs : vérifiez ses propriétés (LockedOut).`
  ],

  cause: (_state, p) =>
    `Le compte ${String(p['sam'])} était verrouillé : ${String(p['threshold'])} mots de passe erronés de suite avaient atteint le seuil de verrouillage du domaine.`,

  repair: (_state, p) => [command('adds.unlockAccount', String(p['domain']), String(p['sam']))],

  healed(state, p) {
    const domain = domainOf(state, p)
    const user = userOf(domain, p['sam'])
    return !!domain && !!user && !isLockedOut(domain, user, state.clock) && tryLogon(state, p).ok
  }
}

export const accountDisabled: FaultDef = {
  id: 'win.account-disabled',
  domain: 'windows',
  difficulty: 1,
  title: 'Compte désactivé',

  pick(state, rand) {
    const list = domainLogonCandidates(state).filter((p) => tryLogon(state, p).ok)
    return firstViable(state, rand, list, accountDisabled)
  },

  inject: (_state, p) => [command('adds.setAccountEnabled', String(p['domain']), String(p['sam']), false)],

  symptomVisible: (state, p) => tryLogon(state, p).message.startsWith('Votre compte a été désactivé'),

  ticket: (state, p) =>
    `${String(p['sam'])} n’arrive plus à ouvrir sa session sur ${clientOf(state, p)?.name ?? 'son poste'} : « Votre compte a été désactivé. Contactez votre administrateur système ». Il n’a rien changé.`,

  hints: (_state, p) => [
    `L’ouverture de session de ${String(p['sam'])} est refusée avec un message sur le compte, alors que le mot de passe est le bon.`,
    `Regardez le compte de ${String(p['sam'])} dans l’annuaire Active Directory.`,
    `Vérifiez si le compte est activé (propriété Enabled, case « Compte désactivé »).`
  ],

  cause: (_state, p) =>
    `Le compte ${String(p['sam'])} était désactivé dans l’annuaire : l’ouverture de session était refusée.`,

  repair: (_state, p) => [command('adds.setAccountEnabled', String(p['domain']), String(p['sam']), true)],

  healed: (state, p) => !!userOf(domainOf(state, p), p['sam'])?.enabled && tryLogon(state, p).ok
}
