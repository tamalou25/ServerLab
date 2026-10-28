/**
 * Références visuelles des écrans clés, en thème sombre et clair (filet de sécurité de l'interface v2).
 * Les zones variables (heure d'enregistrement automatique, horloge du Bureau) sont masquées.
 * Mise à jour volontaire des références : npx playwright test visual.spec.ts --update-snapshots
 */
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { domainLab, openLab } from './fixtures'
import { clickMenu, launchApp, openConsole } from './helpers'

const THEMES = [
  { id: 'sombre', menu: 'Sombre' },
  { id: 'clair', menu: 'Clair' }
] as const

/** Fenêtre de taille fixe : les captures ne dépendent pas de l'écran de la machine. */
async function fixWindow(app: ElectronApplication, page: Page): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    win?.unmaximize()
    win?.setContentSize(1280, 800)
  })
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1280)
}

/** Zones qui changent d'une exécution à l'autre. */
const masks = (page: Page): Locator[] => [page.getByTestId('status-save')]

for (const theme of THEMES) {
  test.describe(`thème ${theme.id}`, () => {
    test('écran d’accueil', async () => {
      const { app, page, close } = await launchApp({ home: true })
      try {
        await fixWindow(app, page)
        await clickMenu(app, ['Affichage', 'Thème', theme.menu])
        await expect(page.getByTestId('home-screen')).toBeVisible()
        await expect(page).toHaveScreenshot(`accueil-${theme.id}.png`, { mask: masks(page) })
      } finally {
        await close()
      }
    })

    test('canvas, palette, inspecteur, Simulation, console et fenêtre d’équipement', async () => {
      const { app, page, close } = await launchApp()
      try {
        await fixWindow(app, page)
        await clickMenu(app, ['Affichage', 'Thème', theme.menu])
        await openLab(app, page, domainLab())
        await clickMenu(app, ['Affichage', 'Ajuster à la fenêtre'])
        await page.getByTestId('device-SRV1').click()
        await expect(page.getByTestId('properties-panel')).toBeVisible()
        // Laisse finir l'animation d'ajustement de la vue
        await page.waitForTimeout(500)
        await expect(page).toHaveScreenshot(`canvas-${theme.id}.png`, { mask: masks(page) })
        await expect(page.getByTestId('palette')).toHaveScreenshot(`palette-${theme.id}.png`)
        await expect(page.getByRole('complementary', { name: 'Panneau latéral' })).toHaveScreenshot(
          `inspecteur-${theme.id}.png`
        )

        await page.getByTestId('mode-simulation').click()
        await expect(page.getByTestId('simulation-panel')).toHaveScreenshot(`simulation-${theme.id}.png`)
        await page.getByTestId('mode-realtime').click()

        await page.getByTestId('device-SRV1').dblclick()
        const win = page.getByTestId('device-window-SRV1')
        await expect(win).toBeVisible()
        await expect(win).toHaveScreenshot(`fenetre-equipement-${theme.id}.png`, { mask: masks(page) })

        await openConsole(page, 'SRV1', 'powershell')
        await expect(win).toHaveScreenshot(`console-${theme.id}.png`, { mask: masks(page) })
      } finally {
        await close()
      }
    })
  })
}
