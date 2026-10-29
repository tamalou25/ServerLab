/**
 * Valeurs par défaut des stratégies de groupe : paramètres vides, GPO créées avec un domaine.
 */
import type { Gpo, GpoComputerSettings, GpoUserSettings } from '../../model/schema'
import { AUTHENTICATED_USERS_SID } from '../../model/schema'

/** GUID bien connus des deux GPO créées avec chaque domaine. */
export const DEFAULT_DOMAIN_POLICY_ID = '{31B2F340-016D-11D2-945F-00C04FB984F9}'
export const DEFAULT_DC_POLICY_ID = '{6AC1786C-016F-11D2-945F-00C04FB984F9}'

export const DEFAULT_DOMAIN_POLICY_NAME = 'Default Domain Policy'
export const DEFAULT_DC_POLICY_NAME = 'Default Domain Controllers Policy'

export function emptyComputerSettings(): GpoComputerSettings {
  return {
    minPasswordLength: null,
    passwordComplexity: null,
    logonMessageTitle: null,
    logonMessageText: null,
    wuServer: { state: 'NotConfigured', url: '' },
    wuTargetGroup: { state: 'NotConfigured', group: '' },
    autoEnrollment: 'NotConfigured',
    firewallDomain: 'NotConfigured',
    firewallStandard: 'NotConfigured',
    firewallRules: [],
    lockoutThreshold: null,
    lockoutDuration: null,
    lockoutReset: null,
    auditLogon: null,
    auditAccountManagement: null
  }
}

export function emptyUserSettings(): GpoUserSettings {
  return {
    wallpaper: { state: 'NotConfigured', path: '', style: 'Fill' },
    noControlPanel: 'NotConfigured',
    noRun: 'NotConfigured',
    noCmd: 'NotConfigured',
    driveMaps: []
  }
}

/** Nouvelle GPO vide (filtrage par défaut : Utilisateurs authentifiés). */
export function newGpo(id: string, name: string, time: number): Gpo {
  return {
    id,
    name,
    comment: '',
    status: 'AllSettingsEnabled',
    securityFilter: [AUTHENTICATED_USERS_SID],
    createdAt: time,
    modifiedAt: time,
    userVersion: 0,
    computerVersion: 0,
    computer: emptyComputerSettings(),
    user: emptyUserSettings(),
    registry: []
  }
}

/**
 * GPO créées par la promotion du premier contrôleur : stratégie du domaine (mot de passe de
 * 7 caractères minimum, complexité exigée) et stratégie des contrôleurs de domaine.
 */
export function defaultDomainGpos(time: number): Gpo[] {
  const domainPolicy = newGpo(DEFAULT_DOMAIN_POLICY_ID, DEFAULT_DOMAIN_POLICY_NAME, time)
  domainPolicy.computer.minPasswordLength = 7
  domainPolicy.computer.passwordComplexity = true
  domainPolicy.computerVersion = 3
  const dcPolicy = newGpo(DEFAULT_DC_POLICY_ID, DEFAULT_DC_POLICY_NAME, time)
  dcPolicy.computerVersion = 1
  return [domainPolicy, dcPolicy]
}
