import { expect, test } from '@playwright/test'
import { cableDevices, configureHostIp, launchApp, openConsole, placeDevice, typeCommand } from './helpers'

type Probe = { serverlabPerf: { renders: Record<string, number> } }

/**
 * Régression P-02 (audit v2.11.1) : déplacer un nœud (ce qui modifie `lab.devices`) ne doit pas
 * redessiner les lignes d'évènements du panneau Simulation. Rendus comptés par `countRender`.
 */
test('glisser un nœud ne redessine pas les lignes du panneau Simulation', async () => {
  const { close, page, consoleErrors } = await launchApp()
  try {
    await placeDevice(page, 'server', 220, 160)
    await placeDevice(page, 'client', 220, 420)
    await placeDevice(page, 'switch', 520, 290)
    await cableDevices(page, 'SRV1', 'Ethernet0', 'SW1', 'Fa0/1')
    await cableDevices(page, 'PC1', 'Ethernet0', 'SW1', 'Fa0/2')
    await configureHostIp(page, 'SRV1', '192.168.1.1', '255.255.255.0')
    await configureHostIp(page, 'PC1', '192.168.1.10', '255.255.255.0')

    // Simulation : un ping rejoué pas à pas remplit le tableau d'évènements
    await openConsole(page, 'PC1', 'cmd')
    await page.getByTestId('mode-simulation').click()
    await typeCommand(page, 'PC1', 'ping 192.168.1.1')
    for (let i = 0; i < 30; i++) {
      if (await page.getByTestId('sim-step').isDisabled()) break
      await page.getByTestId('sim-step').click()
    }
    await page.getByTestId('device-window-PC1').getByTestId('close-device-window').click()
    const rows = page.getByTestId('sim-events').locator('tbody tr')
    expect(await rows.count()).toBeGreaterThan(2)

    // Glisse SRV1 : la position change dans lab.devices
    const node = page.getByTestId('device-SRV1')
    const box = await node.boundingBox()
    if (!box) throw new Error('nœud SRV1 introuvable')
    await page.evaluate(() => {
      ;(window as unknown as Probe).serverlabPerf = { renders: {} }
    })
    await page.mouse.move(box.x + 20, box.y + 20)
    await page.mouse.down()
    for (let i = 1; i <= 15; i++) await page.mouse.move(box.x + 20 + i * 8, box.y + 20 + i * 4)
    await page.mouse.up()
    await expect.poll(async () => (await node.boundingBox())?.x).toBeGreaterThan(box.x + 60)

    const renders = await page.evaluate(() =>
      Object.entries((window as unknown as Probe).serverlabPerf.renders)
        .filter(([k]) => k.startsWith('sim-row:'))
        .reduce((sum, [, n]) => sum + n, 0)
    )
    expect(renders, 'le déplacement ne redessine pas les lignes').toBe(0)
    expect(consoleErrors).toEqual([])
  } finally {
    await close()
  }
})
