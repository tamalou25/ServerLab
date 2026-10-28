import { expect, test } from '@playwright/test'
import { clickMenu, launchApp } from './helpers'

/** Libellés des menus de premier niveau (sans les marques d'accélérateur). */
const topMenus = (app: Awaited<ReturnType<typeof launchApp>>['app']) =>
  app.evaluate(({ Menu }) => (Menu.getApplicationMenu()?.items ?? []).map((i) => i.label.replace('&', '')))

test('Affichage › Langue : interface et menus en anglais, choix conservé au redémarrage', async () => {
  const first = await launchApp()
  const { userData } = first
  try {
    await expect(first.page.getByTestId('palette')).toContainText('Équipements')
    await clickMenu(first.app, ['Affichage', 'Langue', 'English'])
    await expect(first.page.getByTestId('palette')).toContainText('Devices')
    await expect(first.page.getByTestId('main-toolbar')).toContainText('Realtime')
    expect(await topMenus(first.app)).toEqual(['File', 'Edit', 'View', 'Simulation', 'Help'])
    expect(first.consoleErrors).toEqual([])
  } finally {
    await first.close()
  }
  const second = await launchApp({ userData })
  try {
    await expect(second.page.getByTestId('palette')).toContainText('Devices')
    await clickMenu(second.app, ['View', 'Language', 'Français'])
    await expect(second.page.getByTestId('palette')).toContainText('Équipements')
  } finally {
    await second.close()
  }
})

test('Langue du système par défaut (anglais si le système est en anglais)', async () => {
  const { app, close, page } = await launchApp({
    language: 'system',
    env: { LANG: 'en_US.UTF-8', LANGUAGE: 'en_US', LC_ALL: 'en_US.UTF-8' }
  })
  try {
    await expect(page.getByTestId('palette')).toContainText('Devices')
    expect(await topMenus(app)).toContain('File')
  } finally {
    await close()
  }
})
