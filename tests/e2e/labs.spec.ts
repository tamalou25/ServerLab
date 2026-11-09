import { expect, test } from '@playwright/test'
import { clickMenu, configureHostIp, launchApp } from './helpers'

test('Lab 1 : ouverture depuis le menu, Vérifier avec indices, configuration puis 100 %', async () => {
  const { app, close, page, consoleErrors } = await launchApp()
  try {
    await clickMenu(app, ['Fichier', 'Ouvrir un lab…'])
    await expect(page.getByTestId('lab-picker')).toContainText('Partage de fichiers et autorisations NTFS')
    await page.getByTestId('lab-open-lab-01-adressage').click()
    await expect(page.locator('.react-flow__node')).toHaveCount(5)
    await expect(page.getByTestId('lab-title')).toHaveText('Adressage IP et routage entre deux réseaux')

    // Première vérification : rien n'est encore configuré, les indices s'affichent
    await page.getByTestId('lab-check').click()
    await expect(page.getByTestId('lab-score')).toHaveText('0 / 7 critère(s) validé(s)')
    await expect(page.getByTestId('lab-hint-pc1-ip')).toContainText('APIPA')

    // Routeur : interfaces Gi0/0 et Gi0/1
    await page.getByTestId('device-R1').dblclick()
    const r1 = page.getByTestId('device-window-R1')
    for (const [port, address] of [
      ['Gi0/0', '192.168.10.254'],
      ['Gi0/1', '192.168.20.254']
    ] as const) {
      await r1.getByTestId(`nav-iface-${port}`).click()
      await r1.getByTestId('if-address').fill(address)
      await r1.getByTestId('if-mask').fill('255.255.255.0')
      await r1.getByTestId('if-apply').click()
    }
    await r1.getByTestId('close-device-window').click()
    await page.getByTestId('mission-tab-mission').click()
    await page.getByTestId('lab-check').click()
    await expect(page.getByTestId('lab-score')).toHaveText('2 / 7 critère(s) validé(s)')
    await expect(page.getByTestId('lab-criterion-r1-a')).toHaveAttribute('data-state', 'ok')

    // Postes : adresse, masque et passerelle
    await configureHostIp(page, 'PC1', '192.168.10.10', '255.255.255.0', '192.168.10.254')
    await configureHostIp(page, 'PC2', '192.168.20.10', '255.255.255.0', '192.168.20.254')
    await page.getByTestId('mission-tab-mission').click()
    await page.getByTestId('lab-check').click()
    await expect(page.getByTestId('lab-score')).toHaveText('7 / 7 critère(s) validé(s)')
    await expect(page.locator('[data-testid^="lab-hint-"]')).toHaveCount(0)
    expect(consoleErrors).toEqual([])
  } finally {
    await close()
  }
})
