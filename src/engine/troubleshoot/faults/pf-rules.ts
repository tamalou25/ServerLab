/**
 * Pannes de filtrage du pare-feu pfSense (v2.10, #248, domaine `pare-feu`) : règle Pass désactivée, règle Pass
 * supprimée (le refus par défaut s'applique), règle Block placée avant la règle Pass, alias erroné.
 * Injection et réparation : commandes `pf.addRule`, `pf.updateRule`, `pf.removeRule`, `pf.setAlias`.
 * Symptôme : la sonde de la règle (ping ou connexion TCP / UDP) n'aboutit plus ; journal et table d'états du
 * pare-feu le montrent (Status > System Logs > Firewall).
 */
import { command } from '../../commands/catalog'
import type { AnyCommand } from '../../commands/define'
import type { PfAlias, PfRule } from '../../model/firewall'
import type { LabState } from '../../model/schema'
import type { PfRuleInput } from '../../net/pf-rules'
import type { FaultDef, FaultTargetParams } from '../types'
import { firstViable } from './viable'
import {
  describeFlow,
  describeProbe,
  firewallOf,
  firewalls,
  probeWorks,
  ruleName,
  ruleTarget,
  unusedNear
} from './pf-common'
import { nameOf } from './net-common'

const ruleOf = (state: LabState, p: FaultTargetParams): PfRule | undefined =>
  firewallOf(state, p['device'])?.pf.rules.find((r) => r.id === p['rule'])

/** Règles Pass actives dont un test aboutit : candidats communs des pannes de règle. */
function passRules(state: LabState, filter: (rule: PfRule, fwId: string) => boolean): FaultTargetParams[] {
  return firewalls(state).flatMap((fw) =>
    fw.pf.rules
      .filter((r) => filter(r, fw.id))
      .flatMap((r) => {
        const target = ruleTarget(state, fw, r)
        return target ? [target] : []
      })
  )
}

const ticketOf = (state: LabState, p: FaultTargetParams): string =>
  `Depuis ce matin, ${describeProbe(p)} n’aboutit plus depuis ${String(p['fromName'])}, alors que ça fonctionnait hier. Le pare-feu ${nameOf(state, p['device'], 'FW1')} est allumé.`

// --- Règle désactivée ----------------------------------------------------------------------------------

export const pfRuleDisabled: FaultDef = {
  id: 'pf.rule-disabled',
  domain: 'pare-feu',
  difficulty: 1,
  title: 'Règle de pare-feu désactivée',
  pick(state, rand) {
    return firstViable(
      state,
      rand,
      passRules(state, () => true),
      pfRuleDisabled
    )
  },
  inject: (_s, p) => [command('pf.updateRule', String(p['device']), String(p['rule']), { disabled: true })],
  symptomVisible: (state, p) => !probeWorks(state, p),
  ticket: ticketOf,
  hints: (state, p) => [
    `${describeFlow(p)} n’aboutit pas ; les autres flux de ${nameOf(state, p['device'], 'FW1')} fonctionnent.`,
    `Le pare-feu refuse par défaut ce que ses règles n’autorisent pas : consultez le journal (Status > System Logs > Firewall) puis la liste des règles de l’interface concernée.`,
    `Une règle peut exister sans s’appliquer : regardez son état dans la liste (règle grisée).`
  ],
  cause: (state, p) =>
    `La règle ${ruleName(ruleOf(state, p), p['rule'])} de ${nameOf(state, p['device'], 'FW1')} était désactivée : elle n’était plus évaluée et le refus par défaut s’appliquait à ${describeFlow(p)}.`,
  repair: (_s, p) => [command('pf.updateRule', String(p['device']), String(p['rule']), { disabled: false })],
  healed: (state, p) => probeWorks(state, p)
}

// --- Règle supprimée -----------------------------------------------------------------------------------

/** Règle sans l'identifiant, sérialisable dans les paramètres. */
function ruleInput(rule: PfRule): PfRuleInput {
  const { id: _ignored, ...input } = rule
  void _ignored
  return input
}

export const pfRuleRemoved: FaultDef = {
  id: 'pf.rule-removed',
  domain: 'pare-feu',
  difficulty: 2,
  title: 'Règle de pare-feu supprimée (refus par défaut)',
  pick(state, rand) {
    const candidates = passRules(state, (r, fwId) => {
      // La règle associée à une redirection de port est gérée par la redirection : hors de cette panne
      const fw = firewallOf(state, fwId)
      return !fw?.pf.nat.portForwards.some((f) => f.ruleId === r.id)
    }).map((target) => {
      const fw = firewallOf(state, target['device'])!
      const index = fw.pf.rules.findIndex((r) => r.id === target['rule'])
      return {
        ...target,
        before: fw.pf.rules[index + 1]?.id ?? '',
        saved: JSON.stringify(ruleInput(fw.pf.rules[index]!))
      }
    })
    return firstViable(state, rand, candidates, pfRuleRemoved)
  },
  inject: (_s, p) => [command('pf.removeRule', String(p['device']), String(p['rule']))],
  symptomVisible: (state, p) => !probeWorks(state, p),
  ticket: ticketOf,
  hints: (_state, p) => [
    `${describeFlow(p)} n’aboutit pas ; le journal du pare-feu montre le paquet bloqué par la règle de refus par défaut.`,
    `Aucune règle n’autorise ce flux sur l’interface d’entrée : comparez la liste des règles avec la politique attendue.`,
    `Il manque une règle Pass sur l’interface d’où part le trafic (source, destination, protocole et port du flux).`
  ],
  cause: (state, p) => {
    const saved = JSON.parse(String(p['saved'])) as { descr?: string }
    return `La règle ${saved.descr ? `« ${saved.descr} »` : 'Pass'} de ${nameOf(state, p['device'], 'FW1')} avait été supprimée : plus aucune règle n’autorisait ${describeFlow(p)}, le refus par défaut le détruisait.`
  },
  repair(state, p) {
    const fw = firewallOf(state, p['device'])
    const before = String(p['before'])
    // La règle qui suivait a disparu : la nouvelle règle est ajoutée en dernier
    const at = before !== '' && fw?.pf.rules.some((r) => r.id === before) ? before : null
    return [
      command('pf.addRule', String(p['device']), JSON.parse(String(p['saved'])) as PfRuleInput, at)
    ] as AnyCommand[]
  },
  healed: (state, p) => probeWorks(state, p)
}

