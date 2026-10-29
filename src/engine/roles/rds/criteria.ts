/**
 * Critères de lab du Bureau à distance et du rôle RDS.
 */
import { z } from 'zod'
import { serverByName, hostByName } from '../../labs/lookup'
import { defineCriterion } from '../types'
import { domainToken } from '../files/acl'
import { memberOfAny } from './connect'
import { rdsServerOf } from './state'

const sameAccount = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

export const rdsCriteria = [
  defineCriterion(
    z.object({
      type: z.literal('rdsCollection'),
      server: z.string(),
      name: z.string(),
      /** Groupe autorisé attendu (DOMAINE\nom ou nom). */
      group: z.string().optional(),
      /** Programme RemoteApp publié attendu (alias ou nom affiché). */
      app: z.string().optional()
    }),
    (state, check) => {
      const collection = rdsServerOf(serverByName(state, check.server))?.collections.find((c) =>
        sameAccount(c.name, check.name)
      )
      if (!collection) return false
      const group = check.group
      if (
        group &&
        !collection.userGroups.some(
          (g) => sameAccount(g, group) || sameAccount(g.split('\\')[1] ?? '', group)
        )
      )
        return false
      const app = check.app
      return (
        !app ||
        collection.remoteApps.some((a) => sameAccount(a.alias, app) || sameAccount(a.displayName, app))
      )
    },
    'Collection de sessions RDS'
  ),
  defineCriterion(
    z.object({
      type: z.literal('rdpSession'),
      /** Ordinateur distant. */
      server: z.string(),
      /** Compte DOMAINE\nom. */
      account: z.string(),
      /** true : une session doit être ouverte ; false : une tentative a dû être refusée (4625 de type 10). */
      opened: z.boolean().default(true)
    }),
    (state, check) => {
      const host = hostByName(state, check.server)
      if (!host) return false
      // Autorisation courante d'après l'état : un compte du domaine absent de tous les groupes des
      // collections (null : pas de collection ou compte hors domaine, rien à en déduire).
      const collections = rdsServerOf(host)?.collections ?? []
      const sam = check.account.split('\\').pop() ?? check.account
      const domain = host.host.domain ? state.domains[host.host.domain] : undefined
      const token = domain ? domainToken(domain, sam) : null
      const inCollection =
        collections.length > 0 && token
          ? collections.some((c) => memberOfAny(state, host, token, c.userGroups))
          : null
      if (check.opened !== false)
        return (
          host.host.remoteSessions.some((s) => sameAccount(s.account, check.account)) &&
          inCollection !== false
        )
      // Refus : motif d'autorisation (pas mot de passe faux ni nom non résolu), et le compte doit
      // être réellement exclu des collections aujourd'hui.
      return (
        inCollection === false &&
        host.host.eventLog.some(
          (e) =>
            e.eventId === 4625 &&
            e.message.toLowerCase().includes(check.account.toLowerCase()) &&
            e.message.includes('Type d’ouverture de session : 10') &&
            e.message.includes('n’a pas reçu le type d’ouverture de session')
        )
      )
    },
    'Session Bureau à distance'
  )
]
