import { expect, test } from '@playwright/test'
import { launchApp, openConsole, placeDevice, typeCommand } from './helpers'

type Probe = { serverlabPerf: { renders: Record<string, number> } }

/**
 * Régression P-01 (audit v2.11.1) : la saisie d'une console ne doit pas redessiner la liste des
 * lignes (jusqu'à 2000 `<div>`). Les rendus de la liste sont comptés par `countRender`.
 */
test('taper dans la console ne redessine pas les lignes de sortie', async () => {
  const { close, page, consoleErrors } = await launchApp()
  try {
    await placeDevice(page, 'server', 220, 160)
    await openConsole(page, 'SRV1', 'powershell')
    const win = page.getByTestId('device-window-SRV1')
    // Remplit la console de quelques dizaines de lignes
    for (let i = 0; i < 8; i++) await typeCommand(page, 'SRV1', 'Get-NetAdapter')
    await expect(win.getByTestId('terminal-powershell')).toContainText('Carte réseau Ethernet virtuelle')

    const input = win.getByTestId('terminal-input')
    await input.focus()
    await page.evaluate(() => {
      ;(window as unknown as Probe).serverlabPerf = { renders: {} }
    })
    await input.pressSequentially('Get-Service -Name Dnscache', { delay: 5 })
    await expect(input).toHaveValue('Get-Service -Name Dnscache')
    const renders = await page.evaluate(() =>
      Object.entries((window as unknown as Probe).serverlabPerf.renders)
        .filter(([k]) => k.startsWith('console-lines:'))
        .reduce((sum, [, n]) => sum + n, 0)
    )
    expect(renders, 'la saisie ne redessine pas les lignes').toBe(0)
    expect(consoleErrors).toEqual([])
  } finally {
    await close()
  }
})
