/**
 * Vérification d'identifiants saisis sur un ordinateur distant (Bureau à distance, VPN) :
 * compte local (DOMAINE = nom de l'ordinateur) ou compte du domaine de l'ordinateur.
 */
import type { Domain, HostDevice, LabState } from '../../model/schema'
import { domainToken, localToken, type AccessToken } from '../files/acl'
import { findLocalUser, isLocalAdmin } from '../../services/localaccounts'

/** Compte saisi → domaine (NetBIOS ou FQDN) et nom. */
export function splitAccount(user: string): { domain: string | null; sam: string } {
  const text = user.trim()
  if (text.includes('\\')) {
    const [domain = '', sam = ''] = text.split('\\')
    return { domain, sam }
  }
  if (text.includes('@')) {
    const [sam = '', domain = ''] = text.split('@')
    return { domain, sam }
  }
  return { domain: null, sam: text }
}

/** Jeton du compte sur l'ordinateur distant (null : identifiants refusés). */
export function authenticate(
  state: LabState,
  target: HostDevice,
  user: string,
  password: string
): AccessToken | null {
  const { domain: domainName, sam } = splitAccount(user)
  const local = !domainName || domainName.toUpperCase() === target.name.toUpperCase() || domainName === '.'
  const domain: Domain | undefined = target.host.domain ? state.domains[target.host.domain] : undefined
  if (local && (!domain || domainName)) {
    if (sam.toLowerCase() === 'administrateur')
      return password === target.host.localAdminPassword ? localToken(target.name, 'Administrateur') : null
    // Compte de la base locale (New-LocalUser) : activé et mot de passe exact
    const user = findLocalUser(state, target.id, sam)
    return user && user.enabled && user.password === password
      ? localToken(target.name, user.name, isLocalAdmin(state, target.id, user.name))
      : null
  }
  if (!domain) return null
  if (
    domainName &&
    domainName.toUpperCase() !== domain.netbios.toUpperCase() &&
    domainName.toLowerCase() !== domain.name
  )
    return null
  const account = domain.users.find((u) => u.sam.toLowerCase() === sam.toLowerCase())
  if (!account || account.password !== password) return null
  return domainToken(domain, account.sam)
}
