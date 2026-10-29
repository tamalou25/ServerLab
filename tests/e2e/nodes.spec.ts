import { expect, test } from '@playwright/test'
import { cableDevices, configureHostIp, launchApp, placeDevice } from './helpers'

test('Nœuds : IP principale, LED d’état (opérationnel, à vérifier, non raccordé, éteint)', async () => {
  const { close, page, consoleErrors } = await launchApp()
  try {
    await placeDevice(page, 'server', 240, 160)
    await placeDevice(page, 'switch', 520, 290)
    await placeDevice(page, 'client', 240, 420)
    await placeDevice(page, 'client', 600, 440)
    await cableDevices(page, 'SRV1', 'Ethernet0', 'SW1', 'Fa0/1')
    await cableDevices(page, 'PC1', 'Ethernet0', 'SW1', 'Fa0/2')

    const srv = page.getByTestId('device-SRV1')
    // Carte raccordée mais sans adresse statique ni serveur DHCP : APIPA, LED orange
    await expect(srv).toHaveAttribute('data-health', 'warn')
    await configureHostIp(page, 'SRV1', '192.168.10.1', '255.255.255.0')
    await expect(srv).toContainText('192.168.10.1/24')
    await expect(srv).toHaveAttribute('data-health', 'ok')

    // Poste en DHCP sans serveur : adresse APIPA signalée
    await expect(page.getByTestId('device-PC1')).toHaveAttribute('data-health', 'warn')
    await expect(page.getByTestId('device-PC1')).toContainText('169.254.')

    // Poste non raccordé : pas d'adresse automatique affichée
    const pc2 = page.getByTestId('device-PC2')
    await expect(pc2).toHaveAttribute('data-health', 'idle')
    await expect(pc2).toContainText('sans IP')

    // Équipement éteint
    await srv.click()
    await page.getByTestId('properties-panel').getByRole('button', { name: 'Éteindre' }).click()
    await expect(srv).toHaveAttribute('data-health', 'off')
    expect(consoleErrors).toEqual([])
  } finally {
    await close()
  }
})

test('Nœuds : forme du voyant selon l’état (double indice) et bandeau IOS des équipements Cisco', async () => {
  const { close, page, consoleErrors } = await launchApp()
  try {
    await placeDevice(page, 'server', 240, 160)
    await placeDevice(page, 'c2960', 520, 290)
    // Aucun câble : état inactif → anneau, nom accessible = libellé de l'état
    const led = page.getByTestId('device-SRV1').getByTestId('device-led')
    await expect(led).toHaveAttribute('data-shape', 'ring')
    await expect(led).toHaveAccessibleName('Aucun câble raccordé')
    await expect(page.getByTestId('device-SRV1').getByTestId('device-ios')).toHaveCount(0)
    const cisco = page
      .locator('[data-testid^="device-"][data-health]')
      .filter({ has: page.getByTestId('device-ios') })
    await expect(cisco).toHaveCount(1)
    await expect(cisco.getByTestId('device-ios')).toHaveText('IOS')
    expect(consoleErrors).toEqual([])
  } finally {
    await close()
  }
})

test('Câbles : voyants à forme, infobulle en texte (extrémités, débit, état) et légende des protocoles', async () => {
  const { close, page, consoleErrors } = await launchApp()
  try {
    await placeDevice(page, 'server', 240, 160)
    await placeDevice(page, 'switch', 560, 300)
    await cableDevices(page, 'SRV1', 'Ethernet0', 'SW1', 'Fa0/1')
    const cable = page.getByTestId('cable-Ethernet0-Fa0/1')
    await expect(cable.locator('[data-shape]')).toHaveCount(2)
    const tip = page.getByTestId('cable-hit').locator('title')
    await expect(tip).toContainText('SRV1 (Ethernet0) ↔ SW1 (Fa0/1)')
    await expect(tip).toContainText('100 Mbit/s')
    await expect(tip).toContainText('Ethernet0 : Lien')

    await expect(page.getByTestId('protocol-legend')).toHaveCount(0)
    await page.getByTestId('mode-simulation').click()
    await expect(page.getByTestId('protocol-legend')).toContainText('ICMP')
    expect(consoleErrors).toEqual([])
  } finally {
    await close()
  }
})
