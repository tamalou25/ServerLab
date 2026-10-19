/**
 * Panne `win.trust-broken` : la relation d'approbation entre un poste et le domaine est rompue
 * (canal sécurisé). Le compte d'ordinateur a été supprimé puis recréé (`adds.removeObject`,
 * `adds.addComputer`) : il porte le même nom mais n'est plus lié au poste. Symptôme :
 * `Test-ComputerSecureChannel` renvoie False (cmdlet sourcée). Réparation officielle :
 * `Test-ComputerSecureChannel -Repair` (`adds.repairSecureChannel`).
 */
import { command } from '../../commands/catalog'
import type { LabState } from '../../model/schema'
import { secureChannelStatus } from '../../roles/adds/objects'
import type { FaultDef, FaultTargetParams } from '../types'
import { nameOf } from './service-probes'
import { firstViable } from './viable'

const status = (state: LabState, p: FaultTargetParams) => secureChannelStatus(state, String(p['client']))

export const trustBroken: FaultDef = {
  id: 'win.trust-broken',
  domain: 'windows',
  difficulty: 3,
  title: 'Relation d’approbation rompue (canal sécurisé)',

  pick(state, rand) {
    const list: FaultTargetParams[] = []
    for (const domain of Object.values(state.domains))
      for (const account of domain.computers) {
        const client = account.deviceId ? state.devices[account.deviceId] : undefined
        if (!client || client.kind !== 'client' || !client.powered) continue
        if (client.host.domain !== domain.name || domain.controllers.includes(client.id)) continue
        const p = { domain: domain.name, client: client.id, account: account.id, computer: account.name }
        if (status(state, p) === 'ok') list.push(p)
      }
    return firstViable(state, rand, list, trustBroken)
  },

  inject: (_state, p) => [
    command('adds.removeObject', String(p['domain']), String(p['account'])),
    command('adds.addComputer', String(p['domain']), { name: String(p['computer']) })
  ],

  symptomVisible: (state, p) => status(state, p) === 'broken',

  ticket: (state, p) =>
    `Plus aucun utilisateur du domaine ne parvient à utiliser ${nameOf(state, p['client'])} comme avant : le poste est pourtant sur le réseau et joint le contrôleur de domaine.`,

  hints: (state, p) => [
    `${nameOf(state, p['client'])} est joint au domaine et joint le contrôleur, mais Test-ComputerSecureChannel renvoie False.`,
    `Le problème concerne le compte d’ordinateur de ${nameOf(state, p['client'])} dans l’annuaire, pas le réseau.`,
    `Le canal sécurisé qui lie le poste à son compte d’ordinateur se teste, et se rétablit, depuis le poste lui-même.`
  ],

  cause: (state, p) =>
    `Le compte d’ordinateur ${String(p['computer'])} avait été supprimé puis recréé dans l’annuaire : il ne correspondait plus à ${nameOf(state, p['client'])} (canal sécurisé rompu).`,

  repair: (_state, p) => [command('adds.repairSecureChannel', String(p['client']))],

  healed: (state, p) => status(state, p) === 'ok'
}
