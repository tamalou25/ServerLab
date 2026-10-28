import { expect, test } from '@playwright/test'
import { launchApp, placeDevice } from './helpers'

test('Barre d’outils : icônes, infobulles avec raccourci, raccourcis V / C / P / Suppr', async () => {
  const { close, page, consoleErrors } = await launchApp()
  try {
    const pressed = (tool: string) => page.getByTestId(`tool-${tool}`)
    await expect(pressed('select')).toHaveAttribute('aria-pressed', 'true')

    await page.getByTestId('tool-cable').hover()
    const tooltip = page.getByRole('tooltip').filter({ hasText: 'Câble' })
    await expect(tooltip).toBeVisible()
    await expect(tooltip).toContainText('C')

    await page.getByTestId('topology-canvas').click({ position: { x: 300, y: 300 } })
    await page.keyboard.press('c')
    await expect(pressed('cable')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('tool-hint')).toBeVisible()
    await page.keyboard.press('p')
    await expect(pressed('pdu')).toHaveAttribute('aria-pressed', 'true')
    await page.keyboard.press('v')
    await expect(pressed('select')).toHaveAttribute('aria-pressed', 'true')
    await page.keyboard.press('Delete')
    await expect(pressed('delete')).toHaveAttribute('aria-pressed', 'true')
    await page.keyboard.press('Escape')
    await expect(pressed('select')).toHaveAttribute('aria-pressed', 'true')
    expect(consoleErrors).toEqual([])
  } finally {
    await close()
  }
})

test('Barre d’outils principale : annuler / rétablir, et aucun raccourci du canvas depuis une fenêtre d’équipement (U-01)', async () => {
  const { close, page, consoleErrors } = await launchApp()
  try {
    const bar = page.getByTestId('main-toolbar')
    await expect(bar.getByTestId('toolbar-undo')).toBeDisabled()
    await placeDevice(page, 'server', 300, 200)
    await expect(page.getByTestId('device-SRV1')).toBeVisible()
    await bar.getByTestId('toolbar-undo').click()
    await expect(page.getByTestId('device-SRV1')).toHaveCount(0)
    await bar.getByTestId('toolbar-redo').click()
    await expect(page.getByTestId('device-SRV1')).toBeVisible()
    // Bascule de mode dans la barre principale
    await bar.getByTestId('mode-simulation').click()
    await expect(bar.getByTestId('mode-simulation')).toHaveAttribute('aria-checked', 'true')
    await bar.getByTestId('mode-realtime').click()

    // Équipement sélectionné, fenêtre ouverte : Suppr et Ctrl+Z dans la fenêtre ne touchent pas au lab
    await page.getByTestId('device-SRV1').dblclick()
    const win = page.getByTestId('device-window-SRV1')
    await expect(win).toBeVisible()
    await win.click({ position: { x: 10, y: 10 } })
    await page.keyboard.press('Delete')
    await page.keyboard.press('Control+z')
    await expect(page.getByTestId('device-SRV1')).toBeVisible()
    await expect(bar.getByTestId('tool-select')).toHaveAttribute('aria-pressed', 'true')
    expect(consoleErrors).toEqual([])
  } finally {
    await close()
  }
})
