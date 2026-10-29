/**
 * Utilitaires E2E : lancement de l'application Electron construite (out/) dans un profil isolé.
 */
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export interface LaunchedApp {
  app: ElectronApplication
  /** Ferme l'application sans enregistrer (répond « Ne pas enregistrer » si besoin). */
  close: () => Promise<void>
  page: Page
  /** Erreurs console capturées (ex. violations CSP). */
  consoleErrors: string[]
  userData: string
}

export interface LaunchOptions {
  /** Profil existant, réutilisé pour vérifier la persistance entre deux lancements (jamais réécrit). */
  userData?: string
  /**
   * Nouveau profil : écran d'accueil et tutoriel proposés au démarrage (comme pour un nouvel
   * utilisateur). Par défaut, ils sont désactivés dans settings.json pour que chaque scénario
   * démarre directement sur le canvas.
   */
  home?: boolean
  tutorial?: boolean
  /** Variables d'environnement supplémentaires (ex. SERVERLAB_LIBRARY_URL : bibliothèque locale). */
  env?: Record<string, string>
  /** Langue enregistrée dans le nouveau profil (français par défaut ; « system » : langue du système). */
  language?: 'fr' | 'en' | 'system'
}

export async function launchApp(options: LaunchOptions = {}): Promise<LaunchedApp> {
  let userData = options.userData
  if (!userData) {
    userData = mkdtempSync(join(tmpdir(), 'serverlab-e2e-'))
    // Interface en français par défaut : les scénarios ne dépendent pas de la langue du système
    const settings: Record<string, boolean | string> = { language: options.language ?? 'fr' }
    if (!options.home) settings['showHomeOnStartup'] = false
    if (!options.tutorial) settings['showTutorialOnStartup'] = false
    writeFileSync(join(userData, 'settings.json'), JSON.stringify(settings))
  }
  // SERVERLAB_E2E_EXECUTABLE : application empaquetée (ex. dist/linux-unpacked/serverlab) au lieu de out/
  const packaged = process.env['SERVERLAB_E2E_EXECUTABLE']
  const app = await electron.launch({
    ...(packaged
      ? { executablePath: resolve(packaged), args: ['--no-sandbox'] }
      : { args: [resolve(__dirname, '../../out/main/index.js'), '--no-sandbox'] }),
    env: { ...process.env, ...options.env, SERVERLAB_USER_DATA: userData, NODE_ENV: 'production' }
  })
  const page = await app.firstWindow()
  const consoleErrors: string[] = []
  // Erreurs du renderer : conservées pour les assertions et affichées dans les journaux (CI)
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return
    consoleErrors.push(msg.text())
    console.log(`[renderer] ${msg.text()}`)
  })
  page.on('pageerror', (err) => {
    consoleErrors.push(err.message)
    console.log(`[renderer] ${err.stack ?? err.message}`)
  })
  await page.waitForLoadState('domcontentloaded')
  const close = async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = (async () => ({
        response: 1,
        checkboxChecked: false
      })) as typeof dialog.showMessageBox
    })
    await app.close()
  }
  return { app, close, page, consoleErrors, userData }
}

/** Déclenche un élément du menu natif, ex. ['Fichier', 'Enregistrer sous…']. */
export async function clickMenu(app: ElectronApplication, path: string[]): Promise<void> {
  await app.evaluate(({ Menu, BrowserWindow }, labels) => {
    let items = Menu.getApplicationMenu()?.items ?? []
    let target: Electron.MenuItem | undefined
    for (const label of labels) {
      target = items.find((i) => i.label.replace('&', '') === label)
      if (!target) throw new Error(`Menu introuvable : ${label}`)
      items = target.submenu?.items ?? []
    }
    const win = BrowserWindow.getAllWindows()[0]
    target?.click(undefined, win, win?.webContents)
  }, path)
}

/** Place un équipement de la palette à une position relative au canvas. */
export async function placeDevice(page: Page, kind: string, x: number, y: number): Promise<void> {
  const tile = page.getByTestId(`palette-${kind}`)
  // Onglet d'une autre famille affiché : retour à « Tous »
  if (!(await tile.isVisible())) await page.getByTestId('palette-group-all').click()
  await tile.click()
  await page.getByTestId('topology-canvas').locator('.react-flow__pane').click({ position: { x, y } })
}

