/**
 * Navigation autorisée dans la fenêtre de l'application (contrôlée par le main).
 * Seule la page de l'application est permise : son fichier exact (hors ancre et paramètres) ou,
 * en développement, l'origine du serveur Vite. Un fichier glissé dans la fenêtre provoque une
 * navigation vers `file:///…` : elle est refusée (travail préservé, preload non exposé).
 */

/** Vrai si `url` désigne la page de l'application `appUrl` ou l'origine du serveur de dev. */
export function isAppNavigation(url: string, appUrl: string, devUrl?: string): boolean {
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return false
  }
  if (devUrl) {
    try {
      const dev = new URL(devUrl)
      if (dev.protocol !== 'file:' && target.origin === dev.origin) return true
    } catch {
      // Adresse de dev invalide : seule la page locale reste autorisée
    }
  }
  const app = new URL(appUrl)
  return target.protocol === 'file:' && target.host === app.host && target.pathname === app.pathname
}
