/**
 * Panne `net.wrong-nat` : le NAT/PAT d'un routeur Cisco est mal configuré. Les postes du réseau interne
 * n'atteignent plus l'extérieur (le fournisseur ne sait pas répondre à une adresse privée) : `ping`
 * sans réponse, `show ip nat translations` vide. Trois variantes, tirées avec la graine :
 * - `acl` : la liste d'accès du NAT désigne un autre réseau que le réseau interne ;
 * - `iface` : la règle traduit vers l'interface interne au lieu de l'interface de sortie ;
 * - `roles` : les rôles `ip nat inside` / `ip nat outside` des deux interfaces sont inversés.
 * Injection et réparation sont des lignes saisies à la console IOS (`shell.exec`).
 */
import { iosState } from '../../ios/config'
import { isIos, type IosDevice } from '../../ios/device'
import { formatSpec } from '../../ios/acl'
import type { LabState } from '../../model/schema'
import { effectiveIpv4 } from '../../net/addressing'
import { formatIpv4, parseIpv4 } from '../../net/ipv4'
import type { FaultDef, FaultTargetParams } from '../types'
import { firstVisible, iosCommands, nameOf, pingOk, poweredHosts } from './net-common'

const ID = 'net.wrong-nat'

type Variant = 'acl' | 'iface' | 'roles'

const peerAnswers = (state: LabState, p: FaultTargetParams): boolean =>
  pingOk(state, String(p['host']), String(p['peer']))

const router = (state: LabState, p: FaultTargetParams): IosDevice | null => {
  const d = state.devices[String(p['router'])]
  return isIos(d) ? d : null
}

/** Rôle NAT d'une interface du routeur ciblé. */
const roleOf = (state: LabState, p: FaultTargetParams, name: string): string | null => {
  const r = router(state, p)
  return r ? (iosState(r).interfaces[name]?.nat ?? null) : null
}

/** Entrées d'une liste standard au format « permit 192.168.1.0 0.0.0.255 » séparées par « ; ». */
const entriesOf = (acl: { entries: { action: string; src: string; srcWildcard: string }[] }): string =>
  acl.entries.map((e) => `${e.action} ${formatSpec(e.src, e.srcWildcard)}`).join(';')

/** La configuration NAT ciblée est-elle celle d'origine (selon la variante) ? */
function natConfigOk(state: LabState, p: FaultTargetParams): boolean {
  const r = router(state, p)
  if (!r) return false
  const ios = iosState(r)
  if (p['variant'] === 'roles')
    return (
      roleOf(state, p, String(p['inside'])) === 'inside' &&
      roleOf(state, p, String(p['outside'])) === 'outside'
    )
  if (p['variant'] === 'iface')
    return ios.natRules.some((x) => x.kind === 'dynamic' && x.acl === p['acl'] && x.iface === p['outside'])
  const acl = ios.acls.find((a) => a.name === p['acl'])
  return !!acl && entriesOf(acl) === p['entries']
}

/** Bloc de même taille que le réseau, juste après lui (la « faute de frappe » sur l'adresse du réseau). */
function nextBlock(network: string, wildcard: string): string | null {
  const net = parseIpv4(network)
  const wild = parseIpv4(wildcard)
  if (net === null || wild === null) return null
  return formatIpv4((net + wild + 1) >>> 0)
}

/** Lignes qui configurent la règle de NAT et la liste d'accès à partir de leur description. */
function natLines(p: FaultTargetParams, broken: boolean): string[] {
  const variant = String(p['variant']) as Variant
  const acl = String(p['acl'])
  const rule = (iface: string) => `ip nat inside source list ${acl} interface ${iface} overload`
  const header = ['enable', 'configure terminal']
  if (variant === 'acl') {
    // `entries` : « permit 192.168.1.0 0.0.0.255 » séparées par « ; » (listes standard numérotées)
    const entries = String(broken ? p['wrongEntries'] : p['entries']).split(';')
    return [...header, `no access-list ${acl}`, ...entries.map((e) => `access-list ${acl} ${e}`), 'end']
  }
  if (variant === 'iface')
    return [
      ...header,
      `no ${rule(broken ? String(p['outside']) : String(p['inside']))}`,
      rule(broken ? String(p['inside']) : String(p['outside'])),
      'end'
    ]
  const [inRole, outRole] = broken ? ['outside', 'inside'] : ['inside', 'outside']
  return [
    ...header,
    `interface ${String(p['inside'])}`,
    `no ip nat ${broken ? 'inside' : 'outside'}`,
    `ip nat ${inRole}`,
    `interface ${String(p['outside'])}`,
    `no ip nat ${broken ? 'outside' : 'inside'}`,
    `ip nat ${outRole}`,
    'end'
  ]
}

