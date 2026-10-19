/**
 * Panne `win.dns-wrong-a` : un enregistrement A de la zone pointe vers une mauvaise adresse IP
 * (`dns.removeRecord` puis `dns.addRecord`). Le nom se résout, mais vers une machine qui n'existe
 * pas : `nslookup` renvoie l'adresse erronée et le `ping` du nom ne répond pas. Symptôme lu par la
 * résolution de nom du moteur (sortie `nslookup` existante, déjà sourcée).
 */
import { command } from '../../commands/catalog'
import type { LabState } from '../../model/schema'
import { effectiveIpv4 } from '../../net/addressing'
import { dnsServersOf, firstAddress, resolveName } from '../../roles/dns/resolver'
import { dnsServerOf } from '../../roles/dns/state'
import { serviceRunning } from '../../services/servicestate'
import type { FaultDef, FaultTargetParams } from '../types'
import { nameOf } from './service-probes'
import { firstViable } from './viable'

const answer = (state: LabState, p: FaultTargetParams): string | null =>
  firstAddress(resolveName(state, String(p['client']), String(p['name'])))

/** Adresse erronée mais plausible : même réseau /24, autre dernier octet, absente de la zone. */
function wrongAddress(original: string, taken: Set<string>): string | null {
  const parts = original.split('.')
  const last = Number(parts[3])
  if (parts.length !== 4 || !Number.isInteger(last)) return null
  for (let k = 1; k < 250; k++) {
    const candidate = `${parts[0]}.${parts[1]}.${parts[2]}.${((last + 100 + k) % 250) + 2}`
    if (candidate !== original && !taken.has(candidate)) return candidate
  }
  return null
}

export const dnsWrongA: FaultDef = {
  id: 'win.dns-wrong-a',
  domain: 'windows',
  difficulty: 2,
  title: 'Enregistrement DNS erroné',

  pick(state, rand) {
    const candidates: FaultTargetParams[] = []
    for (const server of Object.values(state.devices)) {
      if (server.kind !== 'server' || !server.powered || !server.host.features.includes('DNS')) continue
      if (!serviceRunning(server, 'DNS')) continue
      const ips = server.interfaces.map((i) => effectiveIpv4(i)?.address).filter((a): a is string => !!a)
      const zones = dnsServerOf(server)?.zones ?? []
      for (const zone of zones) {
        if (zone.reverse) continue
        const taken = new Set(zone.records.map((r) => r.data))
        for (const record of zone.records) {
          if (record.type !== 'A' || record.name === '@') continue
          const wrong = wrongAddress(record.data, taken)
          if (!wrong) continue
          const name = `${record.name}.${zone.name}`
          for (const client of Object.values(state.devices)) {
            if (client.id === server.id || (client.kind !== 'client' && client.kind !== 'server')) continue
            if (!client.powered || !dnsServersOf(client).some((s) => ips.includes(s))) continue
            const p = {
              device: server.id,
              zone: zone.name,
              record: record.name,
              client: client.id,
              name,
              original: record.data,
              wrong
            }
            if (answer(state, p) === record.data) candidates.push(p)
          }
        }
      }
    }
    return firstViable(state, rand, candidates, dnsWrongA)
  },

  inject: (_state, p) => [
    command('dns.removeRecord', String(p['device']), String(p['zone']), String(p['record']), 'A'),
    command('dns.addRecord', String(p['device']), String(p['zone']), {
      name: String(p['record']),
      type: 'A',
      data: String(p['wrong'])
    })
  ],

  // Le nom se résout bien, mais vers l'adresse erronée (le DNS doit donc répondre)
  symptomVisible: (state, p) => answer(state, p) === String(p['wrong']),

  ticket: (state, p) =>
    `Depuis ${nameOf(state, p['client'])}, « ${String(p['name'])} » ne répond plus : le ping par le nom échoue, alors que la machine est allumée et que le ping par son adresse IP fonctionne.`,

  hints: (state, p) => [
    `Depuis ${nameOf(state, p['client'])}, le ping de « ${String(p['name'])} » échoue mais le ping de l’adresse IP de la machine répond.`,
    `Comparez l’adresse renvoyée par nslookup pour « ${String(p['name'])} » avec la vraie adresse de la machine.`,
    `Le serveur DNS répond : regardez le contenu de la zone ${String(p['zone'])} sur ${nameOf(state, p['device'])}.`
  ],

  cause: (state, p) =>
    `L’enregistrement A « ${String(p['name'])} » pointait vers ${String(p['wrong'])} au lieu de ${String(p['original'])} (zone ${String(p['zone'])} de ${nameOf(state, p['device'])}).`,

  repair: (_state, p) => [
    command('dns.removeRecord', String(p['device']), String(p['zone']), String(p['record']), 'A'),
    command('dns.addRecord', String(p['device']), String(p['zone']), {
      name: String(p['record']),
      type: 'A',
      data: String(p['original'])
    })
  ],

  healed: (state, p) => answer(state, p) === String(p['original'])
}
