/**
 * Panne `net.etherchannel-down` : le mode `channel-group` d'un côté d'un EtherChannel devient incompatible
 * avec celui du voisin (`on` face à LACP, ou LACP face à `on`) : le canal ne se monte pas. Le symptôme est
 * celui de `show etherchannel summary` (ports isolés `I`, agrégat non groupé). Injection et réparation
 * sont des lignes saisies à la console IOS (`shell.exec`). Aucune sortie de console nouvelle.
 */
import { iosState } from '../../ios/config'
import { isIos, type IosDevice } from '../../ios/device'
import { memberFlag, members, type ChannelMode } from '../../ios/features/etherchannel'
import type { LabState } from '../../model/schema'
import { linkOnInterface, otherEnd } from '../../topology/queries'
import type { FaultDef, FaultTargetParams } from '../types'
import { firstVisible, iosCommands, nameOf } from './net-common'

const ID = 'net.etherchannel-down'

const iosSwitch = (state: LabState, id: unknown): IosDevice | null => {
  const d = state.devices[String(id)]
  return isIos(d) && d.kind === 'switch' ? d : null
}

/** Ports membres du groupe sur le switch ciblé. */
const memberPorts = (state: LabState, p: FaultTargetParams) => {
  const sw = iosSwitch(state, p['switch'])
  return sw ? members(sw, Number(p['group'])) : []
}

/** Tous les ports du groupe sont-ils groupés (P) ? */
function bundled(state: LabState, p: FaultTargetParams): boolean {
  const sw = iosSwitch(state, p['switch'])
  const ports = memberPorts(state, p)
  return !!sw && ports.length > 0 && ports.every((port) => memberFlag(state, sw, port) === 'P')
}

/** Mode forcé sur chaque port du groupe. */
function modeLines(p: FaultTargetParams, mode: string): string[] {
  return [
    'enable',
    'configure terminal',
    ...String(p['ports'])
      .split(',')
      .flatMap((name) => [`interface ${name}`, `channel-group ${String(p['group'])} mode ${mode}`]),
    'end'
  ]
}

export const etherchannelDown: FaultDef = {
  id: ID,
  domain: 'reseau',
  difficulty: 3,
  title: 'EtherChannel qui ne se monte pas',

  pick(state, rand) {
    const candidates: FaultTargetParams[] = []
    for (const sw of Object.values(state.devices)) {
      if (!isIos(sw) || sw.kind !== 'switch' || !sw.powered) continue
      const groups = new Set<number>()
      for (const entry of Object.values(iosState(sw).interfaces))
        if (entry.channelGroup) groups.add(entry.channelGroup.group)
      for (const group of groups) {
        const ports = members(sw, group)
        const mode = iosState(sw).interfaces[ports[0]?.name ?? '']?.channelGroup?.mode
        if (!mode) continue
        const link = ports[0] ? linkOnInterface(state, sw.id, ports[0].id) : undefined
        const peerId = link && ports[0] ? otherEnd(link, sw.id, ports[0].id).deviceId : ''
        const wrong: ChannelMode = mode === 'on' ? 'active' : 'on'
        candidates.push({
          switch: sw.id,
          group,
          ports: ports.map((x) => x.name).join(','),
          original: mode,
          wrong,
          peer: peerId
        })
      }
    }
    return firstVisible(etherchannelDown, state, candidates, rand)
  },

  inject: (state, p) => iosCommands(state, String(p['switch']), modeLines(p, String(p['wrong']))),

  symptomVisible: (state, p) => memberPorts(state, p).length > 0 && !bundled(state, p),

  ticket: (state, p) =>
    `La liaison redondante entre ${nameOf(state, p['switch'], 'deux switchs')} et ${nameOf(state, p['peer'], 'son voisin')} n’apporte plus le débit prévu : l’agrégat n’est pas monté, les ports n’y sont pas regroupés.`,

  hints: (state, p) => [
    `Sur ${nameOf(state, p['switch'], 'le switch')}, affichez le résumé des agrégats (show etherchannel summary) : dans quel état sont les ports du groupe ${String(p['group'])} ?`,
    `Un EtherChannel ne se monte que si les deux extrémités négocient avec des protocoles compatibles : comparez la configuration des ports des deux côtés.`,
    `Regardez les modes channel-group (active, passive, desirable, auto, on) de chaque côté : tous les modes ne sont pas compatibles entre eux.`
  ],

  cause: (state, p) =>
    `Les ports ${String(p['ports'])} de ${nameOf(state, p['switch'], 'le switch')} étaient en mode « ${String(p['wrong'])} » au lieu de « ${String(p['original'])} », incompatible avec le mode de ${nameOf(state, p['peer'], 'son voisin')} : le canal ne se montait pas.`,

  repair: (state, p) => iosCommands(state, String(p['switch']), modeLines(p, String(p['original']))),

  healed(state, p) {
    const sw = iosSwitch(state, p['switch'])
    return (
      !!sw &&
      bundled(state, p) &&
      memberPorts(state, p).every(
        (port) => iosState(sw).interfaces[port.name]?.channelGroup?.mode === p['original']
      )
    )
  }
}
