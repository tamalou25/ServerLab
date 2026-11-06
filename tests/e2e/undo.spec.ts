import { expect, test, type ElectronApplication } from '@playwright/test'
import { clickMenu, configureHostIp, launchApp, openConsole, placeDevice, typeCommand } from './helpers'

/** Éléments Annuler / Rétablir du menu Édition natif (libellé, actif). */
async function editMenu(app: ElectronApplication): Promise<{ label: string; enabled: boolean }[]> {
  return app.evaluate(({ Menu }) => {
    const edit = Menu.getApplicationMenu()?.items.find((i) => i.label.replace('&', '') === 'Édition')
    return (edit?.submenu?.items ?? []).slice(0, 2).map((i) => ({ label: i.label, enabled: i.enabled }))
  })
}

/** Clique Édition > Annuler (premier élément), quel que soit son libellé. */
async function clickUndoMenu(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ Menu, BrowserWindow }) => {
    const edit = Menu.getApplicationMenu()?.items.find((i) => i.label.replace('&', '') === 'Édition')
    const win = BrowserWindow.getAllWindows()[0]
    edit?.submenu?.items[0]?.click(undefined, win, win?.webContents)
  })
}

test('Annuler / rétablir : ajout, glisser (une seule annulation) et commande console', async () => {
  const { app, close, page, consoleErrors } = await launchApp()
  try {
    // Document neuf : rien à annuler, éléments grisés
    await expect
      .poll(() => editMenu(app))
      .toEqual([
        { label: 'Annuler', enabled: false },
        { label: 'Rétablir', enabled: false }
      ])
    await placeDevice(page, 'server', 250, 150)
    await placeDevice(page, 'client', 250, 380)
    await expect(page.locator('.react-flow__node')).toHaveCount(2)
    await expect
      .poll(async () => (await editMenu(app))[0])
      .toEqual({ label: 'Annuler : Ajouter PC1', enabled: true })

    // Glisser : plusieurs déplacements intermédiaires, une seule entrée dans le journal
    const node = page.getByTestId('device-PC1')
    const before = await node.boundingBox()
    await node.hover()
    await page.mouse.down()
    for (let i = 1; i <= 5; i++) await page.mouse.move(before!.x + 20 + i * 30, before!.y + 20 + i * 10)
    await page.mouse.up()
    await expect.poll(async () => (await node.boundingBox())?.x).toBeGreaterThan(before!.x + 100)
    await expect.poll(async () => (await editMenu(app))[0]?.label).toBe('Annuler : Déplacer PC1')
    await page.locator('.react-flow__pane').click({ position: { x: 600, y: 60 } })
    await page.keyboard.press('Control+z')
    await expect.poll(async () => Math.round((await node.boundingBox())?.x ?? 0)).toBe(Math.round(before!.x))
    await expect(page.locator('.react-flow__node')).toHaveCount(2)
    await expect.poll(async () => (await editMenu(app))[1]?.label).toBe('Rétablir : Déplacer PC1')
    await page.keyboard.press('Control+z')
    await expect(page.locator('.react-flow__node')).toHaveCount(1)
    await page.keyboard.press('Control+y')
    await expect(page.locator('.react-flow__node')).toHaveCount(2)

    // Commande console : Ctrl+Z / Maj+Ctrl+Z sur la ligne vide, sans quitter la console
    await openConsole(page, 'SRV1', 'powershell')
    await typeCommand(
      page,
      'SRV1',
      'New-NetIPAddress -InterfaceAlias Ethernet0 -IPAddress 192.168.10.1 -PrefixLength 24'
    )
    const srv = page.getByTestId('device-SRV1')
    await expect(srv).toContainText('192.168.10.1')
    await expect.poll(async () => (await editMenu(app))[0]?.label).toMatch(/^Annuler : New-NetIPAddress/)
    await page.keyboard.press('Control+z')
    await expect(srv).not.toContainText('192.168.10.1')
    await page.keyboard.press('Control+Shift+z')
    await expect(srv).toContainText('192.168.10.1')

    // Menu Édition > Annuler : annule la commande annoncée, même avec le focus dans la console
    await clickUndoMenu(app)
    await expect(srv).not.toContainText('192.168.10.1')
    await page.getByTestId('close-device-window').click()

    // Nouveau document : historique vidé
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = (async () => ({
        response: 1,
        checkboxChecked: false
      })) as typeof dialog.showMessageBox
    })
    await clickMenu(app, ['Fichier', 'Nouveau'])
    await expect(page.locator('.react-flow__node')).toHaveCount(0)
    await expect
      .poll(() => editMenu(app))
      .toEqual([
        { label: 'Annuler', enabled: false },
        { label: 'Rétablir', enabled: false }
      ])
    expect(consoleErrors).toEqual([])
  } finally {
    await close()
  }
})

test('Annuler / rétablir : configuration IPv4 faite dans la fenêtre de l’équipement', async () => {
  const { app, close, page, consoleErrors } = await launchApp()
  try {
    await placeDevice(page, 'client', 300, 200)
    const pc = page.getByTestId('device-PC1')
    await configureHostIp(page, 'PC1', '192.168.10.10', '255.255.255.0')
    await expect(pc).toContainText('192.168.10.10')
    await expect.poll(async () => (await editMenu(app))[0]?.label).toMatch(/^Annuler : Configurer IPv4 de /)
    await page.locator('.react-flow__pane').click({ position: { x: 600, y: 60 } })
    await page.keyboard.press('Control+z')
    await expect(pc).not.toContainText('192.168.10.10')
    await expect.poll(async () => (await editMenu(app))[1]?.label).toMatch(/^Rétablir : Configurer IPv4 de /)
    await page.keyboard.press('Control+y')
    await expect(pc).toContainText('192.168.10.10')
    expect(consoleErrors).toEqual([])
  } finally {
    await close()
  }
})
