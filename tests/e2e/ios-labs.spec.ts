import { expect, test } from '@playwright/test'
import { clickMenu, launchApp, typeCommand } from './helpers'

test('Lab IOS : ouverture depuis le menu, configuration à la console, vérification à 100 %', async () => {
  const { app, close, page, consoleErrors } = await launchApp()
  try {
    await clickMenu(app, ['Fichier', 'Ouvrir un lab…'])
    await expect(page.getByTestId('lab-picker')).toContainText(
      'Sujet E6 : deux sites Cisco et Windows Server'
    )
    await page.getByTestId('lab-open-lab-22-ios-base').click()
    await expect(page.locator('.react-flow__node')).toHaveCount(2)
    await expect(page.getByTestId('lab-title')).toHaveText('Premiers pas sur un routeur Cisco')

    // Rien n'est configuré : tous les critères échouent, les indices s'affichent
    await page.getByTestId('lab-check').click()
    await expect(page.getByTestId('lab-score')).toHaveText('0 / 5 critère(s) validé(s)')
    await page.getByTestId('lab-hint-toggle-secret').click()
    await expect(page.getByTestId('lab-hint-secret')).toBeVisible()

    // Configuration saisie à la console du routeur, comme à la main
    await page.getByTestId('device-R1').dblclick()
    for (const line of [
      'en',
      'conf t',
      'enable secret Cisco123',
      'banner motd #Acces reserve#',
      'int g0/0',
      'description LAN PC1',
      'ip address 192.168.1.1 255.255.255.0',
      'no shutdown',
      'end',
      'write memory'
    ])
      await typeCommand(page, 'R1', line)
    await expect(page.getByTestId('device-window-R1').getByTestId('terminal-ios')).toContainText('[OK]')
    await page.getByTestId('device-window-R1').getByTestId('close-device-window').click()

    await page.getByTestId('mission-tab-mission').click()
    await page.getByTestId('lab-check').click()
    await expect(page.getByTestId('lab-score')).toHaveText('5 / 5 critère(s) validé(s)')
    await expect(page.locator('[data-testid^="lab-hint-"]')).toHaveCount(0)
    expect(consoleErrors).toEqual([])
  } finally {
    await close()
  }
})
