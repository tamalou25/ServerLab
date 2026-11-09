import { expect, test } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CURRENT_SCHEMA_VERSION } from '../../src/engine/serialization/migrations'
import { cableDevices, clickMenu, launchApp, placeDevice } from './helpers'

test('construire une topologie, l’enregistrer puis la rouvrir', async () => {
  const { app, close, page, consoleErrors, userData } = await launchApp()
  try {
    await placeDevice(page, 'server', 250, 150)
    await placeDevice(page, 'client', 250, 380)
    await placeDevice(page, 'switch', 520, 260)
    await expect(page.locator('.react-flow__node')).toHaveCount(3)
    await expect(page.getByTestId('device-SRV1')).toBeVisible()

    await cableDevices(page, 'SRV1', 'Ethernet0', 'SW1', 'Fa0/1')
    await cableDevices(page, 'PC1', 'Ethernet0', 'SW1', 'Fa0/2')
    await expect(page.locator('.react-flow__edge')).toHaveCount(2)
    await expect(page).toHaveTitle(/Sans titre \* — ServerLab/)

    // Annuler / rétablir le dernier câble
    await page.locator('.react-flow__pane').click({ position: { x: 600, y: 100 } })
    await page.keyboard.press('Control+z')
    await expect(page.locator('.react-flow__edge')).toHaveCount(1)
    await page.keyboard.press('Control+y')
    await expect(page.locator('.react-flow__edge')).toHaveCount(2)

    // Enregistrer sous (dialogue natif simulé)
    const file = join(userData, 'mon-lab.slab')
    await app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = (async () => ({
        canceled: false,
        filePath: path
      })) as typeof dialog.showSaveDialog
    }, file)
    await clickMenu(app, ['Fichier', 'Enregistrer sous…'])
    await expect(page).toHaveTitle('mon-lab.slab — ServerLab')
    expect(existsSync(file)).toBe(true)
    const saved = JSON.parse(readFileSync(file, 'utf8')) as {
      schemaVersion: number
      lab: { devices: object }
    }
    expect(saved.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    expect(Object.keys(saved.lab.devices)).toHaveLength(3)

    // Nouveau document puis réouverture
    await clickMenu(app, ['Fichier', 'Nouveau'])
    await expect(page.locator('.react-flow__node')).toHaveCount(0)
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [path]
      })) as typeof dialog.showOpenDialog
    }, file)
    await clickMenu(app, ['Fichier', 'Ouvrir…'])
    await expect(page.locator('.react-flow__node')).toHaveCount(3)
    await expect(page.locator('.react-flow__edge')).toHaveCount(2)
    await expect(page).toHaveTitle('mon-lab.slab — ServerLab')

    // Le fichier apparaît dans les récents
    const recent = await app.evaluate(({ Menu }) => {
      const file = Menu.getApplicationMenu()?.items.find((i) => i.label.includes('Fichier'))
      const sub = file?.submenu?.items.find((i) => i.label === 'Fichiers récents')
      return sub?.submenu?.items.map((i) => i.label) ?? []
    })
    expect(recent[0]).toContain('mon-lab.slab')

    expect(consoleErrors).toEqual([])
  } finally {
    await close()
  }
})

test('ouvrir la fenêtre d’un équipement par double-clic', async () => {
  const { close, page } = await launchApp()
  try {
    await placeDevice(page, 'router', 300, 200)
    await placeDevice(page, 'switch', 550, 300)
    // Régression : double-clic sur un équipement alors qu'un autre est sélectionné
    await page.getByTestId('device-SW1').click()
    await page.getByTestId('device-R1').dblclick()
    await expect(page.getByTestId('device-window-R1')).toBeVisible()
    await page.getByTestId('close-device-window').click()
    await expect(page.getByTestId('device-window-R1')).toHaveCount(0)
  } finally {
    await close()
  }
})
