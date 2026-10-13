import { expect, test } from '@playwright/test'
import { clickMenu, launchApp, placeDevice } from './helpers'

/**
 * Un dialogue modal ouvert bloque les raccourcis du canvas : Suppr ou Ctrl+Z ne modifient pas le
 * lab caché derrière (audit U-01).
 */
test('les raccourcis du canvas sont inactifs derrière un dialogue modal', async () => {
  const { app, close, page, consoleErrors } = await launchApp()
  try {
    await placeDevice(page, 'client', 300, 200)
    const nodes = page.locator('.react-flow__node')
    await expect(nodes).toHaveCount(1)
    await nodes.first().click()

    await clickMenu(app, ['Fichier', 'Ouvrir un lab…'])
    await expect(page.getByTestId('lab-picker')).toBeVisible()
    // Une touche à la fois : Suppr puis Ctrl+Z s'annuleraient mutuellement
    for (const key of ['Delete', 'Backspace', 'Control+z']) {
      await page.keyboard.press(key)
      await expect(nodes).toHaveCount(1)
      await expect(nodes.first()).toHaveClass(/selected/)
    }

    // Sans dialogue, Suppr supprime bien la sélection (le raccourci reste actif)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('lab-picker')).toHaveCount(0)
    await nodes.first().click()
    await page.keyboard.press('Delete')
    await expect(nodes).toHaveCount(0)
    expect(consoleErrors).toEqual([])
  } finally {
    await close()
  }
})

/** Dialogues accessibles (audit U-02) : titre relié, focus confiné, Échap pour fermer. */
test('dialogues : titre, focus confiné à la boîte, Échap', async () => {
  const { app, close, page, consoleErrors } = await launchApp()
  try {
    const inDialog = () =>
      page.evaluate(() => !!document.activeElement?.closest('[role="dialog"][aria-modal="true"]'))

    await clickMenu(app, ['Fichier', 'Ouvrir un lab…'])
    const picker = page.getByRole('dialog', { name: 'Ouvrir un lab' })
    await expect(picker).toBeVisible()
    expect(await inDialog()).toBe(true)
    // Tab et Maj+Tab ne sortent jamais de la boîte
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press(i % 2 ? 'Shift+Tab' : 'Tab')
      expect(await inDialog()).toBe(true)
    }
    await page.keyboard.press('Escape')
    await expect(picker).toHaveCount(0)

    await clickMenu(app, ['Aide', 'Raccourcis clavier'])
    const help = page.getByRole('dialog', { name: 'Raccourcis clavier' })
    await expect(help).toBeVisible()
    expect(await inDialog()).toBe(true)
    await page.keyboard.press('Escape')
    await expect(help).toHaveCount(0)
    expect(consoleErrors).toEqual([])
  } finally {
    await close()
  }
})
