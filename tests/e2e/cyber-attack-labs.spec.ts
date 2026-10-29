import { expect, test } from '@playwright/test'
import { clickMenu, launchApp } from './helpers'

test('Lab 31 : scénarios joués depuis le panneau Simulation, critères validés', async () => {
  const { app, close, page, consoleErrors } = await launchApp()
  try {
    await clickMenu(app, ['Fichier', 'Ouvrir un lab…'])
    await page.getByTestId('lab-open-lab-31-compromission-ad').click()
    await expect(page.getByTestId('lab-title')).toHaveText("Compromission de l'annuaire (Red)")
    await page.getByTestId('lab-check').click()
    await expect(page.getByTestId('lab-score')).toHaveText('0 / 3 critère(s) validé(s)')

    // Le panneau Scénarios fait partie du mode Simulation ; seuls les scénarios du lab sont proposés
    await page.getByTestId('mode-simulation').click()
    await expect(page.getByTestId('scenario-select').locator('option')).toHaveCount(4)
    for (const id of ['auth-repetee', 'compte-service', 'reutilisation-acces']) {
      await page.getByTestId('scenario-select').selectOption(id)
      await page.getByTestId('scenario-step').click()
    }
    await expect(page.getByTestId('scenario-timeline').locator('li')).toHaveCount(1)

    await page.getByTestId('right-tab-lab').click()
    await page.getByTestId('lab-check').click()
    await expect(page.getByTestId('lab-score')).toHaveText('3 / 3 critère(s) validé(s)')
    expect(consoleErrors).toEqual([])
  } finally {
    await close()
  }
})

test('Lab 35 : sujet Red / Blue, le lab impose le camp de l’IA', async () => {
  const { app, close, page, consoleErrors } = await launchApp()
  try {
    await clickMenu(app, ['Fichier', 'Ouvrir un lab…'])
    await page.getByTestId('lab-open-lab-35-red-blue').click()
    await expect(page.getByTestId('lab-title')).toHaveText('Sujet Red / Blue : défendre le site')
    await page.getByTestId('lab-check').click()
    await expect(page.getByTestId('lab-score')).toHaveText('0 / 5 critère(s) validé(s)')

    await page.getByTestId('mode-simulation').click()
    await page.getByTestId('game-open').click()
    // L'IA joue Red : le joueur est Blue, minuteur de 15 minutes
    await expect(page.getByTestId('game-setup')).toContainText('6 tours maximum')
    await expect(page.getByTestId('game-setup')).toContainText('900 s')
    await expect(page.getByTestId('game-play-red')).toBeDisabled()
    await page.getByTestId('game-play-blue').click()
    await expect(page.getByTestId('game-side')).toHaveText('Vous jouez Blue')
    await page.getByTestId('game-harden-strong-password').click()
    await page.getByTestId('game-begin').click()
    await expect(page.getByTestId('game-timer')).toContainText('15:00')
    expect(consoleErrors).toEqual([])
  } finally {
    await close()
  }
})
