import { expect, test } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  correctSubmission,
  createSubject,
  parseLab,
  parseSubject,
  parseSubmission,
  serializeSubject
} from '../../src/engine/index'
import lab1 from '../../labs/lab-01-adressage.json'
import { clickMenu, configureHostIp, launchApp } from './helpers'

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

test('Passation : lab 1 résolu dans l’interface, indice, rendu ; la correction par rejeu donne 100 % des critères', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'serverlab-passation-'))
  const lab = parseLab(lab1)
  if (!lab.ok) throw new Error(lab.message)
  const subject = createSubject(lab.lab, { appVersion: 'e2e' })
  const subjectPath = join(dir, 'sujet.slabsujet')
  writeFileSync(subjectPath, serializeSubject(subject))
  const rendu = join(dir, 'alice')
  const { app, close, page, consoleErrors } = await launchApp()
  try {
    await clickMenu(app, ['Affichage', 'Mode enseignant'])
    await page.getByTestId('right-tab-teacher').click()
    await app.evaluate(
      ({ dialog }, paths) => {
        dialog.showOpenDialog = (async () => ({
          canceled: false,
          filePaths: [paths.open]
        })) as typeof dialog.showOpenDialog
        dialog.showSaveDialog = (async () => ({
          canceled: false,
          filePath: paths.save
        })) as typeof dialog.showSaveDialog
      },
      { open: subjectPath, save: rendu }
    )
    await page.getByTestId('teacher-take-subject').click()
    const panel = page.getByTestId('attempt-panel')
    await panel.getByTestId('attempt-name').fill('Alice')
    await panel.getByTestId('attempt-start').click()
    await expect(panel.getByTestId('attempt-timer')).toBeVisible()
    // Solution inaccessible : ni onglet Lab ni onglet Enseignant pendant l'épreuve
    await expect(page.getByTestId('right-tab-lab')).toHaveCount(0)
    await expect(page.getByTestId('right-tab-teacher')).toHaveCount(0)

    // Indice : pénalité confirmée avant
    await panel.getByTestId('attempt-hint').click()
    await page.getByTestId('modal-confirm').click()
    await expect(panel.getByTestId('attempt-hint-text')).not.toBeEmpty()

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

    await page.getByTestId('right-tab-attempt').click()
    await panel.getByTestId('attempt-end').click()
    await page.getByTestId('modal-confirm').click()
    await expect(panel.getByTestId('attempt-done')).toContainText(`${rendu}.slabrendu`)

    const parsed = parseSubmission(readFileSync(`${rendu}.slabrendu`, 'utf8'))
    if (!parsed.ok) throw new Error(parsed.message)
    expect(parsed.doc.student.name).toBe('Alice')
    expect(parsed.doc.hints).toHaveLength(1)
    const correction = correctSubmission(subject, parsed.doc, { appVersion: 'e2e', correctedAt: 'x' })
    expect(correction.flags).toEqual([])
    expect(correction.criteria.filter((c) => !c.ok)).toEqual([])
    expect(correction.grade.value).toBeCloseTo(20 - (0.5 / 7) * 20, 2)
    expect(consoleErrors).toEqual([])
  } finally {
    await close()
  }
})
