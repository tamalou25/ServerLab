import { expect, test } from '@playwright/test'
import { launchApp, placeDevice } from './helpers'

test('Menu contextuel d’un nœud : souris et clavier, Console, Éteindre, Renommer, Supprimer', async () => {
  const { close, page, consoleErrors } = await launchApp()
  try {
    await placeDevice(page, 'server', 300, 200)
    const node = page.getByTestId('device-SRV1')

    // Clic droit : le premier élément a le focus, flèches et Échap
    await node.click({ button: 'right' })
    const menu = page.getByTestId('node-menu')
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitem').first()).toBeFocused()
    await page.keyboard.press('ArrowUp')
    await expect(menu.getByTestId('node-menu-delete')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(node).toBeVisible()

    // Éteindre puis Console (fenêtre ouverte sur l'onglet Console, barre de titre avec accès rapides)
    await node.click({ button: 'right' })
    await menu.getByTestId('node-menu-power').click()
    await expect(node).toHaveAttribute('data-health', 'off')
    await node.click({ button: 'right' })
    await menu.getByTestId('node-menu-console').click()
    const win = page.getByTestId('device-window-SRV1')
    await expect(win.getByTestId('tab-console')).toHaveAttribute('aria-selected', 'true')
    await expect(win.getByTestId('win-quick-desktop')).toBeVisible()
    await win.getByTestId('close-device-window').click()

    // Renommer : focus dans le champ de nom du Résumé
    await node.click({ button: 'right' })
    await menu.getByTestId('node-menu-rename').click()
    await expect(page.getByTestId('device-name-input')).toBeFocused()
    await page.keyboard.press('Escape')

    // Clavier : Maj+F10 sur le nœud qui a le focus, Supprimer
    await page.locator('.react-flow__node').filter({ has: node }).focus()
    await page.keyboard.press('Shift+F10')
    await expect(menu).toBeVisible()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('device-SRV1')).toHaveCount(0)
    expect(consoleErrors).toEqual([])
  } finally {
    await close()
  }
})
