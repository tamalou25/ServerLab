/**
 * Cibles et sonde communes aux pannes de domaine (compte, horloge) : un utilisateur du domaine qui
 * ouvre une session sur un poste membre. La sonde rejoue l'ouverture de session
 * (`logon`, sortie des consoles déjà sourcée) avec le BON mot de passe et lit le message de refus :
 * elle ne modifie jamais l'état du lab.
 */
import type { Domain, HostDevice, LabState } from '../../model/schema'
import { logon } from '../../roles/adds/join'
import type { FaultTargetParams } from '../types'

/** Comptes qui ne servent pas de cible (comptes de service et d'administration du domaine). */
const SKIPPED = new Set(['administrateur', 'krbtgt', 'invité', 'invite', 'guest', 'administrator'])

/** Utilisateur du domaine + poste membre (non contrôleur) où il ouvre sa session. */
export function domainLogonCandidates(state: LabState): FaultTargetParams[] {
  const out: FaultTargetParams[] = []
  for (const domain of Object.values(state.domains)) {
    const dc = domain.controllers.map((id) => state.devices[id]).find((d) => d?.powered)
    if (!dc) continue
    for (const client of Object.values(state.devices)) {
      if ((client.kind !== 'client' && client.kind !== 'server') || !client.powered) continue
      if (client.host.domain !== domain.name || domain.controllers.includes(client.id)) continue
      for (const user of domain.users) {
        if (!user.enabled || user.password === '' || user.mustChangePassword) continue
        if (SKIPPED.has(user.sam.toLowerCase()) || user.lockoutTime !== null) continue
        out.push({ domain: domain.name, dc: dc.id, client: client.id, sam: user.sam })
      }
    }
  }
  return out
}

export const domainOf = (state: LabState, p: FaultTargetParams): Domain | undefined =>
  state.domains[String(p['domain'])]

export const clientOf = (state: LabState, p: FaultTargetParams): HostDevice | undefined => {
  const d = state.devices[String(p['client'])]
  return d && (d.kind === 'client' || d.kind === 'server') ? d : undefined
}

/** Résultat de l'ouverture de session de l'utilisateur ciblé, avec son vrai mot de passe. */
export function tryLogon(state: LabState, p: FaultTargetParams): { ok: boolean; message: string } {
  const domain = domainOf(state, p)
  const user = domain?.users.find((u) => u.sam === p['sam'])
  if (!domain || !user) return { ok: false, message: 'Compte introuvable.' }
  const r = logon(state, String(p['client']), {
    user: user.sam,
    password: user.password,
    domain: domain.netbios
  })
  return { ok: r.ok, message: r.message }
}
