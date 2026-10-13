/**
 * Ouverture d'adresses dans le navigateur du système : uniquement par le process principal et
 * uniquement les adresses de la liste blanche (shared/bugReport.ts). Le renderer n'a aucun moyen
 * d'ouvrir une adresse externe.
 */
import { app, shell } from 'electron'
import { release } from 'node:os'
import { bugReportUrl, isAllowedExternalUrl, osName } from '../shared/bugReport'

/** Ouvre l'adresse si elle figure dans la liste blanche ; renvoie faux sinon. */
export async function openAllowedExternal(url: string): Promise<boolean> {
  if (!isAllowedExternalUrl(url)) return false
  // URL normalisée (celle qui a été validée), jamais la chaîne brute
  await shell.openExternal(new URL(url).href)
  return true
}

/**
 * Aide > Signaler un bug : issue préremplie avec la version, le système et Electron. Rien d'autre
 * n'est transmis (ni le lab, ni le nom d'utilisateur, ni le nom de la machine, ni des chemins).
 */
export function openBugReport(): Promise<boolean> {
  return openAllowedExternal(
    bugReportUrl({
      appVersion: app.getVersion(),
      os: osName(process.platform),
      osRelease: release(),
      arch: process.arch,
      electron: process.versions.electron,
      chrome: process.versions.chrome
    })
  )
}
