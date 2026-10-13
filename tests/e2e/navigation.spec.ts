import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from '@playwright/test'
import { launchApp } from './helpers'

/**
 * Un fichier glissé dans la fenêtre (hors canvas) ne remplace pas la page : le renderer annule le
 * dépôt par défaut et le main refuse toute navigation vers un autre fichier local (audit S-01).
 */
test('aucune navigation vers un fichier local étranger (glisser-déposer)', async () => {
  const { close, page } = await launchApp()
  try {
    await expect(page.getByTestId('topology-canvas')).toBeVisible()
    const appUrl = page.url()

    // Dépôt hors du canvas : le comportement par défaut (ouvrir le fichier) est annulé
    const prevented = await page.evaluate(() => {
      const drop = new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: new DataTransfer()
      })
      document.body.dispatchEvent(drop)
      return drop.defaultPrevented
    })
    expect(prevented).toBe(true)

    // Navigation demandée par la page vers un .html local : refusée par le main
    const dir = mkdtempSync(join(tmpdir(), 'serverlab-nav-'))
    const trap = join(dir, 'piege.html')
    writeFileSync(trap, '<!doctype html><title>piege</title><p id="piege">piège</p>')
    await page.evaluate(() => ((window as unknown as { marqueur: number }).marqueur = 42))
    await page.evaluate((url) => {
      window.location.href = url
    }, pathToFileURL(trap).href)
    // Laisse le temps à une éventuelle navigation de se produire
    await page.waitForTimeout(1000)
    expect(page.url()).toBe(appUrl)
    expect(await page.evaluate(() => (window as unknown as { marqueur?: number }).marqueur)).toBe(42)
    // (navigation annulée par le main : Playwright la croit en cours, on interroge le DOM directement)
    expect(await page.evaluate(() => !!document.querySelector('[data-testid="topology-canvas"]'))).toBe(true)
  } finally {
    await close()
  }
})
