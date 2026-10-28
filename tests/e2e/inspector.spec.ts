import { expect, test } from '@playwright/test'
import { launchApp, placeDevice } from './helpers'

test('Inspecteur : onglets Résumé, Audit, Dépannage ; voyant d’état dans le résumé', async () => {
  const { close, page, consoleErrors } = await launchApp()
  try {
    const tabs = page.getByRole('tablist', { name: 'Panneau latéral' }).getByRole('tab')
    await expect(tabs).toHaveText(['Résumé', 'Audit', 'Dépannage'])
    await expect(page.getByTestId('right-tab-properties')).toHaveAttribute('aria-selected', 'true')

    await placeDevice(page, 'server', 300, 200)
    await page.getByTestId('device-SRV1').click()
    const panel = page.getByTestId('properties-panel')
    await expect(panel.locator('[data-shape]').first()).toHaveAttribute('data-shape', 'ring')

    // Dépannage : invitation à lancer un scénario (ouvre le dialogue existant)
    await page.getByTestId('right-tab-troubleshoot').click()
    await page.getByTestId('tshoot-open').click()
    await expect(page.getByTestId('tshoot-dialog')).toBeVisible()
    expect(consoleErrors).toEqual([])
  } finally {
    await close()
  }
})

test('Panneau Simulation inférieur : visible en mode Simulation, vitesse, repli mémorisé', async () => {
  const { close, page, consoleErrors } = await launchApp()
  try {
    await expect(page.getByTestId('simulation-panel')).toHaveCount(0)
    await page.getByTestId('mode-simulation').click()
    const panel = page.getByTestId('simulation-panel')
    await expect(panel).toBeVisible()
    await expect(panel.getByTestId('sim-step')).toBeDisabled()
    await panel.getByTestId('sim-speed').selectOption('2')
    await expect(panel.getByTestId('sim-speed')).toHaveValue('2')
    await expect(panel.getByTestId('sim-events')).toBeVisible()
    await panel.getByTestId('sim-collapse').click()
    await expect(panel.getByTestId('sim-events')).toHaveCount(0)
    await expect(panel.getByTestId('sim-collapse')).toHaveAttribute('aria-expanded', 'false')
    await panel.getByTestId('sim-collapse').click()
    await expect(panel.getByTestId('sim-events')).toBeVisible()
    await page.getByTestId('mode-realtime').click()
    await expect(page.getByTestId('simulation-panel')).toHaveCount(0)
    expect(consoleErrors).toEqual([])
  } finally {
    await close()
  }
})
