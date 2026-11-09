import { expect, test } from '@playwright/test'
import { clickMenu, launchApp, typeCommand } from './helpers'

test('Lab 29 : durcissement L2 Cisco, critères validés au fil de la configuration du switch', async () => {
  const { app, close, page, consoleErrors } = await launchApp()
  try {
    await clickMenu(app, ['Fichier', 'Ouvrir un lab…'])
    await page.getByTestId('lab-open-lab-29-durcissement-l2').click()
    await expect(page.getByTestId('lab-title')).toHaveText('Durcissement L2 d’un switch Cisco')
    await page.getByTestId('lab-check').click()
    await expect(page.getByTestId('lab-score')).toHaveText('1 / 9 critère(s) validé(s)')

    await page.getByTestId('device-SW1').dblclick()
    for (const line of [
      'en',
      'conf t',
      'ip dhcp snooping',
      'ip dhcp snooping vlan 1',
      'vlan 999',
      'exit',
      'int g0/2',
      'switchport nonegotiate',
      'switchport trunk native vlan 999',
      'int g0/1',
      'ip dhcp snooping trust',
      'end',
      'write memory'
    ])
      await typeCommand(page, 'SW1', line)
    await expect(page.getByTestId('device-window-SW1').getByTestId('terminal-ios')).toContainText('[OK]')
    await page.getByTestId('device-window-SW1').getByTestId('close-device-window').click()

    // Ping vers R1 (déjà valide), DHCP snooping, DTP, VLAN natif, enregistrement : 5 critères sur 9
    await page.getByTestId('mission-tab-mission').click()
    await page.getByTestId('lab-check').click()
    await expect(page.getByTestId('lab-score')).toHaveText('5 / 9 critère(s) validé(s)')
    await page.getByTestId('lab-hint-toggle-dai').click()
    await expect(page.getByTestId('lab-hint-dai')).toBeVisible()
    await expect(page.getByTestId('lab-hint-toggle-snooping')).toHaveCount(0)
    expect(consoleErrors).toEqual([])
  } finally {
    await close()
  }
})
