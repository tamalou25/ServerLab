/**
 * Panne `net.wrong-stp-root` : un switch d'accès reçoit une priorité spanning-tree plus basse que celle
 * du switch racine prévu (`spanning-tree vlan N priority …`) et lui prend le rôle de pont racine. Le
 * symptôme est celui de `show spanning-tree` (« This bridge is the root » sur le mauvais switch, ports
 * bloqués ailleurs). Injection et réparation sont des lignes saisies à la console IOS (`shell.exec`).
 * Aucune sortie de console nouvelle.
 */
import { iosState } from '../../ios/config'
import { isIos, type IosDevice } from '../../ios/device'
import { stpInstance } from '../../ios/features/stp'
import type { LabState } from '../../model/schema'
import type { FaultDef, FaultTargetParams } from '../types'
import { firstVisible, iosCommands, nameOf } from './net-common'

const ID = 'net.wrong-stp-root'

const DEFAULT_PRIORITY = 32768

const iosSwitch = (state: LabState, id: unknown): IosDevice | null => {
  const d = state.devices[String(id)]
  return isIos(d) && d.kind === 'switch' ? d : null
}

/** Le switch racine prévu est-il bien le pont racine du VLAN ? */
function rootIsExpected(state: LabState, p: FaultTargetParams): boolean {
  const root = iosSwitch(state, p['root'])
  return !!root && stpInstance(state, root, Number(p['vlan']))?.isRoot === true
}

/** Remet la priorité du VLAN sur le switch ciblé. */
function priorityLines(p: FaultTargetParams, value: string): string[] {
  const vlan = String(p['vlan'])
  return [
    'enable',
    'configure terminal',
    value === 'default'
      ? `no spanning-tree vlan ${vlan} priority`
      : `spanning-tree vlan ${vlan} priority ${value}`,
    'end'
  ]
}

export const wrongStpRoot: FaultDef = {
  id: ID,
  domain: 'reseau',
  difficulty: 3,
  title: 'Mauvais pont racine spanning-tree',

  pick(state, rand) {
    const switches = Object.values(state.devices).filter(
      (d): d is IosDevice => isIos(d) && d.kind === 'switch' && d.powered
    )
    const candidates: FaultTargetParams[] = []
    for (const root of switches)
      for (const key of Object.keys(iosState(root).stpPriorities)) {
        const vlan = Number(key)
        const rootPriority = iosState(root).stpPriorities[key]!
        if (stpInstance(state, root, vlan)?.isRoot !== true) continue
        const wrong = rootPriority > 4096 ? 4096 : rootPriority > 0 ? 0 : null
        if (wrong === null) continue
        for (const other of switches) {
          if (other.id === root.id) continue
          candidates.push({
            vlan,
            root: root.id,
            switch: other.id,
            wrong,
            original: iosState(other).stpPriorities[key] ?? 'default'
          })
        }
      }
    return firstVisible(wrongStpRoot, state, candidates, rand)
  },

  inject: (state, p) => iosCommands(state, String(p['switch']), priorityLines(p, String(p['wrong']))),

  symptomVisible: (state, p) => !rootIsExpected(state, p),

  ticket: (_state, p) =>
    `Le réseau fonctionne mais le trafic entre les switchs emprunte un chemin détourné et une liaison reste bloquée : la topologie logique du VLAN ${String(p['vlan'])} n’est plus celle prévue au dossier d’architecture.`,

  hints: (state, p) => [
    `Sur ${nameOf(state, p['root'], 'le switch de cœur')}, affichez l’arbre spanning-tree du VLAN ${String(p['vlan'])} (show spanning-tree) : est-il bien le pont racine ?`,
    `Comparez les priorités des ponts du VLAN ${String(p['vlan'])} sur chaque switch : quel switch annonce la meilleure priorité ?`,
    `Le pont racine est celui qui a la priorité la plus basse : un switch qui ne devrait pas l’être l’a emporté, corrigez sa priorité.`
  ],

  cause: (state, p) =>
    `${nameOf(state, p['switch'], 'Un switch')} avait la priorité spanning-tree ${String(p['wrong'])} sur le VLAN ${String(p['vlan'])} (au lieu de ${p['original'] === 'default' ? `${DEFAULT_PRIORITY}, la valeur par défaut` : String(p['original'])}) et était devenu le pont racine à la place de ${nameOf(state, p['root'], 'le switch prévu')}.`,

  repair: (state, p) => iosCommands(state, String(p['switch']), priorityLines(p, String(p['original']))),

  healed: (state, p) => rootIsExpected(state, p)
}