/** Relie deux équipements avec l'outil Câble. */
export async function cableDevices(
  page: Page,
  a: string,
  portA: string,
  b: string,
  portB: string
): Promise<void> {
  await page.getByTestId('tool-cable').click()
  await page.getByTestId(`device-${a}`).click()
  await page.getByTestId('port-picker').getByTestId(`port-${portA}`).click()
  await page.getByTestId(`device-${b}`).click()
  await page.getByTestId('port-picker').getByTestId(`port-${portB}`).click()
  await page.getByTestId('tool-select').click()
}

/** Configure l'adresse IPv4 statique d'un serveur/poste via sa fenêtre (onglet Config). */
export async function configureHostIp(
  page: Page,
  device: string,
  ip: string,
  mask: string,
  gateway = '',
  dns = ''
): Promise<void> {
  await page.getByTestId(`device-${device}`).dblclick()
  const win = page.getByTestId(`device-window-${device}`)
  await win.getByTestId('nav-iface-Ethernet0').click()
  await win.getByTestId('ip-static').check()
  await win.getByTestId('ip-address').fill(ip)
  await win.getByTestId('ip-mask').fill(mask)
  await win.getByTestId('ip-gateway').fill(gateway)
  await win.getByTestId('ip-dns1').fill(dns)
  await win.getByTestId('ip-apply').click()
  await expect(win.getByTestId('ip-effective')).toHaveText(ip)
  await win.getByTestId('close-device-window').click()
}

/** Ouvre l'onglet Console d'un équipement et choisit l'interpréteur. */
export async function openConsole(page: Page, device: string, shell: 'cmd' | 'powershell'): Promise<void> {
  const win = page.getByTestId(`device-window-${device}`)
  if ((await win.count()) === 0) await page.getByTestId(`device-${device}`).dblclick()
  await win.getByTestId('tab-console').click()
  await win.getByTestId(`console-${shell}`).click()
}

/** Ouvre l'onglet Bureau d'un équipement ; renvoie la fenêtre de l'équipement. */
export async function openDesktop(page: Page, device: string) {
  const win = page.getByTestId(`device-window-${device}`)
  if ((await win.count()) === 0) await page.getByTestId(`device-${device}`).dblclick()
  await win.getByTestId('tab-desktop').click()
  await expect(win.getByTestId('taskbar')).toBeVisible()
  return win
}

/** Lance un outil d'administration depuis le menu Outils du Gestionnaire de serveur. */
export async function openTool(page: Page, device: string, tool: string): Promise<void> {
  const win = await openDesktop(page, device)
  await win.getByTestId('app-servermanager').getByTestId('sm-tools').click()
  await win.getByTestId(`sm-tool-${tool}`).click()
  await expect(win.getByTestId(`app-${tool}`)).toBeVisible()
}

/** Déverrouille ou ouvre la session de l'écran de verrouillage (Ctrl+Alt+Suppr puis mot de passe). */
export async function unlock(page: Page, device: string, password: string, user?: string): Promise<void> {
  const win = page.getByTestId(`device-window-${device}`)
  await win.getByTestId('send-cad').click()
  if (user) await win.getByTestId('logon-user').fill(user)
  await win.getByTestId('logon-password').fill(password)
  await win.getByTestId('logon-submit').click()
}

/**
 * Attend la fin de l'ouverture de session : le Bureau s'affiche, ou le message d'erreur de l'écran
 * de connexion est remonté tel quel (diagnostic explicite).
 */
export async function expectSignedIn(page: Page, device: string): Promise<void> {
  const win = page.getByTestId(`device-window-${device}`)
  const error = win.getByTestId('logon-error')
  await expect(win.getByTestId('taskbar').or(error)).toBeVisible()
  if (await error.isVisible()) throw new Error(`Ouverture de session refusée : ${await error.innerText()}`)
}

/** Tape une commande dans la console visible et valide. */
export async function typeCommand(page: Page, device: string, command: string): Promise<void> {
  const input = page.getByTestId(`device-window-${device}`).getByTestId('terminal-input')
  await input.fill(command)
  await input.press('Enter')
}