export const wrongNat: FaultDef = {
  id: ID,
  domain: 'reseau',
  difficulty: 3,
  title: 'NAT mal configuré',

  pick(state, rand) {
    const hosts = poweredHosts(state)
    const candidates: FaultTargetParams[] = []
    for (const r of Object.values(state.devices)) {
      if (!isIos(r) || r.kind !== 'router' || !r.powered) continue
      const ios = iosState(r)
      const rule = ios.natRules.find((x) => x.kind === 'dynamic')
      if (!rule || rule.kind !== 'dynamic') continue
      const inside = r.interfaces.find((i) => ios.interfaces[i.name]?.nat === 'inside')
      if (!inside || ios.interfaces[rule.iface]?.nat !== 'outside') continue
      const base = { router: r.id, acl: rule.acl, inside: inside.name, outside: rule.iface }
      const acl = ios.acls.find((a) => a.name === rule.acl)
      const variants: FaultTargetParams[] = [
        { ...base, variant: 'iface' },
        { ...base, variant: 'roles' }
      ]
      if (acl && acl.type === 'standard' && acl.entries.length > 0) {
        const wrong = acl.entries.map((e) => {
          const moved = nextBlock(e.src, e.srcWildcard)
          return moved === null ? null : `${e.action} ${formatSpec(moved, e.srcWildcard)}`
        })
        if (!wrong.includes(null))
          variants.push({
            ...base,
            variant: 'acl',
            entries: entriesOf(acl),
            wrongEntries: wrong.join(';')
          })
      }
      for (const v of variants)
        for (const host of hosts)
          for (const other of hosts) {
            if (other.id === host.id) continue
            for (const o of other.interfaces) {
              const oe = effectiveIpv4(o)
              if (oe) candidates.push({ ...v, host: host.id, peer: oe.address, peerName: other.name })
            }
          }
    }
    return firstVisible(wrongNat, state, candidates, rand)
  },

  inject: (state, p) => iosCommands(state, String(p['router']), natLines(p, true)),

  symptomVisible: (state, p) => !natConfigOk(state, p) && !peerAnswers(state, p),

  ticket: (_state, p) =>
    `Les postes du réseau interne n’accèdent plus à ${String(p['peerName'])} côté fournisseur (ping sans réponse), alors que la liaison avec le fournisseur est active.`,

  hints: (state, p) => [
    `Depuis ${nameOf(state, p['host'], 'le poste')}, le ping vers ${String(p['peerName'])} échoue, mais le routeur ${nameOf(state, p['router'], 'de bordure')} joint bien le fournisseur.`,
    `Les adresses privées doivent être traduites avant de sortir : examinez le NAT de ${nameOf(state, p['router'], 'le routeur')} (show ip nat translations, show running-config).`,
    `Vérifiez les trois éléments du NAT : les interfaces inside / outside, la règle de traduction et la liste d’accès qui désigne les adresses à traduire.`
  ],

  cause(state, p) {
    const name = nameOf(state, p['router'], 'le routeur')
    if (p['variant'] === 'roles')
      return `Sur ${name}, les rôles ip nat inside / outside de ${String(p['inside'])} et ${String(p['outside'])} étaient inversés.`
    if (p['variant'] === 'iface')
      return `Sur ${name}, la règle de NAT traduisait vers l’interface interne ${String(p['inside'])} au lieu de l’interface de sortie ${String(p['outside'])}.`
    return `Sur ${name}, la liste d’accès ${String(p['acl'])} du NAT désignait un autre réseau que le réseau interne à traduire.`
  },

  repair: (state, p) => iosCommands(state, String(p['router']), natLines(p, false)),

  healed: (state, p) => natConfigOk(state, p) && peerAnswers(state, p)
}
