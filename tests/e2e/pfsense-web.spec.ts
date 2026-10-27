import { expect, test } from '@playwright/test'
import { cableDevices, configureHostIp, launchApp, openDesktop, placeDevice } from './helpers'

test('pfSense : interface web depuis le LAN, connexion, règle ajoutée puis appliquée, alias, journal', async () => {
  const { close, page, consoleErrors } = await launchApp()
  try {
    await placeDevice(page, 'firewall', 220, 160)
    await placeDevice(page, 'client', 220, 420)
    await cableDevices(page, 'PC1', 'Ethernet0', 'FW1', 'em1')
    await configureHostIp(page, 'PC1', '192.168.1.10', '255.255.255.0', '192.168.1.1')

    const pc = await openDesktop(page, 'PC1')
    await pc.getByTestId('start-button').click()
    await pc.getByTestId('start-app-browser').click()
    await pc.getByTestId('browser-address').fill('https://192.168.1.1')
    await pc.getByTestId('browser-go').click()

    // Certificat auto-signé, puis page de connexion
    await pc.getByTestId('browser-continue').click()
    await expect(pc.getByTestId('pf-login')).toBeVisible()
    await pc.getByTestId('pf-login-user').fill('admin')
    await pc.getByTestId('pf-login-password').fill('mauvais')
    await pc.getByTestId('pf-login-submit').click()
    await expect(pc.getByTestId('pf-login-error')).toContainText('Username or Password incorrect')
    await pc.getByTestId('pf-login-user').fill('admin')
    await pc.getByTestId('pf-login-password').fill('pfsense')
    await pc.getByTestId('pf-login-submit').click()
    await expect(pc.getByTestId('pf-dash-name')).toBeVisible()

    // Alias puis règle sur le LAN : « Save » met en attente, « Apply Changes » applique
    await pc.getByTestId('pf-menu-Firewall').click()
    await pc.getByTestId('pf-nav-aliases').click()
    await pc.getByTestId('pf-alias-add').click()
    await pc.getByTestId('pf-alias-name').fill('Serveurs_Web')
    await pc.getByTestId('pf-alias-values').fill('172.16.0.10')
    await pc.getByTestId('pf-form-save').click()
    await expect(pc.getByTestId('pf-alias-Serveurs_Web')).toBeVisible()
    await pc.getByTestId('pf-apply').click()
    await expect(pc.getByTestId('pf-apply-banner')).toHaveCount(0)

    await pc.getByTestId('pf-menu-Firewall').click()
    await pc.getByTestId('pf-nav-rules').click()
    await pc.getByTestId('pf-rule-add').click()
    await pc.getByTestId('pf-rule-action').selectOption('block')
    await pc.getByTestId('pf-rule-dst-kind').selectOption('host')
    await pc.getByTestId('pf-rule-dst-text').fill('Serveurs_Web')
    await pc.getByTestId('pf-rule-dport-from').fill('80')
    await pc.getByTestId('pf-rule-log').check()
    await pc.getByTestId('pf-rule-descr').fill('Bloquer le web DMZ')
    await pc.getByTestId('pf-form-save').click()
    await expect(pc.getByText('Bloquer le web DMZ')).toBeVisible()
    await expect(pc.getByTestId('pf-apply-banner')).toContainText('must be applied')
    await pc.getByTestId('pf-apply').click()
    await expect(pc.getByTestId('pf-apply-banner')).toHaveCount(0)

    // Services > DNS Resolver : Host Override mis en attente puis appliqué
    await pc.getByTestId('pf-menu-Services').click()
    await pc.getByTestId('pf-nav-dns').click()
    await pc.getByTestId('pf-override-host').fill('intranet')
    await pc.getByTestId('pf-override-domain').fill('lab.local')
    await pc.getByTestId('pf-override-address').fill('172.16.0.10')
    await pc.getByTestId('pf-override-add').click()
    await expect(pc.getByTestId('pf-override-row')).toContainText('intranet')
    await pc.getByTestId('pf-apply').click()
    await expect(pc.getByTestId('pf-apply-banner')).toHaveCount(0)

    // La connexion à l'administration a laissé une entrée dans la table d'états
    await pc.getByTestId('pf-menu-Diagnostics').click()
    await pc.getByTestId('pf-nav-states').click()
    await expect(pc.getByTestId('pf-state-row').first()).toContainText('192.168.1.1:443')
    expect(consoleErrors).toEqual([])
  } finally {
    await close()
  }
})
