/**
 * Panne `net.wrong-mask` : masque de sous-réseau erroné sur une carte (trop long). L'ordinateur
 * croit que ses voisins sont dans un autre réseau : il ne les joint plus (ping sans réponse).
 * Aucune sortie de console nouvelle : le symptôme est celui, existant, de `ping`.
 */
import { command } from '../../commands/catalog'
import { dispatch } from '../../commands/dispatch'
import type { AnyCommand } from '../../commands/define'
import type { LabState, NetInterface } from '../../model/schema'
import { effectiveIpv4 } from '../../net/addressing'
import { ping } from '../../net/diagnostics'
import { hostAddressError, inNetwork, networkAddress, sameSubnet } from '../../net/ipv4'
import type { FaultDef, FaultTargetParams } from '../types'

const ID = 'net.wrong-mask'

/** Carte ciblée (null si elle a disparu ou n'est plus en adressage statique). */
function target(state: LabState, p: FaultTargetParams): { name: string; iface: NetInterface } | null {
  const device = state.devices[String(p['device'])]
  const iface = device?.interfaces.find((i) => i.id === p['iface'])
  return device && iface ? { name: device.name, iface } : null
}

/** Le ping de la carte ciblée vers le voisin répond-il ? */
function peerAnswers(state: LabState, p: FaultTargetParams): boolean {
  const r = ping(state, String(p['device']), String(p['peer']), { count: 1 })
  return r.ok && r.value.success
}

/** Masque (longueur de préfixe) forcé sur la carte, avec le reste de sa configuration inchangé. */
function setPrefix(state: LabState, p: FaultTargetParams, prefix: number): AnyCommand[] {
  const t = target(state, p)
  if (!t || !t.iface.address) return []
  return [
    command('net.setInterfaceIpv4', String(p['device']), String(p['iface']), {
      addressing: 'static',
      address: t.iface.address,
      mask: String(prefix),
      gateway: t.iface.gateway,
      dnsMode: t.iface.dnsMode,
      dnsServers: t.iface.dnsServers
    })
  ]
}

/** Premier masque plus long qui isole le voisin du réseau de la carte, ou null. */
function wrongPrefix(address: string, gateway: string | null, prefix: number, peer: string): number | null {
  for (let wrong = prefix + 1; wrong <= 30; wrong++) {
    if (hostAddressError(address, wrong)) continue
    if (sameSubnet(address, peer, wrong)) continue
    // La passerelle doit rester joignable : sinon la saisie est refusée comme à l'assistant réseau
    if (gateway && !inNetwork(gateway, networkAddress(address, wrong), wrong)) continue
    return wrong
  }
  return null
}

export const wrongMask: FaultDef = {
  id: ID,
  domain: 'reseau',
  difficulty: 1,
  title: 'Masque de sous-réseau erroné',

  pick(state, rand) {
    const hosts = Object.values(state.devices).filter(
      (d) => (d.kind === 'client' || d.kind === 'server') && d.powered
    )
    const candidates: FaultTargetParams[] = []
    for (const device of hosts)
      for (const iface of device.interfaces) {
        const eff = effectiveIpv4(iface)
        if (!eff || eff.source !== 'static') continue
        for (const other of hosts) {
          if (other.id === device.id) continue
          for (const o of other.interfaces) {
            const oe = effectiveIpv4(o)
            if (!oe || !sameSubnet(eff.address, oe.address, eff.prefixLength)) continue
            const wrong = wrongPrefix(eff.address, eff.gateway, eff.prefixLength, oe.address)
            if (wrong === null) continue
            candidates.push({
              device: device.id,
              iface: iface.id,
              peer: oe.address,
              peerName: other.name,
              original: eff.prefixLength,
              wrong
            })
          }
        }
      }
    // Parcours dans un ordre tiré de la graine ; la première panne dont l'injection est visible gagne
    const start = candidates.length > 0 ? Math.floor(rand() * candidates.length) : 0
    for (let k = 0; k < candidates.length; k++) {
      const p = candidates[(start + k) % candidates.length]!
      if (!peerAnswers(state, p)) continue
      let broken = state
      for (const c of wrongMask.inject(state, p)) {
        const r = dispatch(broken, c)
        if (r.ok) broken = r.state
      }
      if (broken !== state && wrongMask.symptomVisible(broken, p)) return p
    }
    return null
  },

  inject: (state, p) => setPrefix(state, p, Number(p['wrong'])),

  symptomVisible: (state, p) => !peerAnswers(state, p),

  ticket(state, p) {
    const t = target(state, p)
    return `${t?.name ?? 'Un poste'} ne parvient plus à joindre ${String(p['peerName'])} sur le réseau local. Hier encore, tout fonctionnait.`
  },

  hints(state, p) {
    const t = target(state, p)
    const name = t?.name ?? 'le poste'
    return [
      `Testez la connectivité depuis ${name} vers ${String(p['peerName'])} : le ping reste sans réponse alors que les câbles et les voyants sont normaux.`,
      `Le problème est local à ${name} : examinez la configuration IP de sa carte réseau.`,
      `Comparez les paramètres IP de ${name} avec ceux de ${String(p['peerName'])} : les deux machines doivent se croire dans le même réseau.`
    ]
  },

  cause(state, p) {
    const t = target(state, p)
    return `Le masque de sous-réseau de ${t?.name ?? 'la carte'} (${t?.iface.name ?? ''}) était /${String(p['wrong'])} au lieu de /${String(p['original'])} : ${String(p['peerName'])} se retrouvait hors de son réseau.`
  },

  repair: (state, p) => setPrefix(state, p, Number(p['original'])),

  healed(state, p) {
    const t = target(state, p)
    return !!t && t.iface.prefixLength === p['original'] && peerAnswers(state, p)
  }
}
