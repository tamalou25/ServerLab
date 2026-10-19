/**
 * Panne `net.port-err-disabled` : un port d'accès d'un switch Cisco passe en err-disabled à la suite d'une
 * violation de port-security (une adresse MAC autorisée qui n'est pas celle du poste branché). Le poste
 * perd le réseau : `show interfaces status` indique « err-disabled », `show port-security interface`
 * « Secure-shutdown ». Injection et réparation sont des lignes saisies à la console IOS (`shell.exec`).
 * Aucune sortie de console nouvelle.
 */
import { command } from '../../commands/catalog'
import type { LabState, NetInterface } from '../../model/schema'
import { effectiveIpv4 } from '../../net/addressing'
import { switchportOf } from '../../net/switchport'
import { iosState } from '../../ios/config'
import { isIos } from '../../ios/device'
import { linkOnInterface, otherEnd } from '../../topology/queries'
import type { FaultDef, FaultTargetParams } from '../types'
import { firstVisible, iosCommands, nameOf, pingOk, poweredHosts } from './net-common'

const ID = 'net.port-err-disabled'

/** Adresse MAC « autorisée » à tort sur le port (administrée localement, jamais celle d'une carte du lab). */
const FOREIGN_MAC = '0200.5e00.0001'

function port(state: LabState, p: FaultTargetParams): { name: string; iface: NetInterface } | null {
  const device = state.devices[String(p['switch'])]
  const iface = device?.interfaces.find((i) => i.id === p['iface'])
  return device && iface ? { name: device.name, iface } : null
}

const peerAnswers = (state: LabState, p: FaultTargetParams): boolean =>
  pingOk(state, String(p['host']), String(p['peer']))

/** Port désactivé par IOS (état err-disabled) ? */
function errDisabled(state: LabState, p: FaultTargetParams): boolean {
  const device = state.devices[String(p['switch'])]
  const iface = device?.interfaces.find((i) => i.id === p['iface'])
  return !!device && isIos(device) && !!iface && !!iosState(device).interfaces[iface.name]?.errDisabled
}

export const portErrDisabled: FaultDef = {
  id: ID,
  domain: 'reseau',
  difficulty: 2,
  title: 'Port en err-disabled (port-security)',

  pick(state, rand) {
    const hosts = poweredHosts(state)
    const candidates: FaultTargetParams[] = []
    for (const sw of Object.values(state.devices)) {
      if (!isIos(sw) || sw.kind !== 'switch' || !sw.powered) continue
      for (const iface of sw.interfaces) {
        if (switchportOf(iface).mode !== 'access' || iosState(sw).interfaces[iface.name]?.portSecurity)
          continue
        const link = linkOnInterface(state, sw.id, iface.id)
        if (!link) continue
        const host = hosts.find((h) => h.id === otherEnd(link, sw.id, iface.id).deviceId)
        if (!host) continue
        for (const other of hosts) {
          if (other.id === host.id) continue
          for (const o of other.interfaces) {
            const oe = effectiveIpv4(o)
            if (!oe) continue
            candidates.push({
              switch: sw.id,
              iface: iface.id,
              portName: iface.name,
              host: host.id,
              peer: oe.address,
              peerName: other.name
            })
          }
        }
      }
    }
    return firstVisible(portErrDisabled, state, candidates, rand)
  },

  inject: (state, p) => [
    ...iosCommands(state, String(p['switch']), [
      'enable',
      'configure terminal',
      `interface ${String(p['portName'])}`,
      'switchport mode access',
      // L'adresse autorisée est saisie avant l'activation : la place unique est déjà prise
      `switchport port-security mac-address ${FOREIGN_MAC}`,
      'switchport port-security',
      'end'
    ]),
    // La violation est constatée par les tâches de fond (comme en mode Temps réel)
    command('background.tick')
  ],

  symptomVisible: (state, p) => errDisabled(state, p) && !peerAnswers(state, p),

  ticket: (state, p) =>
    `${nameOf(state, p['host'], 'Un poste')} n’a plus de réseau depuis qu’il a été rebranché ; le voyant de sa prise est éteint côté switch.`,

  hints: (state, p) => [
    `Sur le switch ${nameOf(state, p['switch'], 'du réseau')}, affichez l’état des ports (show interfaces status) : que lit-on pour le port de ${nameOf(state, p['host'], 'le poste')} ?`,
    `Le port a été coupé par le switch lui-même, pas par un câble : cherchez la fonction de sécurité qui l’a déclenché (show port-security interface).`,
    `Corrigez ce qui a provoqué la violation, puis réactivez le port : un simple rebranchement ne suffit pas.`
  ],

  cause: (state, p) =>
    `Le port ${String(p['portName'])} de ${nameOf(state, p['switch'], 'le switch')} était protégé par port-security avec une autre adresse MAC que celle du poste : violation, port en err-disabled.`,

  repair: (state, p) =>
    iosCommands(state, String(p['switch']), [
      'enable',
      'configure terminal',
      `interface ${String(p['portName'])}`,
      'no switchport port-security',
      'shutdown',
      'no shutdown',
      'end'
    ]),

  healed(state, p) {
    const t = port(state, p)
    return !!t && t.iface.enabled && !errDisabled(state, p) && peerAnswers(state, p)
  }
}
