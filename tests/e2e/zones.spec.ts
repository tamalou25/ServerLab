import { expect, test } from '@playwright/test'
import { cableDevices, configureHostIp, launchApp, placeDevice } from './helpers'

test('Zones réseau et mises en évidence : calcul depuis les adresses, lecture seule, légende', async () => {
  const { close, page, consoleErrors } = await launchApp()
  try {
    await placeDevice(page, 'client', 200, 200)
    await placeDevice(page, 'client', 500, 200)
    await placeDevice(page, 'switch', 350, 400)
    await cableDevices(page, 'PC1', 'Ethernet0', 'SW1', 'Fa0/1')
    await cableDevices(page, 'PC2', 'Ethernet0', 'SW1', 'Fa0/2')
    // Sans adresse exploitable (APIPA) : aucune zone
    await expect(page.getByTestId('network-zones')).toHaveCount(0)
    await configureHostIp(page, 'PC1', '192.168.10.10', '255.255.255.0')
    await configureHostIp(page, 'PC2', '192.168.10.11', '255.255.255.0')
    const zone = page.getByTestId('zone-192.168.10.0/24')
    await expect(zone).toBeVisible()
    await expect(zone).toContainText('192.168.10.0/24')
    await expect(zone).toContainText('VLAN 1')
    await expect(page.getByTestId('status-counts')).toContainText('1 sous-réseau')
    await expect(page.getByTestId('state-legend')).toContainText('Zone : même réseau IPv4')

    // Un masque différent sort PC2 de la zone (zone descriptive : aucune commande, historique intact)
    const undoLabel = await page.getByTestId('toolbar-undo').getAttribute('aria-label')
    await page.getByTestId('toggle-zones').click()
    await expect(page.getByTestId('network-zones')).toHaveCount(0)
    await page.getByTestId('toggle-zones').click()
    await expect(zone).toBeVisible()
    expect(await page.getByTestId('toolbar-undo').getAttribute('aria-label')).toBe(undoLabel)
    await configureHostIp(page, 'PC2', '192.168.10.11', '255.255.0.0')
    await expect(page.getByTestId('zone-192.168.0.0/16')).toBeVisible()
    await expect(page.getByTestId('status-counts')).toContainText('2 sous-réseau')

    // Branche de l'équipement sélectionné : ses câbles sont mis en évidence, les autres non
    await page.getByTestId('device-PC1').click()
    await expect(page.getByTestId('state-legend')).toContainText('Branche de l’équipement sélectionné')
    const cables = page.getByTestId('cable-hit')
    await expect(cables.filter({ has: page.locator('[data-state="branch"]') })).toHaveCount(0)
    await expect(page.locator('[data-testid="cable-hit"][data-state="branch"]')).toHaveCount(1)
    await expect(page.locator('[data-testid="cable-hit"][data-state="plain"]')).toHaveCount(1)
    // Câble sélectionné : état distinct
    await page.getByTestId('cable-Ethernet0-Fa0/2').click({ force: true })
    await expect(page.locator('[data-testid="cable-hit"][data-state="selected"]')).toHaveCount(1)
    await expect(page.getByTestId('state-legend')).toContainText('Câble sélectionné')
    expect(consoleErrors).toEqual([])
  } finally {
    await close()
  }
})
