/**
 * Critères de lab du rôle AD DS.
 */
import { z } from 'zod'
import { firstDomain, fqdn, hostByName, sameName } from '../../labs/lookup'
import { defineCriterion } from '../types'
import { FSMO_ROLES } from '../../model/schema'
import { allObjects, findContainer, groupsOf } from './directory'
import { fsmoHolder } from './fsmo'
import { RESTORED_EVENT_ID } from './objects'
import { dcSite } from './sites'

export const addsCriteria = [
  defineCriterion(
    z.object({
      type: z.literal('adObject'),
      kind: z.enum(['ou', 'user', 'group', 'computer']),
      name: z.string(),
      /** Nom de l'unité d'organisation parente. */
      parent: z.string().optional(),
      /** Groupe dont l'objet doit être membre (directement ou par imbrication). */
      memberOf: z.string().optional(),
      enabled: z.boolean().optional()
    }),
    (state, check) => {
      const domain = firstDomain(state)
      if (!domain) return false
      const found = allObjects(domain).find((o) => {
        if (o.kind !== (check.kind === 'ou' ? 'container' : check.kind)) return false
        if (o.kind === 'container' && o.obj.kind !== 'ou') return false
        return (
          sameName(o.obj.name, check.name) ||
          (o.kind !== 'container' && o.kind !== 'computer' && sameName(o.obj.sam, check.name))
        )
      })
      if (!found) return false
      if (check.parent !== undefined) {
        const parent = findContainer(domain, found.obj.parentId)
        if (!parent || !sameName(parent.name, check.parent)) return false
      }
      if (
        check.memberOf !== undefined &&
        !groupsOf(domain, found.obj.id).some((g) => sameName(g.name, check.memberOf ?? ''))
      )
        return false
      if (check.enabled !== undefined && (found.kind === 'user' || found.kind === 'computer'))
        return found.obj.enabled === check.enabled
      return true
    },
    'Objet Active Directory'
  ),
  defineCriterion(
    z.object({ type: z.literal('domainJoined'), device: z.string(), domain: z.string() }),
    (state, check) => hostByName(state, check.device)?.host.domain === fqdn(check.domain),
    'Ordinateur joint au domaine'
  ),
  defineCriterion(
    z.object({ type: z.literal('adSite'), site: z.string(), subnet: z.string().optional() }),
    (state, check) => {
      const domain = firstDomain(state)
      const site = domain?.sites.find((x) => sameName(x.name, check.site))
      if (!domain || !site) return false
      return (
        !check.subnet || domain.subnets.some((n) => n.prefix === check.subnet && sameName(n.site, site.name))
      )
    },
    'Site Active Directory'
  ),
  defineCriterion(
    z.object({
      type: z.literal('siteLink'),
      sites: z.array(z.string()),
      maxInterval: z.number().optional()
    }),
    (state, check) =>
      !!firstDomain(state)?.siteLinks.some(
        (l) =>
          check.sites.every((s) => l.sites.some((x) => sameName(x, s))) &&
          (check.maxInterval === undefined || l.interval <= check.maxInterval)
      ),
    'Lien de sites'
  ),
  defineCriterion(
    z.object({ type: z.literal('domainController'), server: z.string(), site: z.string().optional() }),
    (state, check) => {
      const server = hostByName(state, check.server)
      const domain = firstDomain(state)
      if (!server || !domain?.controllers.includes(server.id)) return false
      return !check.site || sameName(dcSite(domain, server.id), check.site)
    },
    'Contrôleur de domaine'
  ),
  defineCriterion(
    z.object({ type: z.literal('fsmoRole'), role: z.enum(FSMO_ROLES), server: z.string() }),
    (state, check) => {
      const domain = firstDomain(state)
      const server = hostByName(state, check.server)
      return !!domain && !!server && fsmoHolder(domain, check.role) === server.id
    },
    'Détenteur d’un rôle FSMO'
  ),
  defineCriterion(
    z.object({ type: z.literal('logonServer'), client: z.string(), server: z.string() }),
    (state, check) =>
      sameName(hostByName(state, check.client)?.host.session?.logonServer ?? '', check.server),
    'Contrôleur qui authentifie une session'
  ),
  defineCriterion(
    z.object({
      type: z.literal('adObjectRestored'),
      domain: z.string(),
      /** Nom d'ouverture de session (sam) ou nom de l'objet restauré. */
      name: z.string()
    }),
    (state, check) => {
      const domain = state.domains[check.domain.toLowerCase()]
      if (!domain) return false
      const account = `${domain.netbios}\\${check.name}`.toLowerCase()
      const wanted = check.name.toLowerCase()
      // L'objet doit exister maintenant et avoir été restauré depuis la Corbeille (pas recréé)
      const exists = [...domain.users, ...domain.groups, ...domain.computers].some(
        (o) => o.name.toLowerCase() === wanted || ('sam' in o && o.sam.toLowerCase() === wanted)
      )
      return (
        exists &&
        domain.controllers.some((id) => {
          const dc = state.devices[id]
          return (
            (dc?.kind === 'server' || dc?.kind === 'client') &&
            dc.host.eventLog.some(
              (e) => e.eventId === RESTORED_EVENT_ID && e.account?.toLowerCase() === account
            )
          )
        })
      )
    },
    'Objet restauré depuis la Corbeille AD'
  )
]
