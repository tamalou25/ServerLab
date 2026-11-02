import { expect, test } from '@playwright/test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSubject } from '../../src/engine/index'
import { clickMenu, launchApp } from './helpers'

test('Mode enseignant désactivé par défaut : aucun onglet visible', async () => {
  const { close, page, consoleErrors } = await launchApp()
  try {
    await expect(page.getByTestId('right-tab-properties')).toBeVisible()
    await expect(page.getByTestId('right-tab-teacher')).toHaveCount(0)
    expect(consoleErrors).toEqual([])
  } finally {
    await close()
  }
})

test('Mode enseignant : sujet créé depuis un lab, contrôle de la solution, export .slabsujet', async () => {
  const target = join(mkdtempSync(join(tmpdir(), 'serverlab-sujet-')), 'e6-dhcp')
  const { app, close, page, consoleErrors } = await launchApp()
  try {
    await clickMenu(app, ['Affichage', 'Mode enseignant'])
    await page.getByTestId('right-tab-teacher').click()
    const panel = page.getByTestId('teacher-panel')
    await panel.getByTestId('teacher-lab-select').selectOption('lab-02-dhcp')
    await panel.getByTestId('teacher-from-library').click()
    await panel.getByTestId('teacher-title').fill('E6 — DHCP')
    await panel.getByTestId('teacher-add-question').click()
    await panel.getByLabel('Texte de la question').fill('Pourquoi exclure des adresses ?')
    // Lab vide : la solution n'obtient pas 100 %
    await expect(panel.getByTestId('teacher-preview')).toContainText('⚠')

    await app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = (async () => ({
        canceled: false,
        filePath: path
      })) as typeof dialog.showSaveDialog
    }, target)
    await panel.getByTestId('teacher-export-subject').click()
    await expect(page.getByTestId('modal')).toContainText('n’obtient pas 100 %')
    await page.getByTestId('modal-confirm').click()
    await expect(page.getByText(`Sujet exporté : ${target}.slabsujet`)).toBeVisible()

    const parsed = parseSubject(readFileSync(`${target}.slabsujet`, 'utf8'))
    expect(parsed.ok && parsed.doc.meta.title).toBe('E6 — DHCP')
    expect(parsed.ok && parsed.doc.oral[0]?.text).toBe('Pourquoi exclure des adresses ?')

    // Désactivé : l'onglet disparaît
    await clickMenu(app, ['Affichage', 'Mode enseignant'])
    await expect(page.getByTestId('right-tab-teacher')).toHaveCount(0)
    expect(consoleErrors).toEqual([])
  } finally {
    await close()
  }
})
