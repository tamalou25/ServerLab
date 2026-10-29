/**
 * Aide > Signaler un bug… : le process principal ouvre le navigateur (ouverture simulée) sur une
 * issue GitHub préremplie, sans donnée du lab ni donnée personnelle.
 */
import { expect, test } from '@playwright/test'
import { hostname, userInfo } from 'node:os'
import { clickMenu, launchApp, placeDevice } from './helpers'

test('Signaler un bug : issue préremplie, liste blanche, aucune donnée du lab', async () => {
  const { app, close, page, consoleErrors } = await launchApp()
  try {
    // Lab avec un nom reconnaissable : il ne doit jamais apparaître dans le rapport
    await placeDevice(page, 'server', 220, 160)
    await page.getByTestId('device-SRV1').dblclick()

    // Navigateur simulé : les adresses ouvertes sont seulement mémorisées
    await app.evaluate(({ shell }) => {
      const opened: string[] = []
      ;(globalThis as { opened?: string[] }).opened = opened
      shell.openExternal = (async (url: string) => {
        opened.push(url)
      }) as typeof shell.openExternal
    })
    await clickMenu(app, ['Aide', 'Signaler un bug…'])
    const opened = () => app.evaluate(() => (globalThis as { opened?: string[] }).opened ?? [])
    await expect.poll(opened).toHaveLength(1)
    const [address] = await opened()
    const url = new URL(address ?? '')

    expect(`${url.origin}${url.pathname}`).toBe('https://github.com/tamalou25/ServerLab/issues/new')
    expect(url.searchParams.get('labels')).toBe('bug')
    const body = url.searchParams.get('body') ?? ''
    // L'application tourne sur la même machine que le test : mêmes nom d'utilisateur et de machine
    const env = await app.evaluate(({ app: electronApp }) => ({
      version: electronApp.getVersion(),
      electron: process.versions.electron,
      home: electronApp.getPath('home'),
      userData: electronApp.getPath('userData')
    }))
    const user = userInfo().username
    const host = hostname()
    expect(body).toContain(`- ServerLab : ${env.version}`)
    expect(body).toContain(`- Electron : ${env.electron}`)
    expect(body).toMatch(/- Système : (Linux|Windows|macOS) /)
    expect(body).toContain('## Étapes pour reproduire')

    // Aucune donnée du lab ni donnée personnelle (contenu décodé : titre, étiquettes et corps)
    const sent = [...url.searchParams.values()].join('\n')
    for (const secret of ['SRV1', env.home, env.userData, host]) expect(sent).not.toContain(secret)
    expect(sent).not.toMatch(new RegExp(`\\b${user}\\b`))
    expect(consoleErrors).toEqual([])
  } finally {
    await close()
  }
})
