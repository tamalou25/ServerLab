/**
 * Confort d'affichage : 1 600 × 1 000, 1 366 × 768 et 1 366 × 768 à 125 % (1 093 × 614 px CSS). Aucun
 * défilement horizontal, actions essentielles (Vérifier, Importer, Enregistrer) visibles sans défiler,
 * panneaux bornés et repliés sur écran serré.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { clickMenu, launchApp } from './helpers'

async function setWindow(app: ElectronApplication, page: Page, w: number, h: number, zoom: number) {
  await app.evaluate(
    ({ BrowserWindow }, { w, h, zoom }) => {
      const win = BrowserWindow.getAllWindows()[0]
      win?.unmaximize()
      win?.setContentSize(w, h)
      win?.webContents.setZoomFactor(zoom)
    },
    { w, h, zoom }
  )
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(Math.round(w / zoom))
}

const noOverflow = (page: Page) =>
  page.evaluate(
    () =>
      document.documentElement.scrollWidth <= window.innerWidth &&
      document.body.scrollWidth <= window.innerWidth
  )

const visible = async (page: Page, id: string) => {
  const box = await page.getByTestId(id).boundingBox()
  const size = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
  return (
    !!box && box.x >= 0 && box.y >= 0 && box.x + box.width <= size.w + 1 && box.y + box.height <= size.h + 1
  )
}

for (const [w, h, zoom] of [
  [1600, 1000, 1],
  [1366, 768, 1],
  [1366, 768, 1.25]
] as const) {
  test(`${w} × ${h} à ${Math.round(zoom * 100)} % : trois espaces sans débordement, actions visibles`, async () => {
    const { app, close, page, consoleErrors } = await launchApp()
    try {
      await setWindow(app, page, w, h, zoom)
      const narrow = w / zoom < 1200
      // Atelier
      expect(await noOverflow(page)).toBe(true)
      expect(await visible(page, 'toolbar-save')).toBe(true)
      expect(await visible(page, 'tool-select')).toBe(true)
      await expect(page.getByTestId('palette')).toHaveCSS('width', narrow ? '44px' : '220px')
      const inspector = await page.getByTestId('inspector').boundingBox()
      expect(Math.round(inspector!.width)).toBeLessThanOrEqual(narrow ? 300 : 480)
      // Mission
      await clickMenu(app, ['Fichier', 'Ouvrir un lab…'])
      await page.getByTestId('lab-open-lab-28-ios-sujet-e6').click()
      await expect(page.getByTestId('mission-reader')).toBeVisible()
      expect(await noOverflow(page)).toBe(true)
      expect(await visible(page, 'lab-check')).toBe(true)
      expect(await visible(page, 'exam-start')).toBe(true)
      await expect(page.getByTestId('mission-sidebar')).toHaveCount(narrow ? 0 : 1)
      const reader = await page.getByTestId('mission-reader').boundingBox()
      const inner = await page.evaluate(() => window.innerWidth)
      expect(reader!.width).toBeLessThanOrEqual(inner * (narrow ? 0.5 : 0.6) + 1)
      // Énoncé long : le lecteur défile, le pied reste en place ; tableau Markdown rendu
      await expect(page.getByTestId('lab-panel').locator('table')).toHaveCount(1)
      // Enseignant
      await clickMenu(app, ['Affichage', 'Mode enseignant'])
      await page.getByTestId('rail-teacher').click()
      await page.getByTestId('teacher-view-grading').click()
      expect(await noOverflow(page)).toBe(true)
      expect(await visible(page, 'grading-open-subject')).toBe(true)
      expect(consoleErrors).toEqual([])
    } finally {
      await close()
    }
  })
}
