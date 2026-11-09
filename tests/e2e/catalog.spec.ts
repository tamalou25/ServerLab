/**
 * Catalogue des exercices : recherche au clavier, filtres (niveau, durée, parcours, réussite), nombre de
 * résultats, remise à zéro, état « aucun résultat », ouverture d'un exercice ; contexte du parcours et
 * ancrage d'une fenêtre d'équipement à côté de la consigne.
 */
import { expect, test } from '@playwright/test'
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { clickMenu, launchApp } from './helpers'

const TOTAL = readdirSync(resolve(__dirname, '../../labs')).filter((f) => f.endsWith('.json')).length

test('Catalogue : recherche, filtres, remise à zéro, aucun résultat, ouverture au clavier', async () => {
  const { app, close, page, consoleErrors } = await launchApp()
  try {
    await clickMenu(app, ['Fichier', 'Ouvrir un lab…'])
    const picker = page.getByTestId('lab-picker')
    const rows = picker.locator('[data-testid^="catalog-lab-"]')
    const count = picker.getByTestId('catalog-count')
    await expect(count).toHaveText(`${TOTAL} exercices`)
    await expect(rows).toHaveCount(TOTAL)
    await expect(picker.getByTestId('catalog-reset')).toHaveCount(0)

    // La recherche a le focus à l'ouverture ; sans accents ni casse
    await expect(picker.getByTestId('catalog-search')).toBeFocused()
    await page.keyboard.type('ETENDUE dhcp')
    await expect(rows).toHaveCount(1)
    await expect(count).toHaveText(`1 exercice sur ${TOTAL}`)
    await expect(picker.getByTestId('catalog-lab-lab-02-dhcp')).toBeVisible()

    // Filtres par métadonnées réelles : niveau, durée, parcours
    await picker.getByTestId('catalog-search-clear').click()
    await picker.getByTestId('catalog-difficulty-Débutant').click()
    await expect(picker.getByTestId('catalog-difficulty-Débutant')).toHaveAttribute('aria-pressed', 'true')
    await expect(rows).toHaveCount(5)
    await picker.getByTestId('catalog-pathway').click()
    await expect(rows).toHaveCount(2)
    await expect(picker.getByTestId('catalog-lab-lab-01-adressage')).toContainText('Parcours, étape 1')
    await picker.getByTestId('catalog-duration-long').click()
    await expect(rows).toHaveCount(0)

    // Aucun résultat : explication et remise à zéro
    const empty = picker.getByTestId('catalog-empty')
    await expect(empty).toContainText('Aucun exercice ne correspond')
    await expect(count).toHaveText(`0 exercice sur ${TOTAL}`)
    await picker.getByTestId('catalog-empty-reset').click()
    await expect(rows).toHaveCount(TOTAL)
    await expect(picker.getByTestId('catalog-difficulty-Débutant')).toHaveAttribute('aria-pressed', 'false')

    // Aucune réussite enregistrée sur ce profil : « Déjà réussi » ne retient rien, « Réinitialiser » rétablit tout
    await picker.getByTestId('catalog-status-done').click()
    await expect(rows).toHaveCount(0)
    await picker.getByTestId('catalog-reset').click()
    await expect(rows).toHaveCount(TOTAL)

    // Clavier : flèche bas vers le premier résultat, Entrée l'ouvre
    await picker.getByTestId('catalog-search').fill('samba linux')
    await expect(picker.getByTestId('catalog-lab-lab-48-linux-samba')).toBeVisible()
    await page.keyboard.press('ArrowDown')
    await expect(picker.locator('[data-testid^="lab-open-"]').first()).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(picker).toHaveCount(0)
    await expect(page.getByTestId('lab-title')).toBeVisible()
    expect(consoleErrors).toEqual([])
  } finally {
    await close()
  }
})

test('Mission : contexte du parcours, fenêtre ancrée à côté de la consigne puis détachée', async () => {
  const { app, close, page, consoleErrors } = await launchApp()
  try {
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      win?.unmaximize()
      win?.setContentSize(1366, 768)
    })
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1366)
    await clickMenu(app, ['Fichier', 'Ouvrir un lab…'])
    await page.getByTestId('lab-open-lab-01-adressage').click()

    // L'exercice est replacé dans le parcours ; l'énoncé d'origine nomme une autre société, c'est dit
    const context = page.getByTestId('mission-pathway')
    await expect(context).toContainText('Parcours PME, étape 1 sur 12')
    await expect(context).toContainText('1. Relier le bureau et l’atelier')
    await expect(page.getByTestId('mission-pathway-note')).toContainText('Atelier Lambert')

    // Tous les équipements du lab sont dans la zone visible du plan après l'ouverture
    const canvas = (await page.getByTestId('topology-canvas').boundingBox())!
    for (const name of ['PC1', 'PC2', 'R1', 'SW1', 'SW2']) {
      const box = (await page.getByTestId(`device-${name}`).boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(canvas.x)
      expect(box.x + box.width).toBeLessThanOrEqual(canvas.x + canvas.width)
      expect(box.y).toBeGreaterThanOrEqual(canvas.y)
      expect(box.y + box.height).toBeLessThanOrEqual(canvas.y + canvas.height)
    }

    // Console ouverte depuis la barre latérale : flottante par défaut, puis ancrée à gauche du lecteur
    await page.getByTestId('mission-console-PC1').click()
    const win = page.getByTestId('device-window-PC1')
    await expect(win).toBeVisible()
    await expect(win).not.toHaveAttribute('data-docked')
    await win.getByTestId('dock-device-window').click()
    await expect(win).toHaveAttribute('data-docked', 'true')
    const reader = (await page.getByTestId('mission-reader').boundingBox())!
    const docked = (await win.boundingBox())!
    expect(docked.x + docked.width).toBeLessThanOrEqual(reader.x + 1)
    // La consigne et Vérifier restent lisibles et utilisables pendant la manipulation en console
    await expect(page.getByTestId('lab-title')).toBeVisible()
    await page.getByTestId('lab-check').click()
    await expect(page.getByTestId('lab-verification')).toBeVisible()
    await win.getByTestId('terminal-input').click()
    await page.keyboard.type('ipconfig')
    await page.keyboard.press('Enter')
    await expect(win).toContainText('Configuration IP')

    // Le choix est mémorisé pour la fenêtre suivante ; détacher rend la fenêtre flottante
    await page.getByTestId('mission-tab-summary').click()
    await win.getByTestId('close-device-window').click()
    await page.getByTestId('mission-console-PC2').click()
    const second = page.getByTestId('device-window-PC2')
    await expect(second).toHaveAttribute('data-docked', 'true')
    await second.getByTestId('dock-device-window').click()
    await expect(second).not.toHaveAttribute('data-docked')
    await expect(second.getByTestId('resize-device-window')).toBeVisible()
    expect(consoleErrors).toEqual([])
  } finally {
    await close()
  }
})
