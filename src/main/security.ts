/**
 * Durcissement de sécurité global d'Electron.
 * Bloque la navigation, les nouvelles fenêtres, les webviews et toutes les permissions.
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, session, type WebContents } from 'electron'
import { isAppNavigation } from '../shared/navigation'

/** Adresse exacte de la page de l'application empaquetée. */
const APP_PAGE_URL = pathToFileURL(join(__dirname, '../renderer/index.html')).href

/** Vrai si l'URL correspond à la page de l'application (fichier exact ou serveur de dev). */
function isAppUrl(url: string): boolean {
  const devUrl = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL']
  return isAppNavigation(url, APP_PAGE_URL, devUrl)
}

export function hardenWebContents(contents: WebContents): void {
  // Aucune navigation hors de l'application
  contents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault()
  })
  contents.on('will-redirect', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault()
  })
  // Aucune nouvelle fenêtre (liens externes ouverts explicitement par le main si besoin)
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  // Aucune webview
  contents.on('will-attach-webview', (event) => event.preventDefault())
}

export function applyGlobalSecurity(): void {
  // Refuse toutes les demandes de permissions (caméra, micro, notifications, géolocalisation…)
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  app.on('web-contents-created', (_event, contents) => hardenWebContents(contents))
}
