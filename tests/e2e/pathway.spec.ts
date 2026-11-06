import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { clickMenu, configureHostIp, launchApp } from './helpers'

/** Lab 1 résolu depuis l'interface (même suite que labs.spec.ts). */
async function solveLab01(page: Parameters<typeof configureHostIp>[0]): Promise<void> {
  await page.getByTestId('device-R1').dblclick()
  const r1 = page.getByTestId('device-window-R1')
  for (const [port, address] of [
    ['Gi0/0', '192.168.10.254'],
    ['Gi0/1', '192.168.20.254']
  ] as const) {
    await r1.getByTestId(`nav-iface-${port}`).click()
    await r1.getByTestId('if-address').fill(address)
    await r1.getByTestId('if-mask').fill('255.255.255.0')
    await r1.getByTestId('if-apply').click()
  }
  await r1.getByTestId('close-device-window').click()
  await configureHostIp(page, 'PC1', '192.168.10.10', '255.255.255.0', '192.168.10.254')
  await configureHostIp(page, 'PC2', '192.168.20.10', '255.255.255.0', '192.168.20.254')
}

test('Parcours PME : étape recommandée, ouverture, réussite enregistrée, progression conservée au relancement', async () => {
  const first = await launchApp()
  const { userData } = first
  try {
    const { app, page } = first
    await clickMenu(app, ['Fichier', 'Ouvrir un lab…'])
    const picker = page.getByTestId('lab-picker')
    await picker.getByTestId('picker-tab-pathway').click()
    const pathway = picker.getByTestId('pathway')
    await expect(pathway).toContainText('Atelier Lambert')
    await expect(pathway.getByTestId('pathway-progress')).toContainText('0 / 12')
    await expect(pathway.getByTestId('pathway-recommended')).toContainText('1. Relier le bureau et l’atelier')
    await expect(pathway.getByTestId('pathway-step-etape-01')).toHaveAttribute('data-state', 'recommande')
    await expect(pathway.getByTestId('pathway-step-etape-02')).toHaveAttribute('data-state', 'disponible')
    // Les étapes d'incident et la mission sont ouvrables librement (variantes par graine)
    await expect(pathway.getByTestId('pathway-variant-etape-10-11')).toBeVisible()
    await expect(
      pathway.getByTestId('pathway-competences').locator('[data-state="non-travaillee"]')
    ).not.toHaveCount(0)

    // Ouvrir l'étape recommandée, la réussir
    await pathway.getByTestId('pathway-open-etape-01').click()
    await expect(page.getByTestId('lab-title')).toHaveText('Adressage IP et routage entre deux réseaux')
    await solveLab01(page)
    await page.getByTestId('right-tab-lab').click()
    await page.getByTestId('lab-check').click()
    await expect(page.getByTestId('lab-score')).toHaveText('7 / 7 critère(s) validé(s)')

    // Progression : étape 1 terminée, étape 2 recommandée, compétence travaillée (pas démontrée)
    await clickMenu(app, ['Fichier', 'Ouvrir un lab…'])
    await picker.getByTestId('picker-tab-pathway').click()
    await expect(pathway.getByTestId('pathway-progress')).toContainText('1 / 12')
    await expect(pathway.getByTestId('pathway-step-etape-01')).toHaveAttribute('data-state', 'termine')
    await expect(pathway.getByTestId('pathway-attempts-etape-01')).toContainText('1 réussite sur 1')
    await expect(pathway.getByTestId('pathway-step-etape-02')).toHaveAttribute('data-state', 'recommande')
    await expect(pathway.getByTestId('pathway-recommended')).toContainText('2. Arrêter d’adresser')
    await expect(pathway.getByTestId('pathway-competences').locator('[data-state="travaillee"]')).toHaveCount(
      2
    )
    await expect(pathway.getByTestId('pathway-competences').locator('[data-state="demontree"]')).toHaveCount(
      0
    )
    expect(first.consoleErrors).toEqual([])
  } finally {
    await first.close()
  }

  // Fichier de progression écrit et validé ; relancement avec le même profil
  const file = join(userData, 'progress.json')
  expect(existsSync(file)).toBe(true)
  const saved = JSON.parse(readFileSync(file, 'utf8')) as {
    formatVersion: number
    attempts: { labId: string }[]
  }
  expect(saved.formatVersion).toBe(1)
  expect(saved.attempts.map((a) => a.labId)).toEqual(['lab-01-adressage'])

  const second = await launchApp({ userData })
  try {
    const { app, page } = second
    await clickMenu(app, ['Fichier', 'Accueil'])
    await expect(page.getByTestId('home-pathway')).toContainText('2. Arrêter d’adresser')
    await page.getByTestId('home-pathway').click()
    const picker = page.getByTestId('lab-picker')
    await expect(picker.getByTestId('pathway-step-etape-01')).toHaveAttribute('data-state', 'termine')
    expect(second.consoleErrors).toEqual([])
  } finally {
    await second.close()
  }
})

test('Progression : fichier corrompu toléré, lab de dépannage fourni avec indices et bilan', async () => {
  const { app, page, close, consoleErrors, userData } = await launchApp()
  // Fichier de progression corrompu : toléré (progression vide), l'application démarre et enregistre ensuite
  writeFileSync(join(userData, 'progress.json'), '{"formatVersion":1,"attempts":[{"id":')
  try {
    await clickMenu(app, ['Fichier', 'Ouvrir un lab…'])
    await page.getByTestId('lab-open-lab-60-mission-compta').click()
    await expect(page.getByTestId('lab-title')).toContainText('la comptabilité ne peut plus enregistrer')
    // Un lab de dépannage fourni garde son énoncé dans l'onglet Lab et a un onglet Dépannage actif
    await page.getByTestId('right-tab-troubleshoot').click()
    const panel = page.getByTestId('tshoot-panel')
    await expect(panel.getByTestId('tshoot-tickets')).toContainText('onglet Lab')
    await expect(panel.getByTestId('tshoot-hints-count')).toHaveText('0 / 6')
    await panel.getByTestId('tshoot-hint').click()
    await expect(panel.getByTestId('tshoot-hints')).not.toContainText('NTFS')
    await panel.getByTestId('tshoot-repaired').click()
    await expect(panel.getByTestId('tshoot-persists')).toHaveText('Le problème persiste.')
    await page.getByTestId('right-tab-lab').click()
    await expect(page.getByTestId('lab-title')).toBeVisible()
    expect(consoleErrors).toEqual([])
  } finally {
    await close()
  }
})
