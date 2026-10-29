/**
 * Aide > Signaler un bug : adresse d'une issue GitHub préremplie (version, système, Electron,
 * étapes à compléter) et liste blanche des adresses que l'application peut ouvrir dans le
 * navigateur. Aucune donnée du lab ni donnée personnelle (nom d'utilisateur, nom de la machine,
 * chemins) n'est ajoutée : seules les informations ci-dessous, visibles avant l'envoi.
 */

/** Seule adresse externe ouverte par l'application. */
export const BUG_REPORT_URL = 'https://github.com/tamalou25/ServerLab/issues/new'

/** Environnement joint au rapport (aucune donnée personnelle). */
export interface BugReportEnvironment {
  appVersion: string
  /** Système : « Windows », « Linux », « macOS ». */
  os: string
  osRelease: string
  arch: string
  electron: string
  chrome: string
}

const OS_NAMES: Record<string, string> = { win32: 'Windows', linux: 'Linux', darwin: 'macOS' }

/** Nom lisible du système (process.platform). */
export function osName(platform: string): string {
  return OS_NAMES[platform] ?? platform
}

/** Corps du rapport : étapes à compléter par l'utilisateur, puis l'environnement. */
export function bugReportBody(env: BugReportEnvironment): string {
  return [
    '## Description',
    '',
    '<!-- Décrivez le problème en une ou deux phrases. -->',
    '',
    '## Étapes pour reproduire',
    '',
    '1. ',
    '2. ',
    '3. ',
    '',
    '## Résultat attendu',
    '',
    '',
    '## Résultat obtenu',
    '',
    '',
    '## Environnement',
    '',
    `- ServerLab : ${env.appVersion}`,
    `- Système : ${env.os} ${env.osRelease} (${env.arch})`,
    `- Electron : ${env.electron} (Chromium ${env.chrome})`,
    '',
    '<!-- Aucun fichier .slab n’est joint automatiquement : ajoutez-en un si besoin. -->'
  ].join('\n')
}

/** Adresse de l'issue préremplie (titre, corps, étiquette « bug »). */
export function bugReportUrl(env: BugReportEnvironment): string {
  const url = new URL(BUG_REPORT_URL)
  url.searchParams.set('title', '[Bug] ')
  url.searchParams.set('labels', 'bug')
  url.searchParams.set('body', bugReportBody(env))
  return url.toString()
}

/**
 * Liste blanche des adresses ouvertes dans le navigateur : uniquement la création d'une issue du
 * dépôt, en HTTPS, sans identifiants ni port ni fragment (paramètres de préremplissage autorisés).
 */
export function isAllowedExternalUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  const allowed = new URL(BUG_REPORT_URL)
  return (
    url.protocol === allowed.protocol &&
    url.hostname === allowed.hostname &&
    url.port === '' &&
    url.username === '' &&
    url.password === '' &&
    url.pathname === allowed.pathname &&
    url.hash === ''
  )
}
