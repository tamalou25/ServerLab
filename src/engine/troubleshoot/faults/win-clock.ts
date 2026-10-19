/**
 * Panne `win.clock-skew` : l'horloge d'un poste du domaine est décalée de plus de 5 minutes
 * (`host.setClock`). Kerberos refuse alors la session de domaine : « Il existe une différence
 * d'heure et/ou de date entre le client et le serveur » (événements 4771 code 0x25 et 4625, déjà
 * simulés ; `w32tm /query /status` montre le décalage). Réparation officielle : `w32tm /resync`
 * (`host.resyncClock`).
 */
import { command } from '../../commands/catalog'
import { clockOffset, TIME_SKEW_MESSAGE } from '../../services/hostclock'
import type { FaultDef } from '../types'
import { firstViable } from './viable'
import { clientOf, domainLogonCandidates, tryLogon } from './domain-probe'

/** Décalages possibles, en secondes (tous au-delà de la tolérance de 300 s). */
const SKEWS = [600, 900, 1800, 3600, -900, -1800, -3600]

export const clockSkew: FaultDef = {
  id: 'win.clock-skew',
  domain: 'windows',
  difficulty: 2,
  title: 'Horloge décalée (Kerberos)',

  pick(state, rand) {
    const skew = SKEWS[Math.floor(rand() * SKEWS.length)]!
    const list = domainLogonCandidates(state)
      .filter((p) => tryLogon(state, p).ok)
      .map((p) => ({
        ...p,
        original: clockOffset(state, String(p['client'])),
        offset: clockOffset(state, String(p['dc'])) + skew,
        skew
      }))
    return firstViable(state, rand, list, clockSkew)
  },

  inject: (_state, p) => [command('host.setClock', String(p['client']), Number(p['offset']))],

  symptomVisible: (state, p) => tryLogon(state, p).message === TIME_SKEW_MESSAGE,

  ticket: (state, p) =>
    `${String(p['sam'])} n’arrive plus à ouvrir sa session de domaine sur ${clientOf(state, p)?.name ?? 'son poste'} : « Il existe une différence d’heure et/ou de date entre le client et le serveur ». Le mot de passe est correct.`,

  hints: (state, p) => [
    `L’ouverture de session de domaine est refusée avec un message sur la date et l’heure, pas sur le mot de passe.`,
    `Comparez l’heure de ${clientOf(state, p)?.name ?? 'le poste'} avec celle du contrôleur de domaine (Get-Date, w32tm /query /status).`,
    `Kerberos tolère 5 minutes d’écart au plus : resynchronisez l’horloge du poste sur le domaine.`
  ],

  cause: (state, p) =>
    `L’horloge de ${clientOf(state, p)?.name ?? 'le poste'} était décalée de ${Math.abs(Number(p['skew']) / 60)} minutes par rapport au contrôleur de domaine : Kerberos refusait la session (tolérance de 5 minutes).`,

  repair: (_state, p) => [command('host.resyncClock', String(p['client']))],

  healed: (state, p) =>
    Math.abs(clockOffset(state, String(p['client'])) - clockOffset(state, String(p['dc']))) <= 300 &&
    tryLogon(state, p).ok
}