// --- Règle Block avant la règle Pass ------------------------------------------------------------------

export const pfRuleOrder: FaultDef = {
  id: 'pf.rule-order',
  domain: 'pare-feu',
  difficulty: 3,
  title: 'Règle Block placée avant la règle Pass',
  pick(state, rand) {
    const candidates = passRules(state, () => true).map((target) => ({
      ...target,
      blockDescr: `Blocage ${String(target['dstName'])}`
    }))
    return firstViable(state, rand, candidates, pfRuleOrder)
  },
  inject(state, p) {
    const rule = ruleOf(state, p)
    if (!rule) return []
    const block: PfRuleInput = {
      iface: rule.iface,
      action: 'block',
      protocol: rule.protocol,
      source: rule.source,
      sourcePort: rule.sourcePort,
      destination: rule.destination,
      destinationPort: rule.destinationPort,
      descr: String(p['blockDescr'])
    }
    return [command('pf.addRule', String(p['device']), block, rule.id)]
  },
  symptomVisible: (state, p) => !probeWorks(state, p),
  ticket: ticketOf,
  hints: (state, p) => [
    `${describeFlow(p)} n’aboutit pas, alors qu’une règle Pass l’autorise bien sur ${nameOf(state, p['device'], 'FW1')}.`,
    `Le journal du pare-feu cite la règle qui bloque le paquet : ce n’est pas le refus par défaut. Comparez-la à la règle Pass.`,
    `Les règles sont évaluées de haut en bas et la première qui correspond s’applique : une règle Block située au-dessus l’emporte.`
  ],
  cause: (state, p) =>
    `Une règle Block « ${String(p['blockDescr'])} » était placée avant la règle ${ruleName(ruleOf(state, p), p['rule'])} de ${nameOf(state, p['device'], 'FW1')} : la première règle qui correspond s’applique, ${describeFlow(p)} était bloqué avant d’atteindre la règle Pass.`,
  repair(state, p) {
    const fw = firewallOf(state, p['device'])
    const block = fw?.pf.rules.find((r) => r.action === 'block' && r.descr === p['blockDescr'])
    return block ? [command('pf.removeRule', String(p['device']), block.id)] : []
  },
  healed: (state, p) => probeWorks(state, p)
}

// --- Alias erroné --------------------------------------------------------------------------------------

/** Nom d'alias d'un point de terminaison de règle (sinon null). */
const aliasName = (endpoint: PfRule['source']): string | null =>
  endpoint.type === 'alias' ? endpoint.name : null

export const pfAliasWrong: FaultDef = {
  id: 'pf.alias-wrong',
  domain: 'pare-feu',
  difficulty: 3,
  title: 'Alias du pare-feu avec une mauvaise adresse',
  pick(state, rand) {
    const candidates: FaultTargetParams[] = []
    for (const fw of firewalls(state))
      for (const rule of fw.pf.rules) {
        const names = [aliasName(rule.source), aliasName(rule.destination)].filter((n) => n !== null)
        for (const name of names) {
          const alias = fw.pf.aliases.find((a) => a.name === name)
          if (!alias || alias.type !== 'host' || alias.values.length === 0) continue
          const target = ruleTarget(state, fw, rule)
          if (!target) continue
          const wrong = alias.values.map((v) => unusedNear(state, v))
          if (wrong.includes(null)) continue
          candidates.push({
            ...target,
            service: `alias:${alias.name}`,
            alias: alias.name,
            values: alias.values.join(','),
            wrong: wrong.join(','),
            aliasDescr: alias.descr
          })
        }
      }
    return firstViable(state, rand, candidates, pfAliasWrong)
  },
  inject: (_s, p) => [command('pf.setAlias', String(p['device']), aliasOf(p, String(p['wrong']).split(',')))],
  symptomVisible: (state, p) => !probeWorks(state, p),
  ticket: ticketOf,
  hints: (_state, p) => [
    `${describeFlow(p)} n’aboutit pas ; la règle Pass correspondante existe, active et bien placée.`,
    `La règle désigne la destination par un alias : vérifiez ce que contient l’alias (Firewall > Aliases) et comparez-le à l’adresse de la machine.`,
    `La valeur de l’alias ne correspond pas à l’adresse réelle de la machine visée.`
  ],
  cause: (state, p) =>
    `L’alias ${String(p['alias'])} de ${nameOf(state, p['device'], 'FW1')} contenait ${String(p['wrong'])} au lieu de ${String(p['values'])} : la règle Pass ne désignait plus la bonne machine et ${describeFlow(p)} était refusé.`,
  repair: (_s, p) => [
    command('pf.setAlias', String(p['device']), aliasOf(p, String(p['values']).split(',')))
  ],
  healed: (state, p) => probeWorks(state, p)
}

function aliasOf(p: FaultTargetParams, values: string[]): PfAlias {
  return { name: String(p['alias']), type: 'host', values, descr: String(p['aliasDescr'] ?? '') }
}

export const PF_RULE_FAULTS: readonly FaultDef[] = [pfRuleDisabled, pfRuleRemoved, pfRuleOrder, pfAliasWrong]
